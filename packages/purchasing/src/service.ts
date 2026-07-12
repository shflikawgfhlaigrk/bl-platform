import type { Kysely } from 'kysely';
import {
  ApiError,
  asCoreDb,
  audit,
  id,
  nowIso,
  type EventBus,
  type Pagination,
} from '@blacklabel/core';
import type {
  PurchasingDatabase,
  ReorderPolicyRow,
  SuggestionRow,
  SuggestionStatus,
  PurchaseOrderRow,
  PurchaseOrderStatus,
  PoLineRow,
  PoEventRow,
  PoEventKind,
  PoDocumentRow,
  ReceiptRow,
  ReceiptLineRow,
  ReceiptCondition,
  DiscrepancyRow,
  DiscrepancyKind,
  VendorBillRow,
  BillExceptionRow,
  BillExceptionKind,
} from './schema';
import { suggestQty, type SuggestQtyInputs } from './suggest';

type Db = Kysely<PurchasingDatabase>;
type Trx = Kysely<PurchasingDatabase>;

/* ================================================================== *
 * Reorder policies
 * ================================================================== */

export interface CreatePolicyInput {
  variationId: string;
  vendorId: string;
  reorderPoint: number;
  safetyStock: number;
  targetDaysOfSupply?: number | null;
  orderMultiple: number;
  minQty: number;
  enabled?: boolean;
  ownerOverrideQty?: number | null;
}

export async function createReorderPolicy(
  db: Db,
  tenantId: string,
  actor: string,
  input: CreatePolicyInput,
): Promise<ReorderPolicyRow> {
  if (!input.variationId.trim()) throw ApiError.badRequest('variationId is required');
  if (!input.vendorId.trim()) throw ApiError.badRequest('vendorId is required');
  if (!Number.isInteger(input.orderMultiple) || input.orderMultiple < 1)
    throw ApiError.badRequest('orderMultiple must be a positive integer');
  const now = nowIso();
  const row: ReorderPolicyRow = {
    id: id(),
    tenant_id: tenantId,
    variation_id: input.variationId,
    vendor_id: input.vendorId,
    reorder_point: input.reorderPoint,
    safety_stock: input.safetyStock,
    target_days_of_supply: input.targetDaysOfSupply ?? null,
    order_multiple: input.orderMultiple,
    min_qty: input.minQty,
    enabled: input.enabled === false ? 0 : 1,
    owner_override_qty: input.ownerOverrideQty ?? null,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('purchasing_reorder_policies').values(row).execute();
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'purchasing.reorder_policy.created',
    'purchasing.reorder_policy',
    row.id,
    { variationId: row.variation_id, vendorId: row.vendor_id },
  );
  return row;
}

export async function getReorderPolicy(
  db: Db,
  tenantId: string,
  policyId: string,
): Promise<ReorderPolicyRow | undefined> {
  return db
    .selectFrom('purchasing_reorder_policies')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', policyId)
    .executeTakeFirst();
}

export async function listReorderPolicies(
  db: Db,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
): Promise<ReorderPolicyRow[]> {
  return db
    .selectFrom('purchasing_reorder_policies')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('variation_id')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export async function updateReorderPolicy(
  db: Db,
  tenantId: string,
  actor: string,
  policyId: string,
  input: Partial<CreatePolicyInput>,
): Promise<ReorderPolicyRow> {
  const existing = await getReorderPolicy(db, tenantId, policyId);
  if (!existing) throw ApiError.notFound(`reorder policy "${policyId}" not found`);
  const patch: Partial<ReorderPolicyRow> = { updated_at: nowIso() };
  if (input.reorderPoint !== undefined) patch.reorder_point = input.reorderPoint;
  if (input.safetyStock !== undefined) patch.safety_stock = input.safetyStock;
  if (input.targetDaysOfSupply !== undefined) patch.target_days_of_supply = input.targetDaysOfSupply;
  if (input.orderMultiple !== undefined) {
    if (!Number.isInteger(input.orderMultiple) || input.orderMultiple < 1)
      throw ApiError.badRequest('orderMultiple must be a positive integer');
    patch.order_multiple = input.orderMultiple;
  }
  if (input.minQty !== undefined) patch.min_qty = input.minQty;
  if (input.enabled !== undefined) patch.enabled = input.enabled ? 1 : 0;
  if (input.ownerOverrideQty !== undefined) patch.owner_override_qty = input.ownerOverrideQty;
  await db
    .updateTable('purchasing_reorder_policies')
    .set(patch)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', policyId)
    .execute();
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'purchasing.reorder_policy.updated',
    'purchasing.reorder_policy',
    policyId,
    { patch },
  );
  return (await getReorderPolicy(db, tenantId, policyId))!;
}

export async function deleteReorderPolicy(
  db: Db,
  tenantId: string,
  actor: string,
  policyId: string,
): Promise<void> {
  const existing = await getReorderPolicy(db, tenantId, policyId);
  if (!existing) throw ApiError.notFound(`reorder policy "${policyId}" not found`);
  await db
    .deleteFrom('purchasing_reorder_policies')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', policyId)
    .execute();
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'purchasing.reorder_policy.deleted',
    'purchasing.reorder_policy',
    policyId,
    null,
  );
}

/* ================================================================== *
 * Suggestions (pure suggestQty + persisted runs)
 * ================================================================== */

export async function runSuggestion(
  db: Db,
  tenantId: string,
  actor: string,
  variationId: string,
  vendorId: string,
  inputs: SuggestQtyInputs,
): Promise<SuggestionRow> {
  if (!variationId.trim() || !vendorId.trim())
    throw ApiError.badRequest('variationId and vendorId are required');
  const { suggestedQty, formulaTrace } = suggestQty(inputs);
  const now = nowIso();
  const row: SuggestionRow = {
    id: id(),
    tenant_id: tenantId,
    variation_id: variationId,
    vendor_id: vendorId,
    inputs: JSON.stringify(inputs),
    suggested_qty: suggestedQty,
    formula_trace: JSON.stringify(formulaTrace),
    status: 'suggested',
    purchase_order_id: null,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('purchasing_suggestions').values(row).execute();
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'purchasing.suggestion.created',
    'purchasing.suggestion',
    row.id,
    { variationId, vendorId, suggestedQty },
  );
  return row;
}

export async function getSuggestion(
  db: Db,
  tenantId: string,
  suggestionId: string,
): Promise<SuggestionRow | undefined> {
  return db
    .selectFrom('purchasing_suggestions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', suggestionId)
    .executeTakeFirst();
}

export async function listSuggestions(
  db: Db,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
  status?: SuggestionStatus,
): Promise<SuggestionRow[]> {
  let q = db.selectFrom('purchasing_suggestions').selectAll().where('tenant_id', '=', tenantId);
  if (status) q = q.where('status', '=', status);
  return q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(page.limit).offset(page.offset).execute();
}

export async function dismissSuggestion(
  db: Db,
  tenantId: string,
  actor: string,
  suggestionId: string,
): Promise<SuggestionRow> {
  const s = await getSuggestion(db, tenantId, suggestionId);
  if (!s) throw ApiError.notFound(`suggestion "${suggestionId}" not found`);
  if (s.status !== 'suggested')
    throw ApiError.conflict(`suggestion is ${s.status}; only "suggested" can be dismissed`);
  await db
    .updateTable('purchasing_suggestions')
    .set({ status: 'dismissed', updated_at: nowIso() })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', suggestionId)
    .execute();
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'purchasing.suggestion.dismissed',
    'purchasing.suggestion',
    suggestionId,
    null,
  );
  return (await getSuggestion(db, tenantId, suggestionId))!;
}

/* ================================================================== *
 * Purchase orders + lines + events + documents
 * ================================================================== */

const LEGAL_TRANSITIONS: Record<PurchaseOrderStatus, PurchaseOrderStatus[]> = {
  draft: ['pending_approval', 'canceled'],
  pending_approval: ['approved', 'draft', 'canceled'],
  approved: ['sent', 'canceled'],
  sent: ['acknowledged', 'partially_received', 'received', 'canceled'],
  acknowledged: ['partially_received', 'received', 'canceled'],
  partially_received: ['partially_received', 'received', 'closed', 'canceled'],
  received: ['closed'],
  closed: [],
  canceled: [],
};

function assertTransition(from: PurchaseOrderStatus, to: PurchaseOrderStatus): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw ApiError.conflict(`illegal PO transition ${from} → ${to}`);
  }
}

async function recordPoEvent(
  trx: Trx,
  tenantId: string,
  poId: string,
  actor: string,
  kind: PoEventKind,
  fromStatus: string | null,
  toStatus: string | null,
  diff: unknown,
): Promise<void> {
  const row: PoEventRow = {
    id: id(),
    tenant_id: tenantId,
    purchase_order_id: poId,
    kind,
    from_status: fromStatus,
    to_status: toStatus,
    diff: diff === undefined || diff === null ? null : JSON.stringify(diff),
    actor,
    created_at: nowIso(),
  };
  await trx.insertInto('purchasing_po_events').values(row).execute();
}

async function recomputeTotals(trx: Trx, tenantId: string, poId: string): Promise<PurchaseOrderRow> {
  const lines = await trx
    .selectFrom('purchasing_po_lines')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('purchase_order_id', '=', poId)
    .execute();
  const subtotal = lines.reduce((sum, l) => sum + l.qty_ordered * l.unit_cost_cents, 0);
  const po = await trx
    .selectFrom('purchasing_purchase_orders')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', poId)
    .executeTakeFirst();
  if (!po) throw ApiError.notFound(`purchase order "${poId}" not found`);
  const total = subtotal + po.freight_cents;
  await trx
    .updateTable('purchasing_purchase_orders')
    .set({ subtotal_cents: subtotal, total_cents: total, updated_at: nowIso() })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', poId)
    .execute();
  return { ...po, subtotal_cents: subtotal, total_cents: total };
}

export interface CreatePoInput {
  vendorId: string;
  shipTo?: string;
  freightCents?: number;
  expectedAt?: string | null;
  lines?: CreatePoLineInput[];
}

export interface CreatePoLineInput {
  variationId: string;
  vendorSku?: string | null;
  qtyOrdered: number;
  unitCostCents: number;
}

export async function createPurchaseOrder(
  db: Db,
  tenantId: string,
  actor: string,
  input: CreatePoInput,
): Promise<PurchaseOrderRow> {
  if (!input.vendorId.trim()) throw ApiError.badRequest('vendorId is required');
  const now = nowIso();
  const poId = id();
  const freight = input.freightCents ?? 0;

  const po = await db.transaction().execute(async (trx) => {
    const row: PurchaseOrderRow = {
      id: poId,
      tenant_id: tenantId,
      vendor_id: input.vendorId,
      status: 'draft',
      expected_at: input.expectedAt ?? null,
      ship_to: input.shipTo ?? 'default',
      subtotal_cents: 0,
      freight_cents: freight,
      total_cents: freight,
      approval_policy_snapshot: null,
      approver: null,
      created_at: now,
      updated_at: now,
    };
    await trx.insertInto('purchasing_purchase_orders').values(row).execute();
    for (const l of input.lines ?? []) {
      await insertLine(trx, tenantId, poId, l);
    }
    return recomputeTotals(trx, tenantId, poId);
  });

  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'purchasing.purchase_order.created',
    'purchasing.purchase_order',
    poId,
    { vendorId: input.vendorId, totalCents: po.total_cents },
  );
  return po;
}

async function insertLine(
  trx: Trx,
  tenantId: string,
  poId: string,
  l: CreatePoLineInput,
): Promise<PoLineRow> {
  if (!Number.isInteger(l.qtyOrdered) || l.qtyOrdered < 1)
    throw ApiError.badRequest('qtyOrdered must be a positive integer');
  if (!Number.isInteger(l.unitCostCents) || l.unitCostCents < 0)
    throw ApiError.badRequest('unitCostCents must be a non-negative integer');
  const now = nowIso();
  const row: PoLineRow = {
    id: id(),
    tenant_id: tenantId,
    purchase_order_id: poId,
    variation_id: l.variationId,
    vendor_sku: l.vendorSku ?? null,
    qty_ordered: l.qtyOrdered,
    unit_cost_cents: l.unitCostCents,
    qty_received: 0,
    qty_backordered: 0,
    line_state: 'open',
    created_at: now,
    updated_at: now,
  };
  await trx.insertInto('purchasing_po_lines').values(row).execute();
  return row;
}

/** Add a line to a DRAFT PO. */
export async function addPoLine(
  db: Db,
  tenantId: string,
  actor: string,
  poId: string,
  line: CreatePoLineInput,
  optimizationTrace?: string[],
): Promise<PurchaseOrderRow> {
  const po = await db.transaction().execute(async (trx) => {
    const current = await requirePoTrx(trx, tenantId, poId);
    if (current.status !== 'draft')
      throw ApiError.conflict(`can only add lines to a draft PO (is ${current.status})`);
    const inserted = await insertLine(trx, tenantId, poId, line);
    await recordPoEvent(trx, tenantId, poId, actor, 'line_added', null, null, {
      lineId: inserted.id,
      variationId: inserted.variation_id,
      qtyOrdered: inserted.qty_ordered,
      unitCostCents: inserted.unit_cost_cents,
      optimizationTrace: optimizationTrace ?? [],
    });
    return recomputeTotals(trx, tenantId, poId);
  });
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'purchasing.purchase_order.line_added',
    'purchasing.purchase_order',
    poId,
    { variationId: line.variationId, qty: line.qtyOrdered },
  );
  return po;
}

async function requirePoTrx(trx: Trx, tenantId: string, poId: string): Promise<PurchaseOrderRow> {
  const po = await trx
    .selectFrom('purchasing_purchase_orders')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', poId)
    .executeTakeFirst();
  if (!po) throw ApiError.notFound(`purchase order "${poId}" not found`);
  return po;
}

export async function getPurchaseOrder(
  db: Db,
  tenantId: string,
  poId: string,
): Promise<PurchaseOrderRow | undefined> {
  return db
    .selectFrom('purchasing_purchase_orders')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', poId)
    .executeTakeFirst();
}

export async function listPurchaseOrders(
  db: Db,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
  filters: { vendorId?: string; status?: PurchaseOrderStatus } = {},
): Promise<PurchaseOrderRow[]> {
  let q = db.selectFrom('purchasing_purchase_orders').selectAll().where('tenant_id', '=', tenantId);
  if (filters.vendorId) q = q.where('vendor_id', '=', filters.vendorId);
  if (filters.status) q = q.where('status', '=', filters.status);
  return q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(page.limit).offset(page.offset).execute();
}

export async function listPoLines(db: Db, tenantId: string, poId: string): Promise<PoLineRow[]> {
  return db
    .selectFrom('purchasing_po_lines')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('purchase_order_id', '=', poId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

export async function listPoEvents(db: Db, tenantId: string, poId: string): Promise<PoEventRow[]> {
  return db
    .selectFrom('purchasing_po_events')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('purchase_order_id', '=', poId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

/** Generic status transition used by submit/approve/reject/send/acknowledge/cancel. */
async function transition(
  db: Db,
  tenantId: string,
  actor: string,
  poId: string,
  to: PurchaseOrderStatus,
  opts: {
    kind?: PoEventKind;
    diff?: unknown;
    set?: Partial<PurchaseOrderRow>;
  } = {},
): Promise<PurchaseOrderRow> {
  return db.transaction().execute(async (trx) => {
    const po = await requirePoTrx(trx, tenantId, poId);
    assertTransition(po.status, to);
    const patch: Partial<PurchaseOrderRow> = { status: to, updated_at: nowIso(), ...(opts.set ?? {}) };
    await trx
      .updateTable('purchasing_purchase_orders')
      .set(patch)
      .where('tenant_id', '=', tenantId)
      .where('id', '=', poId)
      .execute();
    await recordPoEvent(trx, tenantId, poId, actor, opts.kind ?? 'status_changed', po.status, to, opts.diff);
    return { ...po, ...patch };
  });
}

export async function submitPurchaseOrder(
  db: Db,
  tenantId: string,
  actor: string,
  poId: string,
  approvalPolicySnapshot: unknown = { policy: 'approval_required' },
): Promise<PurchaseOrderRow> {
  const lines = await listPoLines(db, tenantId, poId);
  if (lines.length === 0) throw ApiError.badRequest('cannot submit a PO with no lines');
  const po = await transition(db, tenantId, actor, poId, 'pending_approval', {
    set: { approval_policy_snapshot: JSON.stringify(approvalPolicySnapshot) },
    diff: { approvalPolicySnapshot },
  });
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'purchasing.purchase_order.submitted',
    'purchasing.purchase_order',
    poId,
    null,
  );
  return po;
}

export async function approvePurchaseOrder(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  poId: string,
): Promise<PurchaseOrderRow> {
  const po = await transition(db, tenantId, actor, poId, 'approved', {
    set: { approver: actor },
    diff: { approver: actor },
  });
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'purchasing.purchase_order.approved',
    'purchasing.purchase_order',
    poId,
    { approver: actor, totalCents: po.total_cents },
  );
  await events.emit(tenantId, 'purchasing.purchase_order.approved', {
    v: 1,
    purchaseOrderId: poId,
    vendorId: po.vendor_id,
    totalCents: po.total_cents,
  });
  return po;
}

export async function rejectPurchaseOrder(
  db: Db,
  tenantId: string,
  actor: string,
  poId: string,
  reason: string,
): Promise<PurchaseOrderRow> {
  const po = await transition(db, tenantId, actor, poId, 'draft', {
    kind: 'rejected',
    diff: { reason },
  });
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'purchasing.purchase_order.rejected',
    'purchasing.purchase_order',
    poId,
    { reason },
  );
  return po;
}

/**
 * Send lane: render-to-record only. Marks the PO sent and stores a
 * deterministic document payload (all lines/costs/terms) in
 * `purchasing_po_documents`. Actual email/PDF transport is wired by the
 * integrator through the automation outbox (this function performs no I/O).
 */
export async function sendPurchaseOrder(
  db: Db,
  tenantId: string,
  actor: string,
  poId: string,
  terms: { paymentTerms?: string | null; note?: string } = {},
): Promise<{ purchaseOrder: PurchaseOrderRow; document: PoDocumentRow }> {
  return db.transaction().execute(async (trx) => {
    const po = await requirePoTrx(trx, tenantId, poId);
    assertTransition(po.status, 'sent');
    const lines = await trx
      .selectFrom('purchasing_po_lines')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('purchase_order_id', '=', poId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();

    const now = nowIso();
    const payload = {
      v: 1,
      purchaseOrderId: po.id,
      vendorId: po.vendor_id,
      shipTo: po.ship_to,
      expectedAt: po.expected_at,
      paymentTerms: terms.paymentTerms ?? null,
      note: terms.note ?? null,
      lines: lines.map((l) => ({
        variationId: l.variation_id,
        vendorSku: l.vendor_sku,
        qtyOrdered: l.qty_ordered,
        unitCostCents: l.unit_cost_cents,
        lineTotalCents: l.qty_ordered * l.unit_cost_cents,
      })),
      subtotalCents: po.subtotal_cents,
      freightCents: po.freight_cents,
      totalCents: po.total_cents,
      renderedAt: now,
    };

    const doc: PoDocumentRow = {
      id: id(),
      tenant_id: tenantId,
      purchase_order_id: poId,
      payload: JSON.stringify(payload),
      created_at: now,
    };
    await trx.insertInto('purchasing_po_documents').values(doc).execute();

    await trx
      .updateTable('purchasing_purchase_orders')
      .set({ status: 'sent', updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', poId)
      .execute();
    await recordPoEvent(trx, tenantId, poId, actor, 'status_changed', po.status, 'sent', {
      documentId: doc.id,
    });
    await audit(
      asCoreDb(trx),
      tenantId,
      actor,
      'purchasing.purchase_order.sent',
      'purchasing.purchase_order',
      poId,
      { documentId: doc.id },
    );

    return { purchaseOrder: { ...po, status: 'sent' }, document: doc };
  });
}

export async function getLatestPoDocument(
  db: Db,
  tenantId: string,
  poId: string,
): Promise<PoDocumentRow | undefined> {
  return db
    .selectFrom('purchasing_po_documents')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('purchase_order_id', '=', poId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirst();
}

export async function acknowledgePurchaseOrder(
  db: Db,
  tenantId: string,
  actor: string,
  poId: string,
  expectedAt?: string | null,
): Promise<PurchaseOrderRow> {
  const set: Partial<PurchaseOrderRow> = {};
  if (expectedAt !== undefined) set.expected_at = expectedAt;
  const po = await transition(db, tenantId, actor, poId, 'acknowledged', {
    set,
    diff: { expectedAt: expectedAt ?? null },
  });
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'purchasing.purchase_order.acknowledged',
    'purchasing.purchase_order',
    poId,
    { expectedAt: expectedAt ?? null },
  );
  return po;
}

export async function cancelPurchaseOrder(
  db: Db,
  tenantId: string,
  actor: string,
  poId: string,
  reason?: string,
): Promise<PurchaseOrderRow> {
  const po = await transition(db, tenantId, actor, poId, 'canceled', { diff: { reason: reason ?? null } });
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'purchasing.purchase_order.canceled',
    'purchasing.purchase_order',
    poId,
    { reason: reason ?? null },
  );
  return po;
}

export async function closePurchaseOrder(
  db: Db,
  tenantId: string,
  actor: string,
  poId: string,
): Promise<PurchaseOrderRow> {
  const po = await transition(db, tenantId, actor, poId, 'closed', {});
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'purchasing.purchase_order.closed',
    'purchasing.purchase_order',
    poId,
    null,
  );
  return po;
}

/* ================================================================== *
 * Accept suggestion → draft PO (group by vendor)
 * ================================================================== */

export interface AcceptSuggestionInput {
  unitCostCents: number;
  vendorSku?: string | null;
  shipTo?: string;
}

export async function acceptSuggestion(
  db: Db,
  tenantId: string,
  actor: string,
  suggestionId: string,
  input: AcceptSuggestionInput,
): Promise<{ suggestion: SuggestionRow; purchaseOrder: PurchaseOrderRow }> {
  if (!Number.isInteger(input.unitCostCents) || input.unitCostCents < 0)
    throw ApiError.badRequest('unitCostCents must be a non-negative integer');

  const result = await db.transaction().execute(async (trx) => {
    const s = await trx
      .selectFrom('purchasing_suggestions')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', suggestionId)
      .executeTakeFirst();
    if (!s) throw ApiError.notFound(`suggestion "${suggestionId}" not found`);
    if (s.status !== 'suggested')
      throw ApiError.conflict(`suggestion is ${s.status}; only "suggested" can be accepted`);
    if (s.suggested_qty < 1)
      throw ApiError.badRequest('suggested quantity is 0; nothing to order');

    // Find an existing draft PO for this vendor, else create one.
    let po = await trx
      .selectFrom('purchasing_purchase_orders')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('vendor_id', '=', s.vendor_id)
      .where('status', '=', 'draft')
      .orderBy('created_at')
      .orderBy('id')
      .executeTakeFirst();

    const now = nowIso();
    if (!po) {
      const row: PurchaseOrderRow = {
        id: id(),
        tenant_id: tenantId,
        vendor_id: s.vendor_id,
        status: 'draft',
        expected_at: null,
        ship_to: input.shipTo ?? 'default',
        subtotal_cents: 0,
        freight_cents: 0,
        total_cents: 0,
        approval_policy_snapshot: null,
        approver: null,
        created_at: now,
        updated_at: now,
      };
      await trx.insertInto('purchasing_purchase_orders').values(row).execute();
      po = row;
    }

    const line = await insertLine(trx, tenantId, po.id, {
      variationId: s.variation_id,
      vendorSku: input.vendorSku ?? null,
      qtyOrdered: s.suggested_qty,
      unitCostCents: input.unitCostCents,
    });
    await recordPoEvent(trx, tenantId, po.id, actor, 'line_added', null, null, {
      fromSuggestionId: s.id,
      lineId: line.id,
      qtyOrdered: line.qty_ordered,
      // Case-pack / min-order optimization was already applied inside suggestQty;
      // the full trace is preserved on the suggestion for transparency.
      optimizationSource: 'suggestQty',
    });
    const updatedPo = await recomputeTotals(trx, tenantId, po.id);

    await trx
      .updateTable('purchasing_suggestions')
      .set({ status: 'accepted', purchase_order_id: po.id, updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', suggestionId)
      .execute();

    return {
      suggestion: { ...s, status: 'accepted' as SuggestionStatus, purchase_order_id: po.id },
      purchaseOrder: updatedPo,
    };
  });

  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'purchasing.suggestion.accepted',
    'purchasing.suggestion',
    suggestionId,
    { purchaseOrderId: result.purchaseOrder.id },
  );
  return result;
}

/* ================================================================== *
 * Receiving
 * ================================================================== */

export interface ReceiveLineInput {
  poLineId: string;
  qtyReceived: number;
  condition?: ReceiptCondition;
  /** When true, closes the line — a shortfall vs ordered raises a "short" discrepancy. */
  final?: boolean;
}

export interface ReceiveInput {
  note?: string;
  lines: ReceiveLineInput[];
}

export interface ReceiveResult {
  receipt: ReceiptRow;
  discrepancies: DiscrepancyRow[];
  /** Payload lines echoed on the received event (for inventory application). */
  eventLines: { variationId: string; qty: number; condition: ReceiptCondition; unitCostCents: number }[];
  purchaseOrder: PurchaseOrderRow;
}

/**
 * Post a receipt against a PO. Receiving writes NO inventory directly — it
 * emits `purchasing.purchase_order.received` with per-line { variationId, qty,
 * condition, unitCostCents } so the integrator applies movements (ok → stock,
 * damaged → quarantine, wrong_item → return). Over/short/wrong/damaged per line
 * become discrepancy rows and fire the internal `purchasing.receipt.discrepant`
 * event.
 */
export async function createReceipt(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  poId: string,
  input: ReceiveInput,
): Promise<ReceiveResult> {
  if (!input.lines || input.lines.length === 0)
    throw ApiError.badRequest('a receipt needs at least one line');

  const result = await db.transaction().execute(async (trx) => {
    const po = await requirePoTrx(trx, tenantId, poId);
    if (!['approved', 'sent', 'acknowledged', 'partially_received'].includes(po.status))
      throw ApiError.conflict(`cannot receive against a PO in status ${po.status}`);

    const now = nowIso();
    const receipt: ReceiptRow = {
      id: id(),
      tenant_id: tenantId,
      purchase_order_id: poId,
      note: input.note ?? null,
      created_at: now,
    };
    await trx.insertInto('purchasing_receipts').values(receipt).execute();

    const discrepancies: DiscrepancyRow[] = [];
    const eventLines: ReceiveResult['eventLines'] = [];

    for (const rl of input.lines) {
      const line = await trx
        .selectFrom('purchasing_po_lines')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('id', '=', rl.poLineId)
        .where('purchase_order_id', '=', poId)
        .executeTakeFirst();
      if (!line) throw ApiError.badRequest(`po line "${rl.poLineId}" not found on this PO`);
      if (!Number.isInteger(rl.qtyReceived) || rl.qtyReceived < 0)
        throw ApiError.badRequest('qtyReceived must be a non-negative integer');
      const condition: ReceiptCondition = rl.condition ?? 'ok';

      const rlRow: ReceiptLineRow = {
        id: id(),
        tenant_id: tenantId,
        receipt_id: receipt.id,
        po_line_id: line.id,
        qty_received: rl.qtyReceived,
        condition,
        created_at: nowIso(),
      };
      await trx.insertInto('purchasing_receipt_lines').values(rlRow).execute();

      eventLines.push({
        variationId: line.variation_id,
        qty: rl.qtyReceived,
        condition,
        unitCostCents: line.unit_cost_cents,
      });

      const addDiscrepancy = async (
        kind: DiscrepancyKind,
        expected: number,
        received: number,
        delta: number,
      ) => {
        const d: DiscrepancyRow = {
          id: id(),
          tenant_id: tenantId,
          receipt_id: receipt.id,
          po_line_id: line.id,
          purchase_order_id: poId,
          kind,
          expected_qty: expected,
          received_qty: received,
          delta_qty: delta,
          created_at: nowIso(),
        };
        await trx.insertInto('purchasing_discrepancies').values(d).execute();
        discrepancies.push(d);
      };

      if (condition === 'damaged') {
        await addDiscrepancy('damaged', 0, rl.qtyReceived, rl.qtyReceived);
        // Damaged units are NOT booked into good qty_received.
      } else if (condition === 'wrong_item') {
        await addDiscrepancy('wrong_item', 0, rl.qtyReceived, rl.qtyReceived);
      } else {
        // condition ok
        const remaining = line.qty_ordered - line.qty_received;
        if (rl.qtyReceived > remaining) {
          await addDiscrepancy('over', remaining, rl.qtyReceived, rl.qtyReceived - remaining);
        }
        const newReceived = line.qty_received + rl.qtyReceived;
        const backordered = Math.max(0, line.qty_ordered - newReceived);
        let lineState: PoLineRow['line_state'];
        if (newReceived >= line.qty_ordered) lineState = 'received';
        else if (rl.final) {
          lineState = 'backordered';
          await addDiscrepancy('short', line.qty_ordered, newReceived, newReceived - line.qty_ordered);
        } else lineState = 'partially_received';
        await trx
          .updateTable('purchasing_po_lines')
          .set({
            qty_received: newReceived,
            qty_backordered: backordered,
            line_state: lineState,
            updated_at: nowIso(),
          })
          .where('tenant_id', '=', tenantId)
          .where('id', '=', line.id)
          .execute();
      }
    }

    // Recompute PO status from line states.
    const allLines = await trx
      .selectFrom('purchasing_po_lines')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('purchase_order_id', '=', poId)
      .execute();
    const anyReceived = allLines.some((l) => l.qty_received > 0);
    const allDone = allLines.every((l) => l.qty_received >= l.qty_ordered);
    let newStatus: PurchaseOrderStatus = po.status;
    if (allDone) newStatus = 'received';
    else if (anyReceived) newStatus = 'partially_received';
    if (newStatus !== po.status) {
      await trx
        .updateTable('purchasing_purchase_orders')
        .set({ status: newStatus, updated_at: nowIso() })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', poId)
        .execute();
      await recordPoEvent(trx, tenantId, poId, actor, 'status_changed', po.status, newStatus, {
        receiptId: receipt.id,
      });
    }

    await audit(
      asCoreDb(trx),
      tenantId,
      actor,
      'purchasing.receipt.created',
      'purchasing.receipt',
      receipt.id,
      { purchaseOrderId: poId, discrepancyCount: discrepancies.length },
    );

    return {
      receipt,
      discrepancies,
      eventLines,
      purchaseOrder: { ...po, status: newStatus },
    };
  });

  await events.emit(tenantId, 'purchasing.purchase_order.received', {
    v: 1,
    purchaseOrderId: poId,
    receiptId: result.receipt.id,
    lines: result.eventLines,
  });
  if (result.discrepancies.length > 0) {
    await events.emit(tenantId, 'purchasing.receipt.discrepant', {
      v: 1,
      receiptId: result.receipt.id,
      purchaseOrderId: poId,
      discrepancyCount: result.discrepancies.length,
    });
  }

  return result;
}

export async function listDiscrepancies(
  db: Db,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
  poId?: string,
): Promise<DiscrepancyRow[]> {
  let q = db.selectFrom('purchasing_discrepancies').selectAll().where('tenant_id', '=', tenantId);
  if (poId) q = q.where('purchase_order_id', '=', poId);
  return q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(page.limit).offset(page.offset).execute();
}

/* ================================================================== *
 * Vendor bills + three-way match
 * ================================================================== */

export interface BillLineInput {
  variationId: string;
  qty: number;
  unitCostCents: number;
}

export interface CreateBillInput {
  vendorId: string;
  billNumber: string;
  amountCents: number;
  lines: BillLineInput[];
}

export async function createVendorBill(
  db: Db,
  tenantId: string,
  actor: string,
  input: CreateBillInput,
): Promise<VendorBillRow> {
  if (!input.vendorId.trim()) throw ApiError.badRequest('vendorId is required');
  if (!input.billNumber.trim()) throw ApiError.badRequest('billNumber is required');

  const row = await db.transaction().execute(async (trx) => {
    // Check-then-insert for the (tenant, vendor, bill_number) uniqueness (no ON CONFLICT).
    const dup = await trx
      .selectFrom('purchasing_vendor_bills')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('vendor_id', '=', input.vendorId)
      .where('bill_number', '=', input.billNumber)
      .executeTakeFirst();
    if (dup)
      throw ApiError.conflict(
        `bill "${input.billNumber}" already exists for vendor "${input.vendorId}"`,
      );
    const now = nowIso();
    const bill: VendorBillRow = {
      id: id(),
      tenant_id: tenantId,
      vendor_id: input.vendorId,
      bill_number: input.billNumber,
      amount_cents: input.amountCents,
      lines: JSON.stringify(input.lines),
      status: 'unmatched',
      created_at: now,
      updated_at: now,
    };
    await trx.insertInto('purchasing_vendor_bills').values(bill).execute();
    return bill;
  });

  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'purchasing.vendor_bill.created',
    'purchasing.vendor_bill',
    row.id,
    { vendorId: row.vendor_id, billNumber: row.bill_number },
  );
  return row;
}

export async function getVendorBill(
  db: Db,
  tenantId: string,
  billId: string,
): Promise<VendorBillRow | undefined> {
  return db
    .selectFrom('purchasing_vendor_bills')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', billId)
    .executeTakeFirst();
}

export async function listVendorBills(
  db: Db,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
): Promise<VendorBillRow[]> {
  return db
    .selectFrom('purchasing_vendor_bills')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export async function listBillExceptions(
  db: Db,
  tenantId: string,
  billId: string,
): Promise<BillExceptionRow[]> {
  return db
    .selectFrom('purchasing_bill_exceptions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('bill_id', '=', billId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

export interface MatchResult {
  status: VendorBillRow['status'];
  exceptions: BillExceptionRow[];
}

/**
 * Three-way match: bill ↔ PO ↔ receipt (via the PO lines' cumulative
 * qty_received). Produces cent-exact price-variance exceptions (bill unit cost
 * vs PO unit cost) and unit-exact qty-variance exceptions (received vs billed).
 * Clean match → status 'matched'; otherwise 'exception'. Re-running replaces
 * the prior exception set (idempotent).
 */
export async function matchVendorBill(
  db: Db,
  tenantId: string,
  actor: string,
  billId: string,
  poId: string,
  receiptId: string | null,
): Promise<MatchResult> {
  const result = await db.transaction().execute(async (trx) => {
    const bill = await trx
      .selectFrom('purchasing_vendor_bills')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', billId)
      .executeTakeFirst();
    if (!bill) throw ApiError.notFound(`vendor bill "${billId}" not found`);
    const po = await trx
      .selectFrom('purchasing_purchase_orders')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', poId)
      .executeTakeFirst();
    if (!po) throw ApiError.notFound(`purchase order "${poId}" not found`);

    const poLines = await trx
      .selectFrom('purchasing_po_lines')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('purchase_order_id', '=', poId)
      .execute();
    const byVariation = new Map<string, PoLineRow>();
    for (const l of poLines) if (!byVariation.has(l.variation_id)) byVariation.set(l.variation_id, l);

    // Clear any prior exception set for this bill (idempotent re-match).
    await trx.deleteFrom('purchasing_bill_exceptions').where('tenant_id', '=', tenantId).where('bill_id', '=', billId).execute();

    const billLines = JSON.parse(bill.lines) as BillLineInput[];
    const exceptions: BillExceptionRow[] = [];
    const now = nowIso();
    const pushException = (
      variationId: string,
      poLineId: string | null,
      kind: BillExceptionKind,
      expected: number,
      actual: number,
    ) => {
      const row: BillExceptionRow = {
        id: id(),
        tenant_id: tenantId,
        bill_id: billId,
        purchase_order_id: poId,
        receipt_id: receiptId,
        po_line_id: poLineId,
        variation_id: variationId,
        kind,
        expected,
        actual,
        delta: actual - expected,
        created_at: now,
      };
      exceptions.push(row);
    };

    for (const bl of billLines) {
      const poLine = byVariation.get(bl.variationId);
      if (!poLine) {
        // Billed a variation not on the PO → full qty variance vs expected 0.
        pushException(bl.variationId, null, 'qty_variance', 0, bl.qty);
        continue;
      }
      // Price variance: billed unit cost vs PO unit cost (cent-exact).
      if (bl.unitCostCents !== poLine.unit_cost_cents) {
        pushException(bl.variationId, poLine.id, 'price_variance', poLine.unit_cost_cents, bl.unitCostCents);
      }
      // Qty variance: received (cumulative) vs billed.
      if (bl.qty !== poLine.qty_received) {
        pushException(bl.variationId, poLine.id, 'qty_variance', poLine.qty_received, bl.qty);
      }
    }

    if (exceptions.length > 0) {
      await trx.insertInto('purchasing_bill_exceptions').values(exceptions).execute();
    }
    const status: VendorBillRow['status'] = exceptions.length > 0 ? 'exception' : 'matched';
    await trx
      .updateTable('purchasing_vendor_bills')
      .set({ status, updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', billId)
      .execute();

    return { status, exceptions };
  });

  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'purchasing.vendor_bill.matched',
    'purchasing.vendor_bill',
    billId,
    { poId, receiptId, status: result.status, exceptionCount: result.exceptions.length },
  );
  return result;
}
