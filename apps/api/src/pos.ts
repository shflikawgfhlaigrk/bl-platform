/**
 * POS composition facade.
 *
 * The orders module intentionally accepts generic/manual prices because it also
 * serves invoices and imports. A live register must not trust browser prices,
 * so this facade resolves every catalog line and active promotion at checkout,
 * applies the tenant's stored tax setting, assigns the inventory location, and
 * only then creates the unified order. Custom items remain explicit, audited
 * cashier-entered prices.
 */
import { createHash } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import {
  ApiError,
  asCoreDb,
  errorHandler,
  getTenant,
  getUser,
  nowIso,
  tenantMiddleware,
  type CoreDatabase,
  type EventBus,
  type TenantEnv,
} from '@blacklabel/core';
import type { Kysely } from 'kysely';
import {
  getProduct,
  getVariation,
  lookupByCode,
  resolvePromotedPrice,
  type CatalogDatabase,
} from '@blacklabel/catalog';
import {
  getLocation,
  getStock,
  reserve,
  sellForOrder,
  settleReservationsForReference,
  type InventoryDatabase,
} from '@blacklabel/inventory';
import {
  buildProviderRegistry,
  cancelPaymentAttempt,
  cancelOrder,
  cancelSplitPayment,
  createPaymentAttempt,
  createRefund,
  createOrder,
  getPaymentAttempt,
  getOrder,
  listPaymentAttempts,
  listRefunds,
  listTenders,
  payOrder,
  reserveOrder,
  type CheckoutProvider,
  type LineInputSvc,
  type OrdersDatabase,
} from '@blacklabel/orders';
import { getProfile, type CustomersDatabase } from '@blacklabel/customers';
import {
  cashSessionReconciliation,
  closeCashSession,
  getCashSession,
  listCashMovements,
  listCashSessions,
  openCashSession,
  postCashDrawerMovement,
  type FinanceDatabase,
} from '@blacklabel/finance';
import { CONFIG_KEYS, getConfig, resolveDefaultLocationId, setConfig } from './config';
import type { ApiDatabase } from './migrations';
import type { PosReconciliationTables } from './pos-reconciliation-migrations';
import { withPosCashSessionLock } from './pos-serialization';

export type PosDatabase =
  & CoreDatabase
  & CatalogDatabase
  & InventoryDatabase
  & OrdersDatabase
  & CustomersDatabase
  & FinanceDatabase
  & ApiDatabase
  & PosReconciliationTables;

export interface PosRouterOptions {
  providers?: readonly CheckoutProvider[];
  envDefaultLocationId?: string;
  /** Composition-root identity resolver (browser session first, tool lane second). */
  getActingUser?: (c: Context, tenantId: string) => Promise<string | undefined>;
  /**
   * Server-owned card-present capability. The browser never chooses a reader
   * or asserts that hardware is online; both facts are resolved here.
   */
  cardPresent?: PosCardPresentOptions;
  processorStatus?: () => Promise<unknown>;
}

export interface PosCardReaderVerification {
  verified: boolean;
  readerId: string;
  status: string | null;
  checkedAt: string;
  code?: string;
}

export interface PosCardPresentOptions {
  provider: 'stripe_terminal';
  readerId: string;
  verify: () => Promise<PosCardReaderVerification>;
}

const bps = z.number().int().min(0).max(10000);
const cents = z.number().int().min(0);
const lineSchema = z.object({
  variationId: z.string().trim().min(1).optional(),
  locationId: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).max(500).optional(),
  qty: z.number().finite().positive(),
  unitPriceCents: cents.optional(),
  discountBps: bps.optional(),
  discountFixedCents: cents.optional(),
});
const orderSchema = z.object({
  cartId: z.string().trim().min(1).max(200),
  customerId: z.string().trim().min(1).optional(),
  showId: z.string().trim().min(1).optional(),
  registerId: z.string().trim().min(1).max(200).optional(),
  deviceId: z.string().trim().min(1).max(200).optional(),
  cashierId: z.string().trim().min(1).max(200).optional(),
  cashSessionId: z.string().trim().min(1).max(200).optional(),
  lines: z.array(lineSchema).min(1).max(250),
  discountBps: bps.optional(),
  discountFixedCents: cents.optional(),
  /** May be sent by the UI as an optimistic assertion; the stored setting wins. */
  taxBps: bps.optional(),
  tipCents: cents.optional(),
  note: z.string().max(2000).optional(),
});

const settingsSchema = z
  .object({
    defaultLocationId: z.string().trim().min(1).optional(),
    taxBps: bps.optional(),
    receiptFooter: z.string().trim().max(500).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'at least one setting is required');

const openDrawerSchema = z.object({
  drawerRef: z.string().trim().min(1).max(200),
  registerRef: z.string().trim().min(1).max(200).optional(),
  openingFloatCents: cents,
  note: z.string().trim().max(500).optional(),
});
const drawerMovementSchema = z.object({
  kind: z.enum(['paid_in', 'paid_out', 'drop']),
  amountCents: z.number().int().positive(),
  note: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().trim().min(1).max(250),
});
const closeDrawerSchema = z.object({
  countedCents: cents,
  note: z.string().trim().max(500).optional(),
});

const manualTenderSchema = z
  .object({
    kind: z.enum(['cash', 'external']),
    amountCents: z.number().int().positive(),
    cashReceivedCents: cents.optional(),
    idempotencyKey: z.string().trim().min(1).max(250),
    provider: z.string().trim().min(1).max(100).optional(),
    providerRef: z.string().trim().min(1).max(250).optional(),
  })
  .superRefine((tender, ctx) => {
    if (tender.kind === 'cash') {
      if (tender.provider !== undefined || tender.providerRef !== undefined) {
        ctx.addIssue({ code: 'custom', message: 'cash tenders cannot include provider fields' });
      }
      return;
    }
    if (!tender.provider) {
      ctx.addIssue({ code: 'custom', message: 'external tenders require a payment source' });
    }
    if (!tender.providerRef) {
      ctx.addIssue({ code: 'custom', message: 'external tenders require a transaction reference' });
    }
    if (tender.cashReceivedCents !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'cashReceivedCents is only valid for cash tenders' });
    }
  });

const payOrderSchema = z.object({
  tenders: z.array(manualTenderSchema).max(10).default([]),
});

const cardPaymentSchema = z.object({
  amountCents: z.number().int().positive().optional(),
  idempotencyKey: z.string().trim().min(1).max(250),
});

const refundSchema = z.object({
  tenderId: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1).max(250),
  cashSessionId: z.string().trim().min(1).optional(),
  amountCents: z.number().int().positive(),
  reason: z.string().trim().max(1000).optional(),
  lines: z
    .array(
      z.object({
        lineId: z.string().trim().min(1),
        qty: z.number().finite().positive(),
        disposition: z.enum(['restock', 'quarantine', 'damaged', 'none']),
      }),
    )
    .max(250),
});

interface PosSettings {
  defaultLocationId: string | null;
  taxBps: number | null;
  taxConfigured: boolean;
  receiptFooter: string | null;
  currency: 'USD';
}

type PosOrderInput = z.infer<typeof orderSchema>;

/** Bind a browser cart id to the normalized request facts that created it. */
function posCartFactHash(body: PosOrderInput, actor: string): string {
  const facts = {
    customerId: body.customerId ?? null,
    showId: body.showId ?? null,
    registerId: body.registerId ?? null,
    deviceId: body.deviceId ?? null,
    cashierId: actor,
    cashSessionId: body.cashSessionId ?? null,
    lines: body.lines.map((line) => line.variationId
      ? {
          kind: 'catalog',
          variationId: line.variationId,
          locationId: line.locationId ?? null,
          qty: line.qty,
          discountBps: line.discountBps ?? 0,
          discountFixedCents: line.discountFixedCents ?? 0,
        }
      : {
          kind: 'custom',
          description: line.description ?? null,
          qty: line.qty,
          unitPriceCents: line.unitPriceCents ?? null,
          discountBps: line.discountBps ?? 0,
          discountFixedCents: line.discountFixedCents ?? 0,
        }),
    discountBps: body.discountBps ?? 0,
    discountFixedCents: body.discountFixedCents ?? 0,
    taxAssertionBps: body.taxBps ?? null,
    tipCents: body.tipCents ?? 0,
    note: body.note ?? null,
  };
  return createHash('sha256').update(JSON.stringify(facts), 'utf8').digest('hex');
}

async function requireCartReplayMatches(
  db: Kysely<PosReconciliationTables>,
  tenantId: string,
  cartId: string,
  orderId: string,
  factHash: string,
): Promise<void> {
  const fact = await db
    .selectFrom('api_pos_cart_facts')
    .select(['order_id', 'fact_hash'])
    .where('tenant_id', '=', tenantId)
    .where('cart_id', '=', cartId)
    .executeTakeFirst();
  if (!fact) {
    throw ApiError.conflict('this legacy cart cannot be replayed safely; start a new cart');
  }
  if (fact.order_id !== orderId || fact.fact_hash !== factHash) {
    throw ApiError.conflict('cartId is already bound to different checkout facts');
  }
}

function parseTax(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 && value <= 10000 ? value : null;
}

async function readSettings(
  db: Kysely<PosDatabase>,
  tenantId: string,
  envDefaultLocationId?: string,
): Promise<PosSettings> {
  const apiDb = db as unknown as Kysely<ApiDatabase>;
  const [defaultLocationId, rawTax, footer] = await Promise.all([
    resolveDefaultLocationId(apiDb, tenantId, envDefaultLocationId),
    getConfig(apiDb, tenantId, CONFIG_KEYS.posTaxBps),
    getConfig(apiDb, tenantId, CONFIG_KEYS.posReceiptFooter),
  ]);
  const taxBps = parseTax(rawTax);
  return {
    defaultLocationId,
    taxBps,
    taxConfigured: rawTax !== null && taxBps !== null,
    receiptFooter: footer && footer.trim() ? footer.trim() : null,
    currency: 'USD',
  };
}

async function requireOperationalSettings(
  db: Kysely<PosDatabase>,
  tenantId: string,
  envDefaultLocationId?: string,
): Promise<PosSettings & { defaultLocationId: string; taxBps: number }> {
  const settings = await readSettings(db, tenantId, envDefaultLocationId);
  if (!settings.defaultLocationId) {
    throw ApiError.conflict('POS setup required: choose a default inventory location');
  }
  const location = await getLocation(
    db as unknown as Kysely<InventoryDatabase>,
    tenantId,
    settings.defaultLocationId,
  );
  if (location.archived === 1) {
    throw ApiError.conflict('POS setup required: the default inventory location is archived');
  }
  if (!settings.taxConfigured || settings.taxBps === null) {
    throw ApiError.conflict('POS setup required: set the sales tax rate (use 0 for no tax)');
  }
  return { ...settings, defaultLocationId: settings.defaultLocationId, taxBps: settings.taxBps };
}

function providerKeys(providers: readonly CheckoutProvider[]): string[] {
  return [...new Set(providers.map((provider) => provider.key))].sort();
}

const CARD_LIKE_EXTERNAL_SOURCE = /(?:^|[\s_-])(card|credit|debit|visa|mastercard|amex|discover|stripe|square|terminal)(?:$|[\s_-])/i;

function validateExternalTenderSource(provider: string): void {
  if (CARD_LIKE_EXTERNAL_SOURCE.test(provider)) {
    throw ApiError.badRequest(
      'card payments must use the verified card-present provider flow, not an external tender',
    );
  }
}

async function cardPresentState(
  providers: readonly CheckoutProvider[],
  option: PosCardPresentOptions | undefined,
): Promise<{
  enabled: boolean;
  configured: boolean;
  provider: 'stripe_terminal' | null;
  readerId: string | null;
  readerStatus: string | null;
  physicalReaderVerified: boolean;
  checkedAt: string | null;
  code?: string;
}> {
  const providerAvailable = providers.some((provider) => provider.key === 'stripe_terminal');
  const configured = Boolean(
    providerAvailable &&
      option?.provider === 'stripe_terminal' &&
      option.readerId.trim(),
  );
  if (!configured || !option) {
    return {
      enabled: false,
      configured: false,
      provider: null,
      readerId: null,
      readerStatus: null,
      physicalReaderVerified: false,
      checkedAt: null,
    };
  }

  try {
    const verification = await option.verify();
    const verified =
      verification.verified === true &&
      verification.readerId === option.readerId &&
      verification.status === 'online';
    return {
      enabled: verified,
      configured: true,
      provider: 'stripe_terminal',
      readerId: option.readerId,
      readerStatus: verification.status,
      physicalReaderVerified: verified,
      checkedAt: verification.checkedAt,
      ...(verification.code ? { code: verification.code } : {}),
    };
  } catch {
    return {
      enabled: false,
      configured: true,
      provider: 'stripe_terminal',
      readerId: option.readerId,
      readerStatus: null,
      physicalReaderVerified: false,
      checkedAt: new Date().toISOString(),
      code: 'reader_check_failed',
    };
  }
}

async function requireOpenPosCashSession(
  db: Kysely<FinanceDatabase>,
  tenantId: string,
  sessionId: string,
  expected: { locationId?: string | null; registerId?: string | null } = {},
): Promise<void> {
  const session = await getCashSession(db, tenantId, sessionId);
  if (session.status !== 'open') {
    throw ApiError.conflict('the cash drawer session is closed');
  }
  if ((session.expected_mode ?? 'posted') !== 'ledger') {
    throw ApiError.conflict('POS cash requires a ledger-backed drawer session');
  }
  if (expected.locationId && session.location_ref !== expected.locationId) {
    throw ApiError.conflict('the cash drawer session belongs to a different inventory location');
  }
  if (
    Object.prototype.hasOwnProperty.call(expected, 'registerId') &&
    session.register_ref &&
    session.register_ref !== (expected.registerId ?? null)
  ) {
    throw ApiError.conflict('the cash drawer session belongs to a different register');
  }
}

function tenderRowMatches(
  row: Awaited<ReturnType<typeof listTenders>>[number],
  tender: z.infer<typeof manualTenderSchema>,
): boolean {
  const cashReceived = tender.kind === 'cash'
    ? tender.cashReceivedCents ?? tender.amountCents
    : null;
  const changeDue = tender.kind === 'cash'
    ? (cashReceived as number) - tender.amountCents
    : null;
  return (
    row.kind === tender.kind &&
    row.amount_cents === tender.amountCents &&
    row.cash_received_cents === cashReceived &&
    row.change_due_cents === changeDue &&
    row.provider === (tender.provider ?? null) &&
    row.provider_ref === (tender.providerRef ?? null)
  );
}

async function requirePosOrder(
  db: Kysely<OrdersDatabase>,
  apiDb: Kysely<ApiDatabase>,
  tenantId: string,
  orderId: string,
): Promise<NonNullable<Awaited<ReturnType<typeof getOrder>>>> {
  const order = await getOrder(db, tenantId, orderId);
  if (!order) throw ApiError.notFound('order not found');
  if (order.order.channel !== 'pos') {
    throw ApiError.badRequest('the POS facade only accepts register orders');
  }
  const claim = await apiDb
    .selectFrom('api_pos_order_claims')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('order_id', '=', orderId)
    .executeTakeFirst();
  if (!claim) {
    throw ApiError.forbidden('the order did not pass the POS checkout validation facade');
  }
  return order;
}

interface PosStockLine {
  variationId: string;
  locationId: string;
  qty: number;
}

async function trackedStockLines(
  catalogDb: Kysely<CatalogDatabase>,
  tenantId: string,
  lines: Array<{ variation_id: string | null; location_id: string | null; qty: number }>,
): Promise<PosStockLine[]> {
  const grouped = new Map<string, PosStockLine>();
  for (const line of lines) {
    if (!line.variation_id || !line.location_id) continue;
    const variation = await getVariation(catalogDb, tenantId, line.variation_id);
    if (!variation || variation.track_inventory !== 1) continue;
    if (!Number.isSafeInteger(line.qty) || line.qty <= 0) {
      throw ApiError.badRequest('inventory-tracked POS quantities must be positive whole numbers');
    }
    const key = JSON.stringify([line.variation_id, line.location_id]);
    const prior = grouped.get(key);
    if (prior) prior.qty += line.qty;
    else {
      grouped.set(key, {
        variationId: line.variation_id,
        locationId: line.location_id,
        qty: line.qty,
      });
    }
  }
  return [...grouped.values()];
}

async function ensurePosReservations(
  inventoryDb: Kysely<InventoryDatabase>,
  catalogDb: Kysely<CatalogDatabase>,
  events: EventBus,
  tenantId: string,
  actor: string,
  orderId: string,
  lines: Array<{ variation_id: string | null; location_id: string | null; qty: number }>,
): Promise<void> {
  const stock = await trackedStockLines(catalogDb, tenantId, lines);
  try {
    for (const line of stock) {
      await reserve(inventoryDb, events, tenantId, actor, {
        ...line,
        refType: 'order',
        refId: orderId,
      });
    }
  } catch (error) {
    await settleReservationsForReference(
      inventoryDb,
      events,
      tenantId,
      actor,
      'order',
      orderId,
      'released',
    ).catch(() => undefined);
    throw error;
  }
}

async function reconcilePaidPosInventory(
  inventoryDb: Kysely<InventoryDatabase>,
  catalogDb: Kysely<CatalogDatabase>,
  events: EventBus,
  tenantId: string,
  actor: string,
  order: NonNullable<Awaited<ReturnType<typeof getOrder>>>,
): Promise<void> {
  if (order.order.status !== 'paid') return;
  const stock = await trackedStockLines(catalogDb, tenantId, order.lines);
  if (!stock.length) return;
  await sellForOrder(inventoryDb, events, tenantId, actor, {
    orderId: order.order.id,
    lines: stock,
    idempotencyKey: `order-paid:${order.order.id}`,
  });
}

/**
 * Move one POS draft into the reserved state while tolerating an identical
 * concurrent retry. Inventory reservation is replay-safe on the order stock
 * facts; the order transition itself is compare-and-swap guarded.
 */
async function ensureReservedPosOrder(
  ordersDb: Kysely<OrdersDatabase>,
  apiDb: Kysely<ApiDatabase>,
  inventoryDb: Kysely<InventoryDatabase>,
  catalogDb: Kysely<CatalogDatabase>,
  events: EventBus,
  tenantId: string,
  actor: string,
  order: NonNullable<Awaited<ReturnType<typeof getOrder>>>,
): Promise<NonNullable<Awaited<ReturnType<typeof getOrder>>>> {
  if (order.order.status !== 'draft') return order;
  await ensurePosReservations(
    inventoryDb,
    catalogDb,
    events,
    tenantId,
    actor,
    order.order.id,
    order.lines,
  );
  try {
    await reserveOrder({ db: ordersDb, events }, tenantId, actor, order.order.id);
  } catch (error) {
    const raced = await requirePosOrder(ordersDb, apiDb, tenantId, order.order.id);
    if (raced.order.status === 'draft') throw error;
  }
  return requirePosOrder(ordersDb, apiDb, tenantId, order.order.id);
}

/**
 * Claimed register orders must keep the POS refund invariants (original tender,
 * current cash drawer, provider registry). The generic orders endpoint remains
 * available for non-POS orders, but may not be used as a bypass.
 */
export function posClaimedOrderGuard(db: Kysely<ApiDatabase>): MiddlewareHandler {
  return async (c, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
    const match = /^\/api\/orders\/orders\/([^/]+)(?:\/|$)/.exec(c.req.path);
    if (!match) return next();
    const tenantId = c.req.header('x-tenant-id')?.trim();
    if (!tenantId) return next();
    let orderId: string;
    try {
      orderId = decodeURIComponent(match[1]);
    } catch {
      throw ApiError.badRequest('invalid order id');
    }
    const claim = await db
      .selectFrom('api_pos_order_claims')
      .select(['id', 'cart_id'])
      .where('tenant_id', '=', tenantId)
      .where('order_id', '=', orderId)
      .executeTakeFirst();
    if (claim?.cart_id.startsWith('bar:')) throw ApiError.conflict('Bar checks must be changed through the bar POS.');
    if (claim && c.req.method === 'POST' && c.req.path.endsWith('/refunds')) {
      throw ApiError.conflict('claimed POS orders must be refunded through the POS refund endpoint');
    }
    return next();
  };
}

export function posRouter(
  db: Kysely<PosDatabase>,
  events: EventBus,
  options: PosRouterOptions = {},
): Hono<TenantEnv> {
  const providers = options.providers ?? [];
  const providerRegistry = buildProviderRegistry(providers);
  const apiDb = db as unknown as Kysely<ApiDatabase>;
  const cartFactDb = db as unknown as Kysely<PosReconciliationTables>;
  const catalogDb = db as unknown as Kysely<CatalogDatabase>;
  const inventoryDb = db as unknown as Kysely<InventoryDatabase>;
  const ordersDb = db as unknown as Kysely<OrdersDatabase>;
  const customersDb = db as unknown as Kysely<CustomersDatabase>;
  const financeDb = db as unknown as Kysely<FinanceDatabase>;
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(db)));

  const actingUser = async (c: Context, tenantId: string): Promise<string> => {
    const resolved = await options.getActingUser?.(c, tenantId);
    if (resolved) return resolved;
    // Standalone router compatibility for explicit non-browser integrations.
    const header = c.req.header('x-user-id')?.trim();
    if (header) return header;
    throw ApiError.unauthorized('Sign in to the register to continue.');
  };

  app.get('/settings', async (c) => {
    const data = await readSettings(db, c.get('tenantId'), options.envDefaultLocationId);
    return c.json({ data });
  });

  app.put('/settings', async (c) => {
    const tenantId = c.get('tenantId');
    const body = settingsSchema.parse(await c.req.json());
    if (body.defaultLocationId !== undefined) {
      const location = await getLocation(inventoryDb, tenantId, body.defaultLocationId);
      if (location.archived === 1) throw ApiError.conflict('cannot use an archived POS location');
      await setConfig(apiDb, tenantId, CONFIG_KEYS.defaultLocation, location.id);
    }
    if (body.taxBps !== undefined) {
      await setConfig(apiDb, tenantId, CONFIG_KEYS.posTaxBps, String(body.taxBps));
    }
    if (body.receiptFooter !== undefined) {
      await setConfig(apiDb, tenantId, CONFIG_KEYS.posReceiptFooter, body.receiptFooter ?? '');
    }
    return c.json({ data: await readSettings(db, tenantId, options.envDefaultLocationId) });
  });

  app.get('/readiness', async (c) => {
    const tenantId = c.get('tenantId');
    const settings = await readSettings(db, tenantId, options.envDefaultLocationId);
    let locationReady = false;
    if (settings.defaultLocationId) {
      try {
        const location = await getLocation(inventoryDb, tenantId, settings.defaultLocationId);
        locationReady = location.archived === 0;
      } catch {
        locationReady = false;
      }
    }
    const keys = providerKeys(providers);
    const cardPresent = await cardPresentState(providers, options.cardPresent);
    const blockers: Array<{ code: string; message: string; blocking: boolean }> = [];
    if (!locationReady) {
      blockers.push({
        code: 'default_location_required',
        message: 'Choose an active default inventory location.',
        blocking: true,
      });
    }
    if (!settings.taxConfigured) {
      blockers.push({
        code: 'tax_rate_required',
        message: 'Set the sales tax rate explicitly; use 0% where appropriate.',
        blocking: true,
      });
    }
    if (!cardPresent.configured) {
      blockers.push({
        code: 'card_present_not_configured',
        message: 'Stripe Terminal credentials and a reader are not configured. Cash and external tenders remain available.',
        blocking: false,
      });
    } else if (!cardPresent.physicalReaderVerified) {
      blockers.push({
        code: 'card_reader_not_verified',
        message: 'The configured Stripe Terminal reader is not online and verified. Card tender remains disabled.',
        blocking: false,
      });
    }
    const operational = locationReady && settings.taxConfigured;
    return c.json({
      data: {
        ready: operational,
        operational,
        settings,
        providers: keys,
        tenders: {
          cash: { enabled: operational },
          external: { enabled: operational },
          cardPresent: { ...cardPresent, enabled: operational && cardPresent.enabled },
        },
        blockers,
      },
    });
  });

  /**
   * Register lookup with the exact promoted price and location availability the
   * checkout facade will use. The generic catalog lookup remains available for
   * back-office work.
   */
  app.get('/catalog', async (c) => {
    const code = c.req.query('code');
    if (!code) throw ApiError.badRequest('code query param is required');
    const tenantId = c.get('tenantId');
    const settings = await readSettings(db, tenantId, options.envDefaultLocationId);
    const result = await lookupByCode(catalogDb, tenantId, code);
    const matches = [];
    for (const match of result.matches) {
      if (!match.product || match.product.archived === 1 || match.variation.archived === 1) continue;
      const price = await resolvePromotedPrice(catalogDb, tenantId, match.variation.id);
      let stock: { onHand: number; reserved: number; available: number } | null = null;
      if (settings.defaultLocationId) {
        const rows = await getStock(inventoryDb, tenantId, {
          variationId: match.variation.id,
          locationId: settings.defaultLocationId,
        });
        if (rows[0]) {
          stock = {
            onHand: rows[0].onHand,
            reserved: rows[0].reserved,
            available: rows[0].available,
          };
        }
      }
      matches.push({
        variationId: match.variation.id,
        productId: match.product.id,
        name: match.product.name,
        variationName: match.variation.name || null,
        sku: match.variation.sku,
        barcode: match.barcode?.code_raw ?? null,
        trackInventory: match.variation.track_inventory === 1,
        locationId: settings.defaultLocationId,
        basePriceCents: price.baseCents,
        unitPriceCents: price.bestCents,
        promotionId: price.promotionId,
        stock,
      });
    }
    return c.json({ data: { matchType: matches.length ? result.matchType : 'none', matches } });
  });

  /** Inventory levels enriched with the catalog identity a register operator sees. */
  app.get('/stock', async (c) => {
    const tenantId = c.get('tenantId');
    let query = db
      .selectFrom('inventory_stock_levels as stock')
      .leftJoin('catalog_variations as variation', (join) =>
        join
          .onRef('variation.tenant_id', '=', 'stock.tenant_id')
          .onRef('variation.id', '=', 'stock.variation_id'),
      )
      .leftJoin('catalog_products as product', (join) =>
        join
          .onRef('product.tenant_id', '=', 'variation.tenant_id')
          .onRef('product.id', '=', 'variation.product_id'),
      )
      .select([
        'stock.variation_id as variation_id',
        'stock.location_id as location_id',
        'stock.on_hand as on_hand',
        'stock.reserved as reserved',
        'stock.counted_ever as counted_ever',
        'stock.last_movement_at as last_movement_at',
        'variation.name as variation_name',
        'variation.sku as sku',
        'product.name as product_name',
      ])
      .where('stock.tenant_id', '=', tenantId);
    const variationId = c.req.query('variationId')?.trim();
    const locationId = c.req.query('locationId')?.trim();
    if (variationId) query = query.where('stock.variation_id', '=', variationId);
    if (locationId) query = query.where('stock.location_id', '=', locationId);
    const rows = await query
      .orderBy('product.name')
      .orderBy('variation.name')
      .orderBy('stock.variation_id')
      .execute();
    return c.json({
      data: rows.map((row) => {
        const variationName = row.variation_name?.trim() || null;
        const productName = row.product_name?.trim() || null;
        const showVariation = variationName && variationName.toLowerCase() !== 'default';
        return {
          variationId: row.variation_id,
          locationId: row.location_id,
          name: productName
            ? `${productName}${showVariation ? ` — ${variationName}` : ''}`
            : variationName ?? row.variation_id,
          variationName,
          sku: row.sku,
          onHand: row.on_hand,
          reserved: row.reserved,
          available: row.on_hand - row.reserved,
          countedEver: row.counted_ever === 1,
          lastMovementAt: row.last_movement_at,
        };
      }),
    });
  });

  /* A narrow cashier-safe drawer facade; the full finance module stays gated. */
  app.get('/drawer', async (c) => {
    const drawerRef = c.req.query('drawerRef')?.trim();
    if (!drawerRef) throw ApiError.badRequest('drawerRef query param is required');
    const tenantId = c.get('tenantId');
    const sessions = await listCashSessions(financeDb, tenantId, { limit: 200, offset: 0 });
    const session = sessions.find((row) => row.status === 'open' && row.drawer_ref === drawerRef);
    if (!session) return c.json({ data: null });
    const [reconciliation, movements] = await Promise.all([
      cashSessionReconciliation(financeDb, tenantId, session.id),
      listCashMovements(financeDb, tenantId, session.id, { limit: 100, offset: 0 }),
    ]);
    return c.json({ data: { session, reconciliation, movements } });
  });

  app.post('/drawer/open', async (c) => {
    const tenantId = c.get('tenantId');
    const body = openDrawerSchema.parse(await c.req.json());
    const settings = await requireOperationalSettings(db, tenantId, options.envDefaultLocationId);
    const actor = await actingUser(c, tenantId);
    const session = await openCashSession(financeDb, tenantId, actor, {
      locationRef: settings.defaultLocationId,
      drawerRef: body.drawerRef,
      registerRef: body.registerRef,
      expectedMode: 'ledger',
      openedBy: actor,
      openingFloatCents: body.openingFloatCents,
      note: body.note,
    });
    const reconciliation = await cashSessionReconciliation(financeDb, tenantId, session.id);
    return c.json({ data: { session, reconciliation } }, 201);
  });

  app.post('/drawer/:id/movements', async (c) => {
    const tenantId = c.get('tenantId');
    const body = drawerMovementSchema.parse(await c.req.json());
    const actor = await actingUser(c, tenantId);
    const result = await postCashDrawerMovement(financeDb, tenantId, actor, c.req.param('id'), {
      ...body,
      createdBy: actor,
    });
    const reconciliation = await cashSessionReconciliation(financeDb, tenantId, c.req.param('id'));
    return c.json(
      { data: { movement: result.movement, reconciliation }, created: result.created },
      result.created ? 201 : 200,
    );
  });

  app.post('/drawer/:id/close', async (c) => {
    const tenantId = c.get('tenantId');
    const body = closeDrawerSchema.parse(await c.req.json());
    const actor = await actingUser(c, tenantId);
    const session = await closeCashSession(financeDb, events, tenantId, actor, c.req.param('id'), {
      closedBy: actor,
      countedCents: body.countedCents,
      note: body.note,
    });
    const reconciliation = await cashSessionReconciliation(financeDb, tenantId, session.id);
    return c.json({ data: { session, reconciliation } });
  });

  app.post('/orders', async (c) => {
    const tenantId = c.get('tenantId');
    const body = orderSchema.parse(await c.req.json());
    const actor = await actingUser(c, tenantId);
    if (body.cashierId && body.cashierId !== actor) {
      throw ApiError.badRequest('cashierId must match the signed-in register operator');
    }
    const factHash = posCartFactHash(body, actor);
    const settings = await requireOperationalSettings(db, tenantId, options.envDefaultLocationId);
    if (body.taxBps !== undefined && body.taxBps !== settings.taxBps) {
      throw ApiError.conflict('The register tax rate is stale. Refresh POS settings before charging.');
    }

    // Browser retry / offline replay: a cart maps to one durable order.
    const sourceOrderId = 'pos:' + body.cartId;
    const prior = await ordersDb
      .selectFrom('orders_orders')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('source_order_id', '=', sourceOrderId)
      .executeTakeFirst();
    if (prior) {
      const existing = await requirePosOrder(ordersDb, apiDb, tenantId, prior.id);
      await requireCartReplayMatches(cartFactDb, tenantId, body.cartId, prior.id, factHash);
      if (existing.order.status === 'draft') {
        const reserved = await ensureReservedPosOrder(
          ordersDb,
          apiDb,
          inventoryDb,
          catalogDb,
          events,
          tenantId,
          actor,
          existing,
        );
        return c.json({ data: { ...reserved.order, lines: reserved.lines }, created: false });
      }
      return c.json({ data: { ...existing.order, lines: existing.lines }, created: false });
    }

    if (body.cashSessionId) {
      await requireOpenPosCashSession(financeDb, tenantId, body.cashSessionId, {
        locationId: settings.defaultLocationId,
        registerId: body.registerId,
      });
    }

    if (body.customerId) {
      const profile = await getProfile(customersDb, tenantId, body.customerId);
      if (!profile || profile.merged_into) throw ApiError.badRequest('customer profile is missing or merged');
    }

    const resolvedLines: LineInputSvc[] = [];
    for (const line of body.lines) {
      if (!line.variationId) {
        if (!line.description || line.unitPriceCents === undefined) {
          throw ApiError.badRequest('custom POS lines require a description and unitPriceCents');
        }
        resolvedLines.push({
          description: line.description,
          qty: line.qty,
          unitPriceCents: line.unitPriceCents,
          discountBps: line.discountBps,
          discountFixedCents: line.discountFixedCents,
        });
        continue;
      }

      const variation = await getVariation(catalogDb, tenantId, line.variationId);
      if (!variation || variation.archived === 1) throw ApiError.badRequest('catalog variation is unavailable');
      const product = await getProduct(catalogDb, tenantId, variation.product_id);
      if (!product || product.archived === 1) throw ApiError.badRequest('catalog product is unavailable');
      if (variation.track_inventory === 1 && !Number.isSafeInteger(line.qty)) {
        throw ApiError.badRequest('inventory-tracked POS quantities must be whole numbers');
      }
      const locationId = line.locationId ?? settings.defaultLocationId;
      const location = await getLocation(inventoryDb, tenantId, locationId);
      if (location.archived === 1) throw ApiError.badRequest('line inventory location is archived');
      const price = await resolvePromotedPrice(catalogDb, tenantId, variation.id);
      if (price.bestCents === null) {
        throw ApiError.conflict('"' + product.name + '" has no active POS price');
      }
      const variationName = variation.name?.trim();
      resolvedLines.push({
        variationId: variation.id,
        locationId,
        description: variationName ? [product.name, variationName].join(' — ') : product.name,
        qty: line.qty,
        unitPriceCents: price.bestCents,
        discountBps: line.discountBps,
        discountFixedCents: line.discountFixedCents,
      });
    }

    let createdNow = true;
    let result: NonNullable<Awaited<ReturnType<typeof getOrder>>>;
    try {
      result = await db.transaction().execute(async (trx) => {
        const txOrders = trx as unknown as Kysely<OrdersDatabase>;
        const txApi = trx as unknown as Kysely<ApiDatabase>;
        const txCartFacts = trx as unknown as Kysely<PosReconciliationTables>;
        const created = await createOrder(
          { db: txOrders, events },
          tenantId,
          actor,
          {
            channel: 'pos',
            customerId: body.customerId,
            showId: body.showId,
            source: 'mags',
            sourceOrderId,
            registerId: body.registerId,
            deviceId: body.deviceId,
            cashierId: actor,
            cashSessionId: body.cashSessionId,
            lines: resolvedLines,
            discountBps: body.discountBps,
            discountFixedCents: body.discountFixedCents,
            taxBps: settings.taxBps,
            tipCents: body.tipCents,
            note: body.note,
          },
        );
        await txApi
          .insertInto('api_pos_order_claims')
          .values({
            id: created.order.id,
            tenant_id: tenantId,
            order_id: created.order.id,
            cart_id: body.cartId,
            created_at: nowIso(),
          })
          .execute();
        await txCartFacts
          .insertInto('api_pos_cart_facts')
          .values({
            id: created.order.id,
            tenant_id: tenantId,
            cart_id: body.cartId,
            order_id: created.order.id,
            fact_hash: factHash,
            created_at: nowIso(),
          })
          .execute();
        return created;
      });
    } catch (error) {
      // The unique source/cart constraints arbitrate identical concurrent
      // submissions. Once the winner commits, the loser resumes from the same
      // claimed order instead of surfacing an opaque unique-constraint error.
      const winner = await ordersDb
        .selectFrom('orders_orders')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('source_order_id', '=', sourceOrderId)
        .executeTakeFirst();
      if (!winner) throw error;
      result = await requirePosOrder(ordersDb, apiDb, tenantId, winner.id);
      await requireCartReplayMatches(cartFactDb, tenantId, body.cartId, winner.id, factHash);
      createdNow = false;
    }
    const reserved = await ensureReservedPosOrder(
      ordersDb,
      apiDb,
      inventoryDb,
      catalogDb,
      events,
      tenantId,
      actor,
      result,
    );
    return c.json(
      { data: { ...reserved.order, lines: reserved.lines }, created: createdNow },
      createdNow ? 201 : 200,
    );
  });

  /**
   * The only cashier-facing manual payment lane. It validates the complete
   * tender plan before the orders service captures anything and re-checks the
   * physical drawer immediately before a cash sale.
   */
  app.post('/orders/:orderId/pay', async (c) => {
    const tenantId = c.get('tenantId');
    const actor = await actingUser(c, tenantId);
    const body = payOrderSchema.parse(await c.req.json());
    const order = await requirePosOrder(ordersDb, apiDb, tenantId, c.req.param('orderId'));
    const keys = body.tenders.map((tender) => tender.idempotencyKey);
    if (new Set(keys).size !== keys.length) {
      throw ApiError.badRequest('tender idempotency keys must be unique within a payment');
    }
    if (body.tenders.filter((tender) => tender.kind === 'cash').length > 1) {
      throw ApiError.badRequest('a POS payment may include at most one cash tender');
    }
    const requestedTotal = body.tenders.reduce((sum, tender) => sum + tender.amountCents, 0);
    const priorTenders = await listTenders(ordersDb, tenantId, order.order.id);
    const priorCardCents = priorTenders.filter((row) => row.kind === 'provider' && ['captured', 'partially_refunded', 'refunded'].includes(row.status))
      .reduce((sum, row) => sum + row.amount_cents, 0);
    if (requestedTotal + priorCardCents !== order.order.total_cents) {
      throw ApiError.conflict(
        `tender total (${requestedTotal}) does not equal order total (${order.order.total_cents})`,
      );
    }
    for (const tender of body.tenders) {
      if (tender.kind === 'external') validateExternalTenderSource(tender.provider as string);
    }

    const cashTender = body.tenders.find((tender) => tender.kind === 'cash');
    const cashSessionId = cashTender ? order.order.cash_session_id : null;
    if (cashTender && !cashSessionId) {
      throw ApiError.badRequest('this POS order is not attached to a cash drawer session');
    }
    const executePayment = async () => {
      if (cashSessionId) {
        await requireOpenPosCashSession(financeDb, tenantId, cashSessionId, {
          registerId: order.order.register_id,
        });
      }

      const existingTenders = await listTenders(ordersDb, tenantId, order.order.id);
      for (const tender of body.tenders) {
        const existing = existingTenders.find((row) => row.idempotency_key === tender.idempotencyKey);
        if (existing && !tenderRowMatches(existing, tender)) {
          throw ApiError.conflict('a tender idempotency key is bound to different payment facts');
        }
      }
      const unrelatedCaptured = existingTenders.find(
        (row) =>
          ['captured', 'partially_refunded', 'refunded'].includes(row.status) &&
          row.kind !== 'provider' && !keys.includes(row.idempotency_key),
      );
      if (unrelatedCaptured) {
        throw ApiError.conflict('the order already contains a tender outside this payment plan');
      }

      if (order.order.status === 'paid') {
        const replayMatches = body.tenders.every((tender) => {
          const existing = existingTenders.find((row) => row.idempotency_key === tender.idempotencyKey);
          return existing !== undefined && tenderRowMatches(existing, tender);
        });
        if (!replayMatches) {
          throw ApiError.conflict('the paid order does not match this payment replay');
        }
        await reconcilePaidPosInventory(
          inventoryDb,
          catalogDb,
          events,
          tenantId,
          actor,
          order,
        );
        return c.json({ data: { ...order.order, lines: order.lines }, created: false });
      }
      if (order.order.status !== 'draft' && order.order.status !== 'reserved') {
        throw ApiError.conflict(`order cannot be paid from status ${order.order.status}`);
      }

      await payOrder(
        { db: ordersDb, events },
        tenantId,
        actor,
        order.order.id,
        { tenders: body.tenders },
      );
      const paid = await requirePosOrder(ordersDb, apiDb, tenantId, order.order.id);
      await reconcilePaidPosInventory(
        inventoryDb,
        catalogDb,
        events,
        tenantId,
        actor,
        paid,
      );
      return c.json({ data: { ...paid.order, lines: paid.lines }, created: true });
    };
    return cashSessionId
      ? withPosCashSessionLock(tenantId, cashSessionId, executePayment)
      : executePayment();
  });

  app.post('/orders/:orderId/cancel', async (c) => {
    const tenantId = c.get('tenantId');
    const actor = await actingUser(c, tenantId);
    const order = await requirePosOrder(ordersDb, apiDb, tenantId, c.req.param('orderId'));
    if (order.order.status === 'canceled') {
      return c.json({ data: { ...order.order, lines: order.lines }, created: false });
    }
    const canceled = await cancelOrder(
      { db: ordersDb, events },
      tenantId,
      actor,
      order.order.id,
    );
    const refreshed = await requirePosOrder(ordersDb, apiDb, tenantId, canceled.id);
    return c.json({ data: { ...refreshed.order, lines: refreshed.lines }, created: true });
  });

  app.post('/orders/:orderId/cancel-split', async (c) => {
    const tenantId = c.get('tenantId');
    const actor = await actingUser(c, tenantId);
    const order = await requirePosOrder(ordersDb, apiDb, tenantId, c.req.param('orderId'));
    const result = await cancelSplitPayment({ db: ordersDb, events }, providerRegistry,
      tenantId, actor, order.order.id);
    return c.json({ data: result }, result.order.status === 'canceled' ? 200 : 202);
  });

  /** Start one server-driven card-present attempt on the configured reader. */
  app.post('/orders/:orderId/card-payments', async (c) => {
    const tenantId = c.get('tenantId');
    const actor = await actingUser(c, tenantId);
    const body = cardPaymentSchema.parse(await c.req.json());
    await requireOperationalSettings(db, tenantId, options.envDefaultLocationId);
    const order = await requirePosOrder(ordersDb, apiDb, tenantId, c.req.param('orderId'));
    const prior = (await listPaymentAttempts(ordersDb, tenantId, order.order.id)).find(
      (attempt) => attempt.idempotency_key === body.idempotencyKey,
    );
    if (!prior) {
      const card = await cardPresentState(providers, options.cardPresent);
      if (!card.configured || !options.cardPresent) {
        throw new ApiError(503, 'card-present payments are not configured', 'card_present_not_configured');
      }
      if (!card.physicalReaderVerified || !card.enabled) {
        throw ApiError.conflict('the configured card reader is not online and verified');
      }
    }
    if (!options.cardPresent) {
      throw new ApiError(503, 'card-present payments are not configured', 'card_present_not_configured');
    }
    const result = await createPaymentAttempt(
      { db: ordersDb, events },
      providerRegistry,
      tenantId,
      actor,
      order.order.id,
      {
        provider: options.cardPresent.provider,
        readerId: options.cardPresent.readerId,
        idempotencyKey: body.idempotencyKey,
        amountCents: body.amountCents,
      },
    );
    return c.json({ data: result, created: result.created }, result.created ? 201 : 200);
  });

  app.get('/processor', async (c) => c.json({ data: options.processorStatus
    ? await options.processorStatus() : { connected: false, code: 'missing_credentials', readers: [] } }));

  app.get('/orders/:orderId/balance', async (c) => {
    const tenantId = c.get('tenantId');
    const order = await requirePosOrder(ordersDb, apiDb, tenantId, c.req.param('orderId'));
    const tenders = await listTenders(ordersDb, tenantId, order.order.id);
    const capturedCents = tenders.filter((t) => ['captured', 'partially_refunded', 'refunded'].includes(t.status))
      .reduce((sum, t) => sum + t.amount_cents, 0);
    const refundedCents = tenders.reduce((sum, t) => sum + t.refunded_cents, 0);
    const refunds = await listRefunds(ordersDb, tenantId, order.order.id);
    const cancellationStarted = ['draft', 'reserved', 'canceled'].includes(order.order.status) && refunds.length > 0;
    return c.json({ data: { orderId: order.order.id, status: order.order.status,
      totalCents: order.order.total_cents, capturedCents,
      refundedCents, netPaidCents: capturedCents - refundedCents, cancellationStarted,
      remainingCents: order.order.total_cents - capturedCents, tenders } });
  });

  app.get('/orders/:orderId/payment-attempts', async (c) => {
    const tenantId = c.get('tenantId');
    const order = await requirePosOrder(ordersDb, apiDb, tenantId, c.req.param('orderId'));
    const data = await listPaymentAttempts(ordersDb, tenantId, order.order.id);
    return c.json({ data });
  });

  app.get('/payment-attempts/:attemptId', async (c) => {
    const tenantId = c.get('tenantId');
    const actor = await actingUser(c, tenantId);
    const attempt = await getPaymentAttempt(ordersDb, tenantId, c.req.param('attemptId'));
    if (!attempt) throw ApiError.notFound('payment attempt not found');
    const order = await requirePosOrder(ordersDb, apiDb, tenantId, attempt.order_id);
    if (attempt.status === 'succeeded') {
      await reconcilePaidPosInventory(
        inventoryDb,
        catalogDb,
        events,
        tenantId,
        actor,
        order,
      );
    }
    return c.json({ data: attempt });
  });

  app.post('/payment-attempts/:attemptId/cancel', async (c) => {
    const tenantId = c.get('tenantId');
    const actor = await actingUser(c, tenantId);
    const attempt = await getPaymentAttempt(ordersDb, tenantId, c.req.param('attemptId'));
    if (!attempt) throw ApiError.notFound('payment attempt not found');
    await requirePosOrder(ordersDb, apiDb, tenantId, attempt.order_id);
    const data = await cancelPaymentAttempt(
      { db: ordersDb, events },
      providerRegistry,
      tenantId,
      actor,
      attempt.id,
    );
    return c.json({ data });
  });

  /** Refund through the original tender, validating today's drawer for cash. */
  app.post('/orders/:orderId/refunds', async (c) => {
    const tenantId = c.get('tenantId');
    const actor = await actingUser(c, tenantId);
    const body = refundSchema.parse(await c.req.json());
    const order = await requirePosOrder(ordersDb, apiDb, tenantId, c.req.param('orderId'));
    const claim = await apiDb.selectFrom('api_pos_order_claims').select('cart_id')
      .where('tenant_id', '=', tenantId).where('order_id', '=', order.order.id).executeTakeFirst();
    if (!body.lines.length && !claim?.cart_id.startsWith('bar:')) throw ApiError.badRequest('Select at least one returned item.');
    if (claim?.cart_id.startsWith('bar:') && body.lines.some(l => l.disposition !== 'none')) throw ApiError.badRequest('Prepared food and poured drinks are not automatically restocked.');
    const tender = (await listTenders(ordersDb, tenantId, order.order.id)).find(
      (row) => row.id === body.tenderId,
    );
    if (!tender) throw ApiError.badRequest('the refund tender is not on this order');
    if (tender.kind === 'cash') {
      if (!body.cashSessionId) {
        throw ApiError.badRequest('an open cash drawer session is required for a cash refund');
      }
    } else if (body.cashSessionId !== undefined) {
      throw ApiError.badRequest('cashSessionId is only valid for cash refunds');
    }
    const executeRefund = async () => {
      if (tender.kind === 'cash' && body.cashSessionId) {
        const settings = await requireOperationalSettings(db, tenantId, options.envDefaultLocationId);
        await requireOpenPosCashSession(financeDb, tenantId, body.cashSessionId, {
          locationId: settings.defaultLocationId,
        });
      }
      const result = await createRefund(
        { db: ordersDb, events },
        tenantId,
        actor,
        order.order.id,
        body,
        providerRegistry,
      );
      const responseStatus = result.refund.status === 'pending'
        ? 202
        : result.created
          ? 201
          : 200;
      return c.json(
        {
          data: { refund: result.refund, lines: result.lines, order: result.order },
          created: result.created,
        },
        responseStatus,
      );
    };
    return tender.kind === 'cash' && body.cashSessionId
      ? withPosCashSessionLock(tenantId, body.cashSessionId, executeRefund)
      : executeRefund();
  });

  /** One fetchable, printable receipt projection; no browser-side ledger joins. */
  app.get('/receipts/:orderId', async (c) => {
    const tenantId = c.get('tenantId');
    const order = await requirePosOrder(
      ordersDb,
      apiDb,
      tenantId,
      c.req.param('orderId'),
    );
    const [tenders, refunds, returnedLineRows, tenant, settings, cashier] = await Promise.all([
      listTenders(ordersDb, tenantId, order.order.id),
      listRefunds(ordersDb, tenantId, order.order.id),
      ordersDb
        .selectFrom('orders_refund_lines as refund_line')
        .innerJoin('orders_refunds as refund', 'refund.id', 'refund_line.refund_id')
        .select([
          'refund_line.line_id as line_id',
          'refund_line.qty as qty',
          'refund.status as refund_status',
        ])
        .where('refund_line.tenant_id', '=', tenantId)
        .where('refund.order_id', '=', order.order.id)
        .where('refund.status', 'in', ['completed', 'pending'])
        .execute(),
      getTenant(asCoreDb(db), tenantId),
      readSettings(db, tenantId, options.envDefaultLocationId),
      order.order.cashier_id
        ? getUser(asCoreDb(db), tenantId, order.order.cashier_id)
        : Promise.resolve(undefined),
    ]);
    const returnedQtyByLine = new Map<string, number>();
    const pendingReturnQtyByLine = new Map<string, number>();
    for (const row of returnedLineRows) {
      const target = row.refund_status === 'completed'
        ? returnedQtyByLine
        : pendingReturnQtyByLine;
      target.set(row.line_id, (target.get(row.line_id) ?? 0) + row.qty);
    }
    const receiptLines = order.lines.map((line) => {
      const returnedQty = returnedQtyByLine.get(line.id) ?? 0;
      const pendingReturnQty = pendingReturnQtyByLine.get(line.id) ?? 0;
      return {
        ...line,
        returned_qty: returnedQty,
        pending_return_qty: pendingReturnQty,
        returnable_qty: Math.max(0, line.qty - returnedQty - pendingReturnQty),
      };
    });
    const amountPaidCents = tenders
      .filter((tender) => ['captured', 'partially_refunded', 'refunded'].includes(tender.status))
      .reduce((sum, tender) => sum + tender.amount_cents, 0);
    const amountRefundedCents = refunds
      .filter((refund) => refund.status === 'completed')
      .reduce((sum, refund) => sum + refund.amount_cents, 0);
    return c.json({
      data: {
        merchant: {
          name: tenant?.name ?? 'Black Label',
          receiptFooter: settings.receiptFooter,
          currency: settings.currency,
        },
        cashier: order.order.cashier_id
          ? { id: order.order.cashier_id, name: cashier?.name ?? null }
          : null,
        order: { ...order.order, lines: receiptLines },
        tenders,
        refunds,
        amountPaidCents,
        amountRefundedCents,
        netPaidCents: amountPaidCents - amountRefundedCents,
      },
    });
  });

  return app;
}
