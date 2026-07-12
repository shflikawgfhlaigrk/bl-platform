import type { CoreDatabase } from '@blacklabel/core';

/**
 * Purchasing module schema — reorder policies + suggestion runs, purchase
 * orders/lines with an append-only event log + rendered documents, receiving
 * with discrepancies, and vendor bills with three-way match exceptions.
 *
 * Cross-module discipline: vendors are referenced by `vendor_id` STRING only.
 * This module never imports @blacklabel/vendors and never joins its tables.
 * Costs travel INTO purchasing on inputs (accept/line create); they are not
 * read out of the vendors package.
 */

/* ---------------- reorder policies ---------------- */

export interface ReorderPolicyRow {
  id: string;
  tenant_id: string;
  variation_id: string;
  vendor_id: string;
  reorder_point: number;
  safety_stock: number;
  target_days_of_supply: number | null;
  /** Case-pack / order multiple. */
  order_multiple: number;
  min_qty: number;
  /** 0/1. */
  enabled: number;
  owner_override_qty: number | null;
  created_at: string;
  updated_at: string;
}

/* ---------------- suggestions ---------------- */

export type SuggestionStatus = 'suggested' | 'accepted' | 'dismissed';

export interface SuggestionRow {
  id: string;
  tenant_id: string;
  variation_id: string;
  vendor_id: string;
  /** JSON SuggestQtyInputs. */
  inputs: string;
  suggested_qty: number;
  /** JSON string[]. */
  formula_trace: string;
  status: SuggestionStatus;
  /** Draft PO the suggestion was folded into on accept (null until accepted). */
  purchase_order_id: string | null;
  created_at: string;
  updated_at: string;
}

/* ---------------- purchase orders ---------------- */

export type PurchaseOrderStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'sent'
  | 'acknowledged'
  | 'partially_received'
  | 'received'
  | 'closed'
  | 'canceled';

export interface PurchaseOrderRow {
  id: string;
  tenant_id: string;
  vendor_id: string;
  status: PurchaseOrderStatus;
  expected_at: string | null;
  ship_to: string;
  subtotal_cents: number;
  freight_cents: number;
  total_cents: number;
  /** JSON snapshot of the approval policy at submit time. */
  approval_policy_snapshot: string | null;
  approver: string | null;
  created_at: string;
  updated_at: string;
}

export type PoLineState = 'open' | 'partially_received' | 'received' | 'backordered' | 'canceled';

export interface PoLineRow {
  id: string;
  tenant_id: string;
  purchase_order_id: string;
  variation_id: string;
  vendor_sku: string | null;
  qty_ordered: number;
  unit_cost_cents: number;
  qty_received: number;
  qty_backordered: number;
  line_state: PoLineState;
  created_at: string;
  updated_at: string;
}

export type PoEventKind = 'status_changed' | 'edited' | 'line_added' | 'rejected';

/** Append-only history for a PO (status changes + edits with diff JSON). */
export interface PoEventRow {
  id: string;
  tenant_id: string;
  purchase_order_id: string;
  kind: PoEventKind;
  from_status: string | null;
  to_status: string | null;
  /** JSON diff / reason payload. */
  diff: string | null;
  actor: string;
  created_at: string;
}

/** Deterministic rendered PO document payload (render-to-record; no transport). */
export interface PoDocumentRow {
  id: string;
  tenant_id: string;
  purchase_order_id: string;
  /** JSON payload with all lines/costs/terms. */
  payload: string;
  created_at: string;
}

/* ---------------- receiving ---------------- */

export interface ReceiptRow {
  id: string;
  tenant_id: string;
  purchase_order_id: string;
  note: string | null;
  created_at: string;
}

export type ReceiptCondition = 'ok' | 'damaged' | 'wrong_item';

export interface ReceiptLineRow {
  id: string;
  tenant_id: string;
  receipt_id: string;
  po_line_id: string;
  qty_received: number;
  condition: ReceiptCondition;
  created_at: string;
}

export type DiscrepancyKind = 'over' | 'short' | 'wrong_item' | 'damaged';

export interface DiscrepancyRow {
  id: string;
  tenant_id: string;
  receipt_id: string;
  po_line_id: string;
  purchase_order_id: string;
  kind: DiscrepancyKind;
  expected_qty: number;
  received_qty: number;
  /** Signed delta (received − expected for over/short; qty for damaged/wrong). */
  delta_qty: number;
  created_at: string;
}

/* ---------------- vendor bills / matching ---------------- */

export type VendorBillStatus = 'unmatched' | 'matched' | 'exception';

export interface VendorBillRow {
  id: string;
  tenant_id: string;
  vendor_id: string;
  bill_number: string;
  amount_cents: number;
  /** JSON [{ variationId, qty, unitCostCents }]. */
  lines: string;
  status: VendorBillStatus;
  created_at: string;
  updated_at: string;
}

export type BillExceptionKind = 'price_variance' | 'qty_variance';

export interface BillExceptionRow {
  id: string;
  tenant_id: string;
  bill_id: string;
  purchase_order_id: string | null;
  receipt_id: string | null;
  po_line_id: string | null;
  variation_id: string;
  kind: BillExceptionKind;
  /** For price_variance: expected unit cost cents. For qty_variance: expected qty. */
  expected: number;
  actual: number;
  /** actual − expected (cent-exact for price, unit-exact for qty). */
  delta: number;
  created_at: string;
}

export interface PurchasingDatabase extends CoreDatabase {
  purchasing_reorder_policies: ReorderPolicyRow;
  purchasing_suggestions: SuggestionRow;
  purchasing_purchase_orders: PurchaseOrderRow;
  purchasing_po_lines: PoLineRow;
  purchasing_po_events: PoEventRow;
  purchasing_po_documents: PoDocumentRow;
  purchasing_receipts: ReceiptRow;
  purchasing_receipt_lines: ReceiptLineRow;
  purchasing_discrepancies: DiscrepancyRow;
  purchasing_vendor_bills: VendorBillRow;
  purchasing_bill_exceptions: BillExceptionRow;
}
