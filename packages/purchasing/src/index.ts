/**
 * @blacklabel/purchasing — reorder policies + transparent reorder suggestions,
 * purchase orders (with an append-only event log + rendered documents),
 * receiving with discrepancies, and vendor bills with three-way match.
 *
 * Cross-module discipline: vendors are referenced by `vendor_id` STRING only —
 * this package never imports @blacklabel/vendors and never joins its tables.
 * Costs travel IN on inputs; inventory movements travel OUT via events.
 *
 * Events emitted:
 *   purchasing.purchase_order.approved  { v:1, purchaseOrderId, vendorId, totalCents }
 *   purchasing.purchase_order.received  { v:1, purchaseOrderId, receiptId,
 *                                         lines:[{ variationId, qty, condition, unitCostCents }] }
 *   purchasing.receipt.discrepant       { v:1, receiptId, purchaseOrderId, discrepancyCount }  (internal)
 *
 * Integrator wiring notes:
 *   - Inventory: subscribe to `purchasing.purchase_order.received`; for each
 *     line apply a movement — condition 'ok' → +onHand, 'damaged' → quarantine,
 *     'wrong_item' → return/hold. unitCostCents is provided for weighted-average
 *     costing (see `weightedCost`). Handlers must be idempotent on receiptId.
 *   - Send lane: `sendPurchaseOrder` only renders + records the document; the
 *     integrator delivers it (email/PDF) via the automation outbox using the
 *     stored `purchasing_po_documents.payload`.
 */

export { purchasingMigrations } from './migrations';
export { purchasingRouter } from './router';
export { suggestQty } from './suggest';
export type { SuggestQtyInputs, SuggestQtyResult } from './suggest';
export { weightedCost } from './cost';
export type { CostLot } from './cost';
export {
  createReorderPolicy,
  getReorderPolicy,
  listReorderPolicies,
  updateReorderPolicy,
  deleteReorderPolicy,
  runSuggestion,
  getSuggestion,
  listSuggestions,
  acceptSuggestion,
  dismissSuggestion,
  createPurchaseOrder,
  addPoLine,
  getPurchaseOrder,
  listPurchaseOrders,
  listPoLines,
  listPoEvents,
  getLatestPoDocument,
  submitPurchaseOrder,
  approvePurchaseOrder,
  rejectPurchaseOrder,
  sendPurchaseOrder,
  acknowledgePurchaseOrder,
  cancelPurchaseOrder,
  closePurchaseOrder,
  createReceipt,
  listDiscrepancies,
  createVendorBill,
  getVendorBill,
  listVendorBills,
  listBillExceptions,
  matchVendorBill,
} from './service';
export type {
  CreatePolicyInput,
  CreatePoInput,
  CreatePoLineInput,
  AcceptSuggestionInput,
  ReceiveInput,
  ReceiveLineInput,
  ReceiveResult,
  BillLineInput,
  CreateBillInput,
  MatchResult,
} from './service';
export type {
  PurchasingDatabase,
  ReorderPolicyRow,
  SuggestionRow,
  SuggestionStatus,
  PurchaseOrderRow,
  PurchaseOrderStatus,
  PoLineRow,
  PoLineState,
  PoEventRow,
  PoDocumentRow,
  ReceiptRow,
  ReceiptLineRow,
  ReceiptCondition,
  DiscrepancyRow,
  DiscrepancyKind,
  VendorBillRow,
  VendorBillStatus,
  BillExceptionRow,
  BillExceptionKind,
} from './schema';
