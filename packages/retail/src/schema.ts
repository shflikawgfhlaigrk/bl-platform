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

/* ================================================================== *
 * Incremental import system (provider-neutral: export drop / API
 * polling / webhook / simulator all land here). Every fact carries the
 * POS `source_id` (unique per tenant) so re-imports are idempotent.
 * ================================================================== */

/**
 * One import run of ONE batch (source × kind). Append-only ledger; the
 * accumulated reconciliation totals (payments/orders) live on the row so a
 * reconciliation endpoint can compare them against live table totals.
 */
export interface RetailImportManifestRow {
  id: string;
  tenant_id: string;
  /** square_export | square_api | square_webhook | simulator. */
  source: string;
  /** payments | orders | customers | ... (see ImportKind). */
  kind: string;
  record_count: number;
  accepted: number;
  updated: number;
  skipped_duplicates: number;
  quarantined: number;
  /** sha256 of the canonicalized input (key-order independent). */
  source_hash: string;
  /** Cursor the run resumed from (polling); null for export/webhook. */
  cursor_before: string | null;
  /** Cursor/watermark the run advanced to; null for export/webhook. */
  cursor_after: string | null;
  /** Reconciliation snapshot — live COMPLETED gross cents (payments/orders only). */
  recon_gross_cents: number | null;
  /** Reconciliation snapshot — live completed count (payments/orders only). */
  recon_count: number | null;
  started_at: string;
  finished_at: string | null;
  /** running | done | failed. */
  status: string;
  error: string | null;
  created_at: string;
}

/**
 * A record that failed per-kind zod validation. NEVER silently skipped —
 * every malformed record lands here and drives an owner action.
 */
export interface RetailQuarantineRow {
  id: string;
  tenant_id: string;
  manifest_id: string;
  kind: string;
  /** The offending record, JSON-serialized verbatim. */
  record: string;
  /** Zod issues, JSON-serialized. */
  errors: string;
  /** quarantined | repaired | discarded. */
  status: string;
  created_at: string;
  updated_at: string;
}

/** Per (source, kind) resume point for the polling adapter. Unique per tenant. */
export interface RetailImportCursorRow {
  id: string;
  tenant_id: string;
  source: string;
  kind: string;
  /** Opaque resume token / ISO watermark. */
  cursor: string;
  updated_at: string;
  created_at: string;
}

/** Webhook dedup ledger — event_id UNIQUE per tenant makes replay a no-op. */
export interface RetailWebhookReceiptRow {
  id: string;
  tenant_id: string;
  /** Square event_id (unique per tenant). */
  event_id: string;
  event_type: string;
  /** Manifest produced by processing the event (null if the event was empty). */
  manifest_id: string | null;
  received_at: string;
  created_at: string;
}

/** One POS order header (lines land in retail_order_lines). */
export interface RetailOrderRow {
  id: string;
  tenant_id: string;
  source_id: string;
  state: string;
  total_cents: number;
  ordered_at: string;
  location_source_id: string | null;
  created_at: string;
}

/** One POS customer (identity fields only; PII stays tenant-local). */
export interface RetailCustomerRow {
  id: string;
  tenant_id: string;
  source_id: string;
  given_name: string | null;
  family_name: string | null;
  email: string | null;
  phone: string | null;
  created_source: string | null;
  customer_created_at: string | null;
  created_at: string;
}

/** One POS catalog object (ITEM / ITEM_VARIATION / CATEGORY), flattened. */
export interface RetailCatalogObjectRow {
  id: string;
  tenant_id: string;
  source_id: string;
  object_type: string;
  name: string | null;
  /** Parent ITEM id for a variation. */
  item_source_id: string | null;
  price_cents: number | null;
  sku: string | null;
  upc: string | null;
  category_name: string | null;
  is_deleted: number;
  created_at: string;
}

/** One POS gift card (store-credit liability). */
export interface RetailGiftCardRow {
  id: string;
  tenant_id: string;
  source_id: string;
  gan: string | null;
  state: string;
  balance_cents: number;
  gift_card_created_at: string | null;
  created_at: string;
}

/** One POS payout to the merchant bank/stored balance. */
export interface RetailPayoutRow {
  id: string;
  tenant_id: string;
  source_id: string;
  status: string;
  amount_cents: number;
  destination_type: string | null;
  payout_created_at: string | null;
  arrival_date: string | null;
  created_at: string;
}

/** One POS dispute/chargeback. */
export interface RetailDisputeRow {
  id: string;
  tenant_id: string;
  source_id: string;
  state: string;
  reason: string | null;
  amount_cents: number;
  payment_source_id: string | null;
  dispute_created_at: string | null;
  created_at: string;
}

/** One POS invoice. */
export interface RetailInvoiceRow {
  id: string;
  tenant_id: string;
  source_id: string;
  status: string;
  order_source_id: string | null;
  customer_source_id: string | null;
  computed_amount_cents: number;
  invoice_number: string | null;
  invoice_created_at: string | null;
  created_at: string;
}

/**
 * One POS inventory count. Keyed on (catalog_object, location, state);
 * quantity kept as Square's verbatim decimal string (never fabricated).
 */
export interface RetailInventoryCountRow {
  id: string;
  tenant_id: string;
  catalog_source_id: string;
  location_source_id: string;
  state: string;
  quantity: string | null;
  calculated_at: string | null;
  created_at: string;
}

export interface RetailDatabase extends CoreDatabase {
  retail_payments: RetailPaymentRow;
  retail_order_lines: RetailOrderLineRow;
  retail_refunds: RetailRefundRow;
  retail_customer_links: RetailCustomerLinkRow;
  retail_import_runs: RetailImportRunRow;
  retail_import_manifests: RetailImportManifestRow;
  retail_quarantine: RetailQuarantineRow;
  retail_import_cursors: RetailImportCursorRow;
  retail_webhook_receipts: RetailWebhookReceiptRow;
  retail_orders: RetailOrderRow;
  retail_customers: RetailCustomerRow;
  retail_catalog_objects: RetailCatalogObjectRow;
  retail_gift_cards: RetailGiftCardRow;
  retail_payouts: RetailPayoutRow;
  retail_disputes: RetailDisputeRow;
  retail_invoices: RetailInvoiceRow;
  retail_inventory_counts: RetailInventoryCountRow;
}
