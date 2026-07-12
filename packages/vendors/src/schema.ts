import type { CoreDatabase } from '@blacklabel/core';

/**
 * Vendors module schema — supplier master data: vendors, their contacts and
 * terms, and a per-vendor catalog of costs/case-packs keyed to a catalog
 * variation id (string reference only — this module NEVER joins catalog
 * tables). Cost history is preserved append-only: a new cost is a NEW row that
 * closes the prior row's `effective_to`.
 */

export type VendorStatus = 'active' | 'archived';

/** A supplier. contacts/address are JSON blobs serialized to text. */
export interface VendorRow {
  id: string;
  tenant_id: string;
  name: string;
  /** JSON array of { name?, email?, phone?, role? } — serialized text. */
  contacts: string;
  /** JSON object { line1?, line2?, city?, region?, postal?, country? } — serialized text. */
  address: string;
  account_number: string | null;
  /** Free-text terms label, e.g. "Net 30". */
  payment_terms: string | null;
  lead_time_days: number;
  minimum_order_cents: number;
  /** Order subtotal at/above which freight is free; null = never free. */
  free_freight_threshold_cents: number | null;
  status: VendorStatus;
  created_at: string;
  updated_at: string;
}

/**
 * One cost record for (vendor, variation). Effective-dated: the open record has
 * `effective_to = null`; setting a new cost closes it by stamping its
 * `effective_to` to the new record's `effective_from`.
 */
export interface VendorCatalogEntryRow {
  id: string;
  tenant_id: string;
  vendor_id: string;
  /** Catalog variation id — string reference only. */
  variation_id: string;
  vendor_sku: string;
  cost_cents: number;
  case_pack_qty: number;
  /** ISO-8601 UTC inclusive start. */
  effective_from: string;
  /** ISO-8601 UTC exclusive end; null = currently open. */
  effective_to: string | null;
  created_at: string;
}

export type ImportJobStatus = 'previewed' | 'committed';

/** Append-only record of a price-list import run: counts + row errors JSON. */
export interface VendorImportJobRow {
  id: string;
  tenant_id: string;
  vendor_id: string;
  status: ImportJobStatus;
  rows_total: number;
  rows_valid: number;
  rows_error: number;
  rows_committed: number;
  /** JSON array of { rowNumber, errors: string[] } — serialized text. */
  errors: string;
  created_at: string;
}

export interface VendorsDatabase extends CoreDatabase {
  vendors_vendors: VendorRow;
  vendors_catalog_entries: VendorCatalogEntryRow;
  vendors_import_jobs: VendorImportJobRow;
}
