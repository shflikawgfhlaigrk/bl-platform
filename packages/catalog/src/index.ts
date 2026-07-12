/**
 * @blacklabel/catalog — the merchandising system of record: departments,
 * deterministic category→department mapping (admin review queue), exact-safe
 * brand extraction, products/variations with PRESERVED Square source ids,
 * multi-barcode normalization + UPC-A/EAN-13 checksum validation, price books
 * with deterministic scheduled-price resolution, promotions (core money math),
 * kits/bundles, publication/exclusion law (DNU/JPC/consignment), CSV bulk
 * lanes, label data, and an idempotent ledger import.
 *
 * Events emitted (canonical, payloads include v:1):
 *   - catalog.variation.changed      { v:1, variationId }
 *   - catalog.publication.changed    { v:1, itemIds: string[] }
 *
 * Internal audit actions: catalog.department.*, catalog.product.*,
 * catalog.variation.*, catalog.barcode.added, catalog.price_book.created,
 * catalog.price_entry.added, catalog.promotion.created, catalog.kit.*,
 * catalog.bulk_job.completed, catalog.import.completed.
 *
 * Integrator wiring:
 *   - mount `catalogRouter(deps)` at /api/catalog
 *   - initial data load: `importFromLedger(db, tenantId, rows, { events })`
 *     where `rows` are ledger-shaped items (see LedgerItem). Idempotent — safe
 *     to re-run; keyed on preserved Square source ids.
 *   - `buildImportPlan(rows)` is pure: inspect the full plan (+stats) first.
 */

export { catalogMigrations } from './migrations';
export { catalogRouter } from './router';

// Pure mapping/law + barcode helpers
export {
  slugify,
  mapCategory,
  extractBrand,
  evaluateExclusion,
  DEPARTMENT_TREE,
  CATEGORY_RULES,
  BRAND_TABLE,
  EXCLUSION_RULES,
  MIN_BRAND_ITEMS,
} from './mapping';
export type { CategoryRule, DepartmentSeed, CategoryDecision, BrandDecision, ExclusionDecision } from './mapping';

export {
  normalizeCode,
  analyzeCode,
  isValidUpcA,
  isValidEan13,
  upcaCheckDigit,
  ean13CheckDigit,
  classifySymbology,
} from './barcode';
export type { AnalyzedCode } from './barcode';

// Import lane
export { buildImportPlan, importFromLedger } from './importer';
export type {
  LedgerItem,
  LedgerVariation,
  ImportPlan,
  ImportPlanStats,
  ImportResult,
  PlannedProduct,
  PlannedVariation,
  PlannedBarcode,
  PlannedCategoryMapping,
} from './importer';

// Services (also usable directly by apps/api / other lanes)
export * from './service';

// Schema types
export type {
  CatalogDatabase,
  CatalogDepartmentRow,
  CatalogCategoryMappingRow,
  CatalogBrandRow,
  CatalogProductRow,
  CatalogVariationRow,
  CatalogBarcodeRow,
  CatalogPriceBookRow,
  CatalogPriceEntryRow,
  CatalogPromotionRow,
  CatalogKitRow,
  CatalogKitComponentRow,
  CatalogBulkJobRow,
  PublicationState,
  ExclusionReason,
  Symbology,
  MappingStatus,
} from './schema';
