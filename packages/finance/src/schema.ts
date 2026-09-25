import type { CoreDatabase } from '@blacklabel/core';

/**
 * Finance module schema — imported/append-only financial ledgers plus derived
 * reconciliation, cash-close, COGS/margin, liability, and tax-evidence tables.
 *
 * DATA-FLOW RULE (CONTRACTS-MAGS §3 / this module's charter): finance NEVER
 * reads another module's tables. Historical payment / fee / payout / refund /
 * dispute / vendor-bill rows are FED by the integrator via idempotent import
 * functions, keyed on the SOURCE system's ids. Cross-module linkage is by id
 * string only (`order_ref`, `payment_ref`, `variation_id`, `vendor_bill_ref`).
 * Missing data is stored as NULL (a gap), never fabricated to 0.
 *
 * Money is integer cents everywhere; percentages are basis points (`*_bps`).
 */

export type FinanceSourceKind = 'card' | 'cash' | 'external' | 'wallet' | 'gift_card';
export type FinanceCostMethod = 'vendor_invoice' | 'manual' | 'weighted_average';
export type FinanceJurisdictionSource = 'show_venue' | 'ship_to' | 'pos_location' | 'unknown';
export type FinanceCashStatus = 'open' | 'closed';
export type FinanceCashExpectedMode = 'posted' | 'ledger';
export type FinanceCashMovementKind =
  | 'cash_sale'
  | 'cash_refund'
  | 'paid_in'
  | 'paid_out'
  | 'drop';

/** One imported payment fact. `source_payment_id` is unique per tenant. */
export interface FinancePaymentRow {
  id: string;
  tenant_id: string;
  /** Source system's payment id — idempotency key (unique per tenant). */
  source_payment_id: string;
  /** Order id in the orders module, by string reference. Null = unlinked. */
  order_ref: string | null;
  amount_cents: number;
  fee_cents: number;
  net_cents: number;
  source_kind: FinanceSourceKind;
  /** e.g. "VISA"; null when not a card or the export lacks it. */
  card_brand: string | null;
  /** Source status verbatim, e.g. "COMPLETED". */
  status: string;
  occurred_at: string;
  created_at: string;
}

/** One imported refund fact. `source_refund_id` is unique per tenant. */
export interface FinanceRefundRow {
  id: string;
  tenant_id: string;
  source_refund_id: string;
  /** The payment this refund is against (source_payment_id), by string ref. */
  payment_ref: string;
  amount_cents: number;
  occurred_at: string;
  created_at: string;
}

/** One imported payout/deposit batch. `source_payout_id` is unique per tenant. */
export interface FinancePayoutRow {
  id: string;
  tenant_id: string;
  source_payout_id: string;
  amount_cents: number;
  status: string;
  paid_at: string;
  /** Coverage window the processor states this payout spans; null = unknown. */
  coverage_start: string | null;
  coverage_end: string | null;
  created_at: string;
}

/** One imported dispute/chargeback fact. `source_dispute_id` unique per tenant. */
export interface FinanceDisputeRow {
  id: string;
  tenant_id: string;
  source_dispute_id: string;
  /** Payment the dispute is against (source_payment_id), by string ref. */
  payment_ref: string | null;
  amount_cents: number;
  status: string;
  occurred_at: string;
  created_at: string;
}

/**
 * Reference to a purchasing-owned vendor bill + its amount, fed by the
 * integrator. Finance does not own vendor bills; it tracks the id + amount for
 * matching against payments/cash out. `vendor_bill_ref` unique per tenant.
 */
export interface FinanceVendorBillRefRow {
  id: string;
  tenant_id: string;
  /** purchasing vendor-bill id, by string reference. */
  vendor_bill_ref: string;
  vendor_ref: string | null;
  amount_cents: number;
  status: string;
  /** When the bill is due / dated; null when unknown. */
  occurred_at: string | null;
  created_at: string;
}

/** Deterministic payout-reconciliation result (journey 17). */
export interface FinancePayoutMatchRow {
  id: string;
  tenant_id: string;
  /** finance_payouts.id being reconciled. */
  payout_id: string;
  /** 1 when delta_cents === 0. */
  matched: number;
  /** The payout's own amount (what the processor deposited). */
  expected_cents: number;
  /** Sum of net_cents over the candidate payments. */
  actual_cents: number;
  /** actual - expected, to the cent. */
  delta_cents: number;
  candidate_count: number;
  /** JSON {start,end} explicit coverage window over the candidates. */
  coverage_window: string;
  notes: string | null;
  created_at: string;
}

/** Daily/show/register cash session (journey 13 support). Immutable once closed. */
export interface FinanceCashSessionRow {
  id: string;
  tenant_id: string;
  location_ref: string | null;
  show_ref: string | null;
  /** Physical drawer id. New POS sessions use this as their open-session scope. */
  drawer_ref: string | null;
  /** Register/device id for operational attribution. */
  register_ref: string | null;
  /** Null only on rows created before the POS drawer-ledger migration. */
  expected_mode: FinanceCashExpectedMode | null;
  /** Non-null only while open; unique per tenant to prevent two open sessions. */
  open_scope_key: string | null;
  /** Updated by every guarded drawer mutation; also acts as the row-lock write. */
  last_activity_at: string | null;
  opened_by: string;
  opened_at: string;
  opening_float_cents: number;
  closed_by: string | null;
  closed_at: string | null;
  /** POSTED by the caller from real tender data; null until posted. */
  expected_cents: number | null;
  counted_cents: number | null;
  /** counted - expected; null until closed. */
  variance_cents: number | null;
  status: FinanceCashStatus;
  note: string | null;
  created_at: string;
}

/**
 * Append-only physical drawer ledger. Amounts are stored as positive cents;
 * `kind` determines their effect on expected cash:
 * sale/paid_in = +, refund/paid_out/drop = -.
 */
export interface FinanceCashMovementRow {
  id: string;
  tenant_id: string;
  session_ref: string;
  kind: FinanceCashMovementKind;
  /** Original tender/refund/manual source reference for drill-through. */
  source_ref: string;
  /** Namespaced mutation identity, unique across all drawer mutation kinds. */
  idempotency_key: string;
  /** Orders-module id by string reference; null for manual drawer movements. */
  order_ref: string | null;
  /** Cash tender id; refund rows point back to the refunded tender when known. */
  tender_ref: string | null;
  amount_cents: number;
  note: string | null;
  created_by: string;
  occurred_at: string;
  created_at: string;
}

/** Post-close correction against a (now immutable) cash session. */
export interface FinanceCashAdjustmentRow {
  id: string;
  tenant_id: string;
  session_ref: string;
  amount_cents: number;
  reason: string;
  created_by: string;
  created_at: string;
}

/** Cost history for a variation. Non-overlapping effective windows per variation. */
export interface FinanceItemCostRow {
  id: string;
  tenant_id: string;
  variation_id: string;
  cost_cents: number;
  method: FinanceCostMethod;
  source_ref: string | null;
  effective_from: string;
  /** null = still in effect (the open window). */
  effective_to: string | null;
  created_at: string;
}

/** Gift-card / store-credit liability snapshot with provenance (loyalty owns the ledger). */
export interface FinanceLiabilitySnapshotRow {
  id: string;
  tenant_id: string;
  outstanding_cents: number;
  source: string;
  as_of: string;
  created_at: string;
}

/** Tax CONFIGURATION only — no computed conclusions. One row per jurisdiction. */
export interface FinanceTaxConfigRow {
  id: string;
  tenant_id: string;
  jurisdiction: string;
  registered: number;
  rate_bps: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string | null;
}

/** Imported tax-evidence fact; grouped for the accountant with an UNKNOWN bucket. */
export interface FinanceTaxEvidenceRow {
  id: string;
  tenant_id: string;
  /** source tax-evidence id — idempotency key (unique per tenant). */
  source_evidence_id: string;
  order_ref: string;
  jurisdiction_source: FinanceJurisdictionSource;
  /** null = the state could not be determined honestly (UNKNOWN bucket). */
  state: string | null;
  amount_cents: number;
  occurred_at: string;
  created_at: string;
}

export interface FinanceDatabase extends CoreDatabase {
  finance_payments: FinancePaymentRow;
  finance_refunds: FinanceRefundRow;
  finance_payouts: FinancePayoutRow;
  finance_disputes: FinanceDisputeRow;
  finance_vendor_bill_refs: FinanceVendorBillRefRow;
  finance_payout_matches: FinancePayoutMatchRow;
  finance_cash_sessions: FinanceCashSessionRow;
  finance_cash_movements: FinanceCashMovementRow;
  finance_cash_adjustments: FinanceCashAdjustmentRow;
  finance_item_costs: FinanceItemCostRow;
  finance_liability_snapshots: FinanceLiabilitySnapshotRow;
  finance_tax_configs: FinanceTaxConfigRow;
  finance_tax_evidence: FinanceTaxEvidenceRow;
}
