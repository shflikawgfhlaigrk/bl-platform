/**
 * @blacklabel/inventory — stock as an APPEND-ONLY movement ledger.
 *
 * Iron invariant: inventory_stock_levels.on_hand === SUM(inventory_movements.delta)
 * for every (tenant, variation, location). The stock-levels row is a derived
 * cache maintained transactionally by the single write path `applyMovement`;
 * `verifyConservation` recomputes and reports drift. There is no update/delete
 * path for movements — a mistake is fixed with a compensating `correction`
 * movement (ref_type 'correction_of').
 *
 * Events emitted (all payloads include `v: 1`):
 *   - inventory.stock.changed             { v, variationId, locationId, delta, onHand, movementId, reason, oversold? }
 *   - inventory.stock.below_reorder_point { v, variationId, locationId, onHand, reorderPoint }
 *   - inventory.count.completed           { v, countSessionId, locationId }
 *   - inventory.transfer.closed           { v, transferId, fromLocationId, toLocationId, discrepancyCount }
 *
 * Reorder-point emission rule: after a NEGATIVE on_hand movement, for each
 * enabled reorder-point row scoped to the variation (location_id === the
 * movement's location, or null = aggregate across all locations), emit
 * `inventory.stock.below_reorder_point` ONLY when the movement crossed the
 * threshold — i.e. onHandBefore > reorderPoint AND onHandAfter <= reorderPoint.
 * Being already at-or-below before the movement does NOT re-emit. The emitted
 * `locationId` is the movement's location; for aggregate rows `onHand` is the
 * cross-location total.
 *
 * Oversell rule: negative `sold`/`transfer_out` movements that would drive
 * on_hand below 0 consult the location's oversell_policy — `deny` throws
 * ApiError.conflict; `allow_flag` proceeds and returns `oversold: true` (also in
 * the stock.changed payload). Reservations enforce the same policy against
 * available (on_hand - reserved) in `reserve()`.
 */

export { inventoryMigrations } from './migrations';
export { inventoryRouter } from './router';

export {
  // Single write path + correction
  applyMovement,
  correctMovement,
  // Locations
  createLocation,
  listLocations,
  getLocation,
  updateLocation,
  archiveLocation,
  // Stock reads
  getStock,
  onHandByLocation,
  listMovements,
  // Reservations
  reserve,
  releaseReservation,
  settleReservationsForReference,
  expireReservations,
  listReservations,
  // Sell reconciliation
  sellForOrder,
  // Count sessions
  openCountSession,
  getCountSession,
  addCountLine,
  recordCount,
  recordRecount,
  approveCountLine,
  setCountSessionStatus,
  listCountLines,
  closeCountSession,
  // Transfers
  createTransfer,
  getTransfer,
  shipTransfer,
  receiveTransfer,
  closeTransfer,
  // Kits
  assembleKit,
  disassembleKit,
  // Reorder points
  createReorderPoint,
  listReorderPoints,
  updateReorderPoint,
  deleteReorderPoint,
  // Analytics
  stockAging,
  velocity,
  daysOfSupply,
  stockoutList,
  shrinkSummary,
  // Conservation
  verifyConservation,
} from './service';

export type {
  ApplyMovementInput,
  ApplyMovementResult,
  ReorderCrossing,
  CreateLocationInput,
  StockView,
  MovementFilter,
  ReserveInput,
  ReserveResult,
  SettleReservationsResult,
  SellLine,
  SellForOrderInput,
  SellForOrderResult,
  SellLineResult,
  OpenCountSessionInput,
  CountLineView,
  TransferLineInput,
  ReceiveLineInput,
  KitComponentLine,
  ReorderPointInput,
  AgingRow,
  VelocityResult,
  DaysOfSupplyResult,
  StockoutRow,
  ShrinkSummary,
  ConservationDrift,
  ConservationReport,
} from './service';

export type {
  InventoryDatabase,
  InventoryLocationRow,
  InventoryMovementRow,
  InventoryStockLevelRow,
  InventoryReservationRow,
  InventoryCountSessionRow,
  InventoryCountLineRow,
  InventoryTransferRow,
  InventoryTransferLineRow,
  InventoryReorderPointRow,
  LocationKind,
  OversellPolicy,
  MovementReason,
  ReservationStatus,
  CountSessionKind,
  CountSessionStatus,
  TransferStatus,
} from './schema';
