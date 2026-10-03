import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import type { Kysely } from 'kysely';
import {
  ApiError,
  applyDiscount,
  asCoreDb,
  audit,
  computeTotals,
  id,
  nowIso,
  serializeCsv,
  type CreateInvoiceContract,
  type CreateInvoiceInput,
  type Discount,
  EventBus,
  type Pagination,
  type Sort,
} from '@blacklabel/core';
import type {
  BillingAccountRow,
  BillingDatabase,
  BillingInvoiceLineRow,
  BillingInvoiceRow,
  BillingMembershipRow,
  BillingPaymentRow,
  BillingSubscriptionRow,
  BillingWebhookEventRow,
  BillingCollectionPlanRow,
  BillingReminderRow,
  InvoiceStatus,
  MembershipStatus,
  SubscriptionInterval,
  SubscriptionStatus,
} from './schema';
import type { PaymentIntent, PaymentProvider, ProviderWebhookEvent, WebhookOutcome } from './providers';

/* ------------------------------------------------------------------ *
 * Shared context + DTO helpers
 * ------------------------------------------------------------------ */

export interface BillingCtx {
  db: Kysely<BillingDatabase>;
  events: EventBus;
  deferredEvents?: { type: string; payload: Record<string, unknown> }[];
}

async function withBillingTransaction<T>(ctx: BillingCtx, tenantId: string, operation: (txCtx: BillingCtx) => Promise<T>): Promise<T> {
  const pending: { type: string; payload: any }[] = [];
  const deferred = new EventBus(); deferred.on('*', event => { pending.push(event); });
  const result = await ctx.db.transaction().execute(async db => operation({ ...ctx, db, events: deferred }));
  for (const event of pending) await ctx.events.emit(tenantId, event.type, event.payload);
  return result;
}
const MAX_CENTS = Math.floor(Number.MAX_SAFE_INTEGER / 10000);
function validateCents(value: number | undefined | null, label: string): void {
  if (value != null && (!Number.isSafeInteger(value) || value < 0 || value > MAX_CENTS)) throw ApiError.badRequest(`${label} must be safe non-negative integer cents`);
}
function validateBps(value: number | undefined | null, label: string): void {
  if (value != null && (!Number.isSafeInteger(value) || value < 0 || value > 10000)) throw ApiError.badRequest(`${label} must be integer basis points from 0 to 10000`);
}
function validateInvoiceAmounts(lines: InvoiceLineInputSvc[], discountBps?: number | null, fixedCents?: number | null, taxBps?: number | null): void {
  validateBps(discountBps, 'discountBps'); validateBps(taxBps, 'taxBps'); validateCents(fixedCents, 'discountFixedCents');
  for (const line of lines) {
    if (!line.description?.trim() || !Number.isFinite(line.quantity) || line.quantity <= 0) throw ApiError.badRequest('Work lines require a description and positive finite quantity.');
    validateCents(line.unitPriceCents, 'unitPriceCents'); validateBps(line.discountBps, 'line discountBps'); validateCents(line.discountFixedCents, 'line discountFixedCents');
    validateCents(Math.round(line.quantity * line.unitPriceCents), 'line amount');
  }
}
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Invoice with the 0/1 portal flag converted to a boolean at the service boundary. */
export type InvoiceDto = Omit<BillingInvoiceRow, 'portal_visible'> & { portal_visible: boolean };

export type WebhookEventDto = Omit<BillingWebhookEventRow, 'processed'> & { processed: boolean };

function toInvoiceDto(row: BillingInvoiceRow): InvoiceDto {
  return { ...row, portal_visible: row.portal_visible === 1 };
}

function toWebhookEventDto(row: BillingWebhookEventRow): WebhookEventDto {
  return { ...row, processed: row.processed === 1 };
}

/* ------------------------------------------------------------------ *
 * Status math
 * ------------------------------------------------------------------ */

/**
 * Compute the invoice payment status from recorded payments vs the total.
 * Precedence: void > paid > draft > overdue > partial > sent.
 * (A partially paid invoice past its due date is "overdue".)
 */
export function computeInvoiceStatus(
  invoice: Pick<BillingInvoiceRow, 'total_cents' | 'paid_cents' | 'sent_at' | 'due_at' | 'voided_at'>,
  now: string = nowIso(),
): InvoiceStatus {
  if (invoice.voided_at) return 'void';
  if (invoice.total_cents > 0 && invoice.paid_cents >= invoice.total_cents) return 'paid';
  if (!invoice.sent_at) return 'draft';
  if (invoice.due_at && invoice.due_at < now) return 'overdue';
  if (invoice.paid_cents > 0) return 'partial';
  return 'sent';
}

/* ------------------------------------------------------------------ *
 * Invoice numbering — INV-{seq}, per tenant
 * ------------------------------------------------------------------ */

/** Allocate the next per-tenant invoice number (check-then-insert; no upserts). */
export async function nextInvoiceNumber(
  db: Kysely<BillingDatabase>,
  tenantId: string,
): Promise<string> {
  const counter = await db
    .selectFrom('billing_invoice_counters')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
  if (!counter) {
    await db
      .insertInto('billing_invoice_counters')
      .values({ tenant_id: tenantId, next_seq: 2 })
      .execute();
    return 'INV-1';
  }
  await db
    .updateTable('billing_invoice_counters')
    .set({ next_seq: counter.next_seq + 1 })
    .where('tenant_id', '=', tenantId)
    .execute();
  return `INV-${counter.next_seq}`;
}

/* ------------------------------------------------------------------ *
 * Invoices + line items
 * ------------------------------------------------------------------ */

export interface InvoiceLineInputSvc {
  description: string;
  quantity: number;
  unitPriceCents: number;
  discountBps?: number;
  discountFixedCents?: number;
}

export interface CreateInvoiceInputSvc {
  customerId: string;
  billingAccountId?: string;
  lines: InvoiceLineInputSvc[];
  discountBps?: number;
  discountFixedCents?: number;
  taxBps?: number;
  dueAt?: string;
  memo?: string;
  portalVisible?: boolean;
  sourceEntityType?: string;
  sourceEntityId?: string;
  custom?: Record<string, unknown>;
}

export interface InvoiceWithLines {
  invoice: InvoiceDto;
  lines: BillingInvoiceLineRow[];
}

function toDiscount(bps: number | null | undefined, fixedCents: number | null | undefined): Discount | undefined {
  if (bps === null || bps === undefined) {
    if (fixedCents === null || fixedCents === undefined) return undefined;
    return { fixedCents };
  }
  if (fixedCents === null || fixedCents === undefined) return { bps };
  return { bps, fixedCents };
}

export async function createInvoice(
  ctx: BillingCtx,
  tenantId: string,
  actor: string,
  input: CreateInvoiceInputSvc,
): Promise<InvoiceWithLines> {
  if (!ctx.db.isTransaction) return withBillingTransaction(ctx, tenantId, txCtx => createInvoice(txCtx, tenantId, actor, input));
  if (!input.customerId || input.customerId.trim() === '') {
    throw ApiError.badRequest('customerId is required');
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw ApiError.badRequest('an invoice needs at least one line item');
  }
  if (input.billingAccountId) {
    const account = await getBillingAccount(ctx.db, tenantId, input.billingAccountId);
    if (!account || account.customer_id !== input.customerId) throw ApiError.badRequest(`billing account does not belong to this customer: ${input.billingAccountId}`);
  }

  validateInvoiceAmounts(input.lines, input.discountBps, input.discountFixedCents, input.taxBps);
  // Shared math with quoting: core computeTotals (line discounts -> invoice
  // discount -> tax; Math.round each step; never below 0).
  const totals = computeTotals(
    input.lines.map((l) => ({
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      discount: toDiscount(l.discountBps, l.discountFixedCents),
    })),
    {
      discount: toDiscount(input.discountBps, input.discountFixedCents),
      taxBps: input.taxBps,
    },
  );

  validateCents(totals.subtotalCents, 'subtotal');
  const now = nowIso();
  const invoice: BillingInvoiceRow = {
    id: id(),
    tenant_id: tenantId,
    billing_account_id: input.billingAccountId ?? null,
    customer_id: input.customerId,
    number: await nextInvoiceNumber(ctx.db, tenantId),
    status: 'draft',
    discount_bps: input.discountBps ?? null,
    discount_fixed_cents: input.discountFixedCents ?? null,
    tax_bps: input.taxBps ?? null,
    subtotal_cents: totals.subtotalCents,
    discount_cents: totals.discountCents,
    tax_cents: totals.taxCents,
    total_cents: totals.totalCents,
    paid_cents: 0,
    due_at: input.dueAt ?? null,
    sent_at: null,
    paid_at: null,
    voided_at: null,
    memo: input.memo ?? null,
    source_entity_type: input.sourceEntityType ?? null,
    source_entity_id: input.sourceEntityId ?? null,
    portal_visible: input.portalVisible ? 1 : 0,
    custom: input.custom === undefined ? null : JSON.stringify(input.custom),
    created_at: now,
    updated_at: now,
  };
  await ctx.db.insertInto('billing_invoices').values(invoice).execute();

  const lines: BillingInvoiceLineRow[] = input.lines.map((l, position) => ({
    id: id(),
    tenant_id: tenantId,
    invoice_id: invoice.id,
    position,
    description: l.description,
    quantity: l.quantity,
    unit_price_cents: l.unitPriceCents,
    discount_bps: l.discountBps ?? null,
    discount_fixed_cents: l.discountFixedCents ?? null,
    line_total_cents: totals.lineTotalsCents[position],
    created_at: now,
  }));
  for (const line of lines) {
    await ctx.db.insertInto('billing_invoice_lines').values(line).execute();
  }

  await audit(asCoreDb(ctx.db), tenantId, actor, 'billing.invoice.created', 'billing.invoice', invoice.id, {
    number: invoice.number,
    totalCents: invoice.total_cents,
  });
  const created = {
    invoiceId: invoice.id,
    customerId: invoice.customer_id,
    totalCents: invoice.total_cents,
  };
  if (ctx.deferredEvents) ctx.deferredEvents.push({ type: 'billing.invoice.created', payload: created });
  else await ctx.events.emit(tenantId, 'billing.invoice.created', created);
  return { invoice: toInvoiceDto(invoice), lines };
}

export async function getInvoiceRow(
  db: Kysely<BillingDatabase>,
  tenantId: string,
  invoiceId: string,
): Promise<BillingInvoiceRow | undefined> {
  return db
    .selectFrom('billing_invoices')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', invoiceId)
    .executeTakeFirst();
}

export async function getInvoice(
  db: Kysely<BillingDatabase>,
  tenantId: string,
  invoiceId: string,
): Promise<InvoiceWithLines | undefined> {
  const row = await getInvoiceRow(db, tenantId, invoiceId);
  if (!row) return undefined;
  const lines = await db
    .selectFrom('billing_invoice_lines')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('invoice_id', '=', invoiceId)
    .orderBy('position')
    .orderBy('id')
    .execute();
  return { invoice: toInvoiceDto(row), lines };
}

export interface ListInvoicesFilters {
  status?: string;
  customer_id?: string;
  portal_visible?: string;
}

export async function listInvoices(
  db: Kysely<BillingDatabase>,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
  filters: ListInvoicesFilters = {},
  sort?: Sort,
): Promise<InvoiceDto[]> {
  let query = db
    .selectFrom('billing_invoices')
    .selectAll()
    .where('tenant_id', '=', tenantId);
  if (filters.status !== undefined) {
    query = query.where('status', '=', filters.status as InvoiceStatus);
  }
  if (filters.customer_id !== undefined) {
    query = query.where('customer_id', '=', filters.customer_id);
  }
  if (filters.portal_visible !== undefined) {
    const flag = filters.portal_visible === '1' || filters.portal_visible === 'true' ? 1 : 0;
    query = query.where('portal_visible', '=', flag);
  }
  const effectiveSort: Sort = sort ?? { column: 'created_at', direction: 'asc' };
  const rows = await query
    .orderBy(effectiveSort.column as 'created_at', effectiveSort.direction)
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
  return rows.map(toInvoiceDto);
}

export interface UpdateInvoiceInputSvc {
  billingAccountId?: string | null;
  lines?: InvoiceLineInputSvc[];
  discountBps?: number | null;
  discountFixedCents?: number | null;
  taxBps?: number | null;
  dueAt?: string | null;
  memo?: string | null;
  portalVisible?: boolean;
  custom?: Record<string, unknown> | null;
}

/** Update a DRAFT invoice (409 otherwise). Passing `lines` replaces them all. */
export async function updateInvoice(
  ctx: BillingCtx,
  tenantId: string,
  actor: string,
  invoiceId: string,
  patch: UpdateInvoiceInputSvc,
): Promise<InvoiceWithLines> {
  if (!ctx.db.isTransaction) return withBillingTransaction(ctx, tenantId, txCtx => updateInvoice(txCtx, tenantId, actor, invoiceId, patch));
  const existing = await getInvoiceRow(ctx.db, tenantId, invoiceId);
  if (!existing) throw ApiError.notFound(`invoice not found: ${invoiceId}`);
  if (existing.status !== 'draft') {
    throw ApiError.conflict(`only draft invoices can be edited (status: ${existing.status})`);
  }
  if (existing.source_entity_type === 'quoting.quote' && [patch.lines, patch.discountBps, patch.discountFixedCents, patch.taxBps].some(value => value !== undefined)) throw ApiError.conflict('Accepted quote pricing requires a separately approved change quote.');
  if (patch.lines !== undefined && patch.lines.length === 0) {
    throw ApiError.badRequest('an invoice needs at least one line item');
  }
  if (patch.billingAccountId) {
    const account = await getBillingAccount(ctx.db, tenantId, patch.billingAccountId);
    if (!account || account.customer_id !== existing.customer_id) throw ApiError.badRequest(`billing account does not belong to this customer: ${patch.billingAccountId}`);
  }

  const now = nowIso();
  const discountBps = patch.discountBps !== undefined ? patch.discountBps : existing.discount_bps;
  const discountFixedCents =
    patch.discountFixedCents !== undefined ? patch.discountFixedCents : existing.discount_fixed_cents;
  const taxBps = patch.taxBps !== undefined ? patch.taxBps : existing.tax_bps;

  let lineInputs: InvoiceLineInputSvc[];
  if (patch.lines !== undefined) {
    lineInputs = patch.lines;
  } else {
    const currentLines = await ctx.db
      .selectFrom('billing_invoice_lines')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('invoice_id', '=', invoiceId)
      .orderBy('position')
      .orderBy('id')
      .execute();
    lineInputs = currentLines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPriceCents: l.unit_price_cents,
      discountBps: l.discount_bps ?? undefined,
      discountFixedCents: l.discount_fixed_cents ?? undefined,
    }));
  }

  validateInvoiceAmounts(lineInputs, discountBps, discountFixedCents, taxBps);
  const totals = computeTotals(
    lineInputs.map((l) => ({
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      discount: toDiscount(l.discountBps, l.discountFixedCents),
    })),
    { discount: toDiscount(discountBps, discountFixedCents), taxBps: taxBps ?? undefined },
  );

  validateCents(totals.subtotalCents, 'subtotal');
  if (patch.lines !== undefined) {
    await ctx.db
      .deleteFrom('billing_invoice_lines')
      .where('tenant_id', '=', tenantId)
      .where('invoice_id', '=', invoiceId)
      .execute();
    for (const [position, l] of patch.lines.entries()) {
      const line: BillingInvoiceLineRow = {
        id: id(),
        tenant_id: tenantId,
        invoice_id: invoiceId,
        position,
        description: l.description,
        quantity: l.quantity,
        unit_price_cents: l.unitPriceCents,
        discount_bps: l.discountBps ?? null,
        discount_fixed_cents: l.discountFixedCents ?? null,
        line_total_cents: totals.lineTotalsCents[position],
        created_at: now,
      };
      await ctx.db.insertInto('billing_invoice_lines').values(line).execute();
    }
  }

  await ctx.db
    .updateTable('billing_invoices')
    .set({
      billing_account_id:
        patch.billingAccountId !== undefined ? patch.billingAccountId : existing.billing_account_id,
      discount_bps: discountBps,
      discount_fixed_cents: discountFixedCents,
      tax_bps: taxBps,
      subtotal_cents: totals.subtotalCents,
      discount_cents: totals.discountCents,
      tax_cents: totals.taxCents,
      total_cents: totals.totalCents,
      due_at: patch.dueAt !== undefined ? patch.dueAt : existing.due_at,
      memo: patch.memo !== undefined ? patch.memo : existing.memo,
      portal_visible:
        patch.portalVisible !== undefined ? (patch.portalVisible ? 1 : 0) : existing.portal_visible,
      custom:
        patch.custom !== undefined
          ? patch.custom === null
            ? null
            : JSON.stringify(patch.custom)
          : existing.custom,
      updated_at: now,
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', invoiceId)
    .execute();

  await audit(asCoreDb(ctx.db), tenantId, actor, 'billing.invoice.updated', 'billing.invoice', invoiceId, {
    totalCents: totals.totalCents,
  });
  const updated = await getInvoice(ctx.db, tenantId, invoiceId);
  if (!updated) throw ApiError.notFound(`invoice not found: ${invoiceId}`);
  return updated;
}

/** Delete a DRAFT invoice (409 otherwise). */
export async function deleteInvoice(
  ctx: BillingCtx,
  tenantId: string,
  actor: string,
  invoiceId: string,
): Promise<void> {
  if (!ctx.db.isTransaction) return withBillingTransaction(ctx, tenantId, txCtx => deleteInvoice(txCtx, tenantId, actor, invoiceId));
  const existing = await getInvoiceRow(ctx.db, tenantId, invoiceId);
  if (!existing) throw ApiError.notFound(`invoice not found: ${invoiceId}`);
  if (existing.status !== 'draft') {
    throw ApiError.conflict(`only draft invoices can be deleted (status: ${existing.status})`);
  }
  await ctx.db
    .deleteFrom('billing_invoice_lines')
    .where('tenant_id', '=', tenantId)
    .where('invoice_id', '=', invoiceId)
    .execute();
  await ctx.db
    .deleteFrom('billing_invoices')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', invoiceId)
    .execute();
  await audit(asCoreDb(ctx.db), tenantId, actor, 'billing.invoice.deleted', 'billing.invoice', invoiceId, {
    number: existing.number,
  });
}

/** draft -> sent. Sets sent_at; status may land on "overdue" if due_at already passed. */
export async function sendInvoice(
  ctx: BillingCtx,
  tenantId: string,
  actor: string,
  invoiceId: string,
): Promise<InvoiceDto> {
  if (!ctx.db.isTransaction) return withBillingTransaction(ctx, tenantId, txCtx => sendInvoice(txCtx, tenantId, actor, invoiceId));
  const existing = await getInvoiceRow(ctx.db, tenantId, invoiceId);
  if (!existing) throw ApiError.notFound(`invoice not found: ${invoiceId}`);
  if (existing.status !== 'draft') {
    throw ApiError.conflict(`only draft invoices can be sent (status: ${existing.status})`);
  }
  const now = nowIso();
  const next: BillingInvoiceRow = { ...existing, sent_at: now, updated_at: now };
  next.status = computeInvoiceStatus(next, now);
  await ctx.db
    .updateTable('billing_invoices')
    .set({ sent_at: next.sent_at, status: next.status, updated_at: next.updated_at })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', invoiceId)
    .execute();
  await audit(asCoreDb(ctx.db), tenantId, actor, 'billing.invoice.sent', 'billing.invoice', invoiceId, {
    number: existing.number,
  });
  await ctx.events.emit(tenantId, 'billing.invoice.sent', {
    invoiceId,
    customerId: existing.customer_id,
    totalCents: existing.total_cents,
  });
  return toInvoiceDto(next);
}

/** Void an unpaid invoice (terminal). 409 if already paid or void. */
export async function voidInvoice(
  ctx: BillingCtx,
  tenantId: string,
  actor: string,
  invoiceId: string,
): Promise<InvoiceDto> {
  if (!ctx.db.isTransaction) return withBillingTransaction(ctx, tenantId, txCtx => voidInvoice(txCtx, tenantId, actor, invoiceId));
  const existing = await getInvoiceRow(ctx.db, tenantId, invoiceId);
  if (!existing) throw ApiError.notFound(`invoice not found: ${invoiceId}`);
  if (existing.paid_cents > 0) throw ApiError.conflict('Reconcile recorded payments before voiding this invoice.');
  if (existing.status === 'void') throw ApiError.conflict('invoice is already void');
  const now = nowIso();
  await ctx.db
    .updateTable('billing_invoices')
    .set({ voided_at: now, status: 'void', updated_at: now })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', invoiceId)
    .execute();
  await audit(asCoreDb(ctx.db), tenantId, actor, 'billing.invoice.voided', 'billing.invoice', invoiceId, {
    number: existing.number,
  });
  await suppressPreparedReminders(ctx, tenantId, actor, invoiceId, 'void');
  await ctx.events.emit(tenantId, 'billing.invoice.voided', {
    invoiceId,
    customerId: existing.customer_id,
  });
  return { ...toInvoiceDto(existing), voided_at: now, status: 'void', updated_at: now };
}

/**
 * Flip sent/partial invoices past their due date to "overdue" ("overdue" is
 * time-dependent, so it only lands on rows via mutations or this tick).
 * Returns the number of invoices transitioned.
 */
export async function markOverdueInvoices(
  ctx: BillingCtx,
  tenantId: string,
  now: string = nowIso(),
): Promise<number> {
  const due = await ctx.db
    .selectFrom('billing_invoices')
    .select(['id'])
    .where('tenant_id', '=', tenantId)
    .where('status', 'in', ['sent', 'partial'])
    .where('due_at', 'is not', null)
    .where('due_at', '<', now)
    .orderBy('id')
    .execute();
  for (const row of due) {
    await ctx.db
      .updateTable('billing_invoices')
      .set({ status: 'overdue', updated_at: nowIso() })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', row.id)
      .execute();
    await audit(asCoreDb(ctx.db), tenantId, 'system', 'billing.invoice.marked_overdue', 'billing.invoice', row.id);
  }
  return due.length;
}

/* ------------------------------------------------------------------ *
 * Payments
 * ------------------------------------------------------------------ */

export interface RecordPaymentInputSvc {
  amountCents: number;
  method?: string;
  provider?: string;
  providerRef?: string;
  note?: string;
  receivedAt?: string;
  /** Stable reference from the actual offline receipt; retries cannot count it twice. */
  receiptRef?: string;
}

export interface RecordPaymentResult {
  payment: BillingPaymentRow;
  invoice: InvoiceDto;
  replayed?: boolean;
}

interface RecordPaymentOptions {
  /** Webhook transactions defer events until after commit. */
  emitEvents?: boolean;
}

/**
 * Record a payment against a sent/partial/overdue invoice and recompute the
 * status. Emits billing.invoice.paid exactly once, on the transition to paid.
 */
export async function recordPayment(
  ctx: BillingCtx,
  tenantId: string,
  actor: string,
  invoiceId: string,
  input: RecordPaymentInputSvc,
  options: RecordPaymentOptions = {},
): Promise<RecordPaymentResult> {
  if (!ctx.db.isTransaction) return withBillingTransaction(ctx, tenantId, txCtx => recordPayment(txCtx, tenantId, actor, invoiceId, input, options));
  const invoice = await getInvoiceRow(ctx.db, tenantId, invoiceId);
  if (!invoice) throw ApiError.notFound(`invoice not found: ${invoiceId}`);
  const receiptRef = input.receiptRef?.trim();
  if (input.receiptRef !== undefined && !receiptRef) throw ApiError.badRequest('receiptRef cannot be blank');
  const inputHash = fingerprint({ invoiceId, amountCents: input.amountCents, method: input.method ?? 'manual', note: input.note ?? null, receivedAt: input.receivedAt ?? null });
  if (receiptRef) {
    const prior = await ctx.db.selectFrom('billing_payment_receipts').selectAll().where('tenant_id', '=', tenantId).where('receipt_ref', '=', receiptRef).executeTakeFirst();
    if (prior) {
      if (prior.invoice_id !== invoiceId || prior.input_hash !== inputHash) throw ApiError.conflict('Receipt reference already belongs to a different payment.');
      const payment = await ctx.db.selectFrom('billing_payments').selectAll().where('tenant_id', '=', tenantId).where('id', '=', prior.payment_id).executeTakeFirst();
      if (!payment || payment.invoice_id !== invoiceId || payment.amount_cents !== input.amountCents) throw ApiError.conflict('Payment receipt readback needs review.');
      return { payment, invoice: toInvoiceDto(invoice), replayed: true };
    }
  }
  if (invoice.status === 'void') throw ApiError.conflict('cannot record a payment on a void invoice');
  if (invoice.status === 'draft') {
    throw ApiError.conflict('invoice must be sent before payments can be recorded');
  }
  if (invoice.status === 'paid') throw ApiError.conflict('invoice is already paid in full');
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > MAX_CENTS) {
    throw ApiError.badRequest('amountCents must be a positive integer');
  }

  const now = nowIso();
  const payment: BillingPaymentRow = {
    id: id(),
    tenant_id: tenantId,
    invoice_id: invoiceId,
    amount_cents: input.amountCents,
    method: input.method ?? 'manual',
    provider: input.provider ?? null,
    provider_ref: input.providerRef ?? null,
    status: 'succeeded',
    note: input.note ?? null,
    received_at: input.receivedAt ?? now,
    created_at: now,
  };
  await ctx.db.insertInto('billing_payments').values(payment).execute();

  const paidCents = invoice.paid_cents + input.amountCents;
  validateCents(paidCents, 'reconciled paid amount');
  const next: BillingInvoiceRow = { ...invoice, paid_cents: paidCents };
  next.status = computeInvoiceStatus(next, now);
  next.paid_at = next.status === 'paid' ? (invoice.paid_at ?? now) : invoice.paid_at;
  next.updated_at = now;
  await ctx.db
    .updateTable('billing_invoices')
    .set({
      paid_cents: next.paid_cents,
      status: next.status,
      paid_at: next.paid_at,
      updated_at: next.updated_at,
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', invoiceId)
    .execute();

  await audit(asCoreDb(ctx.db), tenantId, actor, 'billing.payment.recorded', 'billing.payment', payment.id, {
    invoiceId,
    amountCents: input.amountCents,
    status: next.status,
  });
  if (receiptRef) {
    await ctx.db.insertInto('billing_payment_receipts').values({ id: id(), tenant_id: tenantId, receipt_ref: receiptRef, input_hash: inputHash, invoice_id: invoiceId, payment_id: payment.id, created_at: now }).execute();
  }
  await suppressPreparedReminders(ctx, tenantId, actor, invoiceId, next.status === 'paid' ? 'paid' : 'balance_changed');
  const result = { payment, invoice: toInvoiceDto(next), replayed: false };
  if (options.emitEvents !== false) {
    await emitPaymentEvents(ctx.events, tenantId, result);
  }
  return result;
}

async function emitPaymentEvents(
  events: EventBus,
  tenantId: string,
  result: RecordPaymentResult,
): Promise<void> {
  await events.emit(tenantId, 'billing.payment.recorded', {
    paymentId: result.payment.id,
    invoiceId: result.payment.invoice_id,
    amountCents: result.payment.amount_cents,
  });
  // The guards reject already-paid invoices, so reaching "paid" is the
  // transition and this event is emitted exactly once after a successful commit.
  if (result.invoice.status === 'paid') {
    await events.emit(tenantId, 'billing.invoice.paid', {
      invoiceId: result.invoice.id,
      customerId: result.invoice.customer_id,
      totalCents: result.invoice.total_cents,
    });
  }
}

export async function listPayments(
  db: Kysely<BillingDatabase>,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
  filters: { invoice_id?: string } = {},
): Promise<Array<BillingPaymentRow & { receipt_ref: string | null }>> {
  let query = db.selectFrom('billing_payments').selectAll().where('tenant_id', '=', tenantId);
  if (filters.invoice_id !== undefined) {
    query = query.where('invoice_id', '=', filters.invoice_id);
  }
  const rows = await query
    .orderBy('received_at')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
  const receipts = await db.selectFrom('billing_payment_receipts').selectAll().where('tenant_id', '=', tenantId).orderBy('created_at').orderBy('id').execute();
  return rows.map(row => ({ ...row, receipt_ref: receipts.find(receipt => receipt.payment_id === row.id)?.receipt_ref ?? null }));
}

/* ------------------------------------------------------------------ *
 * Payment providers: intents + webhooks
 * ------------------------------------------------------------------ */

export type ProviderRegistry = ReadonlyMap<string, PaymentProvider>;

export function buildProviderRegistry(providers: readonly PaymentProvider[]): ProviderRegistry {
  return new Map(providers.map((p) => [p.key, p]));
}

function requireProvider(providers: ProviderRegistry, key: string): PaymentProvider {
  const provider = providers.get(key);
  if (!provider) {
    throw new ApiError(501, `payment provider not configured: ${key}`, 'provider_not_configured', {
      available: [...providers.keys()],
    });
  }
  return provider;
}

/** Create a provider payment intent for the invoice's remaining balance. */
export async function createPaymentIntent(
  ctx: BillingCtx,
  providers: ProviderRegistry,
  tenantId: string,
  invoiceId: string,
  providerKey: string,
  purpose: 'deposit' | 'balance' = 'balance',
): Promise<PaymentIntent> {
  const provider = requireProvider(providers, providerKey);
  const invoice = await getInvoiceRow(ctx.db, tenantId, invoiceId);
  if (!invoice) throw ApiError.notFound(`invoice not found: ${invoiceId}`);
  if (!['sent', 'partial', 'overdue'].includes(invoice.status)) {
    throw ApiError.conflict(`invoice is not collectible (status: ${invoice.status})`);
  }
  const remaining = Math.max(invoice.total_cents - invoice.paid_cents, 0);
  if (remaining <= 0) throw ApiError.conflict('invoice has no remaining balance');
  const collection = await getCollectionPlan(ctx.db, tenantId, invoiceId);
  const amountCents = purpose === 'deposit' ? collection.depositRemainingCents : remaining;
  if (amountCents <= 0) throw ApiError.conflict('No deposit is outstanding.');
  return provider.createPaymentIntent({
    tenantId,
    invoiceId,
    amountCents,
    metadata: { invoiceId, invoiceNumber: invoice.number },
  });
}

export interface WebhookResult {
  event: WebhookEventDto;
  outcome: WebhookOutcome;
}

/**
 * Persist a raw provider webhook event, let the adapter normalize it, and
 * apply "payment_succeeded" outcomes as recorded payments (actor "system").
 */
export async function recordWebhookEvent(
  ctx: BillingCtx,
  providers: ProviderRegistry,
  tenantId: string,
  providerKey: string,
  event: Omit<ProviderWebhookEvent, 'tenantId'>,
): Promise<WebhookResult> {
  const provider = requireProvider(providers, providerKey);
  const normalized = await provider.recordWebhookEvent({ tenantId, ...event });

  // One process owns SQLite, so this transaction serializes provider-ref
  // idempotency with the payment insert and invoice read-modify-write.
  const committed = await ctx.db.transaction().execute(async (trx) => {
    const now = nowIso();
    const eventType =
      event.payload &&
      typeof event.payload === 'object' &&
      typeof (event.payload as { type?: unknown }).type === 'string'
        ? ((event.payload as { type: string }).type)
        : null;
    const row: BillingWebhookEventRow = {
      id: id(),
      tenant_id: tenantId,
      provider: providerKey,
      event_type: eventType,
      payload: event.rawBody,
      outcome: null,
      processed: 0,
      created_at: now,
    };
    await trx.insertInto('billing_webhook_events').values(row).execute();
    await audit(
      asCoreDb(trx),
      tenantId,
      'system',
      'billing.webhook_event.received',
      'billing.webhook_event',
      row.id,
      { provider: providerKey, eventType },
    );

    let outcome = normalized;
    let processed = 0;
    let payment: RecordPaymentResult | undefined;
    if (outcome.kind === 'payment_succeeded') {
      if (!outcome.externalRef || outcome.externalRef.trim() === '') {
        outcome = { kind: 'ignored', reason: 'payment event missing provider reference' };
      } else {
        const duplicate = await trx
          .selectFrom('billing_payments')
          .select('id')
          .where('tenant_id', '=', tenantId)
          .where('provider', '=', providerKey)
          .where('provider_ref', '=', outcome.externalRef)
          .where('status', '=', 'succeeded')
          .executeTakeFirst();
        if (duplicate) {
          outcome = {
            kind: 'ignored',
            reason: `duplicate delivery: payment ${duplicate.id} already recorded for ${outcome.externalRef}`,
          };
        } else {
          payment = await recordPayment(
            { db: trx, events: ctx.events },
            tenantId,
            'system',
            outcome.invoiceId,
            {
              amountCents: outcome.amountCents,
              method: `provider:${providerKey}`,
              provider: providerKey,
              providerRef: outcome.externalRef,
            },
            { emitEvents: false },
          );
          processed = 1;
        }
      }
    }
    await trx
      .updateTable('billing_webhook_events')
      .set({ outcome: JSON.stringify(outcome), processed })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', row.id)
      .execute();
    return {
      result: {
        event: toWebhookEventDto({ ...row, outcome: JSON.stringify(outcome), processed }),
        outcome,
      },
      payment,
    };
  });
  if (committed.payment) {
    await emitPaymentEvents(ctx.events, tenantId, committed.payment);
  }
  return committed.result;
}

/* ------------------------------------------------------------------ *
 * Quote -> invoice conversion
 * ------------------------------------------------------------------ */

/**
 * Quote payload contract: the caller (quoting module / apps/api) sends the
 * quote's data by value — billing never reads quoting tables. Line/discount/
 * tax semantics are identical to quoting's (core computeTotals).
 */
export interface QuoteToInvoiceInput {
  quoteId: string;
  customerId: string;
  lines: InvoiceLineInputSvc[];
  discountBps?: number;
  discountFixedCents?: number;
  taxBps?: number;
  dueAt?: string;
  memo?: string;
  portalVisible?: boolean;
  billingAccountId?: string;
}

export async function convertQuoteToInvoice(
  ctx: BillingCtx,
  tenantId: string,
  actor: string,
  input: QuoteToInvoiceInput,
): Promise<InvoiceWithLines> {
  if (!ctx.db.isTransaction) return withBillingTransaction(ctx, tenantId, txCtx => convertQuoteToInvoice(txCtx, tenantId, actor, input));
  if (!input.quoteId || input.quoteId.trim() === '') {
    throw ApiError.badRequest('quoteId is required');
  }
  const result = await createInvoiceOnce(ctx, tenantId, actor, {
    customerId: input.customerId,
    billingAccountId: input.billingAccountId,
    lines: input.lines,
    discountBps: input.discountBps,
    discountFixedCents: input.discountFixedCents,
    taxBps: input.taxBps,
    dueAt: input.dueAt,
    memo: input.memo,
    portalVisible: input.portalVisible,
    sourceEntityType: 'quoting.quote',
    sourceEntityId: input.quoteId,
  });
  await ctx.events.emit(tenantId, 'billing.invoice.converted', {
    invoiceId: result.invoice.id,
    quoteId: input.quoteId,
  });
  return result;
}

async function createInvoiceOnce(ctx: BillingCtx, tenantId: string, actor: string, input: CreateInvoiceInputSvc): Promise<InvoiceWithLines> {
  if (!ctx.db.isTransaction) return withBillingTransaction(ctx, tenantId, txCtx => createInvoiceOnce(txCtx, tenantId, actor, input));
  if (!input.sourceEntityType || !input.sourceEntityId) return createInvoice(ctx, tenantId, actor, input);
  const inputHash = fingerprint({ customerId: input.customerId, billingAccountId: input.billingAccountId ?? null,
    lines: input.lines.map(line => ({ description: line.description, quantity: line.quantity, unitPriceCents: line.unitPriceCents, discountBps: line.discountBps ?? null, discountFixedCents: line.discountFixedCents ?? null })),
    discountBps: input.discountBps ?? null, discountFixedCents: input.discountFixedCents ?? null, taxBps: input.taxBps ?? null,
    dueAt: input.dueAt ?? null, memo: input.memo ?? null, portalVisible: input.portalVisible ?? false });
  const prior = await ctx.db.selectFrom('billing_source_receipts').selectAll().where('tenant_id', '=', tenantId)
    .where('source_entity_type', '=', input.sourceEntityType).where('source_entity_id', '=', input.sourceEntityId).executeTakeFirst();
  if (prior) {
    if (prior.input_hash !== inputHash) throw ApiError.conflict('Invoice source was replayed with different scope or amounts.');
    const invoice = await getInvoice(ctx.db, tenantId, prior.invoice_id);
    if (!invoice || invoice.invoice.customer_id !== input.customerId || invoice.invoice.source_entity_type !== input.sourceEntityType || invoice.invoice.source_entity_id !== input.sourceEntityId) throw ApiError.conflict('Invoice source receipt readback needs review.');
    const expectedTotals = computeTotals(input.lines.map(line => ({ quantity: line.quantity, unitPriceCents: line.unitPriceCents, discount: toDiscount(line.discountBps, line.discountFixedCents) })), { discount: toDiscount(input.discountBps, input.discountFixedCents), taxBps: input.taxBps });
    const expectedLines = input.lines.map(line => ({ description: line.description, quantity: line.quantity, unitPriceCents: line.unitPriceCents, discountBps: line.discountBps ?? null, discountFixedCents: line.discountFixedCents ?? null }));
    const actualLines = invoice.lines.map(line => ({ description: line.description, quantity: line.quantity, unitPriceCents: line.unit_price_cents, discountBps: line.discount_bps, discountFixedCents: line.discount_fixed_cents }));
    if (JSON.stringify(actualLines) !== JSON.stringify(expectedLines) || invoice.invoice.total_cents !== expectedTotals.totalCents || invoice.invoice.subtotal_cents !== expectedTotals.subtotalCents || invoice.invoice.discount_cents !== expectedTotals.discountCents || invoice.invoice.tax_cents !== expectedTotals.taxCents) throw ApiError.conflict('Invoice source receipt scope changed; review before retrying.');
    return invoice;
  }
  const legacy = await ctx.db.selectFrom('billing_invoices').select('id').where('tenant_id', '=', tenantId)
    .where('source_entity_type', '=', input.sourceEntityType).where('source_entity_id', '=', input.sourceEntityId).orderBy('created_at').orderBy('id').execute();
  if (legacy.length > 1) throw ApiError.conflict('Multiple invoices already use this source; reconcile them before retrying.');
  const result = legacy.length ? await getInvoice(ctx.db, tenantId, legacy[0].id) : await createInvoice(ctx, tenantId, actor, input);
  if (!result) throw ApiError.conflict('Invoice source is missing.');
  if (legacy.length) {
    const expected = computeTotals(input.lines.map(line => ({ quantity: line.quantity, unitPriceCents: line.unitPriceCents, discount: toDiscount(line.discountBps, line.discountFixedCents) })), { discount: toDiscount(input.discountBps, input.discountFixedCents), taxBps: input.taxBps });
    const expectedLines = input.lines.map(line => [line.description, line.quantity, line.unitPriceCents, line.discountBps ?? null, line.discountFixedCents ?? null]);
    const actualLines = result.lines.map(line => [line.description, line.quantity, line.unit_price_cents, line.discount_bps, line.discount_fixed_cents]);
    if (result.invoice.customer_id !== input.customerId || result.invoice.total_cents !== expected.totalCents || result.invoice.subtotal_cents !== expected.subtotalCents || result.invoice.discount_cents !== expected.discountCents || result.invoice.tax_cents !== expected.taxCents || JSON.stringify(expectedLines) !== JSON.stringify(actualLines)) throw ApiError.conflict('Earlier source invoice differs from the requested work; review before retrying.');
  }
  await ctx.db.insertInto('billing_source_receipts').values({ id: id(), tenant_id: tenantId, source_entity_type: input.sourceEntityType,
    source_entity_id: input.sourceEntityId, input_hash: inputHash, invoice_id: result.invoice.id, created_at: nowIso() }).execute();
  await audit(asCoreDb(ctx.db), tenantId, actor, 'billing.invoice.source_verified', 'billing.invoice', result.invoice.id, { sourceEntityType: input.sourceEntityType, sourceEntityId: input.sourceEntityId });
  return result;
}

/** CreateInvoiceContract implementation (wired by apps/api into deps.contracts). */
export function billingCreateInvoiceContract(
  db: Kysely<BillingDatabase>,
  events: EventBus,
): CreateInvoiceContract {
  return {
    async createInvoice(input: CreateInvoiceInput): Promise<{ id: string }> {
      const { invoice } = await createInvoiceOnce({ db, events }, input.tenantId, 'system', {
        customerId: input.customerId,
        lines: input.lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
          discountBps: l.discountBps,
          discountFixedCents: l.discountFixedCents,
        })),
        discountBps: input.discountBps,
        discountFixedCents: input.discountFixedCents,
        taxBps: input.taxBps,
        dueAt: input.dueAt,
        memo: input.memo,
        sourceEntityType: input.sourceEntityType,
        sourceEntityId: input.sourceEntityId,
      });
      return { id: invoice.id };
    },
  };
}

/* ------------------------------------------------------------------ *
 * CSV export
 * ------------------------------------------------------------------ */

export const INVOICE_CSV_COLUMNS = [
  'number',
  'status',
  'customer_id',
  'subtotal_cents',
  'discount_cents',
  'tax_cents',
  'total_cents',
  'paid_cents',
  'balance_cents',
  'source_entity_type',
  'source_entity_id',
  'due_at',
  'sent_at',
  'paid_at',
  'created_at',
  'id',
] as const;

export async function exportInvoicesCsv(
  db: Kysely<BillingDatabase>,
  tenantId: string,
): Promise<string> {
  const rows = await db
    .selectFrom('billing_invoices')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return serializeCsv(
    rows.map((r) => ({ ...r, balance_cents: Math.max(0, r.total_cents - r.paid_cents) })),
    INVOICE_CSV_COLUMNS,
  );
}

/* ------------------------------------------------------------------ *
 * Subscriptions (recurring-invoice placeholder)
 * ------------------------------------------------------------------ */

const INTERVAL_DELTAS: Record<SubscriptionInterval, Record<string, number>> = {
  daily: { days: 1 },
  weekly: { weeks: 1 },
  monthly: { months: 1 },
  quarterly: { months: 3 },
  yearly: { years: 1 },
};

/** Advance an ISO-8601 UTC instant by one subscription interval (luxon). */
export function advanceInterval(iso: string, interval: SubscriptionInterval): string {
  const next = DateTime.fromISO(iso, { zone: 'utc' }).plus(INTERVAL_DELTAS[interval]).toISO();
  if (!next) throw ApiError.badRequest(`invalid timestamp: ${iso}`);
  return next;
}

export interface CreateSubscriptionInputSvc {
  customerId: string;
  planName: string;
  amountCents: number;
  interval: SubscriptionInterval;
  nextInvoiceAt: string;
  taxBps?: number;
  billingAccountId?: string;
}

export async function createSubscription(
  ctx: BillingCtx,
  tenantId: string,
  actor: string,
  input: CreateSubscriptionInputSvc,
): Promise<BillingSubscriptionRow> {
  if (input.billingAccountId) {
    const account = await getBillingAccount(ctx.db, tenantId, input.billingAccountId);
    if (!account) throw ApiError.badRequest(`unknown billing account: ${input.billingAccountId}`);
  }
  const now = nowIso();
  const row: BillingSubscriptionRow = {
    id: id(),
    tenant_id: tenantId,
    customer_id: input.customerId,
    billing_account_id: input.billingAccountId ?? null,
    plan_name: input.planName,
    amount_cents: input.amountCents,
    tax_bps: input.taxBps ?? null,
    interval: input.interval,
    status: 'active',
    next_invoice_at: input.nextInvoiceAt,
    created_at: now,
    updated_at: now,
  };
  await ctx.db.insertInto('billing_subscriptions').values(row).execute();
  await audit(asCoreDb(ctx.db), tenantId, actor, 'billing.subscription.created', 'billing.subscription', row.id, {
    planName: row.plan_name,
    interval: row.interval,
  });
  await ctx.events.emit(tenantId, 'billing.subscription.created', {
    subscriptionId: row.id,
    customerId: row.customer_id,
  });
  return row;
}

export async function getSubscription(
  db: Kysely<BillingDatabase>,
  tenantId: string,
  subscriptionId: string,
): Promise<BillingSubscriptionRow | undefined> {
  return db
    .selectFrom('billing_subscriptions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', subscriptionId)
    .executeTakeFirst();
}

export async function listSubscriptions(
  db: Kysely<BillingDatabase>,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
  filters: { status?: string; customer_id?: string } = {},
): Promise<BillingSubscriptionRow[]> {
  let query = db.selectFrom('billing_subscriptions').selectAll().where('tenant_id', '=', tenantId);
  if (filters.status !== undefined) {
    query = query.where('status', '=', filters.status as SubscriptionStatus);
  }
  if (filters.customer_id !== undefined) {
    query = query.where('customer_id', '=', filters.customer_id);
  }
  return query
    .orderBy('created_at')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export interface UpdateSubscriptionInputSvc {
  status?: SubscriptionStatus;
  planName?: string;
  amountCents?: number;
  interval?: SubscriptionInterval;
  nextInvoiceAt?: string;
  taxBps?: number | null;
}

export async function updateSubscription(
  ctx: BillingCtx,
  tenantId: string,
  actor: string,
  subscriptionId: string,
  patch: UpdateSubscriptionInputSvc,
): Promise<BillingSubscriptionRow> {
  const existing = await getSubscription(ctx.db, tenantId, subscriptionId);
  if (!existing) throw ApiError.notFound(`subscription not found: ${subscriptionId}`);
  await ctx.db
    .updateTable('billing_subscriptions')
    .set({
      status: patch.status ?? existing.status,
      plan_name: patch.planName ?? existing.plan_name,
      amount_cents: patch.amountCents ?? existing.amount_cents,
      interval: patch.interval ?? existing.interval,
      next_invoice_at: patch.nextInvoiceAt ?? existing.next_invoice_at,
      tax_bps: patch.taxBps !== undefined ? patch.taxBps : existing.tax_bps,
      updated_at: nowIso(),
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', subscriptionId)
    .execute();
  await audit(
    asCoreDb(ctx.db),
    tenantId,
    actor,
    'billing.subscription.updated',
    'billing.subscription',
    subscriptionId,
    { patch: { ...patch } },
  );
  const updated = await getSubscription(ctx.db, tenantId, subscriptionId);
  if (!updated) throw ApiError.notFound(`subscription not found: ${subscriptionId}`);
  return updated;
}

export interface GeneratedInvoiceRef {
  subscriptionId: string;
  invoiceId: string;
  nextInvoiceAt: string;
}

/**
 * Recurring-billing tick: for every ACTIVE subscription with
 * next_invoice_at <= now, create a draft invoice (one line from the plan) and
 * advance next_invoice_at by one interval FROM THE OLD VALUE (so a lapsed
 * schedule catches up one period per tick, deterministically).
 */
export async function generateDueInvoices(
  ctx: BillingCtx,
  tenantId: string,
  now: string = nowIso(),
): Promise<GeneratedInvoiceRef[]> {
  const due = await ctx.db
    .selectFrom('billing_subscriptions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'active')
    .where('next_invoice_at', '<=', now)
    .orderBy('next_invoice_at')
    .orderBy('id')
    .execute();

  const generated: GeneratedInvoiceRef[] = [];
  for (const sub of due) {
    const pending: NonNullable<BillingCtx['deferredEvents']> = [];
    const committed = await ctx.db.transaction().execute(async trx => {
      const current = await trx.selectFrom('billing_subscriptions').selectAll().where('tenant_id', '=', tenantId).where('id', '=', sub.id).executeTakeFirst();
      if (!current || current.status !== 'active' || current.next_invoice_at !== sub.next_invoice_at) return undefined;
      const nextInvoiceAt = advanceInterval(sub.next_invoice_at, sub.interval);
      const previous = await trx.selectFrom('billing_subscription_periods').selectAll().where('tenant_id', '=', tenantId)
        .where('subscription_id', '=', sub.id).where('period_start', '=', sub.next_invoice_at).executeTakeFirst();
      if (previous) {
        await trx.updateTable('billing_subscriptions').set({next_invoice_at:nextInvoiceAt,updated_at:nowIso()}).where('tenant_id','=',tenantId).where('id','=',sub.id).execute();
        return undefined;
      }
      const { invoice } = await createInvoice({ ...ctx, db: trx, deferredEvents: pending }, tenantId, 'system', {
      customerId: sub.customer_id,
      billingAccountId: sub.billing_account_id ?? undefined,
      lines: [
        {
          description: `${sub.plan_name} (${sub.interval})`,
          quantity: 1,
          unitPriceCents: sub.amount_cents,
        },
      ],
      taxBps: sub.tax_bps ?? undefined,
      memo: `Generated from subscription ${sub.id} for period starting ${sub.next_invoice_at}`,
      sourceEntityType: 'billing.subscription',
      sourceEntityId: sub.id,
    });
    await trx.insertInto('billing_subscription_periods').values({id:id(),tenant_id:tenantId,subscription_id:sub.id,period_start:sub.next_invoice_at,invoice_id:invoice.id,created_at:nowIso()}).execute();
    await trx
      .updateTable('billing_subscriptions')
      .set({ next_invoice_at: nextInvoiceAt, updated_at: nowIso() })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', sub.id)
      .execute();
    pending.push({ type: 'billing.invoice.generated', payload: {
      invoiceId: invoice.id,
      subscriptionId: sub.id,
      customerId: sub.customer_id,
      totalCents: invoice.total_cents,
    }});
    return { subscriptionId: sub.id, invoiceId: invoice.id, nextInvoiceAt };
    });
    if (committed) {
      for (const event of pending) await ctx.events.emit(tenantId, event.type, event.payload);
      generated.push(committed);
    }
  }
  return generated;
}

/* ------------------------------------------------------------------ *
 * Memberships
 * ------------------------------------------------------------------ */

export interface CreateMembershipInputSvc {
  customerId: string;
  planKey: string;
  startedAt?: string;
  endsAt?: string;
  subscriptionId?: string;
}

export async function createMembership(
  ctx: BillingCtx,
  tenantId: string,
  actor: string,
  input: CreateMembershipInputSvc,
): Promise<BillingMembershipRow> {
  if (input.subscriptionId) {
    const sub = await getSubscription(ctx.db, tenantId, input.subscriptionId);
    if (!sub) throw ApiError.badRequest(`unknown subscription: ${input.subscriptionId}`);
  }
  const now = nowIso();
  const row: BillingMembershipRow = {
    id: id(),
    tenant_id: tenantId,
    customer_id: input.customerId,
    plan_key: input.planKey,
    status: 'active',
    subscription_id: input.subscriptionId ?? null,
    started_at: input.startedAt ?? now,
    ends_at: input.endsAt ?? null,
    created_at: now,
    updated_at: now,
  };
  await ctx.db.insertInto('billing_memberships').values(row).execute();
  await audit(asCoreDb(ctx.db), tenantId, actor, 'billing.membership.created', 'billing.membership', row.id, {
    planKey: row.plan_key,
  });
  await ctx.events.emit(tenantId, 'billing.membership.created', {
    membershipId: row.id,
    customerId: row.customer_id,
    planKey: row.plan_key,
  });
  return row;
}

export async function getMembership(
  db: Kysely<BillingDatabase>,
  tenantId: string,
  membershipId: string,
): Promise<BillingMembershipRow | undefined> {
  return db
    .selectFrom('billing_memberships')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', membershipId)
    .executeTakeFirst();
}

export async function listMemberships(
  db: Kysely<BillingDatabase>,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
  filters: { status?: string; customer_id?: string; plan_key?: string } = {},
): Promise<BillingMembershipRow[]> {
  let query = db.selectFrom('billing_memberships').selectAll().where('tenant_id', '=', tenantId);
  if (filters.status !== undefined) {
    query = query.where('status', '=', filters.status as MembershipStatus);
  }
  if (filters.customer_id !== undefined) {
    query = query.where('customer_id', '=', filters.customer_id);
  }
  if (filters.plan_key !== undefined) {
    query = query.where('plan_key', '=', filters.plan_key);
  }
  return query
    .orderBy('created_at')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export interface UpdateMembershipInputSvc {
  status?: MembershipStatus;
  planKey?: string;
  endsAt?: string | null;
}

export async function updateMembership(
  ctx: BillingCtx,
  tenantId: string,
  actor: string,
  membershipId: string,
  patch: UpdateMembershipInputSvc,
): Promise<BillingMembershipRow> {
  const existing = await getMembership(ctx.db, tenantId, membershipId);
  if (!existing) throw ApiError.notFound(`membership not found: ${membershipId}`);
  await ctx.db
    .updateTable('billing_memberships')
    .set({
      status: patch.status ?? existing.status,
      plan_key: patch.planKey ?? existing.plan_key,
      ends_at: patch.endsAt !== undefined ? patch.endsAt : existing.ends_at,
      updated_at: nowIso(),
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', membershipId)
    .execute();
  await audit(
    asCoreDb(ctx.db),
    tenantId,
    actor,
    'billing.membership.updated',
    'billing.membership',
    membershipId,
    { patch: { ...patch } },
  );
  const updated = await getMembership(ctx.db, tenantId, membershipId);
  if (!updated) throw ApiError.notFound(`membership not found: ${membershipId}`);
  return updated;
}

/* ------------------------------------------------------------------ *
 * Billing accounts
 * ------------------------------------------------------------------ */

export interface CreateBillingAccountInputSvc {
  customerId: string;
  name: string;
  email?: string;
  phone?: string;
  address?: string;
  notes?: string;
}

export async function createBillingAccount(
  ctx: BillingCtx,
  tenantId: string,
  actor: string,
  input: CreateBillingAccountInputSvc,
): Promise<BillingAccountRow> {
  const now = nowIso();
  const row: BillingAccountRow = {
    id: id(),
    tenant_id: tenantId,
    customer_id: input.customerId,
    name: input.name,
    email: input.email ?? null,
    phone: input.phone ?? null,
    address: input.address ?? null,
    notes: input.notes ?? null,
    created_at: now,
    updated_at: now,
  };
  await ctx.db.insertInto('billing_accounts').values(row).execute();
  await audit(asCoreDb(ctx.db), tenantId, actor, 'billing.account.created', 'billing.account', row.id, {
    customerId: row.customer_id,
  });
  return row;
}

export async function getBillingAccount(
  db: Kysely<BillingDatabase>,
  tenantId: string,
  accountId: string,
): Promise<BillingAccountRow | undefined> {
  return db
    .selectFrom('billing_accounts')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', accountId)
    .executeTakeFirst();
}

export async function listBillingAccounts(
  db: Kysely<BillingDatabase>,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
  filters: { customer_id?: string } = {},
): Promise<BillingAccountRow[]> {
  let query = db.selectFrom('billing_accounts').selectAll().where('tenant_id', '=', tenantId);
  if (filters.customer_id !== undefined) {
    query = query.where('customer_id', '=', filters.customer_id);
  }
  return query
    .orderBy('created_at')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export interface UpdateBillingAccountInputSvc {
  name?: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
}

export async function updateBillingAccount(
  ctx: BillingCtx,
  tenantId: string,
  actor: string,
  accountId: string,
  patch: UpdateBillingAccountInputSvc,
): Promise<BillingAccountRow> {
  const existing = await getBillingAccount(ctx.db, tenantId, accountId);
  if (!existing) throw ApiError.notFound(`billing account not found: ${accountId}`);
  await ctx.db
    .updateTable('billing_accounts')
    .set({
      name: patch.name ?? existing.name,
      email: patch.email !== undefined ? patch.email : existing.email,
      phone: patch.phone !== undefined ? patch.phone : existing.phone,
      address: patch.address !== undefined ? patch.address : existing.address,
      notes: patch.notes !== undefined ? patch.notes : existing.notes,
      updated_at: nowIso(),
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', accountId)
    .execute();
  await audit(asCoreDb(ctx.db), tenantId, actor, 'billing.account.updated', 'billing.account', accountId);
  const updated = await getBillingAccount(ctx.db, tenantId, accountId);
  if (!updated) throw ApiError.notFound(`billing account not found: ${accountId}`);
  return updated;
}

export async function deleteBillingAccount(
  ctx: BillingCtx,
  tenantId: string,
  actor: string,
  accountId: string,
): Promise<void> {
  const result = await ctx.db
    .deleteFrom('billing_accounts')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', accountId)
    .executeTakeFirst();
  if (result.numDeletedRows === 0n) {
    throw ApiError.notFound(`billing account not found: ${accountId}`);
  }
  await audit(asCoreDb(ctx.db), tenantId, actor, 'billing.account.deleted', 'billing.account', accountId);
}

// applyDiscount is re-exported so callers see the exact shared math in one place.
export { applyDiscount };

/* ------------------------------------------------------------------ *
 * Deposit/balance collection plans and deliberate reminder drafts
 * ------------------------------------------------------------------ */
export interface CollectionPlanInput {
  depositCents: number;
  depositDueAt?: string | null;
  balanceDueAt?: string | null;
  remindersEnabled?: boolean;
  optedOut?: boolean;
}
export interface CollectionPlanDetails {
  invoiceId: string;
  plan: BillingCollectionPlanRow | null;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  depositRemainingCents: number;
  overpaidCents: number;
  stage: 'deposit' | 'balance' | 'settled' | 'stopped' | 'draft';
  dueAt: string | null;
  reminderStopReason: string | null;
}
export async function getCollectionPlan(db: Kysely<BillingDatabase>, tenantId: string, invoiceId: string): Promise<CollectionPlanDetails> {
  const invoice = await getInvoiceRow(db, tenantId, invoiceId);
  if (!invoice) throw ApiError.notFound('Invoice not found.');
  const plan = await db.selectFrom('billing_collection_plans').selectAll().where('tenant_id', '=', tenantId).where('invoice_id', '=', invoiceId).executeTakeFirst();
  const balanceCents = Math.max(0, invoice.total_cents - invoice.paid_cents);
  const depositRemainingCents = Math.min(balanceCents, Math.max(0, (plan?.deposit_cents ?? 0) - invoice.paid_cents));
  const stage = invoice.status === 'void' ? 'stopped' : balanceCents === 0 ? 'settled' : invoice.status === 'draft' ? 'draft' : depositRemainingCents > 0 ? 'deposit' : 'balance';
  const dueAt = stage === 'deposit' ? plan?.deposit_due_at ?? null : plan?.balance_due_at ?? invoice.due_at;
  const reminderStopReason = stage === 'stopped' ? 'void' : stage === 'settled' ? 'paid' : stage === 'draft' ? 'draft'
    : !plan?.reminders_enabled ? 'disabled' : plan.opted_out ? 'opted_out' : null;
  return { invoiceId, plan: plan ?? null, totalCents: invoice.total_cents, paidCents: invoice.paid_cents, balanceCents, depositRemainingCents,
    overpaidCents: Math.max(0, invoice.paid_cents - invoice.total_cents), stage, dueAt, reminderStopReason };
}

export async function setCollectionPlan(ctx: BillingCtx, tenantId: string, actor: string, invoiceId: string, input: CollectionPlanInput): Promise<CollectionPlanDetails> {
  if (!ctx.db.isTransaction) return withBillingTransaction(ctx, tenantId, txCtx => setCollectionPlan(txCtx, tenantId, actor, invoiceId, input));
  const details = await getCollectionPlan(ctx.db, tenantId, invoiceId);
  validateCents(input.depositCents, 'depositCents');
  if (input.depositCents > details.totalCents) throw ApiError.badRequest('Deposit exceeds the approved invoice total.');
  for (const date of [input.depositDueAt, input.balanceDueAt]) if (date != null && !Number.isFinite(Date.parse(date))) throw ApiError.badRequest('Collection due dates must be valid UTC dates.');
  if (input.depositDueAt && input.balanceDueAt && Date.parse(input.depositDueAt) > Date.parse(input.balanceDueAt)) throw ApiError.badRequest('Balance due date must not precede the deposit.');
  if (details.paidCents > 0 && (input.depositCents !== (details.plan?.deposit_cents ?? 0)
    || (input.depositDueAt ?? null) !== (details.plan?.deposit_due_at ?? null) || (input.balanceDueAt ?? null) !== (details.plan?.balance_due_at ?? null))) {
    throw ApiError.conflict('Reconciled payment terms cannot be changed; reminder preferences may still be updated.');
  }
  const now = nowIso();
  const values = { deposit_cents: input.depositCents, deposit_due_at: input.depositDueAt ?? null, balance_due_at: input.balanceDueAt ?? null,
    reminders_enabled: input.remindersEnabled === undefined ? details.plan?.reminders_enabled ?? 0 : input.remindersEnabled ? 1 : 0,
    opted_out: input.optedOut === undefined ? details.plan?.opted_out ?? 0 : input.optedOut ? 1 : 0, updated_at: now };
  if (details.plan) await ctx.db.updateTable('billing_collection_plans').set(values).where('tenant_id', '=', tenantId).where('id', '=', details.plan.id).execute();
  else await ctx.db.insertInto('billing_collection_plans').values({ ...values, id: id(), tenant_id: tenantId, invoice_id: invoiceId, created_at: now }).execute();
  await suppressPreparedReminders(ctx, tenantId, actor, invoiceId, values.opted_out ? 'opted_out' : !values.reminders_enabled ? 'disabled' : 'terms_changed');
  await audit(asCoreDb(ctx.db), tenantId, actor, 'billing.collection.configured', 'billing.invoice', invoiceId, { depositCents: input.depositCents, remindersEnabled: !!values.reminders_enabled, optedOut: !!values.opted_out });
  return getCollectionPlan(ctx.db, tenantId, invoiceId);
}

async function suppressPreparedReminders(ctx: BillingCtx, tenantId: string, actor: string, invoiceId: string, reason: string): Promise<void> {
  const result = await ctx.db.updateTable('billing_reminder_receipts').set({ status: 'suppressed', reason, updated_at: nowIso() })
    .where('tenant_id', '=', tenantId).where('invoice_id', '=', invoiceId).where('status', '=', 'prepared').executeTakeFirst();
  if (result.numUpdatedRows) await audit(asCoreDb(ctx.db), tenantId, actor, 'billing.reminder.stopped', 'billing.invoice', invoiceId, { reason, count: Number(result.numUpdatedRows) });
}

/** Creates an inspectable draft only; never contacts the customer or claims delivery. */
export async function prepareCollectionReminder(ctx: BillingCtx, tenantId: string, actor: string, invoiceId: string, operationKey: string): Promise<BillingReminderRow> {
  if (!ctx.db.isTransaction) return withBillingTransaction(ctx, tenantId, txCtx => prepareCollectionReminder(txCtx, tenantId, actor, invoiceId, operationKey));
  if (!operationKey?.trim() || operationKey.length > 160) throw ApiError.badRequest('A bounded reminder operation key is required.');
  const details = await getCollectionPlan(ctx.db, tenantId, invoiceId);
  const prior = await ctx.db.selectFrom('billing_reminder_receipts').selectAll().where('tenant_id', '=', tenantId).where('operation_key', '=', operationKey).executeTakeFirst();
  if (prior) { if (prior.invoice_id !== invoiceId) throw ApiError.conflict('Reminder operation belongs to another invoice.'); return prior; }
  const invoice = await getInvoiceRow(ctx.db, tenantId, invoiceId);
  const amount = details.stage === 'deposit' ? details.depositRemainingCents : details.balanceCents;
  const reason = details.reminderStopReason ?? (!details.dueAt ? 'no_due_date' : Date.parse(details.dueAt) > Date.now() ? 'not_due' : null);
  const now = nowIso();
  const row: BillingReminderRow = { id: id(), tenant_id: tenantId, invoice_id: invoiceId, operation_key: operationKey,
    stage: details.stage === 'deposit' ? 'deposit' : 'balance', amount_cents: amount, status: reason ? 'suppressed' : 'prepared', reason,
    message: reason ? null : `Invoice ${invoice!.number}: ${details.stage === 'deposit' ? 'deposit' : 'remaining balance'} of $${(amount / 100).toFixed(2)} is due. Please contact us if you need help with payment.`,
    delivery_reference: null, created_at: now, updated_at: now };
  await ctx.db.insertInto('billing_reminder_receipts').values(row).execute();
  await audit(asCoreDb(ctx.db), tenantId, actor, 'billing.reminder.prepared', 'billing.reminder', row.id, { invoiceId, status: row.status, reason });
  return row;
}

/** Explicit manual readback receipt; this operation itself does not send anything. */
export async function recordCollectionReminder(ctx: BillingCtx, tenantId: string, actor: string, invoiceId: string, reminderId: string, deliveryReference: string): Promise<BillingReminderRow> {
  if (!ctx.db.isTransaction) return withBillingTransaction(ctx, tenantId, txCtx => recordCollectionReminder(txCtx, tenantId, actor, invoiceId, reminderId, deliveryReference));
  if (!deliveryReference?.trim() || deliveryReference.length > 200) throw ApiError.badRequest('Actual delivery reference is required.');
  const row = await ctx.db.selectFrom('billing_reminder_receipts').selectAll().where('tenant_id', '=', tenantId).where('invoice_id', '=', invoiceId).where('id', '=', reminderId).executeTakeFirst();
  if (!row) throw ApiError.notFound('Reminder not found.');
  if (row.status === 'recorded') { if (row.delivery_reference !== deliveryReference) throw ApiError.conflict('Delivery reference already recorded.'); return row; }
  const current = await getCollectionPlan(ctx.db, tenantId, invoiceId);
  if (row.status !== 'prepared' || current.reminderStopReason || current.stage !== row.stage || (row.stage === 'deposit' ? current.depositRemainingCents : current.balanceCents) !== row.amount_cents) throw ApiError.conflict('Reminder stopped or its amount changed; reconcile it before recording delivery.');
  const updated: BillingReminderRow = { ...row, status: 'recorded', delivery_reference: deliveryReference, updated_at: nowIso() };
  await ctx.db.updateTable('billing_reminder_receipts').set({ status: updated.status, delivery_reference: deliveryReference, updated_at: updated.updated_at })
    .where('tenant_id', '=', tenantId).where('id', '=', reminderId).execute();
  await audit(asCoreDb(ctx.db), tenantId, actor, 'billing.reminder.recorded', 'billing.reminder', reminderId, { invoiceId, deliveryReference });
  return updated;
}

export async function listCollectionReminders(db: Kysely<BillingDatabase>, tenantId: string, invoiceId: string): Promise<BillingReminderRow[]> {
  await getCollectionPlan(db, tenantId, invoiceId);
  return db.selectFrom('billing_reminder_receipts').selectAll().where('tenant_id', '=', tenantId).where('invoice_id', '=', invoiceId).orderBy('created_at').orderBy('id').execute();
}

export async function exportPaymentsCsv(db: Kysely<BillingDatabase>, tenantId: string): Promise<string> {
  const payments = await db.selectFrom('billing_payments').selectAll().where('tenant_id', '=', tenantId).orderBy('received_at').orderBy('id').execute();
  const receipts = await db.selectFrom('billing_payment_receipts').selectAll().where('tenant_id', '=', tenantId).orderBy('created_at').orderBy('id').execute();
  return serializeCsv(payments.map(payment => ({ ...payment, receipt_ref: receipts.find(receipt => receipt.payment_id === payment.id)?.receipt_ref ?? null })),
    ['id', 'invoice_id', 'amount_cents', 'method', 'status', 'receipt_ref', 'provider', 'provider_ref', 'received_at']);
}
