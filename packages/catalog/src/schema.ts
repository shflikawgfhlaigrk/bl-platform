import type { CoreDatabase } from '@blacklabel/core';

/**
 * Catalog module schema — the merchandising system of record for Mags Tack.
 *
 * Source identifiers from the Square export are PRESERVED, never erased:
 * `catalog_products.source_item_id` and `catalog_variations.source_variation_id`
 * carry the Square object ids and are unique per tenant, which is what makes
 * `importFromLedger` idempotent (re-runs update, never duplicate).
 *
 * Money is integer cents. A NULL `price_cents` is an HONEST "price not listed",
 * never 0. Barcodes keep the raw hand-typed code AND a digits-only normalization;
 * a bad check digit is real data (442 exist in the live ledger) — stored,
 * flagged `checksum_valid = 0`, and still searchable.
 */

/** Publication lifecycle of a product on customer-facing surfaces. */
export type PublicationState = 'draft' | 'published' | 'excluded';

/** Why a product is excluded from public surfaces (owner still sees it). */
export type ExclusionReason = 'dnu' | 'jpc_consignment' | 'consignment_name' | 'manual';

/** How a barcode was recognized. */
export type Symbology = 'upca' | 'ean13' | 'code128' | 'unknown';

/** Status of a deterministic source-category → department mapping. */
export type MappingStatus = 'mapped' | 'needs_review';

/** Curated department tree node. */
export interface CatalogDepartmentRow {
  id: string;
  tenant_id: string;
  name: string;
  /** URL-safe slug, unique per tenant (check-then-insert). */
  slug: string;
  /** Parent department id, or null for a root. */
  parent_id: string | null;
  sort: number;
  archived: number;
  created_at: string;
  updated_at: string;
}

/** Deterministic source category name → department decision + review queue. */
export interface CatalogCategoryMappingRow {
  id: string;
  tenant_id: string;
  /** The Square category name, verbatim. Unique per tenant. */
  source_category_name: string;
  /** Resolved department id, or null while it needs review. */
  department_id: string | null;
  status: MappingStatus;
  /** Name of the deterministic rule that produced this decision. */
  rule_name: string;
  created_at: string;
  updated_at: string;
}

/** A known brand, extracted by an exact-safe name-prefix rule. */
export interface CatalogBrandRow {
  id: string;
  tenant_id: string;
  name: string;
  /** Unique per tenant. */
  slug: string;
  /** The extraction rule kind, e.g. "exact_prefix". */
  extraction_rule: string;
  /** 1 when the brand met its minimum-item threshold during extraction. */
  min_items_met: number;
  created_at: string;
  updated_at: string;
}

/** A product — one Square catalog item. */
export interface CatalogProductRow {
  id: string;
  tenant_id: string;
  /** Square catalog item id, preserved. Unique per tenant. */
  source_item_id: string;
  name: string;
  description: string | null;
  department_id: string | null;
  brand_id: string | null;
  /** Denormalized source category name captured at import. */
  source_category_name: string | null;
  publication_state: PublicationState;
  exclusion_reason: ExclusionReason | null;
  archived: number;
  created_at: string;
  updated_at: string;
}

/** A variation — one sellable SKU under a product. */
export interface CatalogVariationRow {
  id: string;
  tenant_id: string;
  product_id: string;
  /** Square catalog variation id, preserved. Unique per tenant. */
  source_variation_id: string;
  name: string;
  sku: string | null;
  /** Integer cents. NULL = price not listed (never 0-as-unknown). */
  price_cents: number | null;
  price_book_id: string | null;
  track_inventory: number;
  archived: number;
  created_at: string;
  updated_at: string;
}

/** A barcode attached to a variation (multiple allowed; duplicates queryable). */
export interface CatalogBarcodeRow {
  id: string;
  tenant_id: string;
  variation_id: string;
  /** The code as typed/scanned, verbatim. */
  code_raw: string;
  /** Digits-only normalization ('' when the raw code has no digits). */
  code_normalized: string;
  symbology: Symbology;
  checksum_valid: number;
  is_primary: number;
  created_at: string;
  updated_at: string;
}

/** A price book (a named, currency-scoped set of scheduled price entries). */
export interface CatalogPriceBookRow {
  id: string;
  tenant_id: string;
  name: string;
  currency: string;
  effective_from: string | null;
  effective_to: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

/** A single scheduled price for a variation within a price book. */
export interface CatalogPriceEntryRow {
  id: string;
  tenant_id: string;
  price_book_id: string;
  variation_id: string;
  price_cents: number;
  effective_from: string | null;
  effective_to: string | null;
  created_at: string;
  updated_at: string;
}

/** A promotion — percent (bps) or fixed (cents) discount over a scope. */
export interface CatalogPromotionRow {
  id: string;
  tenant_id: string;
  name: string;
  type: 'percent_bps' | 'fixed_cents';
  /** bps when percent_bps, cents when fixed_cents. */
  value: number;
  /** JSON: { departmentIds?, brandIds?, productIds? }. */
  scope: string;
  starts_at: string | null;
  ends_at: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

/** A kit / bundle (references a product that IS the kit). */
export interface CatalogKitRow {
  id: string;
  tenant_id: string;
  /** The product id that represents the kit itself. Unique per tenant. */
  product_id: string;
  name: string;
  archived: number;
  created_at: string;
  updated_at: string;
}

/** One component line of a kit. */
export interface CatalogKitComponentRow {
  id: string;
  tenant_id: string;
  kit_id: string;
  variation_id: string;
  quantity: number;
  created_at: string;
  updated_at: string;
}

/** A CSV bulk import/export job record. */
export interface CatalogBulkJobRow {
  id: string;
  tenant_id: string;
  kind: string;
  status: string;
  rows_total: number;
  rows_ok: number;
  rows_failed: number;
  /** JSON array of row-level errors. */
  errors: string;
  created_at: string;
  updated_at: string;
}

export interface CatalogDatabase extends CoreDatabase {
  catalog_departments: CatalogDepartmentRow;
  catalog_category_mappings: CatalogCategoryMappingRow;
  catalog_brands: CatalogBrandRow;
  catalog_products: CatalogProductRow;
  catalog_variations: CatalogVariationRow;
  catalog_barcodes: CatalogBarcodeRow;
  catalog_price_books: CatalogPriceBookRow;
  catalog_price_entries: CatalogPriceEntryRow;
  catalog_promotions: CatalogPromotionRow;
  catalog_kits: CatalogKitRow;
  catalog_kit_components: CatalogKitComponentRow;
  catalog_bulk_jobs: CatalogBulkJobRow;
}
