import type { Kysely } from 'kysely';
import {
  ApiError,
  asCoreDb,
  audit,
  computeTotals,
  id,
  nowIso,
  type Discount,
  type EventBus,
  type Pagination,
  type Sort,
} from '@blacklabel/core';
import type {
  CheckoutSessionRow,
  FulfillmentKind,
  FulfillmentLineRow,
  FulfillmentRow,
  FulfillmentStatus,
  LineFulfillmentState,
  OrderChannel,
  OrderLineRow,
  OrderRow,
  OrderSource,
  OrderStatus,
  OrdersDatabase,
  RefundLineRow,
  RefundRow,
  RestockDisposition,
  TenderKind,
  TenderRow,
  WebhookEventRow,
} from './schema';
import type { CheckoutProvider } from './providers';

export interface OrdersCtx {
  db: Kysely<OrdersDatabase>;
  events: EventBus;
}

/* ================================================================== *
 * DTOs (boolean/JSON conversion at the service boundary)
 * ================================================================== */

export type OrderDto = Omit<OrderRow, 'sent'> & { sent: boolean };
export type LineDto = Omit<OrderLineRow, 'discount'> & { discount: Discount | null };
export type WebhookEventDto = Omit<WebhookEventRow, 'signature_valid' | 'processed'> & {
  signature_valid: boolean;
  processed: boolean;
};

function toOrderDto(row: OrderRow): OrderDto {
  return { ...row, sent: row.sent === 1 };
}
function toLineDto(row: OrderLineRow): LineDto {
  return { ...row, discount: parseDiscount(row.discount) };
}
function toWebhookDto(row: WebhookEventRow): WebhookEventDto {
  return { ...row, signature_valid: row.signature_valid === 1, processed: row.processed === 1 };
}

export interface OrderWithLines {
  order: OrderDto;
  lines: LineDto[];
}

/* ================================================================== *
 * Money helpers — all math goes through core computeTotals.
 * ================================================================== */

function toDiscount(bps?: number | null, fixedCents?: number | null): Discount | undefined {
  const hasBps = bps !== null && bps !== undefined;
  const hasFixed = fixedCents !== null && fixedCents !== undefined;
  if (!hasBps && !hasFixed) return undefined;
  const out: Discount = {};
  if (hasBps) out.bps = bps as number;
  if (hasFixed) out.fixedCents = fixedCents as number;
  return out;
}

function parseDiscount(json: string | null): Discount | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as Discount;
  } catch {
    return null;
  }
}

function discountToJson(d: Discount | undefined): string | null {
  return d === undefined ? null : JSON.stringify(d);
}

/* ================================================================== *
 * State machine
 * ================================================================== */

export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  draft: ['reserved', 'paid', 'canceled'],
  reserved: ['paid', 'canceled'],
  paid: ['partially_fulfilled', 'fulfilled', 'partially_returned', 'returned'],
  partially_fulfilled: ['fulfilled', 'partially_fulfilled', 'partially_returned', 'returned'],
  fulfilled: ['partially_returned', 'returned'],
  partially_returned: ['partially_returned', 'returned', 'partially_fulfilled', 'fulfilled'],
  returned: [],
  canceled: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

const FULFILLMENT_TRANSITIONS: Record<FulfillmentStatus, FulfillmentStatus[]> = {
  pending: ['picking', 'packed', 'ready', 'shipped', 'picked_up', 'canceled'],
  picking: ['packed', 'ready', 'shipped', 'picked_up', 'canceled'],
  packed: ['ready', 'shipped', 'picked_up', 'canceled'],
  ready: ['shipped', 'delivered', 'picked_up', 'canceled'],
  shipped: ['delivered', 'canceled'],
  delivered: [],
  picked_up: [],
  canceled: [],
};

/** Fulfillment statuses that count a fulfillment's lines as fulfilled. */
const FULFILLMENT_COMPLETING: readonly FulfillmentStatus[] = ['shipped', 'delivered', 'picked_up'];

/* ================================================================== *
 * Row loaders (all tenant-scoped)
 * ================================================================== */

export async function getOrderRow(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  orderId: string,
): Promise<OrderRow | undefined> {
  return db
    .selectFrom('orders_orders')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', orderId)
    .executeTakeFirst();
}

async function getLineRows(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  orderId: string,
): Promise<OrderLineRow[]> {
  return db
    .selectFrom('orders_lines')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('order_id', '=', orderId)
    .orderBy('position')
    .orderBy('id')
    .execute();
}

export async function getOrder(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  orderId: string,
): Promise<OrderWithLines | undefined> {
  const order = await getOrderRow(db, tenantId, orderId);
  if (!order) return undefined;
  const lines = await getLineRows(db, tenantId, orderId);
  return { order: toOrderDto(order), lines: lines.map(toLineDto) };
}

async function requireOrder(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  orderId: string,
): Promise<OrderRow> {
  const order = await getOrderRow(db, tenantId, orderId);
  if (!order) throw ApiError.notFound(`order not found: ${orderId}`);
  return order;
}

/** Stock-effect payload: only variation-backed lines contribute to inventory. */
function stockLines(lines: OrderLineRow[]): { variationId: string; qty: number; locationId?: string }[] {
  return lines
    .filter((l) => l.variation_id !== null && l.fulfillment_state !== 'canceled')
    .map((l) => ({
      variationId: l.variation_id as string,
      qty: l.qty,
      ...(l.location_id ? { locationId: l.location_id } : {}),
    }));
}

/* ================================================================== *
 * Totals recompute
 * ================================================================== */

async function recomputeTotals(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  order: OrderRow,
): Promise<OrderRow> {
  const lines = await getLineRows(db, tenantId, order.id);
  const totals = computeTotals(
    lines.map((l) => ({
      quantity: l.qty,
      unitPriceCents: l.unit_price_cents,
      discount: parseDiscount(l.discount) ?? undefined,
    })),
    {
      discount: toDiscount(order.discount_bps, order.discount_fixed_cents),
      taxBps: order.tax_bps ?? undefined,
    },
  );
  const now = nowIso();
  // Persist stored per-line totals so they always agree with the header.
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].line_total_cents !== totals.lineTotalsCents[i]) {
      await db
        .updateTable('orders_lines')
        .set({ line_total_cents: totals.lineTotalsCents[i], updated_at: now })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', lines[i].id)
        .execute();
    }
  }
  await db
    .updateTable('orders_orders')
    .set({
      subtotal_cents: totals.subtotalCents,
      discount_cents: totals.discountCents,
      tax_cents: totals.taxCents,
      total_cents: totals.totalCents,
      updated_at: now,
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', order.id)
    .execute();
  return {
    ...order,
    subtotal_cents: totals.subtotalCents,
    discount_cents: totals.discountCents,
    tax_cents: totals.taxCents,
    total_cents: totals.totalCents,
    updated_at: now,
  };
}

/* ================================================================== *
 * Create / read / update / delete
 * ================================================================== */

export interface LineInputSvc {
  variationId?: string;
  locationId?: string;
  description: string;
  qty: number;
  unitPriceCents: number;
  discountBps?: number;
  discountFixedCents?: number;
}

export interface CreateOrderInputSvc {
  channel: OrderChannel;
  customerId?: string;
  showId?: string;
  source?: OrderSource;
  sourceOrderId?: string;
  lines?: LineInputSvc[];
  discountBps?: number;
  discountFixedCents?: number;
  taxBps?: number;
  note?: string;
}

export async function createOrder(
  ctx: OrdersCtx,
  tenantId: string,
  actor: string,
  input: CreateOrderInputSvc,
): Promise<OrderWithLines> {
  if (input.sourceOrderId) {
    const dupe = await ctx.db
      .selectFrom('orders_orders')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('source_order_id', '=', input.sourceOrderId)
      .executeTakeFirst();
    if (dupe) {
      throw ApiError.conflict(`order already exists for source_order_id: ${input.sourceOrderId}`);
    }
  }
  const lineInputs = input.lines ?? [];
  const totals = computeTotals(
    lineInputs.map((l) => ({
      quantity: l.qty,
      unitPriceCents: l.unitPriceCents,
      discount: toDiscount(l.discountBps, l.discountFixedCents),
    })),
    {
      discount: toDiscount(input.discountBps, input.discountFixedCents),
      taxBps: input.taxBps,
    },
  );

  const now = nowIso();
  const order: OrderRow = {
    id: id(),
    tenant_id: tenantId,
    channel: input.channel,
    status: 'draft',
    customer_id: input.customerId ?? null,
    show_id: input.showId ?? null,
    source: input.source ?? 'mags',
    source_order_id: input.sourceOrderId ?? null,
    discount_bps: input.discountBps ?? null,
    discount_fixed_cents: input.discountFixedCents ?? null,
    tax_bps: input.taxBps ?? null,
    subtotal_cents: totals.subtotalCents,
    discount_cents: totals.discountCents,
    tax_cents: totals.taxCents,
    total_cents: totals.totalCents,
    note: input.note ?? null,
    sent: 0,
    sent_at: null,
    reserved_at: null,
    paid_at: null,
    fulfilled_at: null,
    canceled_at: null,
    created_at: now,
    updated_at: now,
  };
  await ctx.db.insertInto('orders_orders').values(order).execute();

  const lines: OrderLineRow[] = lineInputs.map((l, position) => ({
    id: id(),
    tenant_id: tenantId,
    order_id: order.id,
    position,
    variation_id: l.variationId ?? null,
    location_id: l.locationId ?? null,
    description: l.description,
    qty: l.qty,
    unit_price_cents: l.unitPriceCents,
    discount: discountToJson(toDiscount(l.discountBps, l.discountFixedCents)),
    line_total_cents: totals.lineTotalsCents[position],
    fulfillment_state: 'pending',
    created_at: now,
    updated_at: now,
  }));
  for (const line of lines) {
    await ctx.db.insertInto('orders_lines').values(line).execute();
  }

  await audit(asCoreDb(ctx.db), tenantId, actor, 'orders.order.created', 'orders.order', order.id, {
    channel: order.channel,
    totalCents: order.total_cents,
  });
  return { order: toOrderDto(order), lines: lines.map(toLineDto) };
}

export interface ListOrdersFilters {
  status?: string;
  channel?: string;
  customer_id?: string;
  show_id?: string;
  source?: string;
}

export async function listOrders(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
  filters: ListOrdersFilters = {},
  sort?: Sort,
): Promise<OrderDto[]> {
  let query = db.selectFrom('orders_orders').selectAll().where('tenant_id', '=', tenantId);
  if (filters.status !== undefined) query = query.where('status', '=', filters.status as OrderStatus);
  if (filters.channel !== undefined) query = query.where('channel', '=', filters.channel as OrderChannel);
  if (filters.customer_id !== undefined) query = query.where('customer_id', '=', filters.customer_id);
  if (filters.show_id !== undefined) query = query.where('show_id', '=', filters.show_id);
  if (filters.source !== undefined) query = query.where('source', '=', filters.source as OrderSource);
  const effectiveSort: Sort = sort ?? { column: 'created_at', direction: 'asc' };
  const rows = await query
    .orderBy(effectiveSort.column as 'created_at', effectiveSort.direction)
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
  return rows.map(toOrderDto);
}

export interface UpdateOrderInputSvc {
  customerId?: string | null;
  showId?: string | null;
  note?: string | null;
  discountBps?: number | null;
  discountFixedCents?: number | null;
  taxBps?: number | null;
  lines?: LineInputSvc[];
}

/** Edit a DRAFT order (409 otherwise). Passing `lines` replaces them all. */
export async function updateOrder(
  ctx: OrdersCtx,
  tenantId: string,
  actor: string,
  orderId: string,
  patch: UpdateOrderInputSvc,
): Promise<OrderWithLines> {
  const existing = await requireOrder(ctx.db, tenantId, orderId);
  if (existing.status !== 'draft') {
    throw ApiError.conflict(`only draft orders can be edited (status: ${existing.status})`);
  }
  const now = nowIso();
  await ctx.db
    .updateTable('orders_orders')
    .set({
      customer_id: patch.customerId !== undefined ? patch.customerId : existing.customer_id,
      show_id: patch.showId !== undefined ? patch.showId : existing.show_id,
      note: patch.note !== undefined ? patch.note : existing.note,
      discount_bps: patch.discountBps !== undefined ? patch.discountBps : existing.discount_bps,
      discount_fixed_cents:
        patch.discountFixedCents !== undefined ? patch.discountFixedCents : existing.discount_fixed_cents,
      tax_bps: patch.taxBps !== undefined ? patch.taxBps : existing.tax_bps,
      updated_at: now,
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', orderId)
    .execute();

  if (patch.lines !== undefined) {
    await ctx.db
      .deleteFrom('orders_lines')
      .where('tenant_id', '=', tenantId)
      .where('order_id', '=', orderId)
      .execute();
    for (const [position, l] of patch.lines.entries()) {
      const line: OrderLineRow = {
        id: id(),
        tenant_id: tenantId,
        order_id: orderId,
        position,
        variation_id: l.variationId ?? null,
        location_id: l.locationId ?? null,
        description: l.description,
        qty: l.qty,
        unit_price_cents: l.unitPriceCents,
        discount: discountToJson(toDiscount(l.discountBps, l.discountFixedCents)),
        line_total_cents: 0,
        fulfillment_state: 'pending',
        created_at: now,
        updated_at: now,
      };
      await ctx.db.insertInto('orders_lines').values(line).execute();
    }
  }

  const reloaded = await requireOrder(ctx.db, tenantId, orderId);
  await recomputeTotals(ctx.db, tenantId, reloaded);
  await audit(asCoreDb(ctx.db), tenantId, actor, 'orders.order.updated', 'orders.order', orderId, {});
  const result = await getOrder(ctx.db, tenantId, orderId);
  if (!result) throw ApiError.notFound(`order not found: ${orderId}`);
  return result;
}

/** Delete a DRAFT order (409 otherwise). Paid orders are refunded, never deleted. */
export async function deleteOrder(
  ctx: OrdersCtx,
  tenantId: string,
  actor: string,
  orderId: string,
): Promise<void> {
  const existing = await requireOrder(ctx.db, tenantId, orderId);
  if (existing.status !== 'draft') {
    throw ApiError.conflict(`only draft orders can be deleted (status: ${existing.status})`);
  }
  await ctx.db.deleteFrom('orders_lines').where('tenant_id', '=', tenantId).where('order_id', '=', orderId).execute();
  await ctx.db.deleteFrom('orders_orders').where('tenant_id', '=', tenantId).where('id', '=', orderId).execute();
  await audit(asCoreDb(ctx.db), tenantId, actor, 'orders.order.deleted', 'orders.order', orderId, {});
}

/** Invoice/quote lane: flag a draft order as "sent" to the customer. */
export async function markOrderSent(
  ctx: OrdersCtx,
  tenantId: string,
  actor: string,
  orderId: string,
): Promise<OrderDto> {
  const existing = await requireOrder(ctx.db, tenantId, orderId);
  if (existing.status !== 'draft') {
    throw ApiError.conflict(`only draft orders can be sent (status: ${existing.status})`);
  }
  const now = nowIso();
  await ctx.db
    .updateTable('orders_orders')
    .set({ sent: 1, sent_at: now, updated_at: now })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', orderId)
    .execute();
  await audit(asCoreDb(ctx.db), tenantId, actor, 'orders.order.sent', 'orders.order', orderId, {});
  return toOrderDto({ ...existing, sent: 1, sent_at: now, updated_at: now });
}

/* ================================================================== *
 * Transitions: reserve / cancel / (pay is below with tenders)
 * ================================================================== */

async function setStatus(
  ctx: OrdersCtx,
  order: OrderRow,
  to: OrderStatus,
  extra: Partial<OrderRow> = {},
): Promise<OrderRow> {
  if (order.status !== to && !canTransition(order.status, to)) {
    throw ApiError.conflict(`illegal order transition: ${order.status} -> ${to}`);
  }
  const now = nowIso();
  const patch: Partial<OrderRow> = { status: to, updated_at: now, ...extra };
  await ctx.db
    .updateTable('orders_orders')
    .set(patch)
    .where('tenant_id', '=', order.tenant_id)
    .where('id', '=', order.id)
    .execute();
  return { ...order, ...patch } as OrderRow;
}

export async function reserveOrder(
  ctx: OrdersCtx,
  tenantId: string,
  actor: string,
  orderId: string,
): Promise<OrderDto> {
  const order = await requireOrder(ctx.db, tenantId, orderId);
  if (order.status !== 'draft') {
    throw ApiError.conflict(`only draft orders can be reserved (status: ${order.status})`);
  }
  const next = await setStatus(ctx, order, 'reserved', { reserved_at: nowIso() });
  const lines = await getLineRows(ctx.db, tenantId, orderId);
  await audit(asCoreDb(ctx.db), tenantId, actor, 'orders.order.reserved', 'orders.order', orderId, {});
  await ctx.events.emit(tenantId, 'orders.order.reserved', {
    v: 1,
    orderId,
    lines: stockLines(lines),
  });
  return toOrderDto(next);
}

export async function cancelOrder(
  ctx: OrdersCtx,
  tenantId: string,
  actor: string,
  orderId: string,
): Promise<OrderDto> {
  const order = await requireOrder(ctx.db, tenantId, orderId);
  if (order.status !== 'draft' && order.status !== 'reserved') {
    throw ApiError.conflict(`only draft/reserved orders can be canceled (status: ${order.status})`);
  }
  const next = await setStatus(ctx, order, 'canceled', { canceled_at: nowIso() });
  await audit(asCoreDb(ctx.db), tenantId, actor, 'orders.order.canceled', 'orders.order', orderId, {});
  await ctx.events.emit(tenantId, 'orders.order.canceled', { v: 1, orderId });
  return toOrderDto(next);
}

/* ================================================================== *
 * Tenders (idempotent)
 * ================================================================== */

export interface AddTenderInputSvc {
  kind: TenderKind;
  amountCents: number;
  idempotencyKey: string;
  provider?: string;
  providerRef?: string;
}

/** Add a captured tender. Idempotent on (tenant, idempotencyKey): a repeat call returns the existing tender. */
export async function addTender(
  ctx: OrdersCtx,
  tenantId: string,
  actor: string,
  orderId: string,
  input: AddTenderInputSvc,
): Promise<{ tender: TenderRow; created: boolean }> {
  const order = await requireOrder(ctx.db, tenantId, orderId);
  if (order.status === 'canceled' || order.status === 'returned') {
    throw ApiError.conflict(`cannot tender against a ${order.status} order`);
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw ApiError.badRequest('amountCents must be a positive integer');
  }
  const existing = await ctx.db
    .selectFrom('orders_tenders')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst();
  if (existing) return { tender: existing, created: false };

  const now = nowIso();
  const tender: TenderRow = {
    id: id(),
    tenant_id: tenantId,
    order_id: orderId,
    kind: input.kind,
    amount_cents: input.amountCents,
    provider: input.provider ?? null,
    provider_ref: input.providerRef ?? null,
    status: 'captured',
    refunded_cents: 0,
    idempotency_key: input.idempotencyKey,
    created_at: now,
    updated_at: now,
  };
  await ctx.db.insertInto('orders_tenders').values(tender).execute();
  await audit(asCoreDb(ctx.db), tenantId, actor, 'orders.tender.captured', 'orders.tender', tender.id, {
    orderId,
    amountCents: tender.amount_cents,
    kind: tender.kind,
  });
  return { tender, created: true };
}

export async function listTenders(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  orderId: string,
): Promise<TenderRow[]> {
  return db
    .selectFrom('orders_tenders')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('order_id', '=', orderId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

async function capturedTotal(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  orderId: string,
): Promise<number> {
  const tenders = await db
    .selectFrom('orders_tenders')
    .select(['amount_cents'])
    .where('tenant_id', '=', tenantId)
    .where('order_id', '=', orderId)
    .where('status', 'in', ['captured', 'partially_refunded', 'refunded'])
    .execute();
  return tenders.reduce((sum, t) => sum + t.amount_cents, 0);
}

/**
 * Mark an unpaid order paid. Enforces sum(captured tenders) == total_cents.
 * Emits orders.order.paid exactly once (the guard rejects already-paid orders).
 */
async function markPaid(ctx: OrdersCtx, order: OrderRow, actor: string): Promise<OrderRow> {
  const captured = await capturedTotal(ctx.db, order.tenant_id, order.id);
  if (captured !== order.total_cents) {
    throw ApiError.conflict(
      `captured tenders (${captured}) do not equal order total (${order.total_cents})`,
    );
  }
  const next = await setStatus(ctx, order, 'paid', { paid_at: nowIso() });
  const lines = await getLineRows(ctx.db, order.tenant_id, order.id);
  await audit(asCoreDb(ctx.db), order.tenant_id, actor, 'orders.order.paid', 'orders.order', order.id, {
    totalCents: order.total_cents,
  });
  await ctx.events.emit(order.tenant_id, 'orders.order.paid', {
    v: 1,
    orderId: order.id,
    totalCents: order.total_cents,
    lines: stockLines(lines),
  });
  return next;
}

export interface PayManualInputSvc {
  /** Optional tenders to capture before flipping to paid (cash/external lane). */
  tenders?: AddTenderInputSvc[];
}

/** pay-manual: capture any provided tenders, then require sum(captured) == total and flip to paid. */
export async function payOrder(
  ctx: OrdersCtx,
  tenantId: string,
  actor: string,
  orderId: string,
  input: PayManualInputSvc = {},
): Promise<OrderDto> {
  const order = await requireOrder(ctx.db, tenantId, orderId);
  if (order.status !== 'draft' && order.status !== 'reserved') {
    throw ApiError.conflict(`only draft/reserved orders can be paid (status: ${order.status})`);
  }
  for (const t of input.tenders ?? []) {
    await addTender(ctx, tenantId, actor, orderId, t);
  }
  const next = await markPaid(ctx, order, actor);
  return toOrderDto(next);
}

/* ================================================================== *
 * Checkout sessions + provider webhooks
 * ================================================================== */

export type ProviderRegistry = ReadonlyMap<string, CheckoutProvider>;

export function buildProviderRegistry(providers: readonly CheckoutProvider[]): ProviderRegistry {
  return new Map(providers.map((p) => [p.key, p]));
}

function requireProvider(providers: ProviderRegistry, key: string): CheckoutProvider {
  const provider = providers.get(key);
  if (!provider) {
    throw new ApiError(501, `checkout provider not configured: ${key}`, 'provider_not_configured', {
      available: [...providers.keys()],
    });
  }
  return provider;
}

export interface CreateCheckoutResult {
  session: CheckoutSessionRow;
  redirectUrl: string;
}

export async function createCheckoutSession(
  ctx: OrdersCtx,
  providers: ProviderRegistry,
  tenantId: string,
  actor: string,
  orderId: string,
  providerKey: string,
  returnUrl?: string,
): Promise<CreateCheckoutResult> {
  const provider = requireProvider(providers, providerKey);
  const order = await requireOrder(ctx.db, tenantId, orderId);
  if (order.status !== 'draft' && order.status !== 'reserved') {
    throw ApiError.conflict(`checkout requires an unpaid order (status: ${order.status})`);
  }
  const lines = await getLineRows(ctx.db, tenantId, orderId);
  const created = await provider.createSession({
    tenantId,
    orderId,
    amountCents: order.total_cents,
    returnUrl,
    lineItems: lines.map((l) => ({
      description: l.description,
      qty: l.qty,
      unitPriceCents: l.unit_price_cents,
    })),
  });
  const now = nowIso();
  const session: CheckoutSessionRow = {
    id: id(),
    tenant_id: tenantId,
    order_id: orderId,
    provider: provider.key,
    provider_session_ref: created.providerSessionRef,
    status: 'created',
    amount_cents: order.total_cents,
    return_url: returnUrl ?? null,
    created_at: now,
    completed_at: null,
  };
  await ctx.db.insertInto('orders_checkout_sessions').values(session).execute();
  await audit(
    asCoreDb(ctx.db),
    tenantId,
    actor,
    'orders.checkout_session.created',
    'orders.checkout_session',
    session.id,
    { orderId, provider: provider.key },
  );
  return { session, redirectUrl: created.redirectUrl };
}

export type WebhookOutcome =
  | 'paid'
  | 'amount_mismatch'
  | 'invalid_signature'
  | 'unknown_session'
  | 'duplicate'
  | 'ignored';

export interface ProcessWebhookResult {
  event: WebhookEventDto;
  outcome: WebhookOutcome;
  orderId?: string;
}

/**
 * Process a raw provider callback. Order of operations (journey 8 semantics):
 *   signature verify -> record orders_webhook_events (dup event_ref -> no-op,
 *   returns prior outcome) -> amount reconciliation vs the checkout session
 *   (mismatch -> outcome amount_mismatch, order NOT paid, emits
 *   orders.payment.mismatched) -> on match: capture tender + mark order paid.
 */
export async function processWebhook(
  ctx: OrdersCtx,
  providers: ProviderRegistry,
  tenantId: string,
  providerKey: string,
  headers: Record<string, string | undefined>,
  rawBody: string,
): Promise<ProcessWebhookResult> {
  const provider = requireProvider(providers, providerKey);
  const verified = await provider.verifyWebhook(headers, rawBody);
  const eventRef = verified.event.id;

  // Replay-safe: a duplicate event_ref returns the prior outcome, no side effects.
  const prior = await ctx.db
    .selectFrom('orders_webhook_events')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('event_ref', '=', eventRef)
    .executeTakeFirst();
  if (prior) {
    return {
      event: toWebhookDto(prior),
      outcome: (prior.outcome ? (JSON.parse(prior.outcome) as { outcome: WebhookOutcome }).outcome : 'duplicate'),
    };
  }

  const now = nowIso();
  const record = async (
    signatureValid: boolean,
    processed: boolean,
    outcome: WebhookOutcome,
    orderId?: string,
  ): Promise<ProcessWebhookResult> => {
    const row: WebhookEventRow = {
      id: id(),
      tenant_id: tenantId,
      provider: providerKey,
      event_ref: eventRef,
      signature_valid: signatureValid ? 1 : 0,
      payload: rawBody,
      processed: processed ? 1 : 0,
      outcome: JSON.stringify({ outcome, orderId }),
      created_at: now,
    };
    await ctx.db.insertInto('orders_webhook_events').values(row).execute();
    await audit(
      asCoreDb(ctx.db),
      tenantId,
      'system',
      'orders.webhook_event.received',
      'orders.webhook_event',
      row.id,
      { provider: providerKey, outcome, signatureValid },
    );
    return { event: toWebhookDto(row), outcome, orderId };
  };

  if (!verified.valid) {
    return record(false, false, 'invalid_signature');
  }

  let completion;
  try {
    completion = provider.parseCompletion(verified.event);
  } catch {
    return record(true, false, 'ignored');
  }

  const session = await ctx.db
    .selectFrom('orders_checkout_sessions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('provider_session_ref', '=', completion.providerSessionRef)
    .executeTakeFirst();
  if (!session) {
    return record(true, false, 'unknown_session');
  }

  const order = await getOrderRow(ctx.db, tenantId, session.order_id);
  if (!order) {
    return record(true, false, 'unknown_session', session.order_id);
  }

  // Reconcile the provider amount against the internal expected (session == order total).
  if (completion.amountCents !== session.amount_cents) {
    await ctx.events.emit(tenantId, 'orders.payment.mismatched', {
      v: 1,
      orderId: order.id,
      sessionId: session.id,
      expectedCents: session.amount_cents,
      receivedCents: completion.amountCents,
    });
    return record(true, true, 'amount_mismatch', order.id);
  }

  // Match: capture provider tender (idempotent on tenderRef), complete session, mark paid.
  await addTender(ctx, tenantId, 'system', order.id, {
    kind: 'provider',
    amountCents: completion.amountCents,
    idempotencyKey: `${providerKey}:${completion.tenderRef}`,
    provider: providerKey,
    providerRef: completion.tenderRef,
  });
  await ctx.db
    .updateTable('orders_checkout_sessions')
    .set({ status: 'completed', completed_at: now })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', session.id)
    .execute();
  if (order.status === 'draft' || order.status === 'reserved') {
    await markPaid(ctx, order, 'system');
  }
  return record(true, true, 'paid', order.id);
}

export async function listWebhookEvents(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
): Promise<WebhookEventDto[]> {
  const rows = await db
    .selectFrom('orders_webhook_events')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
  return rows.map(toWebhookDto);
}

/* ================================================================== *
 * Fulfillments (partial supported) + rollup
 * ================================================================== */

export interface FulfillmentLineInputSvc {
  lineId: string;
  qty: number;
}

export interface CreateFulfillmentInputSvc {
  kind: FulfillmentKind;
  address?: Record<string, unknown>;
  tracking?: string;
  lines: FulfillmentLineInputSvc[];
}

/** How much of a line has already been committed to non-canceled fulfillments. */
async function fulfilledQtyByLine(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  orderId: string,
  onlyCompleting: boolean,
): Promise<Map<string, number>> {
  const rows = await db
    .selectFrom('orders_fulfillment_lines as fl')
    .innerJoin('orders_fulfillments as f', 'f.id', 'fl.fulfillment_id')
    .select(['fl.line_id as line_id', 'fl.qty as qty', 'f.status as status'])
    .where('fl.tenant_id', '=', tenantId)
    .where('f.order_id', '=', orderId)
    .execute();
  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.status === 'canceled') continue;
    if (onlyCompleting && !FULFILLMENT_COMPLETING.includes(r.status as FulfillmentStatus)) continue;
    map.set(r.line_id, (map.get(r.line_id) ?? 0) + r.qty);
  }
  return map;
}

export async function createFulfillment(
  ctx: OrdersCtx,
  tenantId: string,
  actor: string,
  orderId: string,
  input: CreateFulfillmentInputSvc,
): Promise<{ fulfillment: FulfillmentRow; lines: FulfillmentLineRow[] }> {
  const order = await requireOrder(ctx.db, tenantId, orderId);
  if (!['paid', 'partially_fulfilled', 'partially_returned'].includes(order.status)) {
    throw ApiError.conflict(`order is not fulfillable (status: ${order.status})`);
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw ApiError.badRequest('a fulfillment needs at least one line');
  }
  const orderLines = await getLineRows(ctx.db, tenantId, orderId);
  const byId = new Map(orderLines.map((l) => [l.id, l]));
  // committed = anything not canceled (a line already assigned to another open fulfillment).
  const committed = await fulfilledQtyByLine(ctx.db, tenantId, orderId, false);
  for (const fl of input.lines) {
    const line = byId.get(fl.lineId);
    if (!line) throw ApiError.badRequest(`line not on this order: ${fl.lineId}`);
    if (!Number.isFinite(fl.qty) || fl.qty <= 0) throw ApiError.badRequest('fulfillment qty must be positive');
    const outstanding = line.qty - (committed.get(fl.lineId) ?? 0);
    if (fl.qty > outstanding) {
      throw ApiError.conflict(`fulfillment qty ${fl.qty} exceeds outstanding ${outstanding} for line ${fl.lineId}`);
    }
  }

  const now = nowIso();
  const fulfillment: FulfillmentRow = {
    id: id(),
    tenant_id: tenantId,
    order_id: orderId,
    kind: input.kind,
    status: 'pending',
    address: input.address ? JSON.stringify(input.address) : null,
    tracking: input.tracking ?? null,
    staged_at: null,
    shipped_at: null,
    completed_at: null,
    created_at: now,
    updated_at: now,
  };
  await ctx.db.insertInto('orders_fulfillments').values(fulfillment).execute();
  const lines: FulfillmentLineRow[] = input.lines.map((fl) => ({
    id: id(),
    tenant_id: tenantId,
    fulfillment_id: fulfillment.id,
    line_id: fl.lineId,
    qty: fl.qty,
    created_at: now,
  }));
  for (const line of lines) {
    await ctx.db.insertInto('orders_fulfillment_lines').values(line).execute();
  }
  await audit(
    asCoreDb(ctx.db),
    tenantId,
    actor,
    'orders.fulfillment.created',
    'orders.fulfillment',
    fulfillment.id,
    { orderId, kind: fulfillment.kind },
  );
  return { fulfillment, lines };
}

export async function getFulfillmentRow(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  fulfillmentId: string,
): Promise<FulfillmentRow | undefined> {
  return db
    .selectFrom('orders_fulfillments')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', fulfillmentId)
    .executeTakeFirst();
}

export async function listFulfillments(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  orderId: string,
): Promise<FulfillmentRow[]> {
  return db
    .selectFrom('orders_fulfillments')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('order_id', '=', orderId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

/** Advance a fulfillment through its lifecycle; recompute the order rollup when it completes. */
export async function advanceFulfillment(
  ctx: OrdersCtx,
  tenantId: string,
  actor: string,
  fulfillmentId: string,
  to: FulfillmentStatus,
  tracking?: string,
): Promise<FulfillmentRow> {
  const f = await getFulfillmentRow(ctx.db, tenantId, fulfillmentId);
  if (!f) throw ApiError.notFound(`fulfillment not found: ${fulfillmentId}`);
  if (f.status !== to && !FULFILLMENT_TRANSITIONS[f.status].includes(to)) {
    throw ApiError.conflict(`illegal fulfillment transition: ${f.status} -> ${to}`);
  }
  const now = nowIso();
  const patch: Partial<FulfillmentRow> = { status: to, updated_at: now };
  if (to === 'packed' && !f.staged_at) patch.staged_at = now;
  if (to === 'shipped' && !f.shipped_at) patch.shipped_at = now;
  if ((to === 'delivered' || to === 'picked_up') && !f.completed_at) patch.completed_at = now;
  if (tracking !== undefined) patch.tracking = tracking;
  await ctx.db
    .updateTable('orders_fulfillments')
    .set(patch)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', fulfillmentId)
    .execute();
  await audit(
    asCoreDb(ctx.db),
    tenantId,
    actor,
    'orders.fulfillment.advanced',
    'orders.fulfillment',
    fulfillmentId,
    { to },
  );
  if (FULFILLMENT_COMPLETING.includes(to)) {
    await recomputeFulfillmentRollup(ctx, tenantId, f.order_id, actor);
  }
  return { ...f, ...patch } as FulfillmentRow;
}

/** Recompute per-line fulfillment_state + order status from completed fulfillments. */
async function recomputeFulfillmentRollup(
  ctx: OrdersCtx,
  tenantId: string,
  orderId: string,
  actor: string,
): Promise<void> {
  const order = await getOrderRow(ctx.db, tenantId, orderId);
  if (!order) return;
  const lines = await getLineRows(ctx.db, tenantId, orderId);
  const completed = await fulfilledQtyByLine(ctx.db, tenantId, orderId, true);

  let allFulfilled = true;
  let anyFulfilled = false;
  const now = nowIso();
  for (const line of lines) {
    if (line.fulfillment_state === 'canceled' || line.fulfillment_state === 'returned') continue;
    const done = completed.get(line.id) ?? 0;
    if (done >= line.qty) {
      anyFulfilled = true;
      if (line.fulfillment_state !== 'fulfilled') {
        await ctx.db
          .updateTable('orders_lines')
          .set({ fulfillment_state: 'fulfilled', updated_at: now })
          .where('tenant_id', '=', tenantId)
          .where('id', '=', line.id)
          .execute();
      }
    } else {
      allFulfilled = false;
      if (done > 0) anyFulfilled = true;
    }
  }

  if (order.status === 'paid' || order.status === 'partially_fulfilled') {
    if (allFulfilled) {
      const next = await setStatus(ctx, order, 'fulfilled', { fulfilled_at: now });
      const stock = stockLines(lines);
      await audit(asCoreDb(ctx.db), tenantId, actor, 'orders.order.fulfilled', 'orders.order', orderId, {});
      await ctx.events.emit(tenantId, 'orders.order.fulfilled', { v: 1, orderId, lines: stock });
      void next;
    } else if (anyFulfilled && order.status !== 'partially_fulfilled') {
      await setStatus(ctx, order, 'partially_fulfilled');
      await audit(
        asCoreDb(ctx.db),
        tenantId,
        actor,
        'orders.order.partially_fulfilled',
        'orders.order',
        orderId,
        {},
      );
    }
  }
}

/* ================================================================== *
 * Pick list + packing slip (deterministic projections)
 * ================================================================== */

export interface PickListItem {
  lineId: string;
  variationId: string | null;
  locationId: string | null;
  description: string;
  qty: number;
  fulfillmentState: LineFulfillmentState;
}

/** Lines still needing pick/pack, deterministic order. */
export async function pickList(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  orderId: string,
): Promise<{ orderId: string; items: PickListItem[] }> {
  await requireOrderExists(db, tenantId, orderId);
  const lines = await getLineRows(db, tenantId, orderId);
  const items = lines
    .filter((l) => ['pending', 'picked', 'packed'].includes(l.fulfillment_state))
    .map((l) => ({
      lineId: l.id,
      variationId: l.variation_id,
      locationId: l.location_id,
      description: l.description,
      qty: l.qty,
      fulfillmentState: l.fulfillment_state,
    }));
  return { orderId, items };
}

export interface PackingSlip {
  fulfillmentId: string;
  orderId: string;
  kind: FulfillmentKind;
  address: Record<string, unknown> | null;
  tracking: string | null;
  items: { lineId: string; variationId: string | null; description: string; qty: number }[];
}

export async function packingSlip(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  fulfillmentId: string,
): Promise<PackingSlip> {
  const f = await getFulfillmentRow(db, tenantId, fulfillmentId);
  if (!f) throw ApiError.notFound(`fulfillment not found: ${fulfillmentId}`);
  const flines = await db
    .selectFrom('orders_fulfillment_lines')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('fulfillment_id', '=', fulfillmentId)
    .orderBy('id')
    .execute();
  const orderLines = await getLineRows(db, tenantId, f.order_id);
  const byId = new Map(orderLines.map((l) => [l.id, l]));
  const items = flines
    .map((fl) => {
      const l = byId.get(fl.line_id);
      return {
        lineId: fl.line_id,
        variationId: l?.variation_id ?? null,
        description: l?.description ?? '',
        qty: fl.qty,
      };
    })
    .sort((a, b) => (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0));
  return {
    fulfillmentId,
    orderId: f.order_id,
    kind: f.kind,
    address: f.address ? (JSON.parse(f.address) as Record<string, unknown>) : null,
    tracking: f.tracking,
    items,
  };
}

async function requireOrderExists(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  orderId: string,
): Promise<void> {
  const order = await getOrderRow(db, tenantId, orderId);
  if (!order) throw ApiError.notFound(`order not found: ${orderId}`);
}

/* ================================================================== *
 * Refunds (per-line restock dispositions)
 * ================================================================== */

export interface RefundLineInputSvc {
  lineId: string;
  qty: number;
  disposition: RestockDisposition;
}

export interface CreateRefundInputSvc {
  tenderId: string;
  amountCents: number;
  reason?: string;
  lines: RefundLineInputSvc[];
}

export interface RefundResult {
  refund: RefundRow;
  lines: RefundLineRow[];
  order: OrderDto;
}

const RETURNABLE: readonly OrderStatus[] = [
  'paid',
  'partially_fulfilled',
  'fulfilled',
  'partially_returned',
];

async function returnedQtyByLine(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  orderId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .selectFrom('orders_refund_lines as rl')
    .innerJoin('orders_refunds as r', 'r.id', 'rl.refund_id')
    .select(['rl.line_id as line_id', 'rl.qty as qty'])
    .where('rl.tenant_id', '=', tenantId)
    .where('r.order_id', '=', orderId)
    .execute();
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.line_id, (map.get(r.line_id) ?? 0) + r.qty);
  return map;
}

export async function createRefund(
  ctx: OrdersCtx,
  tenantId: string,
  actor: string,
  orderId: string,
  input: CreateRefundInputSvc,
): Promise<RefundResult> {
  const order = await requireOrder(ctx.db, tenantId, orderId);
  if (!RETURNABLE.includes(order.status)) {
    throw ApiError.conflict(`order is not refundable (status: ${order.status})`);
  }
  const tender = await ctx.db
    .selectFrom('orders_tenders')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('order_id', '=', orderId)
    .where('id', '=', input.tenderId)
    .executeTakeFirst();
  if (!tender) throw ApiError.badRequest(`tender not on this order: ${input.tenderId}`);
  if (!['captured', 'partially_refunded'].includes(tender.status)) {
    throw ApiError.conflict(`tender cannot be refunded (status: ${tender.status})`);
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw ApiError.badRequest('amountCents must be a positive integer');
  }
  const refundableCents = tender.amount_cents - tender.refunded_cents;
  if (input.amountCents > refundableCents) {
    throw ApiError.conflict(`refund ${input.amountCents} exceeds refundable ${refundableCents} on tender`);
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw ApiError.badRequest('a refund needs at least one line disposition');
  }

  const orderLines = await getLineRows(ctx.db, tenantId, orderId);
  const byId = new Map(orderLines.map((l) => [l.id, l]));
  const alreadyReturned = await returnedQtyByLine(ctx.db, tenantId, orderId);
  for (const rl of input.lines) {
    const line = byId.get(rl.lineId);
    if (!line) throw ApiError.badRequest(`line not on this order: ${rl.lineId}`);
    if (!Number.isFinite(rl.qty) || rl.qty <= 0) throw ApiError.badRequest('refund qty must be positive');
    const outstanding = line.qty - (alreadyReturned.get(rl.lineId) ?? 0);
    if (rl.qty > outstanding) {
      throw ApiError.conflict(`refund qty ${rl.qty} exceeds returnable ${outstanding} for line ${rl.lineId}`);
    }
  }

  const now = nowIso();
  const refund: RefundRow = {
    id: id(),
    tenant_id: tenantId,
    order_id: orderId,
    tender_id: input.tenderId,
    amount_cents: input.amountCents,
    reason: input.reason ?? null,
    status: 'completed',
    created_at: now,
  };
  await ctx.db.insertInto('orders_refunds').values(refund).execute();
  const refundLines: RefundLineRow[] = input.lines.map((rl) => ({
    id: id(),
    tenant_id: tenantId,
    refund_id: refund.id,
    line_id: rl.lineId,
    qty: rl.qty,
    disposition: rl.disposition,
    created_at: now,
  }));
  for (const rl of refundLines) {
    await ctx.db.insertInto('orders_refund_lines').values(rl).execute();
  }

  // Tender refund accounting.
  const newRefunded = tender.refunded_cents + input.amountCents;
  const tenderStatus = newRefunded >= tender.amount_cents ? 'refunded' : 'partially_refunded';
  await ctx.db
    .updateTable('orders_tenders')
    .set({ refunded_cents: newRefunded, status: tenderStatus, updated_at: now })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', input.tenderId)
    .execute();

  // Mark fully-returned lines.
  const cumulative = await returnedQtyByLine(ctx.db, tenantId, orderId);
  for (const line of orderLines) {
    const ret = cumulative.get(line.id) ?? 0;
    if (ret >= line.qty && line.fulfillment_state !== 'returned') {
      await ctx.db
        .updateTable('orders_lines')
        .set({ fulfillment_state: 'returned', updated_at: now })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', line.id)
        .execute();
    }
  }

  // Order rollup: all lines returned -> returned, else partially_returned.
  const refreshed = await getLineRows(ctx.db, tenantId, orderId);
  const allReturned = refreshed.every(
    (l) => l.fulfillment_state === 'returned' || l.fulfillment_state === 'canceled',
  );
  const target: OrderStatus = allReturned ? 'returned' : 'partially_returned';
  const next = await setStatus(ctx, order, target);

  const stock = refundLines
    .map((rl) => {
      const l = byId.get(rl.line_id);
      return l && l.variation_id
        ? {
            variationId: l.variation_id,
            qty: rl.qty,
            disposition: rl.disposition,
            ...(l.location_id ? { locationId: l.location_id } : {}),
          }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  await audit(asCoreDb(ctx.db), tenantId, actor, 'orders.refund.created', 'orders.refund', refund.id, {
    orderId,
    amountCents: input.amountCents,
    status: target,
  });
  await ctx.events.emit(tenantId, 'orders.order.returned', {
    v: 1,
    orderId,
    returnId: refund.id,
    lines: stock,
  });
  return { refund, lines: refundLines, order: toOrderDto(next) };
}

export async function listRefunds(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  orderId: string,
): Promise<RefundRow[]> {
  return db
    .selectFrom('orders_refunds')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('order_id', '=', orderId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}
