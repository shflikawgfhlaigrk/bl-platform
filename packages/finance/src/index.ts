/**
 * @blacklabel/finance — Mags Commerce OS finance module.
 *
 * Owns IMPORTED/append-only financial ledgers (payments, refunds, payouts,
 * disputes, vendor-bill refs) plus derived reconciliation, cash-close,
 * COGS/margin, gift-card/store-credit liability snapshots, tax config +
 * evidence, period rollups, and accountant CSV exports.
 *
 * DATA-FLOW RULE: finance NEVER reads another module's tables. Historical rows
 * are FED by the integrator via idempotent, source-id-keyed import functions.
 * Cross-module linkage is by id string only. Missing data is stored as an
 * explicit NULL gap — never fabricated to 0.
 *
 * THE core honesty invariant (COGS/margin): an unknown cost stays NULL on the
 * line (never 0, never assumed), and the margin aggregate reports known-cost
 * revenue and unknown-cost revenue SEPARATELY so the two never mix.
 *
 * Events emitted:
 *   - finance.payout.reconciliation_failed  { v:1, payoutId, deltaCents }   (canonical; drives payout_mismatch action)
 *   - finance.cash.variance                 { v:1, cashSessionId, varianceCents }  (internal; drives cash_close_variance action)
 *
 * POS drawer integration hooks:
 *   - recordCashTender(...) for a captured orders cash tender
 *   - recordCashRefund(...) for cash physically returned on a refund
 */

export { financeMigrations } from './migrations';
export { financeRouter } from './router';

export {
  // A. ledger imports
  importPayments,
  importRefunds,
  importPayouts,
  importDisputes,
  importVendorBillRefs,
  importTaxEvidence,
  // B. payout reconciliation
  matchPayout,
  listPayoutMatches,
  payoutReconciliationSummary,
  // C. cash sessions
  openCashSession,
  postExpectedCents,
  closeCashSession,
  getCashSession,
  listCashSessions,
  recordCashMovement,
  recordCashTender,
  recordCashRefund,
  postCashDrawerMovement,
  listCashMovements,
  cashSessionReconciliation,
  addCashAdjustment,
  listCashAdjustments,
  // D. COGS / margin
  addItemCost,
  currentCost,
  listItemCosts,
  marginFor,
  // D2. liability
  recordLiabilitySnapshot,
  listLiabilitySnapshots,
  // E. tax
  upsertTaxConfig,
  listTaxConfigs,
  exportTaxEvidence,
  // F. period rollups
  periodSummary,
  // G. csv exports
  exportCsvRows,
  exportPaymentsCsvRows,
  exportRefundsCsvRows,
  exportPayoutsCsvRows,
  exportCashSessionsCsvRows,
  exportCashMovementsCsvRows,
  exportTaxEvidenceCsvRows,
  exportItemCostsCsvRows,
} from './service';

export type {
  ImportResult,
  ImportPaymentInput,
  ImportRefundInput,
  ImportPayoutInput,
  ImportDisputeInput,
  ImportVendorBillRefInput,
  ImportTaxEvidenceInput,
  PayoutMatchInput,
  PayoutMatchResult,
  PayoutReconciliationSummary,
  OpenCashSessionInput,
  CloseCashSessionInput,
  RecordCashMovementInput,
  RecordCashTenderInput,
  RecordCashRefundInput,
  PostCashDrawerMovementInput,
  CashMovementRecordResult,
  CashReconciliation,
  CashAdjustmentInput,
  AddItemCostInput,
  MarginLineInput,
  MarginLineResult,
  MarginResult,
  LiabilitySnapshotInput,
  TaxConfigInput,
  TaxEvidenceGroup,
  PeriodSummary,
  PeriodSourceKindLine,
  CsvKind,
} from './service';

export type {
  FinanceDatabase,
  FinancePaymentRow,
  FinanceRefundRow,
  FinancePayoutRow,
  FinanceDisputeRow,
  FinanceVendorBillRefRow,
  FinancePayoutMatchRow,
  FinanceCashSessionRow,
  FinanceCashMovementRow,
  FinanceCashAdjustmentRow,
  FinanceItemCostRow,
  FinanceLiabilitySnapshotRow,
  FinanceTaxConfigRow,
  FinanceTaxEvidenceRow,
  FinanceSourceKind,
  FinanceCostMethod,
  FinanceJurisdictionSource,
  FinanceCashStatus,
  FinanceCashExpectedMode,
  FinanceCashMovementKind,
} from './schema';
