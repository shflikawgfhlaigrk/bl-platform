import type { CoreDatabase } from '@blacklabel/core';

/**
 * @blacklabel/storefront schema — the PUBLIC PROJECTION.
 *
 * PUBLIC ISOLATION IS LAW. These `storefront_*` tables are the ONLY data a
 * public request may ever touch. A publish pipeline copies FROM private
 * catalog/inventory (through an injected PublishSource — this package never
 * imports those packages) INTO this projection. No public read ever queries a
 * private table.
 *
 * By CONSTRUCTION the projection carries NO PII: there is no customer name,
 * email, phone, address, vendor cost, revenue, or exact stock count column
 * anywhere below. Availability is a STATE ONLY (`in_stock|low|out|unknown`) —
 * never a number. A NULL `price_cents` is an honest "Price not listed", never 0.
 */

/** Availability is a coarse state — NEVER a count. `unknown` renders NO badge. */
export type AvailabilityState = 'in_stock' | 'low' | 'out' | 'unknown';

/** Lifecycle of a publish run. Exactly one run per tenant is ever `live`. */
export type PublishRunStatus = 'pending' | 'live' | 'failed' | 'superseded' | 'rolled_back';

/** A publish attempt: counts, checksum, duration, and every gate's result. */
export interface StorefrontPublishRunRow {
  id: string;
  tenant_id: string;
  status: PublishRunStatus;
  /** Deterministic "data as of" stamp shown on pages (NOT wall-clock at render). */
  data_as_of: string;
  item_count: number;
  variation_count: number;
  page_count: number;
  /** SHA-256 over the deterministic projection payload. */
  checksum: string;
  duration_ms: number;
  /** JSON: GateResult[] — leakage/exclusion/a11y/external-url/broken-link/seo. */
  gate_results: string;
  /** JSON: array of human-readable gate failure messages ([] when clean). */
  failures: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** A published product (one Square catalog item that survived the exclusion law). */
export interface StorefrontPublishedItemRow {
  id: string;
  tenant_id: string;
  publish_run_id: string;
  /** Preserved Square catalog item id (opaque; not PII). */
  source_product_id: string;
  name: string;
  description: string | null;
  department_slug: string | null;
  department_name: string | null;
  category_name: string | null;
  brand_slug: string | null;
  brand_name: string | null;
  /** URL-safe slug for the item page, unique within a run. */
  slug: string;
  /** JSON: { path: string; alt: string }[] — local image refs + alt text. */
  images: string;
  /** Lower = more featured/higher velocity. Deterministic ordering key. */
  velocity_rank: number;
  created_at: string;
}

/** A published variation (sellable SKU) under a published item. */
export interface StorefrontPublishedVariationRow {
  id: string;
  tenant_id: string;
  publish_run_id: string;
  item_id: string;
  source_variation_id: string;
  name: string;
  sku: string | null;
  /** Integer cents. NULL = "Price not listed" (never 0-as-unknown). */
  price_cents: number | null;
  sort: number;
  created_at: string;
}

/** Availability STATE for a variation (never a count). */
export interface StorefrontAvailabilityRow {
  id: string;
  tenant_id: string;
  publish_run_id: string;
  variation_id: string;
  state: AvailabilityState;
  created_at: string;
}

/** A rendered page's routing/SEO record (path → title/description/kind). */
export interface StorefrontPageRow {
  id: string;
  tenant_id: string;
  publish_run_id: string;
  path: string;
  title: string;
  description: string;
  /** home|department|brand|item|search|cart|checkout|order_status|gift_cards|consent|info|sitemap|robots */
  kind: string;
  created_at: string;
}

export interface StorefrontDatabase extends CoreDatabase {
  storefront_publish_runs: StorefrontPublishRunRow;
  storefront_published_items: StorefrontPublishedItemRow;
  storefront_published_variations: StorefrontPublishedVariationRow;
  storefront_availability: StorefrontAvailabilityRow;
  storefront_pages: StorefrontPageRow;
}
