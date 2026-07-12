import type { CoreDatabase } from '@blacklabel/core';

/**
 * Shows module schema — horse-show operations: venues, show events, reusable
 * packing templates, manifests (load-out/scan-back), discrepancies, and
 * closeout.
 *
 * DATA TRUTH: the historical Square export has ONE location id for everything,
 * so venue/state/date attribution is NOT derivable from history. Shows are
 * entered manually or imported from a founder-provided schedule. Nothing in
 * this module fabricates a venue, a date, or show-revenue attribution.
 * Show-scoped analytics only exist for shows operated THROUGH this module.
 *
 * Portable-SQL rules: text ids (`id()`), ISO-8601 UTC timestamps (`nowIso()`),
 * `*_cents` integer money, JSON serialized to text, booleans as integer 0/1.
 * Every table carries `tenant_id` and is indexed on it.
 */

export type ShowStatus =
  | 'planned'
  | 'packing'
  | 'active'
  | 'returned'
  | 'closing'
  | 'closed'
  | 'canceled';

export type ManifestStatus = 'draft' | 'final' | 'loaded' | 'returned' | 'reconciled';

export type CloseoutStatus = 'open' | 'complete';

/** Variance reason recorded when packed/returned quantity differs from suggested. */
export type VarianceReason = 'missing' | 'substituted' | 'deliberate';

/** Discrepancy resolution posted by the integrator once reconciled. */
export type DiscrepancyResolution = 'found' | 'damaged' | 'shrink' | 'sold_unrecorded';

/** A show venue. `state` (2-letter) is REQUIRED — it drives future tax-exposure reporting. */
export interface ShowVenueRow {
  id: string;
  tenant_id: string;
  name: string;
  /** JSON: { street?, city?, state?, zip? } — serialized to text. */
  address: string;
  /** 2-letter state code, uppercased. REQUIRED. */
  state: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** A scheduled show event, operated through this module going forward. */
export interface ShowRow {
  id: string;
  tenant_id: string;
  venue_id: string;
  name: string;
  /** Show start date (YYYY-MM-DD), caller-supplied — never inferred. */
  starts_on: string;
  /** Show end date (YYYY-MM-DD), caller-supplied. */
  ends_on: string;
  /** JSON nullable: setup window details. */
  setup_window: string | null;
  /** JSON nullable: teardown window details. */
  teardown_window: string | null;
  booth_assignment: string | null;
  /** JSON nullable: travel details (route/lodging/etc). */
  travel: string | null;
  booth_fee_cents: number | null;
  travel_cost_cents: number | null;
  /** JSON: list of { userId?, name? } — staffing. */
  staffing: string;
  status: ShowStatus;
  /** Inventory location id string created for this show (set by integrator). */
  location_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** Reusable packing template, by show type and/or season. */
export interface ShowPackingTemplateRow {
  id: string;
  tenant_id: string;
  name: string;
  show_type: string | null;
  season: string | null;
  /** JSON: [{ category?, variationId?, targetQty?, displayMin? }]. */
  lines: string;
  created_at: string;
  updated_at: string;
}

/** A manifest for one show — the packing plan and its load-out/scan-back lifecycle. */
export interface ShowManifestRow {
  id: string;
  tenant_id: string;
  show_id: string;
  template_id: string | null;
  status: ManifestStatus;
  created_at: string;
  updated_at: string;
}

/** One variation line on a manifest, carrying its transparent suggestion trace. */
export interface ShowManifestLineRow {
  id: string;
  tenant_id: string;
  manifest_id: string;
  variation_id: string;
  /** Denormalized name captured at suggestion time (honest snapshot). */
  name: string | null;
  suggested_qty: number;
  packed_qty: number | null;
  returned_qty: number | null;
  /** JSON: FormulaTraceStep[] — every input and step of the suggestion. */
  formula_trace: string;
  /** When this line substitutes another variation, that variation's id. */
  substitution_of: string | null;
  /** Variance reason (missing|substituted|deliberate) when packed != suggested. */
  missing_reason: VarianceReason | null;
  created_at: string;
  updated_at: string;
}

/**
 * Expected-vs-returned discrepancy POSTED by the integrator (expected is
 * computed against inventory movements OUTSIDE this module). This module only
 * stores and resolves them.
 */
export interface ShowDiscrepancyRow {
  id: string;
  tenant_id: string;
  show_id: string;
  manifest_id: string | null;
  variation_id: string;
  expected_qty: number;
  returned_qty: number;
  /** returned - expected (negative = short/shrink). */
  delta: number;
  resolution: DiscrepancyResolution | null;
  resolved: number;
  created_at: string;
  updated_at: string;
}

/**
 * Per-show closeout. Financial numbers are POSTED by the integrator/dashboard
 * from real data — this module never invents them. null = honest "not yet
 * reviewed". A show may only close when closeout is complete: every review
 * section marked AND unresolved_exceptions_count == 0.
 */
export interface ShowCloseoutRow {
  id: string;
  tenant_id: string;
  /** UNIQUE per tenant. */
  show_id: string;
  sales_total_cents: number | null;
  cash_variance_cents: number | null;
  refunds_cents: number | null;
  labor_cents: number | null;
  travel_cents: number | null;
  booth_fee_cents: number | null;
  damages_count: number | null;
  unresolved_exceptions_count: number;
  /** JSON: { [section]: 0|1 } — each review section acknowledged. */
  review: string;
  status: CloseoutStatus;
  created_at: string;
  updated_at: string;
}

export interface ShowsDatabase extends CoreDatabase {
  shows_venues: ShowVenueRow;
  shows_shows: ShowRow;
  shows_packing_templates: ShowPackingTemplateRow;
  shows_manifests: ShowManifestRow;
  shows_manifest_lines: ShowManifestLineRow;
  shows_discrepancies: ShowDiscrepancyRow;
  shows_closeouts: ShowCloseoutRow;
}
