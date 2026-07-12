/**
 * @blacklabel/retail — the provider-neutral Square import lane.
 *
 * Legacy bulk lane: imported POS sales facts (payments, order lines,
 * refunds), POS-customer→crm links, and the append-only import-run ledger
 * via `importSales`.
 *
 * Incremental import system (one normalized ImportBatch contract, four
 * producers — export drop, API polling, webhook, simulator — feeding one
 * pipeline: validate → quarantine → idempotent upsert → reconcile). NO
 * network anywhere: the polling transport and webhook signature key are
 * INJECTED at wiring (founder-gated); the module never fetches.
 *
 * Events emitted:
 *   - retail.import.completed            { importRunId, payments, orderLines, refunds }
 *   - retail.import.quarantined          { v, manifestId, quarantineId, kind }
 *   - retail.import.reconciliation_failed{ v, manifestId, kind, expectedGrossCents, actualGrossCents, expectedCount, actualCount }
 *
 * Integrator wiring: pass a second arg to `retailRouter(deps, wiring)` with
 * `{ webhook: { signatureKey, notificationUrl }, pollTransport, pollOverlapSeconds }`.
 * The `retail.import.quarantined` event drives the quarantined_import_record
 * action; `retail.import.reconciliation_failed` drives the reconciliation action.
 */

export { retailMigrations } from './migrations';
export { retailRouter, type RetailImportWiring } from './router';

// Import contract + adapters
export {
  IMPORT_KINDS,
  IMPORT_SOURCES,
  isImportKind,
  sourceHash,
  validateRecord,
  KIND_SCHEMAS,
} from './contract';
export type { ImportBatch, ImportKind, ImportSource, ImportSourceMeta } from './contract';
export { parseExportFile, extractRecords } from './export-adapter';
export {
  SquarePollingClient,
  type PollTransport,
  type PollRequest,
  type PollResponse,
  type PollResult,
  type SquarePollingClientOptions,
} from './polling-adapter';
export {
  verifyWebhookSignature,
  computeWebhookSignature,
  normalizeWebhookEvent,
  type WebhookSignatureConfig,
  type NormalizedWebhookEvent,
} from './webhook-adapter';
export { SimulatedSquareProvider } from './simulator';

// Pipeline service
export {
  runImportBatch,
  reconciliation,
  lastSuccessfulImportAt,
  importStatus,
  listManifests,
  getManifestDetail,
  listQuarantine,
  getQuarantine,
  repairQuarantine,
  discardQuarantine,
  getCursor,
  setCursor,
  listCursors,
} from './import-service';
export type {
  ManifestResult,
  ReconciliationRow,
  KindStatus,
  ManifestDetail,
  RunBatchOptions,
} from './import-service';
export {
  importSales,
  linkCustomer,
  getCustomerLink,
  listCustomerLinks,
  listImportRuns,
  listPayments,
  salesSummary,
} from './service';
export type {
  ImportSalesInput,
  ImportSalesResult,
  ImportPaymentInput,
  ImportOrderLineInput,
  ImportRefundInput,
  SalesSummary,
} from './service';
export type {
  RetailDatabase,
  RetailPaymentRow,
  RetailOrderLineRow,
  RetailRefundRow,
  RetailCustomerLinkRow,
  RetailImportRunRow,
  RetailImportManifestRow,
  RetailQuarantineRow,
  RetailImportCursorRow,
  RetailWebhookReceiptRow,
  RetailOrderRow,
  RetailCustomerRow,
  RetailCatalogObjectRow,
  RetailGiftCardRow,
  RetailPayoutRow,
  RetailDisputeRow,
  RetailInvoiceRow,
  RetailInventoryCountRow,
} from './schema';
