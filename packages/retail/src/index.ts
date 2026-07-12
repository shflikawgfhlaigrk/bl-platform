/**
 * @blacklabel/retail — imported point-of-sale sales facts (payments, order
 * lines, refunds), POS-customer→crm links, and the append-only import-run
 * ledger. The module never talks to a POS API; rows arrive via `importSales`
 * from an out-of-band export.
 *
 * Events emitted:
 *   - retail.import.completed  { importRunId, payments, orderLines, refunds }
 */

export { retailMigrations } from './migrations';
export { retailRouter } from './router';
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
} from './schema';
