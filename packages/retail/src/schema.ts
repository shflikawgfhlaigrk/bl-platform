import type { CoreDatabase } from '@blacklabel/core';

/**
 * Retail module schema — point-of-sale sales facts imported from an external
 * POS export (e.g. Square). This module OWNS the imported facts; it never
 * calls a POS API itself — rows arrive via the import service, fed by an
 * out-of-band export file.
 *
 * Provenance columns: every fact row keeps the POS's own id in `source_id`
 * (unique per tenant), which is what makes re-imports idempotent.
 */

/** One completed (or otherwise) POS payment. Money is integer cents. */
export interface RetailPaymentRow {
  id: string;
  tenant_id: string;
  /** POS payment id — idempotency key (unique per tenant). */
  source_id: string;
  /** When the POS recorded the payment, ISO-8601 UTC. */
  paid_at: string;
  /** POS status verbatim, e.g. "COMPLETED". */
  status: string;
  amount_cents: number;
  /** Processing fee in cents; null when the export lacks it. */
  fee_cents: number | null;
  /** POS customer id (NOT a crm id — see retail_customer_links). Null = walk-up. */
  customer_source_id: string | null;
  /** POS order id, links to retail_order_lines.source_order_id. */
  order_source_id: string | null;
  created_at: string;
}

/** One line item of a POS order. */
export interface RetailOrderLineRow {
  id: string;
  tenant_id: string;
  /** POS order id this line belongs to. */
  source_order_id: string;
  name: string;
  /** Quantity as a number ("1", "1.5" in exports). Not money. */
  quantity: number;
  total_cents: number;
  /** POS catalog object id of the variation sold, when present. */
  catalog_source_id: string | null;
  /** Denormalized category name captured at import time, when known. */
  category_name: string | null;
  created_at: string;
}

/** One POS refund. */
export interface RetailRefundRow {
  id: string;
  tenant_id: string;
  /** POS refund id — idempotency key (unique per tenant). */
  source_id: string;
  refunded_at: string;
  status: string;
  amount_cents: number;
  created_at: string;
}

/**
 * Mapping POS customer id → crm customer id (string reference only, no FK —
 * CONVENTIONS §9). Lets the import create each crm customer exactly once.
 */
export interface RetailCustomerLinkRow {
  id: string;
  tenant_id: string;
  /** POS customer id (unique per tenant). */
  source_id: string;
  /** crm_customers id, referenced by string only. */
  crm_customer_id: string;
  created_at: string;
}

/** Append-only ledger of import runs (what arrived, when, and the totals). */
export interface RetailImportRunRow {
  id: string;
  tenant_id: string;
  /** Human label for the source, e.g. "square-ledger". */
  source: string;
  started_at: string;
  finished_at: string;
  payments_inserted: number;
  payments_skipped: number;
  lines_inserted: number;
  lines_skipped: number;
  refunds_inserted: number;
  refunds_skipped: number;
  /** SUM(amount_cents) of COMPLETED payments after this run — verification anchor. */
  completed_gross_cents_after: number;
  created_at: string;
}

export interface RetailDatabase extends CoreDatabase {
  retail_payments: RetailPaymentRow;
  retail_order_lines: RetailOrderLineRow;
  retail_refunds: RetailRefundRow;
  retail_customer_links: RetailCustomerLinkRow;
  retail_import_runs: RetailImportRunRow;
}
