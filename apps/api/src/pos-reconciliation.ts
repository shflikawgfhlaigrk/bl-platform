import { Hono, type MiddlewareHandler } from 'hono';
import type { Kysely } from 'kysely';
import {
  ApiError,
  asCoreDb,
  errorHandler,
  getTenant,
  id,
  nowIso,
  parsePagination,
  tenantMiddleware,
  type CoreDatabase,
  type EventBus,
  type TenantEnv,
} from '@blacklabel/core';
import type { CatalogDatabase } from '@blacklabel/catalog';
import {
  applyMovement,
  sellForOrder,
  settleReservationsForReference,
  type InventoryDatabase,
  type MovementReason,
} from '@blacklabel/inventory';
import { recordCashRefund, recordCashTender, type FinanceDatabase } from '@blacklabel/finance';
import type { OrderStatus, OrdersDatabase, TenderStatus } from '@blacklabel/orders';
import type { Logger } from '@blacklabel/admin';
import { CONFIG_KEYS, getConfig, resolveDefaultLocationId } from './config';
import type { ApiDatabase } from './migrations';
import type {
  ApiPosFinanceEntryRow,
  ApiPosReconciliationEffectRow,
  PosReconciliationEffectType,
  PosReconciliationTables,
} from './pos-reconciliation-migrations';
import { withPosCashSessionLock } from './pos-serialization';

export type PosReconciliationDatabase = CoreDatabase &
  CatalogDatabase &
  InventoryDatabase &
  OrdersDatabase &
  FinanceDatabase &
  ApiDatabase &
  PosReconciliationTables;

const PAID_STATUSES: OrderStatus[] = [
  'paid',
  'partially_fulfilled',
  'fulfilled',
  'partially_returned',
  'returned',
];
const CAPTURED_TENDER_STATUSES: TenderStatus[] = ['captured', 'partially_refunded', 'refunded'];
const EFFECT_PRIORITY: Record<PosReconciliationEffectType, number> = {
  inventory_release: 0,
  inventory_sale: 1,
  finance_tender: 2,
  cash_sale: 3,
  finance_refund: 4,
  cash_refund: 5,
  inventory_return: 6,
};
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const ACTOR = 'system';
const EXECUTION_CLAIM_PREFIX = '__pos_reconciliation_execution_claim__:';
const EXECUTION_CLAIM_LEASE_MS = 5 * 60 * 1000;

function boundedLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(value as number)));
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1000);
}

function effectKey(type: PosReconciliationEffectType, sourceRef: string): string {
  return `${type}:${sourceRef}`;
}

async function persistEffect(
  db: Kysely<PosReconciliationDatabase>,
  tenantId: string,
  type: PosReconciliationEffectType,
  sourceRef: string,
): Promise<boolean> {
  const key = effectKey(type, sourceRef);
  const existing = await db
    .selectFrom('api_pos_reconciliation_effects')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('effect_key', '=', key)
    .executeTakeFirst();
  if (existing) return false;
  const now = nowIso();
  try {
    await db
      .insertInto('api_pos_reconciliation_effects')
      .values({
        id: id(),
        tenant_id: tenantId,
        effect_key: key,
        effect_type: type,
        source_ref: sourceRef,
        status: 'pending',
        attempt_count: 0,
        last_error: null,
        created_at: now,
        updated_at: now,
        completed_at: null,
      })
      .execute();
    return true;
  } catch (error) {
    const raced = await db
      .selectFrom('api_pos_reconciliation_effects')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('effect_key', '=', key)
      .executeTakeFirst();
    if (raced) return false;
    throw error;
  }
}

type EffectSource = { tenant_id: string; source_ref: string };

async function missingCanceledOrderSources(
  db: Kysely<PosReconciliationDatabase>,
  tenantId: string | undefined,
  limit: number,
): Promise<EffectSource[]> {
  let query = db
    .selectFrom('api_pos_order_claims as claim')
    .innerJoin('orders_orders as order', (join) =>
      join
        .onRef('order.tenant_id', '=', 'claim.tenant_id')
        .onRef('order.id', '=', 'claim.order_id'),
    )
    .leftJoin('api_pos_reconciliation_effects as effect', (join) =>
      join
        .onRef('effect.tenant_id', '=', 'claim.tenant_id')
        .onRef('effect.source_ref', '=', 'claim.order_id')
        .on('effect.effect_type', '=', 'inventory_release'),
    )
    .select(['claim.tenant_id as tenant_id', 'claim.order_id as source_ref'])
    .where('order.status', '=', 'canceled')
    .where('effect.id', 'is', null);
  if (tenantId) query = query.where('claim.tenant_id', '=', tenantId);
  return query.orderBy('claim.created_at').orderBy('claim.order_id').limit(limit).execute();
}

async function missingSaleSources(
  db: Kysely<PosReconciliationDatabase>,
  tenantId: string | undefined,
  limit: number,
): Promise<EffectSource[]> {
  let query = db
    .selectFrom('api_pos_order_claims as claim')
    .innerJoin('orders_orders as order', (join) =>
      join
        .onRef('order.tenant_id', '=', 'claim.tenant_id')
        .onRef('order.id', '=', 'claim.order_id'),
    )
    .leftJoin('api_pos_reconciliation_effects as effect', (join) =>
      join
        .onRef('effect.tenant_id', '=', 'claim.tenant_id')
        .onRef('effect.source_ref', '=', 'claim.order_id')
        .on('effect.effect_type', '=', 'inventory_sale'),
    )
    .select(['claim.tenant_id as tenant_id', 'claim.order_id as source_ref'])
    .where('order.status', 'in', PAID_STATUSES)
    .where('effect.id', 'is', null);
  if (tenantId) query = query.where('claim.tenant_id', '=', tenantId);
  return query.orderBy('claim.created_at').orderBy('claim.order_id').limit(limit).execute();
}

async function missingTenderSources(
  db: Kysely<PosReconciliationDatabase>,
  type: 'finance_tender' | 'cash_sale',
  tenantId: string | undefined,
  limit: number,
  cashSessionId?: string,
): Promise<EffectSource[]> {
  let query = db
    .selectFrom('api_pos_order_claims as claim')
    .innerJoin('orders_orders as order', (join) =>
      join
        .onRef('order.tenant_id', '=', 'claim.tenant_id')
        .onRef('order.id', '=', 'claim.order_id'),
    )
    .innerJoin('orders_tenders as tender', (join) =>
      join
        .onRef('tender.tenant_id', '=', 'order.tenant_id')
        .onRef('tender.order_id', '=', 'order.id'),
    )
    .leftJoin('api_pos_reconciliation_effects as effect', (join) =>
      join
        .onRef('effect.tenant_id', '=', 'tender.tenant_id')
        .onRef('effect.source_ref', '=', 'tender.id')
        .on('effect.effect_type', '=', type),
    )

    .select(['tender.tenant_id as tenant_id', 'tender.id as source_ref'])
    .where('order.status', 'in', [...PAID_STATUSES, 'draft', 'reserved'])
    .where('tender.status', 'in', CAPTURED_TENDER_STATUSES)
    .where('effect.id', 'is', null);
  if (type === 'cash_sale') query = query.where('tender.kind', '=', 'cash');
  if (tenantId) query = query.where('tender.tenant_id', '=', tenantId);
  if (cashSessionId) query = query.where('order.cash_session_id', '=', cashSessionId);
  return query.orderBy('tender.created_at').orderBy('tender.id').limit(limit).execute();
}

async function missingRefundSources(
  db: Kysely<PosReconciliationDatabase>,
  type: 'finance_refund' | 'cash_refund' | 'inventory_return',
  tenantId: string | undefined,
  limit: number,
  cashSessionId?: string,
): Promise<EffectSource[]> {
  let query = db
    .selectFrom('api_pos_order_claims as claim')
    .innerJoin('orders_refunds as refund', (join) =>
      join
        .onRef('refund.tenant_id', '=', 'claim.tenant_id')
        .onRef('refund.order_id', '=', 'claim.order_id'),
    )
    .innerJoin('orders_tenders as tender', (join) =>
      join
        .onRef('tender.tenant_id', '=', 'refund.tenant_id')
        .onRef('tender.id', '=', 'refund.tender_id'),
    )
    .leftJoin('api_pos_reconciliation_effects as effect', (join) =>
      join
        .onRef('effect.tenant_id', '=', 'refund.tenant_id')
        .onRef('effect.source_ref', '=', 'refund.id')
        .on('effect.effect_type', '=', type),
    )
    .select(['refund.tenant_id as tenant_id', 'refund.id as source_ref'])
    .where('refund.status', '=', 'completed')
    .where('effect.id', 'is', null);
  if (type === 'cash_refund') query = query.where('tender.kind', '=', 'cash');
  if (tenantId) query = query.where('refund.tenant_id', '=', tenantId);
  if (cashSessionId) query = query.where('refund.cash_session_id', '=', cashSessionId);
  return query.orderBy('refund.created_at').orderBy('refund.id').limit(limit).execute();
}

export interface DiscoverPosReconciliationOptions {
  tenantId?: string;
  cashSessionId?: string;
  limit?: number;
}

/** Scan authoritative claimed POS facts and persist missing effects before execution. */
export async function discoverPosReconciliationEffects(
  db: Kysely<PosReconciliationDatabase>,
  options: DiscoverPosReconciliationOptions = {},
): Promise<number> {
  let remaining = boundedLimit(options.limit);
  let discovered = 0;
  const types: PosReconciliationEffectType[] = options.cashSessionId
    ? ['cash_sale', 'cash_refund']
    : [
        'inventory_release',
        'inventory_sale',
        'finance_tender',
        'cash_sale',
        'finance_refund',
        'cash_refund',
        'inventory_return',
      ];
  for (const type of types) {
    if (remaining <= 0) break;
    const sources = type === 'inventory_release'
      ? await missingCanceledOrderSources(db, options.tenantId, remaining)
      : type === 'inventory_sale'
      ? await missingSaleSources(db, options.tenantId, remaining)
      : type === 'finance_tender' || type === 'cash_sale'
        ? await missingTenderSources(db, type, options.tenantId, remaining, options.cashSessionId)
        : await missingRefundSources(db, type, options.tenantId, remaining, options.cashSessionId);
    for (const source of sources) {
      if (await persistEffect(db, source.tenant_id, type, source.source_ref)) {
        discovered += 1;
        remaining -= 1;
      }
      if (remaining <= 0) break;
    }
  }
  return discovered;
}

async function requireClaim(
  db: Kysely<PosReconciliationDatabase>,
  tenantId: string,
  orderId: string,
): Promise<void> {
  const claim = await db
    .selectFrom('api_pos_order_claims')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('order_id', '=', orderId)
    .executeTakeFirst();
  if (!claim) throw new Error(`POS order claim is missing for ${orderId}`);
}

async function reconcileInventoryRelease(
  db: Kysely<PosReconciliationDatabase>,
  events: EventBus,
  effect: ApiPosReconciliationEffectRow,
): Promise<void> {
  const order = await db
    .selectFrom('orders_orders')
    .select(['id', 'status'])
    .where('tenant_id', '=', effect.tenant_id)
    .where('id', '=', effect.source_ref)
    .executeTakeFirst();
  if (!order || order.status !== 'canceled') throw new Error('canceled POS order source is missing');
  await requireClaim(db, effect.tenant_id, order.id);
  await settleReservationsForReference(
    db as unknown as Kysely<InventoryDatabase>,
    events,
    effect.tenant_id,
    ACTOR,
    'order',
    order.id,
    'released',
  );
}

async function reconcileInventorySale(
  db: Kysely<PosReconciliationDatabase>,
  events: EventBus,
  effect: ApiPosReconciliationEffectRow,
  envDefaultLocationId?: string,
): Promise<void> {
  const order = await db
    .selectFrom('orders_orders')
    .selectAll()
    .where('tenant_id', '=', effect.tenant_id)
    .where('id', '=', effect.source_ref)
    .executeTakeFirst();
  if (!order || !PAID_STATUSES.includes(order.status)) throw new Error('paid POS order source is missing');
  await requireClaim(db, effect.tenant_id, order.id);
  const lines = await db
    .selectFrom('orders_lines')
    .selectAll()
    .where('tenant_id', '=', effect.tenant_id)
    .where('order_id', '=', order.id)
    .orderBy('position')
    .orderBy('id')
    .execute();
  const grouped = new Map<string, { variationId: string; locationId: string; qty: number }>();
  let fallback: string | null | undefined;
  for (const line of lines) {
    if (!line.variation_id) continue;
    const variation = await db
      .selectFrom('catalog_variations')
      .select(['id', 'track_inventory'])
      .where('tenant_id', '=', effect.tenant_id)
      .where('id', '=', line.variation_id)
      .executeTakeFirst();
    if (!variation) throw new Error(`catalog variation is missing for POS line ${line.id}`);
    if (variation.track_inventory !== 1) continue;
    fallback = fallback ?? await resolveDefaultLocationId(
      db as unknown as Kysely<ApiDatabase>,
      effect.tenant_id,
      envDefaultLocationId,
    );
    const locationId = line.location_id ?? fallback;
    if (!locationId) throw new Error(`inventory location is missing for POS line ${line.id}`);
    if (!Number.isFinite(line.qty) || line.qty <= 0) throw new Error(`invalid POS quantity on line ${line.id}`);
    const key = JSON.stringify([line.variation_id, locationId]);
    const prior = grouped.get(key);
    if (prior) prior.qty += line.qty;
    else grouped.set(key, { variationId: line.variation_id, locationId, qty: line.qty });
  }
  if (grouped.size === 0) return;
  await sellForOrder(
    db as unknown as Kysely<InventoryDatabase>,
    events,
    effect.tenant_id,
    ACTOR,
    {
      orderId: order.id,
      lines: [...grouped.values()],
      idempotencyKey: `order-paid:${order.id}`,
    },
  );
}

async function tenderFact(
  db: Kysely<PosReconciliationDatabase>,
  effect: ApiPosReconciliationEffectRow,
) {
  const tender = await db
    .selectFrom('orders_tenders')
    .selectAll()
    .where('tenant_id', '=', effect.tenant_id)
    .where('id', '=', effect.source_ref)
    .executeTakeFirst();
  if (!tender || !CAPTURED_TENDER_STATUSES.includes(tender.status)) {
    throw new Error('captured POS tender source is missing');
  }
  const order = await db
    .selectFrom('orders_orders')
    .selectAll()
    .where('tenant_id', '=', effect.tenant_id)
    .where('id', '=', tender.order_id)
    .executeTakeFirst();
  if (!order || ![...PAID_STATUSES, 'draft', 'reserved'].includes(order.status)) throw new Error('POS tender order source is missing');
  await requireClaim(db, effect.tenant_id, order.id);
  return { tender, order };
}

async function refundFact(
  db: Kysely<PosReconciliationDatabase>,
  effect: ApiPosReconciliationEffectRow,
) {
  const refund = await db
    .selectFrom('orders_refunds')
    .selectAll()
    .where('tenant_id', '=', effect.tenant_id)
    .where('id', '=', effect.source_ref)
    .executeTakeFirst();
  if (!refund || refund.status !== 'completed') throw new Error('completed POS refund source is missing');
  const tender = await db
    .selectFrom('orders_tenders')
    .selectAll()
    .where('tenant_id', '=', effect.tenant_id)
    .where('id', '=', refund.tender_id)
    .executeTakeFirst();
  const order = await db
    .selectFrom('orders_orders')
    .selectAll()
    .where('tenant_id', '=', effect.tenant_id)
    .where('id', '=', refund.order_id)
    .executeTakeFirst();
  if (!tender || !order) throw new Error('POS refund tender or order source is missing');
  await requireClaim(db, effect.tenant_id, order.id);
  return { refund, tender, order };
}

const FINANCE_FACT_KEYS: Array<keyof ApiPosFinanceEntryRow> = [
  'tenant_id',
  'source_key',
  'entry_type',
  'order_id',
  'tender_id',
  'refund_id',
  'register_id',
  'cashier_id',
  'cash_session_id',
  'tender_kind',
  'provider',
  'provider_ref',
  'amount_cents',
  'fee_cents',
  'net_cents',
  'occurred_at',
];

function assertFinanceReplay(
  existing: ApiPosFinanceEntryRow,
  expected: ApiPosFinanceEntryRow,
): void {
  if (FINANCE_FACT_KEYS.some((key) => existing[key] !== expected[key])) {
    throw new Error(`POS finance source ${expected.source_key} is bound to different facts`);
  }
}

async function persistFinanceEntry(
  db: Kysely<PosReconciliationDatabase>,
  expected: ApiPosFinanceEntryRow,
): Promise<void> {
  const existing = await db
    .selectFrom('api_pos_finance_entries')
    .selectAll()
    .where('tenant_id', '=', expected.tenant_id)
    .where('source_key', '=', expected.source_key)
    .executeTakeFirst();
  if (existing) return assertFinanceReplay(existing, expected);
  try {
    await db.insertInto('api_pos_finance_entries').values(expected).execute();
  } catch (error) {
    const raced = await db
      .selectFrom('api_pos_finance_entries')
      .selectAll()
      .where('tenant_id', '=', expected.tenant_id)
      .where('source_key', '=', expected.source_key)
      .executeTakeFirst();
    if (!raced) throw error;
    assertFinanceReplay(raced, expected);
  }
}

async function reconcileFinanceTender(
  db: Kysely<PosReconciliationDatabase>,
  effect: ApiPosReconciliationEffectRow,
): Promise<void> {
  const { tender, order } = await tenderFact(db, effect);
  await persistFinanceEntry(db, {
    id: id(),
    tenant_id: effect.tenant_id,
    source_key: `tender:${tender.id}`,
    entry_type: 'payment',
    order_id: order.id,
    tender_id: tender.id,
    refund_id: null,
    register_id: order.register_id,
    cashier_id: order.cashier_id,
    cash_session_id: order.cash_session_id,
    tender_kind: tender.kind,
    provider: tender.provider,
    provider_ref: tender.provider_ref,
    amount_cents: tender.amount_cents,
    fee_cents: null,
    net_cents: null,
    occurred_at: tender.created_at,
    created_at: nowIso(),
  });
}

async function reconcileCashSale(
  db: Kysely<PosReconciliationDatabase>,
  effect: ApiPosReconciliationEffectRow,
): Promise<void> {
  const { tender, order } = await tenderFact(db, effect);
  if (tender.kind !== 'cash') throw new Error('cash sale effect points to a non-cash tender');
  if (!order.cash_session_id) throw new Error('cash POS sale has no cash session');
  await recordCashTender(
    db as unknown as Kysely<FinanceDatabase>,
    effect.tenant_id,
    ACTOR,
    order.cash_session_id,
    {
      tenderRef: tender.id,
      orderRef: order.id,
      amountCents: tender.amount_cents,
      occurredAt: tender.created_at,
    },
  );
}

async function reconcileFinanceRefund(
  db: Kysely<PosReconciliationDatabase>,
  effect: ApiPosReconciliationEffectRow,
): Promise<void> {
  const { refund, tender, order } = await refundFact(db, effect);
  await persistFinanceEntry(db, {
    id: id(),
    tenant_id: effect.tenant_id,
    source_key: `refund:${refund.id}`,
    entry_type: 'refund',
    order_id: order.id,
    tender_id: tender.id,
    refund_id: refund.id,
    register_id: order.register_id,
    cashier_id: order.cashier_id,
    cash_session_id: refund.cash_session_id,
    tender_kind: tender.kind,
    provider: refund.provider ?? tender.provider,
    provider_ref: refund.provider_ref,
    amount_cents: refund.amount_cents,
    fee_cents: null,
    net_cents: null,
    occurred_at: refund.created_at,
    created_at: nowIso(),
  });
}

async function reconcileCashRefund(
  db: Kysely<PosReconciliationDatabase>,
  effect: ApiPosReconciliationEffectRow,
): Promise<void> {
  const { refund, tender, order } = await refundFact(db, effect);
  if (tender.kind !== 'cash') throw new Error('cash refund effect points to a non-cash tender');
  if (!refund.cash_session_id) throw new Error('cash POS refund has no cash session');
  await recordCashRefund(
    db as unknown as Kysely<FinanceDatabase>,
    effect.tenant_id,
    ACTOR,
    refund.cash_session_id,
    {
      refundRef: refund.id,
      tenderRef: tender.id,
      orderRef: order.id,
      amountCents: refund.amount_cents,
      occurredAt: refund.created_at,
    },
  );
}

interface ReturnAggregate {
  variationId: string;
  locationId: string;
  reason: MovementReason;
  qty: number;
}

async function reconcileInventoryReturn(
  db: Kysely<PosReconciliationDatabase>,
  events: EventBus,
  effect: ApiPosReconciliationEffectRow,
  envDefaultLocationId?: string,
): Promise<void> {
  const { refund } = await refundFact(db, effect);
  const lines = await db
    .selectFrom('orders_refund_lines as refund_line')
    .innerJoin('orders_lines as order_line', (join) =>
      join
        .onRef('order_line.tenant_id', '=', 'refund_line.tenant_id')
        .onRef('order_line.id', '=', 'refund_line.line_id'),
    )
    .select([
      'refund_line.id as refund_line_id',
      'refund_line.qty as qty',
      'refund_line.disposition as disposition',
      'order_line.variation_id as variation_id',
      'order_line.location_id as location_id',
    ])
    .where('refund_line.tenant_id', '=', effect.tenant_id)
    .where('refund_line.refund_id', '=', refund.id)
    .orderBy('refund_line.id')
    .execute();
  const apiDb = db as unknown as Kysely<ApiDatabase>;
  let defaultLocation: string | null | undefined;
  let quarantineLocation: string | null | undefined;
  let damagedLocation: string | null | undefined;
  const expected = new Map<string, ReturnAggregate>();
  for (const line of lines) {
    if (line.disposition === 'none' || !line.variation_id) continue;
    const variation = await db
      .selectFrom('catalog_variations')
      .select('track_inventory')
      .where('tenant_id', '=', effect.tenant_id)
      .where('id', '=', line.variation_id)
      .executeTakeFirst();
    if (!variation) throw new Error(`catalog variation is missing for refund line ${line.refund_line_id}`);
    if (variation.track_inventory !== 1) continue;
    let locationId: string | null;
    let reason: MovementReason = 'returned';
    if (line.disposition === 'restock') {
      defaultLocation = defaultLocation ?? await resolveDefaultLocationId(apiDb, effect.tenant_id, envDefaultLocationId);
      locationId = line.location_id ?? defaultLocation;
    } else if (line.disposition === 'damaged') {
      damagedLocation = damagedLocation ?? await getConfig(apiDb, effect.tenant_id, CONFIG_KEYS.damagedLocation);
      locationId = damagedLocation;
      reason = 'damaged';
    } else {
      quarantineLocation = quarantineLocation ?? await getConfig(apiDb, effect.tenant_id, CONFIG_KEYS.quarantineLocation);
      locationId = quarantineLocation;
    }
    if (!locationId) throw new Error(`${line.disposition} location is not configured`);
    const key = JSON.stringify([line.variation_id, locationId, reason]);
    const prior = expected.get(key);
    if (prior) prior.qty += line.qty;
    else expected.set(key, { variationId: line.variation_id, locationId, reason, qty: line.qty });
  }
  const existing = await db
    .selectFrom('inventory_movements')
    .select(['variation_id', 'location_id', 'reason', 'delta'])
    .where('tenant_id', '=', effect.tenant_id)
    .where('ref_type', '=', 'return')
    .where('ref_id', '=', refund.id)
    .execute();
  for (const aggregate of expected.values()) {
    const applied = existing
      .filter((row) =>
        row.variation_id === aggregate.variationId &&
        row.location_id === aggregate.locationId &&
        row.reason === aggregate.reason,
      )
      .reduce((sum, row) => sum + row.delta, 0);
    const deficit = aggregate.qty - applied;
    if (deficit < -1e-9) throw new Error(`inventory return ${refund.id} exceeds its source quantity`);
    if (deficit <= 1e-9) continue;
    await applyMovement(
      db as unknown as Kysely<InventoryDatabase>,
      events,
      effect.tenant_id,
      ACTOR,
      {
        variationId: aggregate.variationId,
        locationId: aggregate.locationId,
        delta: deficit,
        reason: aggregate.reason,
        refType: 'return',
        refId: refund.id,
        idempotencyKey: `pos-return:${refund.id}:${aggregate.variationId}:${aggregate.locationId}:${aggregate.reason}`,
      },
    );
  }
}

async function executeEffect(
  db: Kysely<PosReconciliationDatabase>,
  events: EventBus,
  effect: ApiPosReconciliationEffectRow,
  envDefaultLocationId?: string,
): Promise<void> {
  if (effect.effect_type === 'inventory_release') {
    return reconcileInventoryRelease(db, events, effect);
  }
  if (effect.effect_type === 'inventory_sale') return reconcileInventorySale(db, events, effect, envDefaultLocationId);
  if (effect.effect_type === 'finance_tender') return reconcileFinanceTender(db, effect);
  if (effect.effect_type === 'cash_sale') return reconcileCashSale(db, effect);
  if (effect.effect_type === 'finance_refund') return reconcileFinanceRefund(db, effect);
  if (effect.effect_type === 'cash_refund') return reconcileCashRefund(db, effect);
  return reconcileInventoryReturn(db, events, effect, envDefaultLocationId);
}

async function pendingEffects(
  db: Kysely<PosReconciliationDatabase>,
  tenantId: string | undefined,
  limit: number,
  cashSessionId?: string,
): Promise<ApiPosReconciliationEffectRow[]> {
  const staleClaimCutoff = new Date(Date.now() - EXECUTION_CLAIM_LEASE_MS).toISOString();
  if (!cashSessionId) {
    let query = db
      .selectFrom('api_pos_reconciliation_effects')
      .selectAll()
      .where('status', '=', 'pending')
      .where((eb) => eb.or([
        eb('last_error', 'is', null),
        eb('last_error', 'not like', `${EXECUTION_CLAIM_PREFIX}%`),
        eb('updated_at', '<=', staleClaimCutoff),
      ]));
    if (tenantId) query = query.where('tenant_id', '=', tenantId);
    return query.orderBy('created_at').orderBy('id').limit(limit).execute();
  }
  if (!tenantId) throw new Error('cash-session reconciliation requires a tenant');
  const sales = await db
    .selectFrom('api_pos_reconciliation_effects as effect')
    .innerJoin('orders_tenders as tender', (join) =>
      join
        .onRef('tender.tenant_id', '=', 'effect.tenant_id')
        .onRef('tender.id', '=', 'effect.source_ref'),
    )
    .innerJoin('orders_orders as order', (join) =>
      join
        .onRef('order.tenant_id', '=', 'tender.tenant_id')
        .onRef('order.id', '=', 'tender.order_id'),
    )
    .selectAll('effect')
    .where('effect.tenant_id', '=', tenantId)
    .where('effect.effect_type', '=', 'cash_sale')
    .where('effect.status', '=', 'pending')
    .where((eb) => eb.or([
      eb('effect.last_error', 'is', null),
      eb('effect.last_error', 'not like', `${EXECUTION_CLAIM_PREFIX}%`),
      eb('effect.updated_at', '<=', staleClaimCutoff),
    ]))
    .where('order.cash_session_id', '=', cashSessionId)
    .orderBy('effect.created_at')
    .limit(limit)
    .execute();
  const remaining = Math.max(0, limit - sales.length);
  if (remaining === 0) return sales;
  const refunds = await db
    .selectFrom('api_pos_reconciliation_effects as effect')
    .innerJoin('orders_refunds as refund', (join) =>
      join
        .onRef('refund.tenant_id', '=', 'effect.tenant_id')
        .onRef('refund.id', '=', 'effect.source_ref'),
    )
    .selectAll('effect')
    .where('effect.tenant_id', '=', tenantId)
    .where('effect.effect_type', '=', 'cash_refund')
    .where('effect.status', '=', 'pending')
    .where((eb) => eb.or([
      eb('effect.last_error', 'is', null),
      eb('effect.last_error', 'not like', `${EXECUTION_CLAIM_PREFIX}%`),
      eb('effect.updated_at', '<=', staleClaimCutoff),
    ]))
    .where('refund.cash_session_id', '=', cashSessionId)
    .orderBy('effect.created_at')
    .limit(remaining)
    .execute();
  return [...sales, ...refunds];
}

interface EffectExecutionClaim {
  effect: ApiPosReconciliationEffectRow;
  token: string;
}

/**
 * Atomically lease one pending row. The token is persisted in the existing
 * durable row so independently-started drainers cannot both execute a source
 * they selected before either writer reached this compare-and-swap.
 *
 * A crashed worker's claim becomes eligible again after the lease interval;
 * every terminal write is token-guarded so a stale worker can never overwrite
 * the newer owner's result.
 */
async function claimEffectExecution(
  db: Kysely<PosReconciliationDatabase>,
  effect: ApiPosReconciliationEffectRow,
): Promise<EffectExecutionClaim | null> {
  const token = `${EXECUTION_CLAIM_PREFIX}${id()}`;
  const claimedAt = nowIso();
  let query = db
    .updateTable('api_pos_reconciliation_effects')
    .set({
      attempt_count: effect.attempt_count + 1,
      last_error: token,
      updated_at: claimedAt,
    })
    .where('tenant_id', '=', effect.tenant_id)
    .where('id', '=', effect.id)
    .where('status', '=', 'pending')
    .where('attempt_count', '=', effect.attempt_count)
    .where('updated_at', '=', effect.updated_at);
  query = effect.last_error === null
    ? query.where('last_error', 'is', null)
    : query.where('last_error', '=', effect.last_error);
  const result = await query.executeTakeFirst();
  if (Number(result.numUpdatedRows) !== 1) return null;
  return {
    token,
    effect: {
      ...effect,
      attempt_count: effect.attempt_count + 1,
      last_error: token,
      updated_at: claimedAt,
    },
  };
}

function ownedEffectUpdate(
  db: Kysely<PosReconciliationDatabase>,
  claim: EffectExecutionClaim,
) {
  return db
    .updateTable('api_pos_reconciliation_effects')
    .where('tenant_id', '=', claim.effect.tenant_id)
    .where('id', '=', claim.effect.id)
    .where('status', '=', 'pending')
    .where('attempt_count', '=', claim.effect.attempt_count)
    .where('last_error', '=', claim.token);
}

export interface DrainPosReconciliationOptions extends DiscoverPosReconciliationOptions {
  envDefaultLocationId?: string;
}

export interface PosReconciliationDrainResult {
  discovered: number;
  attempted: number;
  completed: number;
  failed: number;
}

/** One bounded discovery + execution pass. Failures remain pending with evidence. */
export async function drainPosReconciliation(
  db: Kysely<PosReconciliationDatabase>,
  events: EventBus,
  options: DrainPosReconciliationOptions = {},
): Promise<PosReconciliationDrainResult> {
  const limit = boundedLimit(options.limit);
  const discovered = await discoverPosReconciliationEffects(db, { ...options, limit });
  const effects = await pendingEffects(db, options.tenantId, limit, options.cashSessionId);
  effects.sort((a, b) =>
    EFFECT_PRIORITY[a.effect_type] - EFFECT_PRIORITY[b.effect_type] ||
    a.created_at.localeCompare(b.created_at) ||
    a.id.localeCompare(b.id),
  );
  let attempted = 0;
  let completed = 0;
  let failed = 0;
  for (const effect of effects) {
    const claim = await claimEffectExecution(db, effect);
    if (!claim) continue;
    attempted += 1;
    try {
      await executeEffect(db, events, claim.effect, options.envDefaultLocationId);
      const finishedAt = nowIso();
      const result = await ownedEffectUpdate(db, claim)
        .set({ status: 'completed', last_error: null, updated_at: finishedAt, completed_at: finishedAt })
        .executeTakeFirst();
      completed += Number(result.numUpdatedRows);
    } catch (error) {
      const result = await ownedEffectUpdate(db, claim)
        .set({ last_error: boundedError(error), updated_at: nowIso(), completed_at: null })
        .executeTakeFirst();
      // Report only a failure this worker still owned and durably recorded.
      // A stale worker that lost its lease to a successful completion must not
      // make the drain response claim the now-completed effect failed.
      failed += Number(result.numUpdatedRows);
    }
  }
  return { discovered, attempted, completed, failed };
}

export async function reconcilePosTenant(
  db: Kysely<PosReconciliationDatabase>,
  events: EventBus,
  tenantId: string,
  options: Omit<DrainPosReconciliationOptions, 'tenantId'> = {},
): Promise<PosReconciliationDrainResult> {
  return drainPosReconciliation(db, events, { ...options, tenantId });
}

export async function reconcileAllPosTenants(
  db: Kysely<PosReconciliationDatabase>,
  events: EventBus,
  options: Omit<DrainPosReconciliationOptions, 'tenantId' | 'cashSessionId'> = {},
): Promise<PosReconciliationDrainResult> {
  return drainPosReconciliation(db, events, options);
}

async function countEffects(
  db: Kysely<PosReconciliationDatabase>,
  tenantId: string,
  status?: 'pending' | 'completed',
  errorsOnly = false,
): Promise<number> {
  let query = db
    .selectFrom('api_pos_reconciliation_effects')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('tenant_id', '=', tenantId);
  if (status) query = query.where('status', '=', status);
  if (errorsOnly) {
    query = query
      .where('last_error', 'is not', null)
      .where('last_error', 'not like', `${EXECUTION_CLAIM_PREFIX}%`);
  }
  const row = await query.executeTakeFirst();
  return Number(row?.count ?? 0);
}

export async function getPosReconciliationStatus(
  db: Kysely<PosReconciliationDatabase>,
  tenantId: string,
) {
  const [totalCount, pendingCount, completedCount, errorCount] = await Promise.all([
    countEffects(db, tenantId),
    countEffects(db, tenantId, 'pending'),
    countEffects(db, tenantId, 'completed'),
    countEffects(db, tenantId, 'pending', true),
  ]);
  return { totalCount, pendingCount, completedCount, errorCount, healthy: pendingCount === 0 };
}

async function missingCashMovementCount(
  db: Kysely<PosReconciliationDatabase>,
  tenantId: string,
  cashSessionId: string,
): Promise<number> {
  const sale = await db
    .selectFrom('api_pos_order_claims as claim')
    .innerJoin('orders_orders as order', (join) =>
      join.onRef('order.tenant_id', '=', 'claim.tenant_id').onRef('order.id', '=', 'claim.order_id'),
    )
    .innerJoin('orders_tenders as tender', (join) =>
      join.onRef('tender.tenant_id', '=', 'order.tenant_id').onRef('tender.order_id', '=', 'order.id'),
    )
    .leftJoin('finance_cash_movements as movement', (join) =>
      join
        .onRef('movement.tenant_id', '=', 'tender.tenant_id')
        .onRef('movement.source_ref', '=', 'tender.id')
        .on('movement.kind', '=', 'cash_sale'),
    )
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('claim.tenant_id', '=', tenantId)
    .where('order.cash_session_id', '=', cashSessionId)
    .where('order.status', 'in', PAID_STATUSES)
    .where('tender.kind', '=', 'cash')
    .where('tender.status', 'in', CAPTURED_TENDER_STATUSES)
    .where('movement.id', 'is', null)
    .executeTakeFirst();
  const refund = await db
    .selectFrom('api_pos_order_claims as claim')
    .innerJoin('orders_refunds as refund', (join) =>
      join.onRef('refund.tenant_id', '=', 'claim.tenant_id').onRef('refund.order_id', '=', 'claim.order_id'),
    )
    .innerJoin('orders_tenders as tender', (join) =>
      join.onRef('tender.tenant_id', '=', 'refund.tenant_id').onRef('tender.id', '=', 'refund.tender_id'),
    )
    .leftJoin('finance_cash_movements as movement', (join) =>
      join
        .onRef('movement.tenant_id', '=', 'refund.tenant_id')
        .onRef('movement.source_ref', '=', 'refund.id')
        .on('movement.kind', '=', 'cash_refund'),
    )
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('claim.tenant_id', '=', tenantId)
    .where('refund.cash_session_id', '=', cashSessionId)
    .where('refund.status', '=', 'completed')
    .where('tender.kind', '=', 'cash')
    .where('movement.id', 'is', null)
    .executeTakeFirst();
  return Number(sale?.count ?? 0) + Number(refund?.count ?? 0);
}

export async function reconcilePosCashSession(
  db: Kysely<PosReconciliationDatabase>,
  events: EventBus,
  tenantId: string,
  cashSessionId: string,
  options: Omit<DrainPosReconciliationOptions, 'tenantId' | 'cashSessionId'> = {},
) {
  const result = await drainPosReconciliation(db, events, {
    ...options,
    tenantId,
    cashSessionId,
  });
  const missingCashFacts = await missingCashMovementCount(db, tenantId, cashSessionId);
  const pending = await pendingEffects(db, tenantId, MAX_LIMIT, cashSessionId);
  return {
    ...result,
    missingCashFacts,
    pendingCashEffects: pending.length,
    readyToClose: missingCashFacts === 0 && pending.length === 0,
  };
}

export async function listPosFinanceEntries(
  db: Kysely<PosReconciliationDatabase>,
  tenantId: string,
  page: { limit: number; offset: number },
): Promise<Array<ApiPosFinanceEntryRow & { cashier_name: string | null; receipt_number: string | null }>> {
  return db
    .selectFrom('api_pos_finance_entries as entry')
    .leftJoin('users as cashier', (join) =>
      join
        .onRef('cashier.tenant_id', '=', 'entry.tenant_id')
        .onRef('cashier.id', '=', 'entry.cashier_id'),
    )
    .leftJoin('orders_orders as order', (join) =>
      join
        .onRef('order.tenant_id', '=', 'entry.tenant_id')
        .onRef('order.id', '=', 'entry.order_id'),
    )
    .selectAll('entry')
    .select(['cashier.name as cashier_name', 'order.receipt_number as receipt_number'])
    .where('entry.tenant_id', '=', tenantId)
    .orderBy('entry.occurred_at', 'desc')
    .orderBy('entry.id', 'desc')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

async function financeAggregate(
  db: Kysely<PosReconciliationDatabase>,
  tenantId: string,
  entryType: 'payment' | 'refund',
) {
  const row = await db
    .selectFrom('api_pos_finance_entries')
    .select((eb) => [
      eb.fn.countAll<number>().as('count'),
      eb.fn.sum<number>('amount_cents').as('amount'),
    ])
    .where('tenant_id', '=', tenantId)
    .where('entry_type', '=', entryType)
    .executeTakeFirst();
  return { count: Number(row?.count ?? 0), amountCents: Number(row?.amount ?? 0) };
}

export async function getPosFinanceSummary(
  db: Kysely<PosReconciliationDatabase>,
  tenantId: string,
) {
  const [payments, refunds, unknownFees, reconciliation] = await Promise.all([
    financeAggregate(db, tenantId, 'payment'),
    financeAggregate(db, tenantId, 'refund'),
    db
      .selectFrom('api_pos_finance_entries')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('tenant_id', '=', tenantId)
      .where('fee_cents', 'is', null)
      .executeTakeFirst(),
    getPosReconciliationStatus(db, tenantId),
  ]);
  return {
    grossTenderedSalesCents: payments.amountCents,
    completedRefundsCents: refunds.amountCents,
    netSalesBeforeFeesCents: payments.amountCents - refunds.amountCents,
    processorFeesCents: null,
    settlementNetCents: null,
    unknownFeeEntryCount: Number(unknownFees?.count ?? 0),
    paymentCount: payments.count,
    refundCount: refunds.count,
    pendingReconciliationCount: reconciliation.pendingCount,
  };
}

export interface PosReconciliationRuntimeOptions {
  envDefaultLocationId?: string;
  logger?: Logger;
  requestLimit?: number;
}

export function posReconciliationRouter(
  db: Kysely<PosReconciliationDatabase>,
  events: EventBus,
  options: PosReconciliationRuntimeOptions = {},
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(db)));
  app.get('/reconciliation', async (c) =>
    c.json({ data: await getPosReconciliationStatus(db, c.get('tenantId')) }));
  app.post('/reconciliation/drain', async (c) => {
    const tenantId = c.get('tenantId');
    const result = await reconcilePosTenant(db, events, tenantId, {
      limit: Number(c.req.query('limit')) || options.requestLimit,
      envDefaultLocationId: options.envDefaultLocationId,
    });
    return c.json({ data: { result, status: await getPosReconciliationStatus(db, tenantId) } });
  });
  app.get('/finance/entries', async (c) => {
    const page = parsePagination(c.req.query(), { defaultLimit: 50, maxLimit: 200 });
    return c.json({
      data: await listPosFinanceEntries(db, c.get('tenantId'), page),
      limit: page.limit,
      offset: page.offset,
    });
  });
  app.get('/finance/summary', async (c) =>
    c.json({ data: await getPosFinanceSummary(db, c.get('tenantId')) }));
  return app;
}

/** Bounded before/after repair and a hard pre-close cash-ledger gate. */
export function posReconciliationMiddleware(
  db: Kysely<PosReconciliationDatabase>,
  events: EventBus,
  options: PosReconciliationRuntimeOptions = {},
): MiddlewareHandler {
  return async (c, next) => {
    const tenantId = c.req.header('x-tenant-id')?.trim();
    if (!tenantId || !(await getTenant(asCoreDb(db), tenantId))) return next();
    const closeMatch = /^\/api\/pos\/drawer\/([^/]+)\/close$/.exec(c.req.path);
    const reconcileAfterRequest = async () => {
      try {
        await reconcilePosTenant(db, events, tenantId, {
          limit: options.requestLimit,
          envDefaultLocationId: options.envDefaultLocationId,
        });
        const status = await getPosReconciliationStatus(db, tenantId);
        c.header('x-pos-reconciliation-pending', String(status.pendingCount));
        c.header('x-pos-reconciliation-errors', String(status.errorCount));
      } catch (error) {
        options.logger?.error('POS post-request reconciliation failed', { tenantId, error: boundedError(error) });
      }
    };

    if (closeMatch && c.req.method === 'POST') {
      return withPosCashSessionLock(tenantId, closeMatch[1], async () => {
        const unfinished = await db.selectFrom('orders_orders as order')
          .innerJoin('orders_tenders as tender', (join) => join
            .onRef('tender.tenant_id', '=', 'order.tenant_id').onRef('tender.order_id', '=', 'order.id'))
          .select('order.id').where('order.tenant_id', '=', tenantId)
          .where('order.cash_session_id', '=', closeMatch[1])
          .where('order.status', 'in', ['draft', 'reserved'])
          .where('tender.status', 'in', CAPTURED_TENDER_STATUSES)
          .orderBy('order.id').executeTakeFirst();
        if (unfinished) throw ApiError.conflict('finish the partially paid order before closing this drawer');
        const result = await reconcilePosCashSession(db, events, tenantId, closeMatch[1], {
          limit: options.requestLimit ?? 200,
          envDefaultLocationId: options.envDefaultLocationId,
        });
        if (!result.readyToClose) {
          throw ApiError.conflict('cash drawer reconciliation is still pending; retry close', result);
        }
        await next();
        await reconcileAfterRequest();
      });
    }

    try {
      await reconcilePosTenant(db, events, tenantId, {
        limit: options.requestLimit,
        envDefaultLocationId: options.envDefaultLocationId,
      });
    } catch (error) {
      options.logger?.error('POS reconciliation pass failed', { tenantId, error: boundedError(error) });
    }
    await next();
    await reconcileAfterRequest();
  };
}
