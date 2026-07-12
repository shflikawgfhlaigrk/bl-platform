/**
 * @blacklabel/vendors — supplier master data: vendors, contacts/terms, and a
 * per-vendor catalog of effective-dated costs / case-packs keyed to catalog
 * variation ids (string reference only; no catalog joins). Two-phase CSV
 * price-list import (preview → commit). XLSX is unsupported — export to CSV
 * first.
 *
 * This package is standalone: `purchasing` references vendors by id string
 * only and never imports this package.
 *
 * Events emitted: none (pure master-data module; audit on every mutation).
 */

export { vendorsMigrations } from './migrations';
export { vendorsRouter } from './router';
export {
  createVendor,
  getVendor,
  requireVendor,
  listVendors,
  updateVendor,
  archiveVendor,
  setCost,
  catalogHistory,
  listCatalogEntries,
  currentCost,
  previewPriceListImport,
  commitPriceListImport,
  listImportJobs,
} from './service';
export type {
  CreateVendorInput,
  UpdateVendorInput,
  VendorContact,
  VendorAddress,
  SetCostInput,
  ImportMappingConfig,
  VariationMatch,
  ImportPreview,
  ImportPreviewRow,
  ImportCommitResult,
} from './service';
export type {
  VendorsDatabase,
  VendorRow,
  VendorStatus,
  VendorCatalogEntryRow,
  VendorImportJobRow,
  ImportJobStatus,
} from './schema';
