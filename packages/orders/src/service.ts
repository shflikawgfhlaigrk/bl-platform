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
  PaymentAttemptRow,
  PaymentAttemptStatus,
  RefundLineRow,
  RefundRow,
  RestockDisposition,
  TenderKind,
  TenderRow,
  WebhookEventRow,
} from './schema';
import type {
  CheckoutProvider,
  CreateSessionResult,
  ParsedPaymentUpdate,
  ParsedRefundUpdate,
  PreparedSessionResult,
  ProviderRefundResult,
} from './providers';

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
export type PaymentAttemptDto = Omit<PaymentAttemptRow, 'provider_data'> & {
  provider_data: Record<string, unknown> | null;
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
function toPaymentAttemptDto(row: PaymentAttemptRow): PaymentAttemptDto {
  let providerData: Record<string, unknown> | null = null;
  if (row.provider_data) {
    try {
      providerData = JSON.parse(row.provider_data) as Record<string, unknown>;
    } catch {
      providerData = null;
    }
  }
  return { ...row, provider_data: providerData };
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

function totalWithTip(baseTotalCents: number, tipCents: number): number {
  if (!Number.isSafeInteger(tipCents) || tipCents < 0) {
    throw ApiError.badRequest('tipCents must be a non-negative safe integer');
  }
  const total = baseTotalCents + tipCents;
  if (!Number.isSafeInteger(total)) throw ApiError.badRequest('order total exceeds safe integer range');
  return total;
}

function newReceiptNumber(at: string): string {
  const date = at.slice(0, 10).replace(/-/g, '');
  return `BL-${date}-${id().slice(0, 10).toUpperCase()}`;
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

async function requireNoActivePaymentAttempt(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  orderId: string,
): Promise<void> {
  const active = await db
    .selectFrom('orders_payment_attempts')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('order_id', '=', orderId)
    .where('status', 'in', ['pending', 'processing'])
    .orderBy('created_at')
    .orderBy('id')
    .executeTakeFirst();
  if (active) throw ApiError.conflict(`order has an active payment attempt: ${active.id}`);
}

/** Unpaid orders only have refunds when their split is being canceled. */
async function requireNoCheckoutRefund(
  db: Kysely<OrdersDatabase>, tenantId: string, orderId: string,
): Promise<void> {
  const refund = await db.selectFrom('orders_refunds').select('id')
    .where('tenant_id', '=', tenantId).where('order_id', '=', orderId)
    .orderBy('created_at').orderBy('id').executeTakeFirst();
  if (refund) throw ApiError.conflict('split cancellation has started; finish refunding the approved payments');
}

/**
 * Acquire the order row as the serialization point for operations that race
 * with provider payment creation. The monotonic timestamp makes this a real
 * compare-and-swap even when two requests read the same row in the same
 * millisecond. Callers must hold a database transaction around the claim and
 * the mutation/payment-attempt insert it protects.
 */
function nextOrderUpdatedAt(after: string): string {
  const parsed = Date.parse(after);
  return new Date(Math.max(Date.now(), Number.isNaN(parsed) ? 0 : parsed + 1)).toISOString();
}

async function claimOrderForPaymentArbitration(
  db: Kysely<OrdersDatabase>,
  order: OrderRow,
): Promise<OrderRow> {
  const claimedAt = nextOrderUpdatedAt(order.updated_at);
  const changed = await db
    .updateTable('orders_orders')
    .set({ updated_at: claimedAt })
    .where('tenant_id', '=', order.tenant_id)
    .where('id', '=', order.id)
    .where('status', '=', order.status)
    .where('updated_at', '=', order.updated_at)
    .executeTakeFirst();
  if (changed.numUpdatedRows === 0n) {
    const current = await getOrderRow(db, order.tenant_id, order.id);
    if (!current) throw ApiError.notFound(`order not found: ${order.id}`);
    throw ApiError.conflict('order changed concurrently with payment arbitration', {
      expectedStatus: order.status,
      currentStatus: current.status,
    });
  }
  return { ...order, updated_at: claimedAt };
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
  const now = nextOrderUpdatedAt(order.updated_at);
  const totalCents = totalWithTip(totals.totalCents, order.tip_cents);
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
      total_cents: totalCents,
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
    total_cents: totalCents,
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
  registerId?: string;
  deviceId?: string;
  cashierId?: string;
  cashSessionId?: string;
  source?: OrderSource;
  sourceOrderId?: string;
  lines?: LineInputSvc[];
  discountBps?: number;
  discountFixedCents?: number;
  taxBps?: number;
  /** Trusted composition-only tax allocation for split bar checks; never a public input. */
  allocatedTaxCents?: number;
  tipCents?: number;
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
  const tipCents = input.tipCents ?? 0;
  const taxCents = input.allocatedTaxCents ?? totals.taxCents;
  if (!Number.isSafeInteger(taxCents) || taxCents < 0) throw ApiError.badRequest('Invalid allocated tax');
  const totalCents = totalWithTip(totals.totalCents - totals.taxCents + taxCents, tipCents);
  const order: OrderRow = {
    id: id(),
    tenant_id: tenantId,
    channel: input.channel,
    status: 'draft',
    customer_id: input.customerId ?? null,
    show_id: input.showId ?? null,
    register_id: input.registerId ?? null,
    device_id: input.deviceId ?? null,
    cashier_id: input.cashierId ?? null,
    cash_session_id: input.cashSessionId ?? null,
    source: input.source ?? 'mags',
    source_order_id: input.sourceOrderId ?? null,
    discount_bps: input.discountBps ?? null,
    discount_fixed_cents: input.discountFixedCents ?? null,
    tax_bps: input.taxBps ?? null,
    subtotal_cents: totals.subtotalCents,
    discount_cents: totals.discountCents,
    tax_cents: taxCents,
    tip_cents: tipCents,
    total_cents: totalCents,
    receipt_number: newReceiptNumber(now),
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
  registerId?: string | null;
  deviceId?: string | null;
  cashierId?: string | null;
  cashSessionId?: string | null;
  note?: string | null;
  discountBps?: number | null;
  discountFixedCents?: number | null;
  taxBps?: number | null;
  tipCents?: number;
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
  return ctx.db.transaction().execute(async (trx) => {
    let existing = await requireOrder(trx, tenantId, orderId);
    if (existing.status !== 'draft') {
      throw ApiError.conflict(`only draft orders can be edited (status: ${existing.status})`);
    }
    existing = await claimOrderForPaymentArbitration(trx, existing);
    await requireNoActivePaymentAttempt(trx, tenantId, orderId);
    if (await capturedTotal(trx, tenantId, orderId) > 0) {
      throw ApiError.conflict('this order has captured payments; finish the balance before refunding or returning it');
    }
    const now = existing.updated_at;
    await trx
      .updateTable('orders_orders')
      .set({
        customer_id: patch.customerId !== undefined ? patch.customerId : existing.customer_id,
        show_id: patch.showId !== undefined ? patch.showId : existing.show_id,
        register_id: patch.registerId !== undefined ? patch.registerId : existing.register_id,
        device_id: patch.deviceId !== undefined ? patch.deviceId : existing.device_id,
        cashier_id: patch.cashierId !== undefined ? patch.cashierId : existing.cashier_id,
        cash_session_id:
          patch.cashSessionId !== undefined ? patch.cashSessionId : existing.cash_session_id,
        note: patch.note !== undefined ? patch.note : existing.note,
        discount_bps: patch.discountBps !== undefined ? patch.discountBps : existing.discount_bps,
        discount_fixed_cents:
          patch.discountFixedCents !== undefined ? patch.discountFixedCents : existing.discount_fixed_cents,
        tax_bps: patch.taxBps !== undefined ? patch.taxBps : existing.tax_bps,
        tip_cents: patch.tipCents !== undefined ? patch.tipCents : existing.tip_cents,
        updated_at: now,
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', orderId)
      .where('status', '=', 'draft')
      .execute();

    if (patch.lines !== undefined) {
      await trx
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
        await trx.insertInto('orders_lines').values(line).execute();
      }
    }

    const reloaded = await requireOrder(trx, tenantId, orderId);
    await recomputeTotals(trx, tenantId, reloaded);
    await audit(asCoreDb(trx), tenantId, actor, 'orders.order.updated', 'orders.order', orderId, {});
    const result = await getOrder(trx, tenantId, orderId);
    if (!result) throw ApiError.notFound(`order not found: ${orderId}`);
    return result;
  });
}

/** Delete a DRAFT order (409 otherwise). Paid orders are refunded, never deleted. */
export async function deleteOrder(
  ctx: OrdersCtx,
  tenantId: string,
  actor: string,
  orderId: string,
): Promise<void> {
  await ctx.db.transaction().execute(async (trx) => {
    let existing = await requireOrder(trx, tenantId, orderId);
    if (existing.status !== 'draft') {
      throw ApiError.conflict(`only draft orders can be deleted (status: ${existing.status})`);
    }
    existing = await claimOrderForPaymentArbitration(trx, existing);
    await requireNoActivePaymentAttempt(trx, tenantId, orderId);
    if (await capturedTotal(trx, tenantId, orderId) > 0) {
      throw ApiError.conflict('this order has captured payments; finish the balance before refunding or returning it');
    }
    await trx
      .deleteFrom('orders_lines')
      .where('tenant_id', '=', tenantId)
      .where('order_id', '=', orderId)
      .execute();
    const deleted = await trx
      .deleteFrom('orders_orders')
      .where('tenant_id', '=', tenantId)
      .where('id', '=', orderId)
      .where('status', '=', existing.status)
      .where('updated_at', '=', existing.updated_at)
      .executeTakeFirst();
    if (deleted.numDeletedRows === 0n) {
      throw ApiError.conflict('order changed concurrently while it was being deleted');
    }
    await audit(asCoreDb(trx), tenantId, actor, 'orders.order.deleted', 'orders.order', orderId, {});
  });
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
  const changed = await ctx.db
    .updateTable('orders_orders')
    .set(patch)
    .where('tenant_id', '=', order.tenant_id)
    .where('id', '=', order.id)
    .where('status', '=', order.status)
    .executeTakeFirst();
  if (changed.numUpdatedRows === 0n) {
    const current = await getOrderRow(ctx.db, order.tenant_id, order.id);
    if (!current) throw ApiError.notFound(`order not found: ${order.id}`);
    throw ApiError.conflict(
      `order status changed concurrently (${order.status} -> ${current.status})`,
      { expectedStatus: order.status, currentStatus: current.status },
    );
  }
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
  const next = await ctx.db.transaction().execute(async (trx) => {
    let order = await requireOrder(trx, tenantId, orderId);
    if (order.status !== 'draft' && order.status !== 'reserved') {
      throw ApiError.conflict(`only draft/reserved orders can be canceled (status: ${order.status})`);
    }
    order = await claimOrderForPaymentArbitration(trx, order);
    await requireNoActivePaymentAttempt(trx, tenantId, orderId);
    if (await capturedTotal(trx, tenantId, orderId) > 0) {
      throw ApiError.conflict('this order has captured payments; finish the balance before refunding or returning it');
    }
    const canceled = await setStatus(
      { db: trx, events: ctx.events },
      order,
      'canceled',
      { canceled_at: nowIso() },
    );
    await audit(asCoreDb(trx), tenantId, actor, 'orders.order.canceled', 'orders.order', orderId, {});
    return canceled;
  });
  await ctx.events.emit(tenantId, 'orders.order.canceled', { v: 1, orderId });
  return toOrderDto(next);
}

/* ================================================================== *
 * Tenders (idempotent)
 * ================================================================== */

export interface AddTenderInputSvc {
  kind: TenderKind;
  amountCents: number;
  cashReceivedCents?: number;
  idempotencyKey: string;
  provider?: string;
  providerRef?: string;
}

async function addTenderRecord(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  actor: string,
  initialOrder: OrderRow,
  input: AddTenderInputSvc,
  beforeCreate?: () => Promise<OrderRow>,
): Promise<{ tender: TenderRow; created: boolean }> {
  let order = initialOrder;
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw ApiError.badRequest('amountCents must be a positive integer');
  }
  if (!['cash', 'external'].includes(input.kind)) {
    throw ApiError.badRequest(
      `${input.kind} tenders require a validated provider or redemption flow`,
    );
  }
  let cashReceivedCents: number | null = null;
  let changeDueCents: number | null = null;
  if (input.kind === 'cash') {
    if (order.channel === 'pos' && !order.cash_session_id) {
      throw ApiError.badRequest('cashSessionId is required for a POS cash tender');
    }
    cashReceivedCents = input.cashReceivedCents ?? input.amountCents;
    if (!Number.isSafeInteger(cashReceivedCents) || cashReceivedCents < input.amountCents) {
      throw ApiError.badRequest('cashReceivedCents must be an integer at least amountCents');
    }
    changeDueCents = cashReceivedCents - input.amountCents;
  } else if (input.cashReceivedCents !== undefined) {
    throw ApiError.badRequest('cashReceivedCents is only valid for cash tenders');
  }
  const existing = await db
    .selectFrom('orders_tenders')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst();
  if (existing) {
    if (
      existing.order_id !== order.id ||
      existing.kind !== input.kind ||
      existing.amount_cents !== input.amountCents ||
      existing.cash_received_cents !== cashReceivedCents ||
      existing.change_due_cents !== changeDueCents ||
      existing.provider !== (input.provider ?? null) ||
      existing.provider_ref !== (input.providerRef ?? null)
    ) {
      throw ApiError.conflict('idempotency key is already bound to a different tender request');
    }
    return { tender: existing, created: false };
  }

  if (beforeCreate) order = await beforeCreate();
  if (order.status !== 'draft' && order.status !== 'reserved') {
    throw ApiError.conflict(`cannot add a tender to an order with status: ${order.status}`);
  }
  await requireNoCheckoutRefund(db, tenantId, order.id);

  if ((await capturedTotal(db, tenantId, order.id)) + input.amountCents > order.total_cents) {
    throw ApiError.conflict('tender amount exceeds the remaining balance');
  }
  const now = nowIso();
  const tender: TenderRow = {
    id: id(),
    tenant_id: tenantId,
    order_id: order.id,
    kind: input.kind,
    amount_cents: input.amountCents,
    cash_received_cents: cashReceivedCents,
    change_due_cents: changeDueCents,
    provider: input.provider ?? null,
    provider_ref: input.providerRef ?? null,
    status: 'captured',
    refunded_cents: 0,
    idempotency_key: input.idempotencyKey,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('orders_tenders').values(tender).execute();
  await audit(asCoreDb(db), tenantId, actor, 'orders.tender.captured', 'orders.tender', tender.id, {
    orderId: order.id,
    amountCents: tender.amount_cents,
    kind: tender.kind,
    cashReceivedCents: tender.cash_received_cents,
    changeDueCents: tender.change_due_cents,
  });
  return { tender, created: true };
}

async function emitTenderCaptured(
  ctx: OrdersCtx,
  order: OrderRow,
  tender: TenderRow,
): Promise<void> {
  await ctx.events.emit(order.tenant_id, 'orders.tender.captured', {
    v: 1,
    cashSessionId: order.cash_session_id,
    orderId: order.id,
    tenderId: tender.id,
    kind: tender.kind,
    amountCents: tender.amount_cents,
    cashReceivedCents: tender.cash_received_cents,
    changeDueCents: tender.change_due_cents,
    occurredAt: tender.created_at,
  });
}

/** Add a captured tender. Idempotent on (tenant, idempotencyKey): a repeat call returns the existing tender. */
export async function addTender(
  ctx: OrdersCtx,
  tenantId: string,
  actor: string,
  orderId: string,
  input: AddTenderInputSvc,
): Promise<{ tender: TenderRow; created: boolean }> {
  const committed = await ctx.db.transaction().execute(async (trx) => {
    let order = await requireOrder(trx, tenantId, orderId);
    const result = await addTenderRecord(trx, tenantId, actor, order, input, async () => {
      order = await claimOrderForPaymentArbitration(trx, order);
      await requireNoActivePaymentAttempt(trx, tenantId, orderId);
      return order;
    });
    return { order, ...result };
  });
  if (committed.created) await emitTenderCaptured(ctx, committed.order, committed.tender);
  return { tender: committed.tender, created: committed.created };
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

export interface PayManualInputSvc {
  /** Optional tenders to capture before flipping to paid (cash/external lane). */
  tenders?: AddTenderInputSvc[];
}

/**
 * Pay-manual is one atomic commit: every inline tender and the paid transition
 * succeeds together, or none of them is retained. Events are emitted only
 * after the transaction commits.
 */
export async function payOrder(
  ctx: OrdersCtx,
  tenantId: string,
  actor: string,
  orderId: string,
  input: PayManualInputSvc = {},
): Promise<OrderDto> {
  const committed = await ctx.db.transaction().execute(async (trx) => {
    let order = await requireOrder(trx, tenantId, orderId);
    if (order.status !== 'draft' && order.status !== 'reserved') {
      throw ApiError.conflict(`only draft/reserved orders can be paid (status: ${order.status})`);
    }
    order = await claimOrderForPaymentArbitration(trx, order);
    await requireNoActivePaymentAttempt(trx, tenantId, orderId);
    await requireNoCheckoutRefund(trx, tenantId, orderId);

    const createdTenders: TenderRow[] = [];
    for (const tenderInput of input.tenders ?? []) {
      const result = await addTenderRecord(trx, tenantId, actor, order, tenderInput);
      if (result.created) createdTenders.push(result.tender);
    }
    const captured = await capturedTotal(trx, tenantId, orderId);
    if (captured !== order.total_cents) {
      throw ApiError.conflict(
        `captured tenders (${captured}) do not equal order total (${order.total_cents})`,
      );
    }

    const next = await setStatus(
      { db: trx, events: ctx.events },
      order,
      'paid',
      { paid_at: nowIso() },
    );
    const lines = await getLineRows(trx, tenantId, orderId);
    await audit(asCoreDb(trx), tenantId, actor, 'orders.order.paid', 'orders.order', orderId, {
      totalCents: order.total_cents,
    });
    return { order, next, lines, createdTenders };
  });

  for (const tender of committed.createdTenders) {
    await emitTenderCaptured(ctx, committed.order, tender);
  }
  await ctx.events.emit(tenantId, 'orders.order.paid', {
    v: 1,
    orderId,
    totalCents: committed.order.total_cents,
    lines: stockLines(committed.lines),
  });
  return toOrderDto(committed.next);
}

/* ================================================================== *
 * Checkout sessions + provider webhooks
 * ================================================================== */

export type ProviderRegistry = ReadonlyMap<string, CheckoutProvider>;

export const PAYMENT_ATTEMPT_TRANSITIONS: Record<PaymentAttemptStatus, PaymentAttemptStatus[]> = {
  pending: ['processing', 'failed', 'canceled'],
  processing: ['succeeded', 'failed', 'canceled'],
  succeeded: [],
  failed: [],
  canceled: [],
};

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

async function getCheckoutSessionById(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  sessionId: string,
): Promise<CheckoutSessionRow | undefined> {
  return db
    .selectFrom('orders_checkout_sessions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', sessionId)
    .executeTakeFirst();
}

export async function getPaymentAttemptRow(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  attemptId: string,
): Promise<PaymentAttemptRow | undefined> {
  return db
    .selectFrom('orders_payment_attempts')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', attemptId)
    .executeTakeFirst();
}

export async function getPaymentAttempt(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  attemptId: string,
): Promise<PaymentAttemptDto | undefined> {
  const row = await getPaymentAttemptRow(db, tenantId, attemptId);
  return row ? toPaymentAttemptDto(row) : undefined;
}

export async function listPaymentAttempts(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  orderId: string,
): Promise<PaymentAttemptDto[]> {
  const rows = await db
    .selectFrom('orders_payment_attempts')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('order_id', '=', orderId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return rows.map(toPaymentAttemptDto);
}

async function transitionPaymentAttempt(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  attempt: PaymentAttemptRow,
  to: PaymentAttemptStatus,
  details: { failureCode?: string | null; failureMessage?: string | null } = {},
): Promise<PaymentAttemptRow> {
  if (attempt.status === to) return attempt;
  if (!PAYMENT_ATTEMPT_TRANSITIONS[attempt.status].includes(to)) {
    throw ApiError.conflict(`illegal payment attempt transition: ${attempt.status} -> ${to}`);
  }
  const now = nowIso();
  const patch: Partial<PaymentAttemptRow> = {
    status: to,
    updated_at: now,
    ...(['succeeded', 'failed', 'canceled'].includes(to) ? { active_order_key: null } : {}),
    ...(to === 'processing' ? { processing_at: now } : {}),
    ...(to === 'succeeded' ? { succeeded_at: now } : {}),
    ...(to === 'failed'
      ? {
          failed_at: now,
          failure_code: details.failureCode ?? 'provider_failed',
          failure_message: details.failureMessage ?? null,
        }
      : {}),
    ...(to === 'canceled' ? { canceled_at: now } : {}),
  };
  const changed = await db
    .updateTable('orders_payment_attempts')
    .set(patch)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', attempt.id)
    .where('status', '=', attempt.status)
    .executeTakeFirst();
  if (changed.numUpdatedRows === 0n) {
    const current = await getPaymentAttemptRow(db, tenantId, attempt.id);
    if (!current) throw ApiError.notFound(`payment attempt not found: ${attempt.id}`);
    if (current.status === to) return current;
    throw ApiError.conflict(
      `payment attempt status changed concurrently (${attempt.status} -> ${current.status})`,
      { expectedStatus: attempt.status, currentStatus: current.status },
    );
  }
  return { ...attempt, ...patch } as PaymentAttemptRow;
}

function persistedProviderData(created: CreateSessionResult): string {
  return JSON.stringify({
    flow: created.flow,
    ...(created.flow === 'redirect' ? { redirectUrl: created.redirectUrl } : { terminal: created.terminal }),
    ...(created.providerData ? { providerData: created.providerData } : {}),
  });
}

function parsePersistedProviderData(row: PaymentAttemptRow): {
  flow?: 'redirect' | 'terminal';
  redirectUrl?: string;
  terminal?: { readerId: string; readerStatus?: string; actionStatus?: string };
} {
  if (!row.provider_data) return {};
  try {
    return JSON.parse(row.provider_data) as ReturnType<typeof parsePersistedProviderData>;
  } catch {
    return {};
  }
}

function persistedPreparedProviderData(prepared: PreparedSessionResult): string {
  return JSON.stringify({
    prepared: true,
    ...(prepared.providerData ? { providerData: prepared.providerData } : {}),
  });
}

function hasStartedProviderSession(row: PaymentAttemptRow): boolean {
  const stored = parsePersistedProviderData(row);
  return stored.flow === 'redirect' || stored.flow === 'terminal';
}

function hasTwoPhaseSessionProvider(
  provider: CheckoutProvider,
): provider is CheckoutProvider & Required<Pick<CheckoutProvider, 'prepareSession' | 'startPreparedSession'>> {
  return Boolean(provider.prepareSession && provider.startPreparedSession);
}

export interface CreateCheckoutResult {
  attempt: PaymentAttemptDto;
  session?: CheckoutSessionRow;
  created: boolean;
  flow?: 'redirect' | 'terminal';
  redirectUrl?: string;
  terminal?: { readerId: string; readerStatus?: string; actionStatus?: string };
}

export interface CreatePaymentAttemptInputSvc {
  provider: string;
  idempotencyKey: string;
  returnUrl?: string;
  readerId?: string;
  /** Explicit split portion; omitted means the remaining balance. */
  amountCents?: number;
}

async function checkoutResultFromAttempt(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  attempt: PaymentAttemptRow,
  created: boolean,
): Promise<CreateCheckoutResult> {
  const stored = parsePersistedProviderData(attempt);
  const session = attempt.checkout_session_id
    ? await getCheckoutSessionById(db, tenantId, attempt.checkout_session_id)
    : undefined;
  return {
    attempt: toPaymentAttemptDto(attempt),
    ...(session ? { session } : {}),
    created,
    ...stored,
  };
}

function paymentSnapshot(
  order: OrderRow,
  attempt: PaymentAttemptRow,
  lines: readonly OrderLineRow[],
  returnUrl?: string,
) {
  return {
    tenantId: attempt.tenant_id,
    orderId: order.id,
    paymentAttemptId: attempt.id,
    idempotencyKey: `${attempt.tenant_id}:${attempt.idempotency_key}`,
    amountCents: attempt.amount_cents,
    ...(returnUrl ? { returnUrl } : {}),
    ...(attempt.reader_id ? { readerId: attempt.reader_id } : {}),
    lineItems: lines.map((line) => ({
      description: line.description,
      qty: line.qty,
      unitPriceCents: line.unit_price_cents,
    })),
  };
}

async function noteUnresolvedPaymentAttempt(
  ctx: OrdersCtx,
  tenantId: string,
  actor: string,
  attempt: PaymentAttemptRow,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : 'provider request outcome is unresolved';
  await ctx.db
    .updateTable('orders_payment_attempts')
    .set({
      failure_code: 'provider_request_unresolved',
      failure_message: message,
      updated_at: nowIso(),
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', attempt.id)
    .where('status', 'in', ['pending', 'processing'])
    .execute();
  await audit(
    asCoreDb(ctx.db),
    tenantId,
    actor,
    'orders.payment_attempt.unresolved',
    'orders.payment_attempt',
    attempt.id,
    { orderId: attempt.order_id, failureCode: 'provider_request_unresolved' },
  );
}

async function ensureCheckoutSession(
  ctx: OrdersCtx,
  tenantId: string,
  actor: string,
  orderId: string,
  provider: CheckoutProvider,
  providerSessionRef: string,
  amountCents: number,
  returnUrl?: string,
): Promise<CheckoutSessionRow> {
  let session = await ctx.db
    .selectFrom('orders_checkout_sessions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('provider_session_ref', '=', providerSessionRef)
    .executeTakeFirst();
  if (session) {
    if (
      session.order_id !== orderId ||
      session.provider !== provider.key ||
      session.amount_cents !== amountCents
    ) {
      throw ApiError.conflict('provider session reference is already bound to different payment facts');
    }
    return session;
  }

  const candidate: CheckoutSessionRow = {
    id: id(),
    tenant_id: tenantId,
    order_id: orderId,
    provider: provider.key,
    provider_session_ref: providerSessionRef,
    status: 'created',
    amount_cents: amountCents,
    return_url: returnUrl ?? null,
    created_at: nowIso(),
    completed_at: null,
  };
  try {
    await ctx.db.insertInto('orders_checkout_sessions').values(candidate).execute();
    session = candidate;
    await audit(
      asCoreDb(ctx.db),
      tenantId,
      actor,
      'orders.checkout_session.created',
      'orders.checkout_session',
      session.id,
      { orderId, provider: provider.key },
    );
  } catch (error) {
    session = await ctx.db
      .selectFrom('orders_checkout_sessions')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('provider_session_ref', '=', providerSessionRef)
      .executeTakeFirst();
    if (!session) throw error;
    if (
      session.order_id !== orderId ||
      session.provider !== provider.key ||
      session.amount_cents !== amountCents
    ) {
      throw ApiError.conflict('provider session reference is already bound to different payment facts');
    }
  }
  return session;
}

async function runTwoPhasePaymentAttempt(
  ctx: OrdersCtx,
  provider: CheckoutProvider & Required<Pick<CheckoutProvider, 'prepareSession' | 'startPreparedSession'>>,
  tenantId: string,
  actor: string,
  order: OrderRow,
  initialAttempt: PaymentAttemptRow,
  created: boolean,
  returnUrl?: string,
): Promise<CreateCheckoutResult> {
  let attempt = initialAttempt;
  if (!['pending', 'processing'].includes(attempt.status) || hasStartedProviderSession(attempt)) {
    return checkoutResultFromAttempt(ctx.db, tenantId, attempt, created);
  }
  const lines = await getLineRows(ctx.db, tenantId, order.id);
  const snapshot = paymentSnapshot(order, attempt, lines, returnUrl);
  let prepared: PreparedSessionResult;
  try {
    prepared = attempt.provider_ref
      ? { providerSessionRef: attempt.provider_ref }
      : await provider.prepareSession(snapshot);
  } catch (error) {
    await noteUnresolvedPaymentAttempt(ctx, tenantId, actor, attempt, error);
    throw error;
  }
  if (!prepared.providerSessionRef) {
    const error = new Error('provider preparation response missing session reference');
    await noteUnresolvedPaymentAttempt(ctx, tenantId, actor, attempt, error);
    throw error;
  }
  if (attempt.provider_ref && attempt.provider_ref !== prepared.providerSessionRef) {
    const error = ApiError.conflict('provider preparation returned a different session reference');
    await noteUnresolvedPaymentAttempt(ctx, tenantId, actor, attempt, error);
    throw error;
  }

  const session = await ensureCheckoutSession(
    ctx,
    tenantId,
    actor,
    order.id,
    provider,
    prepared.providerSessionRef,
    attempt.amount_cents,
    returnUrl,
  );
  await ctx.db
    .updateTable('orders_payment_attempts')
    .set({
      checkout_session_id: session.id,
      provider_ref: prepared.providerSessionRef,
      provider_data: persistedPreparedProviderData(prepared),
      failure_code: null,
      failure_message: null,
      updated_at: nowIso(),
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', attempt.id)
    .where('status', 'in', ['pending', 'processing'])
    .execute();
  attempt = (await getPaymentAttemptRow(ctx.db, tenantId, attempt.id)) ?? attempt;
  if (!['pending', 'processing'].includes(attempt.status)) {
    return checkoutResultFromAttempt(ctx.db, tenantId, attempt, created);
  }
  if (attempt.status === 'pending') {
    attempt = await transitionPaymentAttempt(ctx.db, tenantId, attempt, 'processing');
  }

  let providerResult: CreateSessionResult;
  try {
    providerResult = await provider.startPreparedSession(snapshot, prepared);
  } catch (error) {
    await noteUnresolvedPaymentAttempt(ctx, tenantId, actor, attempt, error);
    throw error;
  }
  if (providerResult.providerSessionRef !== prepared.providerSessionRef) {
    const error = ApiError.conflict('provider start returned a different session reference');
    await noteUnresolvedPaymentAttempt(ctx, tenantId, actor, attempt, error);
    throw error;
  }
  const readerId = providerResult.flow === 'terminal'
    ? providerResult.terminal.readerId
    : attempt.reader_id;
  await ctx.db
    .updateTable('orders_payment_attempts')
    .set({
      provider_data: persistedProviderData(providerResult),
      reader_id: readerId,
      failure_code: null,
      failure_message: null,
      updated_at: nowIso(),
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', attempt.id)
    .where('status', 'in', ['pending', 'processing'])
    .execute();
  attempt = (await getPaymentAttemptRow(ctx.db, tenantId, attempt.id)) ?? attempt;
  await audit(
    asCoreDb(ctx.db),
    tenantId,
    actor,
    'orders.payment_attempt.processing',
    'orders.payment_attempt',
    attempt.id,
    { orderId: order.id, providerRef: prepared.providerSessionRef },
  );
  return checkoutResultFromAttempt(ctx.db, tenantId, attempt, created);
}

/**
 * Create one durable provider payment attempt. The `pending` row is written
 * before transport I/O, then moved to `processing` only after the provider and
 * checkout-session writes succeed. Repeating the same tenant idempotency key
 * returns the original attempt without a second provider call.
 */
export async function createPaymentAttempt(
  ctx: OrdersCtx,
  providers: ProviderRegistry,
  tenantId: string,
  actor: string,
  orderId: string,
  input: CreatePaymentAttemptInputSvc,
): Promise<CreateCheckoutResult> {
  const provider = requireProvider(providers, input.provider);
  if (input.amountCents !== undefined && (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0)) {
    throw ApiError.badRequest('amountCents must be a positive integer');
  }
  let order = await requireOrder(ctx.db, tenantId, orderId);
  let attempt = await ctx.db
    .selectFrom('orders_payment_attempts')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst();
  if (attempt) {
    if (
      attempt.order_id !== orderId ||
      attempt.provider !== provider.key ||
      (input.amountCents !== undefined && attempt.amount_cents !== input.amountCents) ||
      (input.readerId !== undefined && attempt.reader_id !== null && attempt.reader_id !== input.readerId)
    ) {
      throw ApiError.conflict('idempotency key is already bound to a different payment request');
    }
    if (
      hasTwoPhaseSessionProvider(provider) &&
      ['pending', 'processing'].includes(attempt.status) &&
      !hasStartedProviderSession(attempt)
    ) {
      return runTwoPhasePaymentAttempt(
        ctx,
        provider,
        tenantId,
        actor,
        order,
        attempt,
        false,
        input.returnUrl,
      );
    }
    return checkoutResultFromAttempt(ctx.db, tenantId, attempt, false);
  }
  let createdAttempt = false;
  let amountCents: number;
  try {
    const arbitration = await ctx.db.transaction().execute(async (trx) => {
      let currentOrder = await requireOrder(trx, tenantId, orderId);
      const concurrentReplay = await trx
        .selectFrom('orders_payment_attempts')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirst();
      if (concurrentReplay) {
        if (
          concurrentReplay.order_id !== orderId ||
          concurrentReplay.provider !== provider.key ||
          (input.amountCents !== undefined && concurrentReplay.amount_cents !== input.amountCents) ||
          (input.readerId !== undefined &&
            concurrentReplay.reader_id !== null &&
            concurrentReplay.reader_id !== input.readerId)
        ) {
          throw ApiError.conflict('idempotency key is already bound to a different payment request');
        }
        return { order: currentOrder, attempt: concurrentReplay, created: false };
      }
      if (currentOrder.status !== 'draft' && currentOrder.status !== 'reserved') {
        throw ApiError.conflict(
          `checkout requires an unpaid order (status: ${currentOrder.status})`,
        );
      }

      currentOrder = await claimOrderForPaymentArbitration(trx, currentOrder);
      await requireNoCheckoutRefund(trx, tenantId, orderId);
      const captured = await capturedTotal(trx, tenantId, orderId);
      const remainingCents = currentOrder.total_cents - captured;
      if (!Number.isSafeInteger(remainingCents) || remainingCents <= 0) {
        throw ApiError.conflict('order has no positive untendered balance');
      }
      const requestedCents = input.amountCents ?? remainingCents;
      if (requestedCents > remainingCents) throw ApiError.conflict('card amount exceeds the remaining balance');
      const active = await trx
        .selectFrom('orders_payment_attempts')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('order_id', '=', orderId)
        .where('status', 'in', ['pending', 'processing'])
        .orderBy('created_at')
        .orderBy('id')
        .executeTakeFirst();
      if (active) {
        throw ApiError.conflict(`order already has an active payment attempt: ${active.id}`);
      }

      const now = nowIso();
      const candidate: PaymentAttemptRow = {
        id: id(),
        tenant_id: tenantId,
        order_id: orderId,
        checkout_session_id: null,
        provider: provider.key,
        provider_ref: null,
        status: 'pending',
        active_order_key: JSON.stringify([tenantId, orderId]),
        amount_cents: requestedCents,
        idempotency_key: input.idempotencyKey,
        reader_id: input.readerId ?? null,
        provider_data: null,
        failure_code: null,
        failure_message: null,
        created_at: now,
        updated_at: now,
        processing_at: null,
        succeeded_at: null,
        failed_at: null,
        canceled_at: null,
      };
      await trx.insertInto('orders_payment_attempts').values(candidate).execute();
      await audit(
        asCoreDb(trx),
        tenantId,
        actor,
        'orders.payment_attempt.created',
        'orders.payment_attempt',
        candidate.id,
        { orderId, provider: provider.key, amountCents: requestedCents },
      );
      return { order: currentOrder, attempt: candidate, created: true };
    });
    order = arbitration.order;
    attempt = arbitration.attempt;
    createdAttempt = arbitration.created;
    amountCents = attempt.amount_cents;
  } catch (error) {
    const concurrentReplay = await ctx.db
      .selectFrom('orders_payment_attempts')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirst();
    if (concurrentReplay) {
      if (
        concurrentReplay.order_id !== orderId ||
        concurrentReplay.provider !== provider.key ||
        (input.amountCents !== undefined && concurrentReplay.amount_cents !== input.amountCents) ||
        (input.readerId !== undefined &&
          concurrentReplay.reader_id !== null &&
          concurrentReplay.reader_id !== input.readerId)
      ) {
        throw ApiError.conflict('idempotency key is already bound to a different payment request');
      }
      return checkoutResultFromAttempt(ctx.db, tenantId, concurrentReplay, false);
    }
    const concurrentActive = await ctx.db
      .selectFrom('orders_payment_attempts')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('order_id', '=', orderId)
      .where('status', 'in', ['pending', 'processing'])
      .orderBy('created_at')
      .orderBy('id')
      .executeTakeFirst();
    if (concurrentActive) {
      throw ApiError.conflict(`order already has an active payment attempt: ${concurrentActive.id}`);
    }
    throw error;
  }
  if (!createdAttempt) {
    return checkoutResultFromAttempt(ctx.db, tenantId, attempt, false);
  }

  if (hasTwoPhaseSessionProvider(provider)) {
    return runTwoPhasePaymentAttempt(
      ctx,
      provider,
      tenantId,
      actor,
      order,
      attempt,
      createdAttempt,
      input.returnUrl,
    );
  }

  const lines = await getLineRows(ctx.db, tenantId, orderId);
  let providerResult: CreateSessionResult;
  try {
    providerResult = await provider.createSession({
      tenantId,
      orderId,
      paymentAttemptId: attempt.id,
      idempotencyKey: `${tenantId}:${input.idempotencyKey}`,
      amountCents,
      returnUrl: input.returnUrl,
      readerId: input.readerId,
      lineItems: lines.map((line) => ({
        description: line.description,
        qty: line.qty,
        unitPriceCents: line.unit_price_cents,
      })),
    });
  } catch (error) {
    attempt = await transitionPaymentAttempt(ctx.db, tenantId, attempt, 'failed', {
      failureCode: 'provider_request_failed',
      failureMessage: error instanceof Error ? error.message : 'provider request failed',
    });
    await audit(
      asCoreDb(ctx.db),
      tenantId,
      actor,
      'orders.payment_attempt.failed',
      'orders.payment_attempt',
      attempt.id,
      { orderId, failureCode: attempt.failure_code },
    );
    throw error;
  }

  let session = await ctx.db
    .selectFrom('orders_checkout_sessions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', provider.key)
    .where('provider_session_ref', '=', providerResult.providerSessionRef)
    .executeTakeFirst();
  if (session && session.order_id !== orderId) {
    attempt = await transitionPaymentAttempt(ctx.db, tenantId, attempt, 'failed', {
      failureCode: 'provider_reference_conflict',
      failureMessage: 'provider session reference is already bound to another order',
    });
    throw ApiError.conflict('provider session reference is already bound to another order');
  }
  if (!session) {
    session = {
      id: id(),
      tenant_id: tenantId,
      order_id: orderId,
      provider: provider.key,
      provider_session_ref: providerResult.providerSessionRef,
      status: 'created',
      amount_cents: amountCents,
      return_url: input.returnUrl ?? null,
      created_at: nowIso(),
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
  }

  attempt = await transitionPaymentAttempt(ctx.db, tenantId, attempt, 'processing');
  const readerId = providerResult.flow === 'terminal' ? providerResult.terminal.readerId : input.readerId ?? null;
  const providerData = persistedProviderData(providerResult);
  await ctx.db
    .updateTable('orders_payment_attempts')
    .set({
      checkout_session_id: session.id,
      provider_ref: providerResult.providerSessionRef,
      reader_id: readerId,
      provider_data: providerData,
      updated_at: nowIso(),
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', attempt.id)
    .execute();
  attempt = {
    ...attempt,
    checkout_session_id: session.id,
    provider_ref: providerResult.providerSessionRef,
    reader_id: readerId,
    provider_data: providerData,
  };
  await audit(
    asCoreDb(ctx.db),
    tenantId,
    actor,
    'orders.payment_attempt.processing',
    'orders.payment_attempt',
    attempt.id,
    { orderId, providerRef: providerResult.providerSessionRef },
  );
  return checkoutResultFromAttempt(ctx.db, tenantId, attempt, createdAttempt);
}

export async function createCheckoutSession(
  ctx: OrdersCtx,
  providers: ProviderRegistry,
  tenantId: string,
  actor: string,
  orderId: string,
  providerKey: string,
  returnUrl?: string,
  options: { idempotencyKey?: string; readerId?: string } = {},
): Promise<CreateCheckoutResult> {
  return createPaymentAttempt(ctx, providers, tenantId, actor, orderId, {
    provider: providerKey,
    idempotencyKey: options.idempotencyKey ?? `checkout:${providerKey}:${orderId}:${id()}`,
    returnUrl,
    readerId: options.readerId,
  });
}

export async function cancelPaymentAttempt(
  ctx: OrdersCtx,
  providers: ProviderRegistry,
  tenantId: string,
  actor: string,
  attemptId: string,
): Promise<PaymentAttemptDto> {
  let attempt = await getPaymentAttemptRow(ctx.db, tenantId, attemptId);
  if (!attempt) throw ApiError.notFound(`payment attempt not found: ${attemptId}`);
  if (attempt.status === 'canceled') return toPaymentAttemptDto(attempt);
  if (attempt.status !== 'pending' && attempt.status !== 'processing') {
    throw ApiError.conflict(`cannot cancel a ${attempt.status} payment attempt`);
  }

  const originalStatus = attempt.status;
  const provider = requireProvider(providers, attempt.provider);
  if (!attempt.provider_ref && hasTwoPhaseSessionProvider(provider)) {
    const order = await requireOrder(ctx.db, tenantId, attempt.order_id);
    const lines = await getLineRows(ctx.db, tenantId, order.id);
    const snapshot = paymentSnapshot(order, attempt, lines);
    let prepared: PreparedSessionResult;
    try {
      prepared = await provider.prepareSession(snapshot);
    } catch (error) {
      await noteUnresolvedPaymentAttempt(ctx, tenantId, actor, attempt, error);
      throw error;
    }
    const session = await ensureCheckoutSession(
      ctx,
      tenantId,
      actor,
      order.id,
      provider,
      prepared.providerSessionRef,
      attempt.amount_cents,
    );
    await ctx.db
      .updateTable('orders_payment_attempts')
      .set({
        checkout_session_id: session.id,
        provider_ref: prepared.providerSessionRef,
        provider_data: persistedPreparedProviderData(prepared),
        updated_at: nowIso(),
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', attempt.id)
      .where('status', '=', attempt.status)
      .execute();
    attempt = (await getPaymentAttemptRow(ctx.db, tenantId, attempt.id)) ?? attempt;
  }

  if (attempt.provider_ref) {
    if (!provider.cancelSession) {
      throw new ApiError(
        501,
        `checkout provider cannot cancel active sessions: ${attempt.provider}`,
        'provider_cancel_not_configured',
      );
    }
    await provider.cancelSession({
      providerSessionRef: attempt.provider_ref,
      ...(originalStatus === 'processing' && attempt.reader_id
        ? { readerId: attempt.reader_id }
        : {}),
      idempotencyKey: `${tenantId}:${attempt.idempotency_key}`,
    });
  }

  attempt = await transitionPaymentAttempt(ctx.db, tenantId, attempt, 'canceled');
  if (attempt.checkout_session_id) {
    await ctx.db
      .updateTable('orders_checkout_sessions')
      .set({ status: 'canceled' })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', attempt.checkout_session_id)
      .execute();
  }
  await audit(
    asCoreDb(ctx.db),
    tenantId,
    actor,
    'orders.payment_attempt.canceled',
    'orders.payment_attempt',
    attempt.id,
    { orderId: attempt.order_id },
  );
  return toPaymentAttemptDto(attempt);
}

export type WebhookOutcome =
  | 'paid'
  | 'partially_paid'
  | 'payment_failed'
  | 'payment_canceled'
  | 'attempt_canceled'
  | 'amount_mismatch'
  | 'refund_pending'
  | 'refund_completed'
  | 'refund_failed'
  | 'refund_canceled'
  | 'refund_mismatch'
  | 'invalid_signature'
  | 'unknown_session'
  | 'duplicate'
  | 'ignored';

export interface ProcessWebhookResult {
  event: WebhookEventDto;
  outcome: WebhookOutcome;
  orderId?: string;
}

function parseProviderUpdate(
  provider: CheckoutProvider,
  event: Parameters<CheckoutProvider['parseCompletion']>[0],
): ParsedPaymentUpdate | null {
  try {
    if (provider.parsePaymentUpdate) return provider.parsePaymentUpdate(event);
    const completion = provider.parseCompletion(event);
    return { ...completion, status: 'succeeded' };
  } catch {
    return null;
  }
}

async function findAttemptByProviderRef(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  provider: string,
  providerRef: string,
): Promise<PaymentAttemptRow | undefined> {
  return db
    .selectFrom('orders_payment_attempts')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', provider as PaymentAttemptRow['provider'])
    .where('provider_ref', '=', providerRef)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirst();
}

async function failOrCancelAttempt(
  ctx: OrdersCtx,
  tenantId: string,
  attempt: PaymentAttemptRow | undefined,
  status: 'failed' | 'canceled',
  details: { failureCode?: string; failureMessage?: string } = {},
): Promise<void> {
  if (!attempt || (attempt.status !== 'pending' && attempt.status !== 'processing')) return;
  const updated = await transitionPaymentAttempt(ctx.db, tenantId, attempt, status, details);
  if (status === 'canceled' && updated.checkout_session_id) {
    await ctx.db
      .updateTable('orders_checkout_sessions')
      .set({ status: 'canceled' })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', updated.checkout_session_id)
      .execute();
  }
  await audit(
    asCoreDb(ctx.db),
    tenantId,
    'system',
    status === 'failed' ? 'orders.payment_attempt.failed' : 'orders.payment_attempt.canceled',
    'orders.payment_attempt',
    updated.id,
    { orderId: updated.order_id, failureCode: updated.failure_code },
  );
}

async function finalizeProviderSuccess(
  ctx: OrdersCtx,
  tenantId: string,
  providerKey: string,
  session: CheckoutSessionRow,
  attempt: PaymentAttemptRow | undefined,
  update: Required<Pick<ParsedPaymentUpdate, 'amountCents' | 'tenderRef'>>,
): Promise<'paid' | 'partially_paid' | 'amount_mismatch' | 'attempt_canceled' | 'ignored'> {
  if (attempt?.status === 'canceled') return 'attempt_canceled';
  if (attempt?.status === 'failed') return 'ignored';

  const result = await ctx.db.transaction().execute(async (trx) => {
    const order = await getOrderRow(trx, tenantId, session.order_id);
    if (!order) return { outcome: 'ignored' as const };
    const currentAttempt = attempt ? await getPaymentAttemptRow(trx, tenantId, attempt.id) : undefined;
    if (currentAttempt?.status === 'canceled') return { outcome: 'attempt_canceled' as const };
    if (currentAttempt?.status === 'failed') return { outcome: 'ignored' as const };

    const tenderKey = `${providerKey}:${update.tenderRef}`;
    const existingTender = await trx
      .selectFrom('orders_tenders')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('idempotency_key', '=', tenderKey)
      .executeTakeFirst();
    if (existingTender) {
      if (
        existingTender.order_id !== order.id ||
        existingTender.amount_cents !== update.amountCents ||
        existingTender.status !== 'captured'
      ) {
        return { outcome: 'amount_mismatch' as const };
      }
      if (order.status === 'paid') return { outcome: 'paid' as const };
    }

    if (order.status !== 'draft' && order.status !== 'reserved') {
      return { outcome: 'ignored' as const };
    }
    const captured = await capturedTotal(trx, tenantId, order.id);
    if (
      update.amountCents !== session.amount_cents ||
      captured + (existingTender ? 0 : update.amountCents) > order.total_cents
    ) {
      return { outcome: 'amount_mismatch' as const };
    }

    const now = nowIso();
    if (!existingTender) {
      const tender: TenderRow = {
        id: id(),
        tenant_id: tenantId,
        order_id: order.id,
        kind: 'provider',
        amount_cents: update.amountCents,
        cash_received_cents: null,
        change_due_cents: null,
        provider: providerKey,
        provider_ref: update.tenderRef,
        status: 'captured',
        refunded_cents: 0,
        idempotency_key: tenderKey,
        created_at: now,
        updated_at: now,
      };
      await trx.insertInto('orders_tenders').values(tender).execute();
      await audit(asCoreDb(trx), tenantId, 'system', 'orders.tender.captured', 'orders.tender', tender.id, {
        orderId: order.id,
        amountCents: tender.amount_cents,
        kind: tender.kind,
      });
    }
    await trx
      .updateTable('orders_checkout_sessions')
      .set({ status: 'completed', completed_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', session.id)
      .execute();
    if (currentAttempt && currentAttempt.status !== 'succeeded') {
      const succeeded = await transitionPaymentAttempt(trx, tenantId, currentAttempt, 'succeeded');
      await trx.updateTable('orders_payment_attempts').set({
        provider_data: JSON.stringify({ ...JSON.parse(currentAttempt.provider_data ?? '{}'), paymentTenderRef: update.tenderRef }),
      }).where('tenant_id', '=', tenantId).where('id', '=', succeeded.id).execute();
      await audit(
        asCoreDb(trx),
        tenantId,
        'system',
        'orders.payment_attempt.succeeded',
        'orders.payment_attempt',
        succeeded.id,
        { orderId: order.id, amountCents: update.amountCents },
      );
    }
    if (captured + (existingTender ? 0 : update.amountCents) < order.total_cents) {
      return { outcome: 'partially_paid' as const };
    }
    const paidOrder = await setStatus(
      { db: trx, events: ctx.events },
      order,
      'paid',
      { paid_at: now },
    );
    await audit(asCoreDb(trx), tenantId, 'system', 'orders.order.paid', 'orders.order', order.id, {
      totalCents: order.total_cents,
    });
    const lines = await getLineRows(trx, tenantId, order.id);
    return { outcome: 'paid' as const, emit: true, order: paidOrder, lines };
  });

  if (result.outcome === 'paid' && result.emit) {
    await ctx.events.emit(tenantId, 'orders.order.paid', {
      v: 1,
      orderId: result.order.id,
      totalCents: result.order.total_cents,
      lines: stockLines(result.lines),
    });
  }
  return result.outcome;
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
    .where('provider', '=', providerKey)
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

  const refundUpdate = provider.parseRefundUpdate?.(verified.event) ?? null;
  if (refundUpdate) {
    const reconciled = await reconcileProviderRefundWebhook(
      ctx,
      tenantId,
      providerKey,
      refundUpdate,
    );
    return record(true, reconciled.processed, reconciled.outcome, reconciled.orderId);
  }

  const update = parseProviderUpdate(provider, verified.event);
  if (!update) return record(true, false, 'ignored');

  const session = await ctx.db
    .selectFrom('orders_checkout_sessions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', provider.key)
    .where('provider_session_ref', '=', update.providerSessionRef)
    .executeTakeFirst();
  if (!session) {
    return record(true, false, 'unknown_session');
  }

  const order = await getOrderRow(ctx.db, tenantId, session.order_id);
  if (!order) {
    return record(true, false, 'unknown_session', session.order_id);
  }

  const attempt = await findAttemptByProviderRef(
    ctx.db,
    tenantId,
    providerKey,
    update.providerSessionRef,
  );

  if (update.status === 'failed') {
    await failOrCancelAttempt(ctx, tenantId, attempt, 'failed', {
      failureCode: update.failureCode,
      failureMessage: update.failureMessage,
    });
    return record(true, true, 'payment_failed', order.id);
  }
  if (update.status === 'canceled') {
    await failOrCancelAttempt(ctx, tenantId, attempt, 'canceled');
    return record(true, true, 'payment_canceled', order.id);
  }
  if (!Number.isInteger(update.amountCents) || !update.tenderRef) {
    return record(true, false, 'ignored', order.id);
  }

  const outcome = await finalizeProviderSuccess(ctx, tenantId, providerKey, session, attempt, {
    amountCents: update.amountCents as number,
    tenderRef: update.tenderRef,
  });
  if (outcome === 'amount_mismatch') {
    await failOrCancelAttempt(ctx, tenantId, attempt, 'failed', {
      failureCode: 'amount_mismatch',
      failureMessage: `received ${update.amountCents}; expected ${session.amount_cents}`,
    });
    await ctx.events.emit(tenantId, 'orders.payment.mismatched', {
      v: 1,
      orderId: order.id,
      sessionId: session.id,
      expectedCents: session.amount_cents,
      receivedCents: update.amountCents,
    });
    return record(true, true, 'amount_mismatch', order.id);
  }
  return record(true, outcome === 'paid' || outcome === 'partially_paid', outcome, order.id);
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
  idempotencyKey: string;
  cashSessionId?: string;
  amountCents: number;
  reason?: string;
  lines: RefundLineInputSvc[];
}

export interface RefundResult {
  refund: RefundRow;
  lines: RefundLineRow[];
  order: OrderDto;
  created: boolean;
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
    .where('r.status', '=', 'completed')
    .execute();
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.line_id, (map.get(r.line_id) ?? 0) + r.qty);
  return map;
}

/**
 * Quantities already committed or owned by an in-flight provider refund.
 * Excluding the current refund lets its signed completion validate the same
 * immutable line facts without allowing another tender to claim them first.
 */
async function unavailableReturnQtyByLine(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  orderId: string,
  excludeRefundId?: string,
): Promise<Map<string, number>> {
  const base = db
    .selectFrom('orders_refund_lines as rl')
    .innerJoin('orders_refunds as r', 'r.id', 'rl.refund_id')
    .select(['rl.line_id as line_id', 'rl.qty as qty'])
    .where('rl.tenant_id', '=', tenantId)
    .where('r.order_id', '=', orderId)
    .where('r.status', 'in', ['completed', 'pending']);
  const rows = excludeRefundId
    ? await base.where('r.id', '!=', excludeRefundId).execute()
    : await base.execute();
  const map = new Map<string, number>();
  for (const row of rows) map.set(row.line_id, (map.get(row.line_id) ?? 0) + row.qty);
  return map;
}

function refundLineFacts(lines: readonly RefundLineInputSvc[]): string[] {
  return lines
    .map((line) => `${line.lineId}\u0000${line.qty}\u0000${line.disposition}`)
    .sort();
}

async function findRefundReplay(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  order: OrderRow,
  input: CreateRefundInputSvc,
): Promise<RefundResult | undefined> {
  const prior = await db
    .selectFrom('orders_refunds')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst();
  if (!prior) return undefined;

  const priorLines = await db
    .selectFrom('orders_refund_lines')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('refund_id', '=', prior.id)
    .orderBy('id')
    .execute();
  const priorFacts = priorLines
    .map((line) => `${line.line_id}\u0000${line.qty}\u0000${line.disposition}`)
    .sort();
  if (
    prior.order_id !== order.id ||
    prior.tender_id !== input.tenderId ||
    prior.cash_session_id !== (input.cashSessionId ?? null) ||
    prior.amount_cents !== input.amountCents ||
    prior.reason !== (input.reason ?? null) ||
    JSON.stringify(priorFacts) !== JSON.stringify(refundLineFacts(input.lines))
  ) {
    throw ApiError.conflict('idempotency key is already bound to a different refund request');
  }
  return { refund: prior, lines: priorLines, order: toOrderDto(order), created: false };
}

interface ValidatedRefundRequest {
  tender: TenderRow;
  orderLines: OrderLineRow[];
  linesById: Map<string, OrderLineRow>;
}

interface ReturnStockLine {
  variationId: string;
  qty: number;
  disposition: RestockDisposition;
  locationId?: string;
}

async function validateNewRefund(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  order: OrderRow,
  input: CreateRefundInputSvc,
  excludeRefundId?: string,
): Promise<ValidatedRefundRequest> {
  const cancelingSplit = input.lines.length === 0 && ['draft', 'reserved'].includes(order.status);
  if (!RETURNABLE.includes(order.status) && !cancelingSplit) {
    throw ApiError.conflict(`order is not refundable (status: ${order.status})`);
  }
  // The bar facade binds these immutable source ids to server-priced checks.
  // Prepared items may receive a money-only adjustment without a stock return.
  const barAdjustment = order.channel === 'pos' && order.source === 'mags' && order.source_order_id?.startsWith('pos:bar:');
  if (!cancelingSplit && !barAdjustment && input.lines.length === 0) {
    throw ApiError.badRequest('a return needs at least one line disposition');
  }
  if (cancelingSplit) {
    await requireNoActivePaymentAttempt(db, tenantId, order.id);
    if (await capturedTotal(db, tenantId, order.id) >= order.total_cents) {
      throw ApiError.conflict('split cancellation requires an incompletely paid order');
    }
  }
  const tender = await db
    .selectFrom('orders_tenders')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('order_id', '=', order.id)
    .where('id', '=', input.tenderId)
    .executeTakeFirst();
  if (!tender) throw ApiError.badRequest(`tender not on this order: ${input.tenderId}`);
  if (!['captured', 'partially_refunded'].includes(tender.status)) {
    throw ApiError.conflict(`tender cannot be refunded (status: ${tender.status})`);
  }
  if (tender.kind === 'gift_card' || tender.kind === 'store_credit') {
    throw ApiError.badRequest(`${tender.kind} refunds require a validated redemption flow`);
  }
  if (tender.kind === 'cash' && !input.cashSessionId) {
    throw ApiError.badRequest('cashSessionId is required for a cash tender refund');
  }
  if (
    (tender.kind === 'provider' || tender.kind === 'card') &&
    (!tender.provider || !tender.provider_ref)
  ) {
    throw ApiError.conflict('provider/card tender is missing processor reconciliation references');
  }
  const refundableCents = tender.amount_cents - tender.refunded_cents;
  if (cancelingSplit && (!isProviderRefundTender(tender) || input.amountCents !== refundableCents)) {
    throw ApiError.badRequest('split cancellation must refund the full remaining amount to the original card');
  }
  if (input.amountCents > refundableCents) {
    throw ApiError.conflict(`refund ${input.amountCents} exceeds refundable ${refundableCents} on tender`);
  }

  const orderLines = await getLineRows(db, tenantId, order.id);
  const linesById = new Map(orderLines.map((line) => [line.id, line]));
  const alreadyUnavailable = await unavailableReturnQtyByLine(
    db,
    tenantId,
    order.id,
    excludeRefundId,
  );
  for (const requested of input.lines) {
    const line = linesById.get(requested.lineId);
    if (!line) throw ApiError.badRequest(`line not on this order: ${requested.lineId}`);
    if (!Number.isFinite(requested.qty) || requested.qty <= 0) {
      throw ApiError.badRequest('refund qty must be positive');
    }
    const outstanding = line.qty - (alreadyUnavailable.get(requested.lineId) ?? 0);
    if (requested.qty > outstanding) {
      throw ApiError.conflict(
        `refund qty ${requested.qty} exceeds returnable ${outstanding} for line ${requested.lineId}`,
      );
    }
  }
  return { tender, orderLines, linesById };
}

function isProviderRefundTender(tender: TenderRow): boolean {
  return tender.kind === 'provider' || tender.kind === 'card';
}

async function succeededAttemptForTender(
  db: Kysely<OrdersDatabase>,
  tenantId: string,
  orderId: string,
  provider: string,
  tenderRef: string,
): Promise<PaymentAttemptRow | undefined> {
  const attempts = await db
    .selectFrom('orders_payment_attempts')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('order_id', '=', orderId)
    .where('provider', '=', provider as PaymentAttemptRow['provider'])
    .where('status', '=', 'succeeded')
    .where('provider_ref', 'is not', null)
    .orderBy('succeeded_at', 'desc')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  const matched = attempts.find((attempt) => attempt.provider_ref === tenderRef ||
    JSON.parse(attempt.provider_data ?? '{}').paymentTenderRef === tenderRef);
  if (matched) return matched;
  if (attempts.length <= 1) return attempts[0];
  throw ApiError.conflict('the selected tender has no unambiguous processor payment reference');
}

async function issueProviderRefund(
  db: Kysely<OrdersDatabase>,
  providers: ProviderRegistry | undefined,
  tenantId: string,
  order: OrderRow,
  tender: TenderRow,
  input: CreateRefundInputSvc,
  refundId: string,
): Promise<ProviderRefundResult> {
  const providerKey = tender.provider as string;
  const tenderPaymentRef = tender.provider_ref as string;
  const provider = requireProvider(providers ?? new Map(), providerKey);
  if (!provider.refund) {
    throw new ApiError(
      501,
      `checkout provider does not support refunds: ${providerKey}`,
      'provider_refund_not_supported',
    );
  }
  const attempt = await succeededAttemptForTender(
    db,
    tenantId,
    order.id,
    providerKey,
    tenderPaymentRef,
  );
  const providerSessionRef = attempt?.provider_ref ?? undefined;
  const expectedPaymentRef = providerSessionRef ?? tenderPaymentRef;
  try {
    const result = await provider.refund({
      tenantId,
      orderId: order.id,
      refundId,
      amountCents: input.amountCents,
      idempotencyKey: `${tenantId}:${input.idempotencyKey}`,
      providerPaymentRef: tenderPaymentRef,
      ...(providerSessionRef ? { providerSessionRef } : {}),
    });
    if (
      typeof result.providerRefundRef !== 'string' ||
      result.providerRefundRef.trim() === '' ||
      !['succeeded', 'pending', 'failed', 'canceled'].includes(result.status) ||
      result.amountCents !== input.amountCents ||
      result.providerPaymentRef !== expectedPaymentRef
    ) {
      throw new Error('provider refund response did not reconcile');
    }
    return result;
  } catch {
    throw new ApiError(
      502,
      'payment provider could not complete the refund',
      'provider_refund_failed',
    );
  }
}

function validateRefundInput(input: CreateRefundInputSvc): void {
  if (!input.idempotencyKey || input.idempotencyKey.trim() === '') {
    throw ApiError.badRequest('idempotencyKey is required');
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw ApiError.badRequest('amountCents must be a positive integer');
  }
  if (!Array.isArray(input.lines)) {
    throw ApiError.badRequest('refund lines must be an array');
  }
  const uniqueLineIds = new Set(input.lines.map((line) => line.lineId));
  if (uniqueLineIds.size !== input.lines.length) {
    throw ApiError.badRequest('refund lines must not contain duplicate lineId values');
  }
}

async function ensurePendingProviderRefund(
  ctx: OrdersCtx,
  tenantId: string,
  actor: string,
  orderId: string,
  input: CreateRefundInputSvc,
): Promise<RefundResult> {
  try {
    return await ctx.db.transaction().execute(async (trx) => {
      let order = await requireOrder(trx, tenantId, orderId);
      const replay = await findRefundReplay(trx, tenantId, order, input);
      if (replay) return replay;
      if (input.lines.length === 0) order = await claimOrderForPaymentArbitration(trx, order);
      const validated = await validateNewRefund(trx, tenantId, order, input);
      if (!isProviderRefundTender(validated.tender) || !validated.tender.provider) {
        throw ApiError.conflict('provider refund preparation requires a processor-backed tender');
      }
      const activeTenderKey = JSON.stringify([tenantId, validated.tender.id]);
      const active = await trx
        .selectFrom('orders_refunds')
        .select(['id'])
        .where('active_tender_key', '=', activeTenderKey)
        .executeTakeFirst();
      if (active) {
        throw ApiError.conflict(`tender already has an active refund: ${active.id}`);
      }

      const now = nowIso();
      const refund: RefundRow = {
        id: id(),
        tenant_id: tenantId,
        order_id: orderId,
        tender_id: input.tenderId,
        cash_session_id: input.cashSessionId ?? null,
        idempotency_key: input.idempotencyKey,
        provider: validated.tender.provider,
        provider_ref: null,
        provider_status: 'pending',
        active_tender_key: activeTenderKey,
        amount_cents: input.amountCents,
        reason: input.reason ?? null,
        status: 'pending',
        created_at: now,
      };
      await trx.insertInto('orders_refunds').values(refund).execute();
      const lines: RefundLineRow[] = input.lines.map((requested) => ({
        id: id(),
        tenant_id: tenantId,
        refund_id: refund.id,
        line_id: requested.lineId,
        qty: requested.qty,
        disposition: requested.disposition,
        created_at: now,
      }));
      for (const line of lines) {
        await trx.insertInto('orders_refund_lines').values(line).execute();
      }
      await audit(
        asCoreDb(trx),
        tenantId,
        actor,
        'orders.refund.pending',
        'orders.refund',
        refund.id,
        { orderId, amountCents: refund.amount_cents, provider: refund.provider },
      );
      return { refund, lines, order: toOrderDto(order), created: true };
    });
  } catch (error) {
    const order = await requireOrder(ctx.db, tenantId, orderId);
    const replay = await findRefundReplay(ctx.db, tenantId, order, input);
    if (replay) return replay;
    throw error;
  }
}

async function persistProviderRefundResult(
  ctx: OrdersCtx,
  tenantId: string,
  refundId: string,
  result: ProviderRefundResult,
): Promise<RefundRow> {
  return ctx.db.transaction().execute(async (trx) => {
    const refund = await trx
      .selectFrom('orders_refunds')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', refundId)
      .executeTakeFirst();
    if (!refund) throw ApiError.notFound(`refund not found: ${refundId}`);
    if (result.amountCents !== refund.amount_cents) {
      throw new ApiError(
        502,
        'payment provider returned a different refund amount for this request',
        'provider_refund_failed',
      );
    }
    if (refund.provider_ref && refund.provider_ref !== result.providerRefundRef) {
      throw new ApiError(
        502,
        'payment provider returned a different refund reference for this request',
        'provider_refund_failed',
      );
    }
    // Validate immutable provider identity before terminal-state replay. A
    // signed callback can win the race with the initiating HTTP response; a
    // different response reference must never be silently accepted afterward.
    if (refund.status === 'completed') return refund;
    if (refund.status !== 'pending') return refund;
    // Stripe's succeeded state is terminal. There is a short, intentional
    // window between persisting that provider fact and committing the local
    // tender/order effects. A stale initiating HTTP response must not move the
    // provider state backward while the signed callback is in that window.
    if (refund.provider_status === 'succeeded' && result.status !== 'succeeded') {
      return refund;
    }
    const reused = await trx
      .selectFrom('orders_refunds')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('provider', '=', refund.provider)
      .where('provider_ref', '=', result.providerRefundRef)
      .where('id', '!=', refund.id)
      .executeTakeFirst();
    if (reused) {
      throw new ApiError(
        502,
        'payment provider returned a refund reference already bound to another request',
        'provider_refund_failed',
      );
    }
    const status = result.status === 'failed' || result.status === 'canceled'
      ? result.status
      : 'pending';
    await trx
      .updateTable('orders_refunds')
      .set({
        provider_ref: result.providerRefundRef,
        provider_status: result.status,
        status,
        ...(status === 'pending' ? {} : { active_tender_key: null }),
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', refund.id)
      .where('status', '=', 'pending')
      .execute();
    return {
      ...refund,
      provider_ref: result.providerRefundRef,
      provider_status: result.status,
      status,
      ...(status === 'pending' ? {} : { active_tender_key: null }),
    };
  });
}

async function commitRefundCompletion(
  ctx: OrdersCtx,
  tenantId: string,
  actor: string,
  orderId: string,
  input: CreateRefundInputSvc,
  providerResult: ProviderRefundResult | undefined,
  created: boolean,
): Promise<{ result: RefundResult; tender: TenderRow | null; stock: ReturnStockLine[] }> {
  return ctx.db.transaction().execute(async (trx) => {
    const currentOrder = await requireOrder(trx, tenantId, orderId);
    const transactionReplay = await findRefundReplay(trx, tenantId, currentOrder, input);
    if (transactionReplay?.refund.status === 'completed') {
      return { result: transactionReplay, tender: null, stock: [] as ReturnStockLine[] };
    }
    if (transactionReplay && transactionReplay.refund.status !== 'pending') {
      throw ApiError.conflict(`refund cannot complete from ${transactionReplay.refund.status}`);
    }
    const current = await validateNewRefund(
      trx,
      tenantId,
      currentOrder,
      input,
      transactionReplay?.refund.id,
    );
    if (providerResult) {
      if (
        !transactionReplay ||
        !isProviderRefundTender(current.tender) ||
        transactionReplay.refund.provider !== current.tender.provider ||
        transactionReplay.refund.provider_ref !== providerResult.providerRefundRef ||
        transactionReplay.refund.provider_status !== 'succeeded'
      ) {
        throw ApiError.conflict('provider refund confirmation does not match the pending refund');
      }
    } else if (isProviderRefundTender(current.tender)) {
      throw ApiError.conflict('provider refund confirmation is required before completing the refund');
    }

    const now = nowIso();
    let refund: RefundRow;
    let refundLines: RefundLineRow[];
    if (transactionReplay) {
      refund = {
        ...transactionReplay.refund,
        status: 'completed',
        provider_status: 'succeeded',
        active_tender_key: null,
      };
      refundLines = transactionReplay.lines;
      const changed = await trx
        .updateTable('orders_refunds')
        .set({ status: 'completed', provider_status: 'succeeded', active_tender_key: null })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', refund.id)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      if (changed.numUpdatedRows === 0n) {
        const replay = await findRefundReplay(trx, tenantId, currentOrder, input);
        if (replay?.refund.status === 'completed') {
          return { result: replay, tender: null, stock: [] as ReturnStockLine[] };
        }
        throw ApiError.conflict('refund status changed while completion was being reconciled');
      }
    } else {
      refund = {
        id: id(),
        tenant_id: tenantId,
        order_id: orderId,
        tender_id: input.tenderId,
        cash_session_id: input.cashSessionId ?? null,
        idempotency_key: input.idempotencyKey,
        provider: null,
        provider_ref: null,
        provider_status: null,
        active_tender_key: null,
        amount_cents: input.amountCents,
        reason: input.reason ?? null,
        status: 'completed',
        created_at: now,
      };
      await trx.insertInto('orders_refunds').values(refund).execute();
      refundLines = input.lines.map((requested) => ({
        id: id(),
        tenant_id: tenantId,
        refund_id: refund.id,
        line_id: requested.lineId,
        qty: requested.qty,
        disposition: requested.disposition,
        created_at: now,
      }));
      for (const line of refundLines) {
        await trx.insertInto('orders_refund_lines').values(line).execute();
      }
    }

    const newRefunded = current.tender.refunded_cents + input.amountCents;
    const tenderStatus = newRefunded >= current.tender.amount_cents
      ? 'refunded'
      : 'partially_refunded';
    await trx
      .updateTable('orders_tenders')
      .set({ refunded_cents: newRefunded, status: tenderStatus, updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', input.tenderId)
      .execute();

    // A canceled partial checkout never sold its inventory. Refund only money,
    // then release reservations once every original card has been reimbursed.
    if (input.lines.length === 0) {
      if (RETURNABLE.includes(currentOrder.status)) {
        await audit(asCoreDb(trx), tenantId, actor, 'orders.refund.created', 'orders.refund', refund.id, {
          orderId, amountCents: input.amountCents, purpose: 'prepared_item_adjustment', providerRef: refund.provider_ref,
        });
        return { result: { refund, lines: refundLines, order: toOrderDto(currentOrder), created }, tender: current.tender, stock: [] };
      }
      const tenders = await listTenders(trx, tenantId, orderId);
      const netPaid = tenders.reduce((sum, tender) => sum + tender.amount_cents - tender.refunded_cents, 0);
      const next = netPaid === 0
        ? await setStatus({ db: trx, events: ctx.events }, currentOrder, 'canceled', { canceled_at: now })
        : currentOrder;
      await audit(asCoreDb(trx), tenantId, actor, 'orders.refund.created', 'orders.refund', refund.id, {
        orderId, amountCents: input.amountCents, purpose: 'split_cancellation', providerRef: refund.provider_ref,
      });
      if (netPaid === 0) await audit(asCoreDb(trx), tenantId, actor, 'orders.order.canceled', 'orders.order', orderId, {});
      return { result: { refund, lines: refundLines, order: toOrderDto(next), created }, tender: current.tender, stock: [] };
    }

    const cumulative = await returnedQtyByLine(trx, tenantId, orderId);
    for (const line of current.orderLines) {
      const returned = cumulative.get(line.id) ?? 0;
      if (returned >= line.qty && line.fulfillment_state !== 'returned') {
        await trx
          .updateTable('orders_lines')
          .set({ fulfillment_state: 'returned', updated_at: now })
          .where('tenant_id', '=', tenantId)
          .where('id', '=', line.id)
          .execute();
      }
    }

    const refreshed = await getLineRows(trx, tenantId, orderId);
    const allReturned = refreshed.every(
      (line) => line.fulfillment_state === 'returned' || line.fulfillment_state === 'canceled',
    );
    const target: OrderStatus = allReturned ? 'returned' : 'partially_returned';
    const next = await setStatus({ db: trx, events: ctx.events }, currentOrder, target);
    const stock: ReturnStockLine[] = refundLines
      .map((line) => {
        const orderLine = current.linesById.get(line.line_id);
        return orderLine?.variation_id
          ? {
              variationId: orderLine.variation_id,
              qty: line.qty,
              disposition: line.disposition,
              ...(orderLine.location_id ? { locationId: orderLine.location_id } : {}),
            }
          : null;
      })
      .filter((line): line is ReturnStockLine => line !== null);

    await audit(asCoreDb(trx), tenantId, actor, 'orders.refund.created', 'orders.refund', refund.id, {
      orderId,
      amountCents: input.amountCents,
      status: target,
      provider: refund.provider,
      providerRef: refund.provider_ref,
    });
    return {
      result: { refund, lines: refundLines, order: toOrderDto(next), created },
      tender: current.tender,
      stock,
    };
  });
}

async function emitCompletedRefund(
  ctx: OrdersCtx,
  tenantId: string,
  committed: Awaited<ReturnType<typeof commitRefundCompletion>>,
): Promise<void> {
  if (!committed.tender) return;
  const { refund } = committed.result;
  await ctx.events.emit(tenantId, 'orders.refund.created', {
    v: 1,
    cashSessionId: refund.cash_session_id,
    orderId: refund.order_id,
    refundId: refund.id,
    tenderId: committed.tender.id,
    tenderKind: committed.tender.kind,
    amountCents: refund.amount_cents,
    occurredAt: refund.created_at,
  });
  if (committed.result.lines.length === 0) {
    if (committed.result.order.status === 'canceled') {
      await ctx.events.emit(tenantId, 'orders.order.canceled', { v: 1, orderId: refund.order_id });
    }
    return;
  }
  await ctx.events.emit(tenantId, 'orders.order.returned', {
    v: 1,
    orderId: refund.order_id,
    returnId: refund.id,
    lines: committed.stock,
  });
}

async function reconcileProviderRefundWebhook(
  ctx: OrdersCtx,
  tenantId: string,
  providerKey: string,
  update: ParsedRefundUpdate,
): Promise<{
  outcome: Extract<
    WebhookOutcome,
    'refund_pending' | 'refund_completed' | 'refund_failed' | 'refund_canceled' | 'refund_mismatch' | 'ignored'
  >;
  processed: boolean;
  orderId?: string;
}> {
  let refund = await ctx.db
    .selectFrom('orders_refunds')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', providerKey)
    .where('provider_ref', '=', update.providerRefundRef)
    .executeTakeFirst();
  if (!refund && update.refundId) {
    refund = await ctx.db
      .selectFrom('orders_refunds')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', update.refundId)
      .executeTakeFirst();
  }
  if (!refund || refund.provider !== providerKey) {
    return { outcome: 'ignored', processed: false };
  }
  const orderId = refund.order_id;
  if (
    (update.tenantId && update.tenantId !== tenantId) ||
    (update.orderId && update.orderId !== orderId) ||
    (update.refundId && update.refundId !== refund.id) ||
    update.amountCents !== refund.amount_cents ||
    (refund.provider_ref && refund.provider_ref !== update.providerRefundRef)
  ) {
    return { outcome: 'refund_mismatch', processed: false, orderId };
  }
  if (refund.status === 'completed') {
    return { outcome: 'refund_completed', processed: true, orderId };
  }
  if (refund.status === 'failed') {
    return { outcome: 'refund_failed', processed: true, orderId };
  }
  if (refund.status === 'canceled') {
    return { outcome: 'refund_canceled', processed: true, orderId };
  }

  const tender = await ctx.db
    .selectFrom('orders_tenders')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', refund.tender_id)
    .where('order_id', '=', orderId)
    .executeTakeFirst();
  if (!tender || tender.provider !== providerKey || !tender.provider_ref) {
    return { outcome: 'refund_mismatch', processed: false, orderId };
  }
  const attempt = await succeededAttemptForTender(ctx.db, tenantId, orderId, providerKey, tender.provider_ref);
  if (
    update.providerPaymentRef !== tender.provider_ref &&
    update.providerPaymentRef !== attempt?.provider_ref
  ) {
    return { outcome: 'refund_mismatch', processed: false, orderId };
  }

  const providerResult: ProviderRefundResult = {
    providerRefundRef: update.providerRefundRef,
    providerPaymentRef: update.providerPaymentRef,
    status: update.status,
    amountCents: update.amountCents,
    ...(update.failureCode ? { failureCode: update.failureCode } : {}),
  };
  refund = await persistProviderRefundResult(ctx, tenantId, refund.id, providerResult);
  if (refund.status === 'failed') {
    return { outcome: 'refund_failed', processed: true, orderId };
  }
  if (refund.status === 'canceled') {
    return { outcome: 'refund_canceled', processed: true, orderId };
  }
  if (update.status === 'pending') {
    return { outcome: 'refund_pending', processed: true, orderId };
  }
  if (refund.status === 'completed') {
    return { outcome: 'refund_completed', processed: true, orderId };
  }

  const lines = await ctx.db
    .selectFrom('orders_refund_lines')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('refund_id', '=', refund.id)
    .orderBy('id')
    .execute();
  const input: CreateRefundInputSvc = {
    tenderId: refund.tender_id,
    idempotencyKey: refund.idempotency_key,
    ...(refund.cash_session_id ? { cashSessionId: refund.cash_session_id } : {}),
    amountCents: refund.amount_cents,
    ...(refund.reason ? { reason: refund.reason } : {}),
    lines: lines.map((line) => ({
      lineId: line.line_id,
      qty: line.qty,
      disposition: line.disposition,
    })),
  };
  const committed = await commitRefundCompletion(
    ctx,
    tenantId,
    'system',
    orderId,
    input,
    providerResult,
    false,
  );
  await emitCompletedRefund(ctx, tenantId, committed);
  return { outcome: 'refund_completed', processed: true, orderId };
}

export async function createRefund(
  ctx: OrdersCtx,
  tenantId: string,
  actor: string,
  orderId: string,
  input: CreateRefundInputSvc,
  providers?: ProviderRegistry,
): Promise<RefundResult> {
  validateRefundInput(input);
  const order = await requireOrder(ctx.db, tenantId, orderId);
  const replay = await findRefundReplay(ctx.db, tenantId, order, input);
  if (replay && replay.refund.status !== 'pending') return replay;

  const validated = await validateNewRefund(
    ctx.db,
    tenantId,
    order,
    input,
    replay?.refund.id,
  );
  if (isProviderRefundTender(validated.tender)) {
    const provider = requireProvider(providers ?? new Map(), validated.tender.provider as string);
    if (!provider.refund) {
      throw new ApiError(
        501,
        `checkout provider does not support refunds: ${validated.tender.provider}`,
        'provider_refund_not_supported',
      );
    }
    const pending = replay ?? await ensurePendingProviderRefund(
      ctx,
      tenantId,
      actor,
      orderId,
      input,
    );
    const providerResult = await issueProviderRefund(
      ctx.db,
      providers,
      tenantId,
      order,
      validated.tender,
      input,
      pending.refund.id,
    );
    const persisted = await persistProviderRefundResult(
      ctx,
      tenantId,
      pending.refund.id,
      providerResult,
    );
    if (persisted.status === 'failed' || persisted.status === 'canceled') {
      throw new ApiError(
        502,
        'payment provider could not complete the refund',
        'provider_refund_failed',
      );
    }
    if (persisted.status === 'pending' && persisted.provider_status !== 'succeeded') {
      const currentOrder = await requireOrder(ctx.db, tenantId, orderId);
      const result = await findRefundReplay(ctx.db, tenantId, currentOrder, input);
      if (!result) throw ApiError.notFound(`refund not found: ${pending.refund.id}`);
      return { ...result, created: pending.created };
    }
    if (persisted.status === 'completed') {
      const currentOrder = await requireOrder(ctx.db, tenantId, orderId);
      const result = await findRefundReplay(ctx.db, tenantId, currentOrder, input);
      if (!result) throw ApiError.notFound(`refund not found: ${pending.refund.id}`);
      return result;
    }
    const completionResult: ProviderRefundResult = persisted.provider_status === 'succeeded'
      ? {
          ...providerResult,
          providerRefundRef: persisted.provider_ref ?? providerResult.providerRefundRef,
          status: 'succeeded',
          amountCents: persisted.amount_cents,
        }
      : providerResult;
    const committed = await commitRefundCompletion(
      ctx,
      tenantId,
      actor,
      orderId,
      input,
      completionResult,
      pending.created,
    );
    await emitCompletedRefund(ctx, tenantId, committed);
    return committed.result;
  }

  const committed = await commitRefundCompletion(
    ctx,
    tenantId,
    actor,
    orderId,
    input,
    undefined,
    true,
  );
  await emitCompletedRefund(ctx, tenantId, committed);
  return committed.result;
}

/**
 * Abort a card split through the durable provider-refund ledger. Empty refund
 * lines are exclusively money reversals on an unpaid order, never returns.
 * Replays reuse pending requests; an explicitly failed refund gets a new key
 * only when the operator requests cancellation again.
 */
export async function cancelSplitPayment(
  ctx: OrdersCtx, providers: ProviderRegistry, tenantId: string, actor: string, orderId: string,
): Promise<{ order: OrderDto; refunds: RefundRow[] }> {
  const order = await requireOrder(ctx.db, tenantId, orderId);
  if (order.status === 'canceled') {
    return { order: toOrderDto(order), refunds: await listRefunds(ctx.db, tenantId, orderId) };
  }
  if (!['draft', 'reserved'].includes(order.status)) {
    throw ApiError.conflict('only an incomplete split can be canceled; use returns for a completed sale');
  }
  await requireNoActivePaymentAttempt(ctx.db, tenantId, orderId);
  const tenders = await listTenders(ctx.db, tenantId, orderId);
  if (!tenders.length || tenders.some((tender) => !isProviderRefundTender(tender))) {
    throw ApiError.conflict('split cancellation requires approved card payments');
  }
  for (const tender of tenders) {
    const amountCents = tender.amount_cents - tender.refunded_cents;
    if (amountCents <= 0) continue;
    const refunds = (await listRefunds(ctx.db, tenantId, orderId)).filter((refund) => refund.tender_id === tender.id);
    const pending = refunds.find((refund) => refund.status === 'pending');
    const failedCount = refunds.filter((refund) => ['failed', 'canceled'].includes(refund.status)).length;
    await createRefund(ctx, tenantId, actor, orderId, {
      tenderId: tender.id, amountCents,
      idempotencyKey: pending?.idempotency_key ?? `cancel-split:${orderId}:${tender.id}:${failedCount}`,
      reason: pending?.reason ?? 'Canceled incomplete split', lines: [],
    }, providers);
  }
  return { order: toOrderDto(await requireOrder(ctx.db, tenantId, orderId)),
    refunds: await listRefunds(ctx.db, tenantId, orderId) };
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
