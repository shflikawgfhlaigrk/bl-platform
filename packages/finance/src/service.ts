import type { Kysely } from 'kysely';
import { DateTime } from 'luxon';
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
  FinanceCashAdjustmentRow,
  FinanceCashSessionRow,
  FinanceCostMethod,
  FinanceDatabase,
  FinanceDisputeRow,
  FinanceItemCostRow,
  FinanceJurisdictionSource,
  FinanceLiabilitySnapshotRow,
  FinancePaymentRow,
  FinancePayoutMatchRow,
  FinancePayoutRow,
  FinanceRefundRow,
  FinanceSourceKind,
  FinanceTaxConfigRow,
  FinanceTaxEvidenceRow,
  FinanceVendorBillRefRow,
} from './schema';

type Db = Kysely<FinanceDatabase>;

const BUSINESS_ZONE = 'America/New_York';
const SOURCE_KINDS: readonly FinanceSourceKind[] = ['card', 'cash', 'external', 'wallet', 'gift_card'];
const COST_METHODS: readonly FinanceCostMethod[] = ['vendor_invoice', 'manual', 'weighted_average'];

/** {inserted,updated,skipped} — every idempotent import returns this exact shape. */
export interface ImportResult {
  inserted: number;
  updated: number;
  skipped: number;
}

function newResult(): ImportResult {
  return { inserted: 0, updated: 0, skipped: 0 };
}

function assertIntCents(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw ApiError.badRequest(`${label} must be integer cents, got ${value}`);
  }
}

/* ================================================================== *
 * A. LEDGER IMPORTS (idempotent, keyed on source ids)
 * ================================================================== */

export interface ImportPaymentInput {
  sourcePaymentId: string;
  orderRef?: string | null;
  amountCents: number;
  feeCents: number;
  netCents: number;
  sourceKind: FinanceSourceKind;
  cardBrand?: string | null;
  status: string;
  occurredAt: string;
}

export async function importPayments(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  rows: ImportPaymentInput[],
): Promise<ImportResult> {
  const res = newResult();
  await db.transaction().execute(async (trx) => {
    const now = nowIso();
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.sourcePaymentId)) {
        res.skipped += 1;
        continue;
      }
      seen.add(r.sourcePaymentId);
      if (!SOURCE_KINDS.includes(r.sourceKind)) {
        throw ApiError.badRequest(`invalid source_kind "${r.sourceKind}"`);
      }
      assertIntCents(r.amountCents, 'amountCents');
      assertIntCents(r.feeCents, 'feeCents');
      assertIntCents(r.netCents, 'netCents');
      const existing = await trx
        .selectFrom('finance_payments')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('source_payment_id', '=', r.sourcePaymentId)
        .executeTakeFirst();
      const next = {
        order_ref: r.orderRef ?? null,
        amount_cents: r.amountCents,
        fee_cents: r.feeCents,
        net_cents: r.netCents,
        source_kind: r.sourceKind,
        card_brand: r.cardBrand ?? null,
        status: r.status,
        occurred_at: r.occurredAt,
      };
      if (existing) {
        const changed =
          existing.order_ref !== next.order_ref ||
          existing.amount_cents !== next.amount_cents ||
          existing.fee_cents !== next.fee_cents ||
          existing.net_cents !== next.net_cents ||
          existing.source_kind !== next.source_kind ||
          existing.card_brand !== next.card_brand ||
          existing.status !== next.status ||
          existing.occurred_at !== next.occurred_at;
        if (changed) {
          await trx
            .updateTable('finance_payments')
            .set(next)
            .where('tenant_id', '=', tenantId)
            .where('id', '=', existing.id)
            .execute();
          res.updated += 1;
        } else {
          res.skipped += 1;
        }
        continue;
      }
      const row: FinancePaymentRow = {
        id: id(),
        tenant_id: tenantId,
        source_payment_id: r.sourcePaymentId,
        ...next,
        created_at: now,
      };
      await trx.insertInto('finance_payments').values(row).execute();
      res.inserted += 1;
    }
    await audit(asCoreDb(trx), tenantId, actor, 'finance.payment.imported', 'finance.payment', 'batch', res);
  });
  return res;
}

export interface ImportRefundInput {
  sourceRefundId: string;
  paymentRef: string;
  amountCents: number;
  occurredAt: string;
}

export async function importRefunds(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  rows: ImportRefundInput[],
): Promise<ImportResult> {
  const res = newResult();
  await db.transaction().execute(async (trx) => {
    const now = nowIso();
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.sourceRefundId)) {
        res.skipped += 1;
        continue;
      }
      seen.add(r.sourceRefundId);
      assertIntCents(r.amountCents, 'amountCents');
      const existing = await trx
        .selectFrom('finance_refunds')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('source_refund_id', '=', r.sourceRefundId)
        .executeTakeFirst();
      const next = {
        payment_ref: r.paymentRef,
        amount_cents: r.amountCents,
        occurred_at: r.occurredAt,
      };
      if (existing) {
        const changed =
          existing.payment_ref !== next.payment_ref ||
          existing.amount_cents !== next.amount_cents ||
          existing.occurred_at !== next.occurred_at;
        if (changed) {
          await trx
            .updateTable('finance_refunds')
            .set(next)
            .where('tenant_id', '=', tenantId)
            .where('id', '=', existing.id)
            .execute();
          res.updated += 1;
        } else {
          res.skipped += 1;
        }
        continue;
      }
      const row: FinanceRefundRow = {
        id: id(),
        tenant_id: tenantId,
        source_refund_id: r.sourceRefundId,
        ...next,
        created_at: now,
      };
      await trx.insertInto('finance_refunds').values(row).execute();
      res.inserted += 1;
    }
    await audit(asCoreDb(trx), tenantId, actor, 'finance.refund.imported', 'finance.refund', 'batch', res);
  });
  return res;
}

export interface ImportPayoutInput {
  sourcePayoutId: string;
  amountCents: number;
  status: string;
  paidAt: string;
  coverageStart?: string | null;
  coverageEnd?: string | null;
}

export async function importPayouts(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  rows: ImportPayoutInput[],
): Promise<ImportResult> {
  const res = newResult();
  await db.transaction().execute(async (trx) => {
    const now = nowIso();
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.sourcePayoutId)) {
        res.skipped += 1;
        continue;
      }
      seen.add(r.sourcePayoutId);
      assertIntCents(r.amountCents, 'amountCents');
      const existing = await trx
        .selectFrom('finance_payouts')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('source_payout_id', '=', r.sourcePayoutId)
        .executeTakeFirst();
      const next = {
        amount_cents: r.amountCents,
        status: r.status,
        paid_at: r.paidAt,
        coverage_start: r.coverageStart ?? null,
        coverage_end: r.coverageEnd ?? null,
      };
      if (existing) {
        const changed =
          existing.amount_cents !== next.amount_cents ||
          existing.status !== next.status ||
          existing.paid_at !== next.paid_at ||
          existing.coverage_start !== next.coverage_start ||
          existing.coverage_end !== next.coverage_end;
        if (changed) {
          await trx
            .updateTable('finance_payouts')
            .set(next)
            .where('tenant_id', '=', tenantId)
            .where('id', '=', existing.id)
            .execute();
          res.updated += 1;
        } else {
          res.skipped += 1;
        }
        continue;
      }
      const row: FinancePayoutRow = {
        id: id(),
        tenant_id: tenantId,
        source_payout_id: r.sourcePayoutId,
        ...next,
        created_at: now,
      };
      await trx.insertInto('finance_payouts').values(row).execute();
      res.inserted += 1;
    }
    await audit(asCoreDb(trx), tenantId, actor, 'finance.payout.imported', 'finance.payout', 'batch', res);
  });
  return res;
}

export interface ImportDisputeInput {
  sourceDisputeId: string;
  paymentRef?: string | null;
  amountCents: number;
  status: string;
  occurredAt: string;
}

export async function importDisputes(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  rows: ImportDisputeInput[],
): Promise<ImportResult> {
  const res = newResult();
  await db.transaction().execute(async (trx) => {
    const now = nowIso();
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.sourceDisputeId)) {
        res.skipped += 1;
        continue;
      }
      seen.add(r.sourceDisputeId);
      assertIntCents(r.amountCents, 'amountCents');
      const existing = await trx
        .selectFrom('finance_disputes')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('source_dispute_id', '=', r.sourceDisputeId)
        .executeTakeFirst();
      const next = {
        payment_ref: r.paymentRef ?? null,
        amount_cents: r.amountCents,
        status: r.status,
        occurred_at: r.occurredAt,
      };
      if (existing) {
        const changed =
          existing.payment_ref !== next.payment_ref ||
          existing.amount_cents !== next.amount_cents ||
          existing.status !== next.status ||
          existing.occurred_at !== next.occurred_at;
        if (changed) {
          await trx
            .updateTable('finance_disputes')
            .set(next)
            .where('tenant_id', '=', tenantId)
            .where('id', '=', existing.id)
            .execute();
          res.updated += 1;
        } else {
          res.skipped += 1;
        }
        continue;
      }
      const row: FinanceDisputeRow = {
        id: id(),
        tenant_id: tenantId,
        source_dispute_id: r.sourceDisputeId,
        ...next,
        created_at: now,
      };
      await trx.insertInto('finance_disputes').values(row).execute();
      res.inserted += 1;
    }
    await audit(asCoreDb(trx), tenantId, actor, 'finance.dispute.imported', 'finance.dispute', 'batch', res);
  });
  return res;
}

export interface ImportVendorBillRefInput {
  vendorBillRef: string;
  vendorRef?: string | null;
  amountCents: number;
  status: string;
  occurredAt?: string | null;
}

export async function importVendorBillRefs(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  rows: ImportVendorBillRefInput[],
): Promise<ImportResult> {
  const res = newResult();
  await db.transaction().execute(async (trx) => {
    const now = nowIso();
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.vendorBillRef)) {
        res.skipped += 1;
        continue;
      }
      seen.add(r.vendorBillRef);
      assertIntCents(r.amountCents, 'amountCents');
      const existing = await trx
        .selectFrom('finance_vendor_bill_refs')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('vendor_bill_ref', '=', r.vendorBillRef)
        .executeTakeFirst();
      const next = {
        vendor_ref: r.vendorRef ?? null,
        amount_cents: r.amountCents,
        status: r.status,
        occurred_at: r.occurredAt ?? null,
      };
      if (existing) {
        const changed =
          existing.vendor_ref !== next.vendor_ref ||
          existing.amount_cents !== next.amount_cents ||
          existing.status !== next.status ||
          existing.occurred_at !== next.occurred_at;
        if (changed) {
          await trx
            .updateTable('finance_vendor_bill_refs')
            .set(next)
            .where('tenant_id', '=', tenantId)
            .where('id', '=', existing.id)
            .execute();
          res.updated += 1;
        } else {
          res.skipped += 1;
        }
        continue;
      }
      const row: FinanceVendorBillRefRow = {
        id: id(),
        tenant_id: tenantId,
        vendor_bill_ref: r.vendorBillRef,
        ...next,
        created_at: now,
      };
      await trx.insertInto('finance_vendor_bill_refs').values(row).execute();
      res.inserted += 1;
    }
    await audit(asCoreDb(trx), tenantId, actor, 'finance.vendor_bill_ref.imported', 'finance.vendor_bill_ref', 'batch', res);
  });
  return res;
}

export interface ImportTaxEvidenceInput {
  sourceEvidenceId: string;
  orderRef: string;
  jurisdictionSource: FinanceJurisdictionSource;
  state?: string | null;
  amountCents: number;
  occurredAt: string;
}

export async function importTaxEvidence(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  rows: ImportTaxEvidenceInput[],
): Promise<ImportResult> {
  const res = newResult();
  await db.transaction().execute(async (trx) => {
    const now = nowIso();
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.sourceEvidenceId)) {
        res.skipped += 1;
        continue;
      }
      seen.add(r.sourceEvidenceId);
      assertIntCents(r.amountCents, 'amountCents');
      const existing = await trx
        .selectFrom('finance_tax_evidence')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('source_evidence_id', '=', r.sourceEvidenceId)
        .executeTakeFirst();
      const next = {
        order_ref: r.orderRef,
        jurisdiction_source: r.jurisdictionSource,
        state: r.state ?? null,
        amount_cents: r.amountCents,
        occurred_at: r.occurredAt,
      };
      if (existing) {
        const changed =
          existing.order_ref !== next.order_ref ||
          existing.jurisdiction_source !== next.jurisdiction_source ||
          existing.state !== next.state ||
          existing.amount_cents !== next.amount_cents ||
          existing.occurred_at !== next.occurred_at;
        if (changed) {
          await trx
            .updateTable('finance_tax_evidence')
            .set(next)
            .where('tenant_id', '=', tenantId)
            .where('id', '=', existing.id)
            .execute();
          res.updated += 1;
        } else {
          res.skipped += 1;
        }
        continue;
      }
      const row: FinanceTaxEvidenceRow = {
        id: id(),
        tenant_id: tenantId,
        source_evidence_id: r.sourceEvidenceId,
        ...next,
        created_at: now,
      };
      await trx.insertInto('finance_tax_evidence').values(row).execute();
      res.inserted += 1;
    }
    await audit(asCoreDb(trx), tenantId, actor, 'finance.tax_evidence.imported', 'finance.tax_evidence', 'batch', res);
  });
  return res;
}

/* ================================================================== *
 * B. PAYOUT RECONCILIATION (journey 17)
 * ================================================================== */

export interface PayoutMatchInput {
  /** finance_payouts.source_payout_id being reconciled. */
  sourcePayoutId: string;
  /** finance_payments.source_payment_id candidates that fund this payout. */
  candidateSourcePaymentIds: string[];
  notes?: string | null;
}

export interface PayoutMatchResult {
  match: FinancePayoutMatchRow;
  coverageWindow: { start: string | null; end: string | null };
}

/**
 * Deterministic payout reconciliation: sum(net_cents of candidate payments) vs
 * the payout amount. A mismatch (delta !== 0) emits
 * `finance.payout.reconciliation_failed { v:1, payoutId, deltaCents }`. The
 * coverage window (min/max occurred_at of the candidates) is stored on every
 * result, matched or not.
 */
export async function matchPayout(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  input: PayoutMatchInput,
): Promise<PayoutMatchResult> {
  const payout = await db
    .selectFrom('finance_payouts')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('source_payout_id', '=', input.sourcePayoutId)
    .executeTakeFirst();
  if (!payout) throw ApiError.notFound(`payout "${input.sourcePayoutId}" not found`);

  const uniqueIds = Array.from(new Set(input.candidateSourcePaymentIds));
  const candidates =
    uniqueIds.length === 0
      ? []
      : await db
          .selectFrom('finance_payments')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('source_payment_id', 'in', uniqueIds)
          .orderBy('occurred_at')
          .orderBy('id')
          .execute();

  const actualCents = candidates.reduce((sum, p) => sum + p.net_cents, 0);
  const expectedCents = payout.amount_cents;
  const deltaCents = actualCents - expectedCents;
  const matched = deltaCents === 0 ? 1 : 0;

  const occurred = candidates.map((p) => p.occurred_at).sort();
  const coverageWindow = {
    start: occurred.length > 0 ? occurred[0] : null,
    end: occurred.length > 0 ? occurred[occurred.length - 1] : null,
  };

  const row: FinancePayoutMatchRow = {
    id: id(),
    tenant_id: tenantId,
    payout_id: payout.id,
    matched,
    expected_cents: expectedCents,
    actual_cents: actualCents,
    delta_cents: deltaCents,
    candidate_count: candidates.length,
    coverage_window: JSON.stringify(coverageWindow),
    notes: input.notes ?? null,
    created_at: nowIso(),
  };

  await db.transaction().execute(async (trx) => {
    await trx.insertInto('finance_payout_matches').values(row).execute();
    await audit(asCoreDb(trx), tenantId, actor, 'finance.payout_match.ran', 'finance.payout_match', row.id, {
      payoutId: payout.id,
      matched,
      deltaCents,
    });
  });

  if (matched === 0) {
    await events.emit(tenantId, 'finance.payout.reconciliation_failed', {
      v: 1,
      payoutId: payout.id,
      deltaCents,
    });
  }

  return { match: row, coverageWindow };
}

export async function listPayoutMatches(
  db: Db,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
): Promise<FinancePayoutMatchRow[]> {
  return db
    .selectFrom('finance_payout_matches')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export interface PayoutReconciliationSummary {
  payoutCount: number;
  matchedCount: number;
  unmatchedCount: number;
  unreconciledCount: number;
  totalDeltaCents: number;
  /** The window the payouts collectively claim to cover. */
  payoutCoverage: { start: string | null; end: string | null };
  /** The full span of imported payments. */
  paymentsPeriod: { start: string | null; end: string | null };
  /** True when payout coverage does NOT span the payments period. */
  partialCoverage: boolean;
}

/**
 * Overall payout reconciliation with an explicit coverage window and a
 * PARTIAL-COVERAGE banner flag whenever the payout rows don't span the
 * imported payments period. Each payout is counted once by its LATEST match.
 */
export async function payoutReconciliationSummary(
  db: Db,
  tenantId: string,
): Promise<PayoutReconciliationSummary> {
  const payouts = await db
    .selectFrom('finance_payouts')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('paid_at')
    .orderBy('id')
    .execute();

  const matches = await db
    .selectFrom('finance_payout_matches')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();

  // Latest match per payout wins.
  const latestByPayout = new Map<string, FinancePayoutMatchRow>();
  for (const m of matches) latestByPayout.set(m.payout_id, m);

  let matchedCount = 0;
  let unmatchedCount = 0;
  let unreconciledCount = 0;
  let totalDeltaCents = 0;
  for (const p of payouts) {
    const m = latestByPayout.get(p.id);
    if (!m) {
      unreconciledCount += 1;
      continue;
    }
    if (m.matched === 1) matchedCount += 1;
    else unmatchedCount += 1;
    totalDeltaCents += m.delta_cents;
  }

  // Payout coverage window: prefer explicit coverage_start/end, else paid_at.
  const covStarts = payouts
    .map((p) => p.coverage_start ?? p.paid_at)
    .filter((v): v is string => v != null)
    .sort();
  const covEnds = payouts
    .map((p) => p.coverage_end ?? p.paid_at)
    .filter((v): v is string => v != null)
    .sort();
  const payoutCoverage = {
    start: covStarts.length > 0 ? covStarts[0] : null,
    end: covEnds.length > 0 ? covEnds[covEnds.length - 1] : null,
  };

  const pmin = await db
    .selectFrom('finance_payments')
    .select((eb) => eb.fn.min<string | null>('occurred_at').as('lo'))
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
  const pmax = await db
    .selectFrom('finance_payments')
    .select((eb) => eb.fn.max<string | null>('occurred_at').as('hi'))
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
  const paymentsPeriod = { start: pmin?.lo ?? null, end: pmax?.hi ?? null };

  // Partial coverage: payments exist but payout coverage doesn't fully span them.
  let partialCoverage = false;
  if (paymentsPeriod.start && paymentsPeriod.end) {
    if (!payoutCoverage.start || !payoutCoverage.end) {
      partialCoverage = true;
    } else if (
      payoutCoverage.start > paymentsPeriod.start ||
      payoutCoverage.end < paymentsPeriod.end
    ) {
      partialCoverage = true;
    }
  }

  return {
    payoutCount: payouts.length,
    matchedCount,
    unmatchedCount,
    unreconciledCount,
    totalDeltaCents,
    payoutCoverage,
    paymentsPeriod,
    partialCoverage,
  };
}

/* ================================================================== *
 * C. CASH SESSIONS (journey 13 support)
 * ================================================================== */

export interface OpenCashSessionInput {
  locationRef?: string | null;
  showRef?: string | null;
  openedBy: string;
  openingFloatCents: number;
  note?: string | null;
}

export async function openCashSession(
  db: Db,
  tenantId: string,
  actor: string,
  input: OpenCashSessionInput,
): Promise<FinanceCashSessionRow> {
  assertIntCents(input.openingFloatCents, 'openingFloatCents');
  if (!input.openedBy.trim()) throw ApiError.badRequest('openedBy is required');
  const openedAt = nowIso();
  const row: FinanceCashSessionRow = {
    id: id(),
    tenant_id: tenantId,
    location_ref: input.locationRef ?? null,
    show_ref: input.showRef ?? null,
    opened_by: input.openedBy,
    opened_at: openedAt,
    opening_float_cents: input.openingFloatCents,
    closed_by: null,
    closed_at: null,
    expected_cents: null,
    counted_cents: null,
    variance_cents: null,
    status: 'open',
    note: input.note ?? null,
    created_at: openedAt,
  };
  await db.insertInto('finance_cash_sessions').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'finance.cash_session.opened', 'finance.cash_session', row.id, {
    openingFloatCents: row.opening_float_cents,
  });
  return row;
}

async function getOpenSession(db: Db, tenantId: string, sessionId: string): Promise<FinanceCashSessionRow> {
  const s = await db
    .selectFrom('finance_cash_sessions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', sessionId)
    .executeTakeFirst();
  if (!s) throw ApiError.notFound(`cash session "${sessionId}" not found`);
  return s;
}

/** Post the expected drawer amount (from real tender data) onto an OPEN session. */
export async function postExpectedCents(
  db: Db,
  tenantId: string,
  actor: string,
  sessionId: string,
  expectedCents: number,
): Promise<FinanceCashSessionRow> {
  assertIntCents(expectedCents, 'expectedCents');
  const s = await getOpenSession(db, tenantId, sessionId);
  if (s.status === 'closed') {
    throw ApiError.conflict('cash session is closed and immutable (use an adjustment)');
  }
  await db
    .updateTable('finance_cash_sessions')
    .set({ expected_cents: expectedCents })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', sessionId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'finance.cash_session.expected_posted', 'finance.cash_session', sessionId, {
    expectedCents,
  });
  return { ...s, expected_cents: expectedCents };
}

export interface CloseCashSessionInput {
  closedBy: string;
  countedCents: number;
  /** Optional: post expected here if not already posted. */
  expectedCents?: number;
  note?: string | null;
}

/**
 * Close a cash session. Requires counted_cents AND a posted expected_cents.
 * variance = counted - expected. A non-zero variance emits the internal
 * `finance.cash.variance` event. Sessions are immutable after close.
 */
export async function closeCashSession(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  sessionId: string,
  input: CloseCashSessionInput,
): Promise<FinanceCashSessionRow> {
  assertIntCents(input.countedCents, 'countedCents');
  if (input.expectedCents !== undefined) assertIntCents(input.expectedCents, 'expectedCents');
  const s = await getOpenSession(db, tenantId, sessionId);
  if (s.status === 'closed') {
    throw ApiError.conflict('cash session is already closed (corrections = adjustments)');
  }
  const expected = input.expectedCents ?? s.expected_cents;
  if (expected == null) {
    throw ApiError.badRequest('expected_cents must be posted before close (no zero assumption)');
  }
  const variance = input.countedCents - expected;
  const closedAt = nowIso();

  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('finance_cash_sessions')
      .set({
        closed_by: input.closedBy,
        closed_at: closedAt,
        expected_cents: expected,
        counted_cents: input.countedCents,
        variance_cents: variance,
        status: 'closed',
        note: input.note ?? s.note,
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', sessionId)
      .where('status', '=', 'open')
      .execute();
    await audit(asCoreDb(trx), tenantId, actor, 'finance.cash_session.closed', 'finance.cash_session', sessionId, {
      expectedCents: expected,
      countedCents: input.countedCents,
      varianceCents: variance,
    });
  });

  if (variance !== 0) {
    await events.emit(tenantId, 'finance.cash.variance', {
      v: 1,
      cashSessionId: sessionId,
      varianceCents: variance,
    });
  }

  return {
    ...s,
    closed_by: input.closedBy,
    closed_at: closedAt,
    expected_cents: expected,
    counted_cents: input.countedCents,
    variance_cents: variance,
    status: 'closed',
    note: input.note ?? s.note,
  };
}

export async function getCashSession(
  db: Db,
  tenantId: string,
  sessionId: string,
): Promise<FinanceCashSessionRow> {
  return getOpenSession(db, tenantId, sessionId);
}

export async function listCashSessions(
  db: Db,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
): Promise<FinanceCashSessionRow[]> {
  return db
    .selectFrom('finance_cash_sessions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('opened_at', 'desc')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export interface CashAdjustmentInput {
  amountCents: number;
  reason: string;
  createdBy: string;
}

/** Correct a CLOSED session via a new adjustment row (session stays immutable). */
export async function addCashAdjustment(
  db: Db,
  tenantId: string,
  actor: string,
  sessionId: string,
  input: CashAdjustmentInput,
): Promise<FinanceCashAdjustmentRow> {
  assertIntCents(input.amountCents, 'amountCents');
  if (!input.reason.trim()) throw ApiError.badRequest('reason is required');
  const s = await getOpenSession(db, tenantId, sessionId);
  if (s.status !== 'closed') {
    throw ApiError.badRequest('adjustments only apply to closed sessions');
  }
  const row: FinanceCashAdjustmentRow = {
    id: id(),
    tenant_id: tenantId,
    session_ref: sessionId,
    amount_cents: input.amountCents,
    reason: input.reason,
    created_by: input.createdBy,
    created_at: nowIso(),
  };
  await db.insertInto('finance_cash_adjustments').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'finance.cash_adjustment.created', 'finance.cash_adjustment', row.id, {
    sessionId,
    amountCents: input.amountCents,
  });
  return row;
}

export async function listCashAdjustments(
  db: Db,
  tenantId: string,
  sessionId: string,
): Promise<FinanceCashAdjustmentRow[]> {
  return db
    .selectFrom('finance_cash_adjustments')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('session_ref', '=', sessionId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

/* ================================================================== *
 * D. COGS / MARGIN
 * ================================================================== */

export interface AddItemCostInput {
  variationId: string;
  costCents: number;
  method: FinanceCostMethod;
  sourceRef?: string | null;
  effectiveFrom: string;
}

/**
 * Add a cost for a variation. History is preserved: the previously-open cost
 * window (effective_to = null) whose effective_from precedes this one is closed
 * at this row's effective_from, producing non-overlapping windows.
 */
export async function addItemCost(
  db: Db,
  tenantId: string,
  actor: string,
  input: AddItemCostInput,
): Promise<FinanceItemCostRow> {
  assertIntCents(input.costCents, 'costCents');
  if (!COST_METHODS.includes(input.method)) {
    throw ApiError.badRequest(`invalid cost method "${input.method}"`);
  }
  const row: FinanceItemCostRow = {
    id: id(),
    tenant_id: tenantId,
    variation_id: input.variationId,
    cost_cents: input.costCents,
    method: input.method,
    source_ref: input.sourceRef ?? null,
    effective_from: input.effectiveFrom,
    effective_to: null,
    created_at: nowIso(),
  };
  await db.transaction().execute(async (trx) => {
    const open = await trx
      .selectFrom('finance_item_costs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('variation_id', '=', input.variationId)
      .where('effective_to', 'is', null)
      .where('effective_from', '<', input.effectiveFrom)
      .orderBy('effective_from', 'desc')
      .orderBy('id')
      .execute();
    for (const prior of open) {
      await trx
        .updateTable('finance_item_costs')
        .set({ effective_to: input.effectiveFrom })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', prior.id)
        .execute();
    }
    await trx.insertInto('finance_item_costs').values(row).execute();
    await audit(asCoreDb(trx), tenantId, actor, 'finance.item_cost.added', 'finance.item_cost', row.id, {
      variationId: input.variationId,
      costCents: input.costCents,
    });
  });
  return row;
}

/** The cost in effect for a variation at instant `at` (default now). */
export async function currentCost(
  db: Db,
  tenantId: string,
  variationId: string,
  at: string = nowIso(),
): Promise<FinanceItemCostRow | undefined> {
  const rows = await db
    .selectFrom('finance_item_costs')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('variation_id', '=', variationId)
    .where('effective_from', '<=', at)
    .orderBy('effective_from', 'desc')
    .orderBy('id', 'desc')
    .execute();
  return rows.find((r) => r.effective_to == null || r.effective_to > at);
}

export async function listItemCosts(
  db: Db,
  tenantId: string,
  variationId: string,
): Promise<FinanceItemCostRow[]> {
  return db
    .selectFrom('finance_item_costs')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('variation_id', '=', variationId)
    .orderBy('effective_from')
    .orderBy('id')
    .execute();
}

export interface MarginLineInput {
  variationId: string;
  unitPriceCents: number;
  qty: number;
}

export interface MarginLineResult {
  variationId: string;
  revenueCents: number;
  /** NULL when the cost is unknown — never 0, never assumed. */
  costCents: number | null;
  marginCents: number | null;
  marginBps: number | null;
}

export interface MarginResult {
  lines: MarginLineResult[];
  totalRevenueCents: number;
  /** Revenue on lines WITH a known cost. */
  knownRevenueCents: number;
  /** Revenue on lines whose cost is UNKNOWN (reported separately, honestly). */
  unknownCostRevenueCents: number;
  /** Margin summed over known-cost lines only. */
  knownMarginCents: number;
  /** Effective margin on known-cost revenue; null when knownRevenue is 0. */
  knownMarginBps: number | null;
}

/**
 * THE core honesty invariant: an unknown cost stays NULL on the line
 * (never 0, never assumed full-margin), and the aggregate reports
 * known-cost revenue and unknown-cost revenue SEPARATELY so the two never mix.
 */
export async function marginFor(
  db: Db,
  tenantId: string,
  lines: MarginLineInput[],
  at: string = nowIso(),
): Promise<MarginResult> {
  const lineResults: MarginLineResult[] = [];
  let totalRevenueCents = 0;
  let knownRevenueCents = 0;
  let unknownCostRevenueCents = 0;
  let knownMarginCents = 0;

  for (const line of lines) {
    assertIntCents(line.unitPriceCents, 'unitPriceCents');
    if (!Number.isInteger(line.qty) || line.qty < 0) {
      throw ApiError.badRequest(`qty must be a non-negative integer, got ${line.qty}`);
    }
    const revenueCents = Math.round(line.unitPriceCents * line.qty);
    totalRevenueCents += revenueCents;

    const cost = await currentCost(db, tenantId, line.variationId, at);
    if (!cost) {
      unknownCostRevenueCents += revenueCents;
      lineResults.push({
        variationId: line.variationId,
        revenueCents,
        costCents: null,
        marginCents: null,
        marginBps: null,
      });
      continue;
    }
    const costCents = Math.round(cost.cost_cents * line.qty);
    const marginCents = revenueCents - costCents;
    const marginBps = revenueCents > 0 ? Math.round((marginCents / revenueCents) * 10000) : null;
    knownRevenueCents += revenueCents;
    knownMarginCents += marginCents;
    lineResults.push({
      variationId: line.variationId,
      revenueCents,
      costCents,
      marginCents,
      marginBps,
    });
  }

  return {
    lines: lineResults,
    totalRevenueCents,
    knownRevenueCents,
    unknownCostRevenueCents,
    knownMarginCents,
    knownMarginBps:
      knownRevenueCents > 0 ? Math.round((knownMarginCents / knownRevenueCents) * 10000) : null,
  };
}

/* ================================================================== *
 * D2. LIABILITY SNAPSHOTS (loyalty owns the ledger; we record + trend)
 * ================================================================== */

export interface LiabilitySnapshotInput {
  outstandingCents: number;
  source: string;
  asOf: string;
}

export async function recordLiabilitySnapshot(
  db: Db,
  tenantId: string,
  actor: string,
  input: LiabilitySnapshotInput,
): Promise<FinanceLiabilitySnapshotRow> {
  assertIntCents(input.outstandingCents, 'outstandingCents');
  if (!input.source.trim()) throw ApiError.badRequest('source is required');
  const row: FinanceLiabilitySnapshotRow = {
    id: id(),
    tenant_id: tenantId,
    outstanding_cents: input.outstandingCents,
    source: input.source,
    as_of: input.asOf,
    created_at: nowIso(),
  };
  await db.insertInto('finance_liability_snapshots').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'finance.liability_snapshot.recorded', 'finance.liability_snapshot', row.id, {
    source: input.source,
    outstandingCents: input.outstandingCents,
  });
  return row;
}

export async function listLiabilitySnapshots(
  db: Db,
  tenantId: string,
  source?: string,
  page: Pagination = { limit: 50, offset: 0 },
): Promise<FinanceLiabilitySnapshotRow[]> {
  let q = db
    .selectFrom('finance_liability_snapshots')
    .selectAll()
    .where('tenant_id', '=', tenantId);
  if (source) q = q.where('source', '=', source);
  return q.orderBy('as_of', 'desc').orderBy('id').limit(page.limit).offset(page.offset).execute();
}

/* ================================================================== *
 * E. TAX CONFIG + EVIDENCE
 * ================================================================== */

export interface TaxConfigInput {
  jurisdiction: string;
  registered: boolean;
  rateBps?: number | null;
  notes?: string | null;
}

export async function upsertTaxConfig(
  db: Db,
  tenantId: string,
  actor: string,
  input: TaxConfigInput,
): Promise<FinanceTaxConfigRow> {
  if (!input.jurisdiction.trim()) throw ApiError.badRequest('jurisdiction is required');
  if (input.rateBps != null && (!Number.isInteger(input.rateBps) || input.rateBps < 0)) {
    throw ApiError.badRequest('rateBps must be a non-negative integer');
  }
  const existing = await db
    .selectFrom('finance_tax_configs')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('jurisdiction', '=', input.jurisdiction)
    .executeTakeFirst();
  if (existing) {
    const updated_at = nowIso();
    await db
      .updateTable('finance_tax_configs')
      .set({
        registered: input.registered ? 1 : 0,
        rate_bps: input.rateBps ?? null,
        notes: input.notes ?? null,
        updated_at,
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', existing.id)
      .execute();
    await audit(asCoreDb(db), tenantId, actor, 'finance.tax_config.updated', 'finance.tax_config', existing.id, input);
    return {
      ...existing,
      registered: input.registered ? 1 : 0,
      rate_bps: input.rateBps ?? null,
      notes: input.notes ?? null,
      updated_at,
    };
  }
  const row: FinanceTaxConfigRow = {
    id: id(),
    tenant_id: tenantId,
    jurisdiction: input.jurisdiction,
    registered: input.registered ? 1 : 0,
    rate_bps: input.rateBps ?? null,
    notes: input.notes ?? null,
    created_at: nowIso(),
    updated_at: null,
  };
  await db.insertInto('finance_tax_configs').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'finance.tax_config.created', 'finance.tax_config', row.id, input);
  return row;
}

export async function listTaxConfigs(db: Db, tenantId: string): Promise<FinanceTaxConfigRow[]> {
  return db
    .selectFrom('finance_tax_configs')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('jurisdiction')
    .orderBy('id')
    .execute();
}

export interface TaxEvidenceGroup {
  /** State code, or "UNKNOWN" for evidence whose state couldn't be determined. */
  state: string;
  /** Business month in America/New_York, YYYY-MM. */
  month: string;
  amountCents: number;
  count: number;
  /** Up to 5 source evidence ids for drill-through. */
  sourceIdsSample: string[];
}

/**
 * Group tax evidence by state + business month with an explicit UNKNOWN bucket.
 * Historical single-location data lands in UNKNOWN — stated honestly, never guessed.
 */
export async function exportTaxEvidence(db: Db, tenantId: string): Promise<TaxEvidenceGroup[]> {
  const rows = await db
    .selectFrom('finance_tax_evidence')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('occurred_at')
    .orderBy('id')
    .execute();

  const groups = new Map<string, TaxEvidenceGroup>();
  for (const r of rows) {
    const state = r.state && r.state.trim() !== '' ? r.state : 'UNKNOWN';
    const month = DateTime.fromISO(r.occurred_at, { zone: 'utc' }).setZone(BUSINESS_ZONE).toFormat('yyyy-MM');
    const key = `${state}|${month}`;
    let g = groups.get(key);
    if (!g) {
      g = { state, month, amountCents: 0, count: 0, sourceIdsSample: [] };
      groups.set(key, g);
    }
    g.amountCents += r.amount_cents;
    g.count += 1;
    if (g.sourceIdsSample.length < 5) g.sourceIdsSample.push(r.source_evidence_id);
  }
  return Array.from(groups.values()).sort((a, b) =>
    a.state === b.state ? a.month.localeCompare(b.month) : a.state.localeCompare(b.state),
  );
}

/* ================================================================== *
 * F. PERIOD ROLLUPS
 * ================================================================== */

function periodKey(iso: string, grain: 'month' | 'year'): string {
  const dt = DateTime.fromISO(iso, { zone: 'utc' }).setZone(BUSINESS_ZONE);
  return grain === 'month' ? dt.toFormat('yyyy-MM') : dt.toFormat('yyyy');
}

function detectGrain(period: string): 'month' | 'year' {
  if (/^\d{4}$/.test(period)) return 'year';
  if (/^\d{4}-\d{2}$/.test(period)) return 'month';
  throw ApiError.badRequest(`period must be "YYYY" or "YYYY-MM", got "${period}"`);
}

export interface PeriodSourceKindLine {
  sourceKind: FinanceSourceKind;
  grossCents: number;
  count: number;
}

export interface PeriodSummary {
  period: string;
  grain: 'month' | 'year';
  /** Gross of COMPLETED payments in the period (America/New_York grouping). */
  grossCents: number;
  refundsCents: number;
  /** gross - refunds. */
  netCents: number;
  feesCents: number;
  /** round(fees / gross * 10000); null when gross is 0. */
  effectiveFeeRateBps: number | null;
  bySourceKind: PeriodSourceKindLine[];
  /** Traceability: how many rows fed each figure + a sample of source ids. */
  paymentCount: number;
  refundCount: number;
  paymentSourceIdsSample: string[];
  refundSourceIdsSample: string[];
}

/** A payment status counts toward revenue when it is COMPLETED (case-insensitive). */
function isCompleted(status: string): boolean {
  return status.toUpperCase() === 'COMPLETED';
}

/**
 * Deterministic month/year rollup computed from finance_payments/refunds.
 * Every figure is traceable (row counts + a sample of source ids). Grouping is
 * America/New_York per the business-timezone rule.
 */
export async function periodSummary(db: Db, tenantId: string, period: string): Promise<PeriodSummary> {
  const grain = detectGrain(period);

  const payments = await db
    .selectFrom('finance_payments')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('occurred_at')
    .orderBy('id')
    .execute();
  const refunds = await db
    .selectFrom('finance_refunds')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('occurred_at')
    .orderBy('id')
    .execute();

  let grossCents = 0;
  let feesCents = 0;
  let paymentCount = 0;
  const paymentSourceIdsSample: string[] = [];
  const bySource = new Map<FinanceSourceKind, PeriodSourceKindLine>();
  for (const k of SOURCE_KINDS) bySource.set(k, { sourceKind: k, grossCents: 0, count: 0 });

  for (const p of payments) {
    if (!isCompleted(p.status)) continue;
    if (periodKey(p.occurred_at, grain) !== period) continue;
    grossCents += p.amount_cents;
    feesCents += p.fee_cents;
    paymentCount += 1;
    if (paymentSourceIdsSample.length < 5) paymentSourceIdsSample.push(p.source_payment_id);
    const line = bySource.get(p.source_kind)!;
    line.grossCents += p.amount_cents;
    line.count += 1;
  }

  let refundsCents = 0;
  let refundCount = 0;
  const refundSourceIdsSample: string[] = [];
  for (const r of refunds) {
    if (periodKey(r.occurred_at, grain) !== period) continue;
    refundsCents += r.amount_cents;
    refundCount += 1;
    if (refundSourceIdsSample.length < 5) refundSourceIdsSample.push(r.source_refund_id);
  }

  return {
    period,
    grain,
    grossCents,
    refundsCents,
    netCents: grossCents - refundsCents,
    feesCents,
    effectiveFeeRateBps: grossCents > 0 ? Math.round((feesCents / grossCents) * 10000) : null,
    bySourceKind: SOURCE_KINDS.map((k) => bySource.get(k)!).filter((l) => l.count > 0),
    paymentCount,
    refundCount,
    paymentSourceIdsSample,
    refundSourceIdsSample,
  };
}

/* ================================================================== *
 * G. CSV EXPORTS (each row carries source ids for drill-through)
 * ================================================================== */

export type CsvKind =
  | 'payments'
  | 'refunds'
  | 'payouts'
  | 'cash-sessions'
  | 'tax-evidence'
  | 'item-costs';

export async function exportPaymentsCsvRows(db: Db, tenantId: string): Promise<Record<string, unknown>[]> {
  const rows = await db
    .selectFrom('finance_payments')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('occurred_at')
    .orderBy('id')
    .execute();
  return rows.map((r) => ({
    source_payment_id: r.source_payment_id,
    order_ref: r.order_ref ?? '',
    amount_cents: r.amount_cents,
    fee_cents: r.fee_cents,
    net_cents: r.net_cents,
    source_kind: r.source_kind,
    card_brand: r.card_brand ?? '',
    status: r.status,
    occurred_at: r.occurred_at,
  }));
}

export async function exportRefundsCsvRows(db: Db, tenantId: string): Promise<Record<string, unknown>[]> {
  const rows = await db
    .selectFrom('finance_refunds')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('occurred_at')
    .orderBy('id')
    .execute();
  return rows.map((r) => ({
    source_refund_id: r.source_refund_id,
    payment_ref: r.payment_ref,
    amount_cents: r.amount_cents,
    occurred_at: r.occurred_at,
  }));
}

export async function exportPayoutsCsvRows(db: Db, tenantId: string): Promise<Record<string, unknown>[]> {
  const payouts = await db
    .selectFrom('finance_payouts')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('paid_at')
    .orderBy('id')
    .execute();
  const matches = await db
    .selectFrom('finance_payout_matches')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const latest = new Map<string, FinancePayoutMatchRow>();
  for (const m of matches) latest.set(m.payout_id, m);
  return payouts.map((p) => {
    const m = latest.get(p.id);
    return {
      source_payout_id: p.source_payout_id,
      amount_cents: p.amount_cents,
      status: p.status,
      paid_at: p.paid_at,
      coverage_start: p.coverage_start ?? '',
      coverage_end: p.coverage_end ?? '',
      matched: m ? m.matched : '',
      expected_cents: m ? m.expected_cents : '',
      actual_cents: m ? m.actual_cents : '',
      delta_cents: m ? m.delta_cents : '',
      candidate_count: m ? m.candidate_count : '',
    };
  });
}

export async function exportCashSessionsCsvRows(db: Db, tenantId: string): Promise<Record<string, unknown>[]> {
  const rows = await db
    .selectFrom('finance_cash_sessions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('opened_at')
    .orderBy('id')
    .execute();
  return rows.map((r) => ({
    cash_session_id: r.id,
    location_ref: r.location_ref ?? '',
    show_ref: r.show_ref ?? '',
    opened_at: r.opened_at,
    closed_at: r.closed_at ?? '',
    opening_float_cents: r.opening_float_cents,
    expected_cents: r.expected_cents ?? '',
    counted_cents: r.counted_cents ?? '',
    variance_cents: r.variance_cents ?? '',
    status: r.status,
  }));
}

export async function exportTaxEvidenceCsvRows(db: Db, tenantId: string): Promise<Record<string, unknown>[]> {
  const rows = await db
    .selectFrom('finance_tax_evidence')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('occurred_at')
    .orderBy('id')
    .execute();
  return rows.map((r) => ({
    source_evidence_id: r.source_evidence_id,
    order_ref: r.order_ref,
    jurisdiction_source: r.jurisdiction_source,
    state: r.state ?? 'UNKNOWN',
    amount_cents: r.amount_cents,
    occurred_at: r.occurred_at,
  }));
}

export async function exportItemCostsCsvRows(db: Db, tenantId: string): Promise<Record<string, unknown>[]> {
  const rows = await db
    .selectFrom('finance_item_costs')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('variation_id')
    .orderBy('effective_from')
    .orderBy('id')
    .execute();
  return rows.map((r) => ({
    item_cost_id: r.id,
    variation_id: r.variation_id,
    cost_cents: r.cost_cents,
    method: r.method,
    source_ref: r.source_ref ?? '',
    effective_from: r.effective_from,
    effective_to: r.effective_to ?? '',
  }));
}

export async function exportCsvRows(db: Db, tenantId: string, kind: CsvKind): Promise<Record<string, unknown>[]> {
  switch (kind) {
    case 'payments':
      return exportPaymentsCsvRows(db, tenantId);
    case 'refunds':
      return exportRefundsCsvRows(db, tenantId);
    case 'payouts':
      return exportPayoutsCsvRows(db, tenantId);
    case 'cash-sessions':
      return exportCashSessionsCsvRows(db, tenantId);
    case 'tax-evidence':
      return exportTaxEvidenceCsvRows(db, tenantId);
    case 'item-costs':
      return exportItemCostsCsvRows(db, tenantId);
    default:
      throw ApiError.badRequest(`unknown export kind "${kind as string}"`);
  }
}
