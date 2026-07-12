import type { CoreDatabase } from '@blacklabel/core';

/**
 * Inventory module schema — stock as an APPEND-ONLY movement ledger.
 *
 * Iron invariant: for every (tenant, variation, location),
 *   inventory_stock_levels.on_hand === SUM(inventory_movements.delta).
 * The stock-levels row is a derived cache maintained transactionally with each
 * movement; `verifyConservation` recomputes and reports drift.
 *
 * There is NO update or delete path for movements. A mistake is fixed with a
 * NEW compensating movement (reason 'correction', ref_type 'correction_of').
 *
 * Reservations do NOT change on_hand — they change the derived `reserved`
 * column (available = on_hand - reserved). A reserve/release still writes a
 * ledger movement (reason 'reserved'/'released') with delta 0 for provenance.
 */

export type LocationKind =
  | 'warehouse'
  | 'trailer'
  | 'show'
  | 'fulfillment_staging'
  | 'reserved'
  | 'damaged'
  | 'quarantine'
  | 'custom';

export type OversellPolicy = 'deny' | 'allow_flag';

export type MovementReason =
  | 'received'
  | 'sold'
  | 'returned'
  | 'counted'
  | 'adjusted'
  | 'transfer_out'
  | 'transfer_in'
  | 'reserved'
  | 'released'
  | 'damaged'
  | 'shrink'
  | 'kit_assembled'
  | 'kit_disassembled'
  | 'correction';

export type ReservationStatus = 'active' | 'released' | 'converted' | 'expired';
export type CountSessionKind = 'full' | 'cycle';
export type CountSessionStatus = 'open' | 'paused' | 'review' | 'closed' | 'abandoned';
export type TransferStatus = 'draft' | 'in_transit' | 'received' | 'closed' | 'discrepancy';

export interface InventoryLocationRow {
  id: string;
  tenant_id: string;
  name: string;
  kind: LocationKind;
  /** String ref to a shows.show id when kind === 'show'; null otherwise. */
  show_id: string | null;
  oversell_policy: OversellPolicy;
  archived: number; // 0/1
  created_at: string;
  updated_at: string;
}

/** APPEND-ONLY. Never updated, never deleted. */
export interface InventoryMovementRow {
  id: string;
  tenant_id: string;
  variation_id: string;
  location_id: string;
  /** Signed on_hand delta. reserved/released movements carry delta 0. */
  delta: number;
  reason: MovementReason;
  ref_type: string | null;
  ref_id: string | null;
  /** UNIQUE per tenant when present. Check-then-insert dedup for replayable inputs. */
  idempotency_key: string | null;
  note: string | null;
  actor: string;
  created_at: string;
}

/** Derived cache. UNIQUE(tenant, variation, location) via check-then-insert. */
export interface InventoryStockLevelRow {
  id: string;
  tenant_id: string;
  variation_id: string;
  location_id: string;
  on_hand: number;
  reserved: number;
  counted_ever: number; // 0/1
  last_movement_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InventoryReservationRow {
  id: string;
  tenant_id: string;
  variation_id: string;
  location_id: string;
  qty: number;
  ref_type: string | null;
  ref_id: string | null;
  status: ReservationStatus;
  /** 1 when created against a location whose policy allowed overselling. */
  oversold: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InventoryCountSessionRow {
  id: string;
  tenant_id: string;
  location_id: string;
  kind: CountSessionKind;
  blind: number; // 0/1
  status: CountSessionStatus;
  assigned_to: string | null;
  recount_threshold: number;
  signed_by: string | null;
  signed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InventoryCountLineRow {
  id: string;
  tenant_id: string;
  session_id: string;
  variation_id: string;
  /** Snapshot of on_hand at line creation. Hidden from blind responses until review. */
  expected_qty: number;
  counted_qty: number | null;
  /** Derived: counted - expected (null until counted). */
  variance: number | null;
  recount_required: number; // 0/1
  recount_qty: number | null;
  approved: number; // 0/1
  created_at: string;
  updated_at: string;
}

export interface InventoryTransferRow {
  id: string;
  tenant_id: string;
  from_location_id: string;
  to_location_id: string;
  status: TransferStatus;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface InventoryTransferLineRow {
  id: string;
  tenant_id: string;
  transfer_id: string;
  variation_id: string;
  qty_sent: number;
  qty_received: number | null;
  created_at: string;
  updated_at: string;
}

export interface InventoryReorderPointRow {
  id: string;
  tenant_id: string;
  variation_id: string;
  /** null = all locations (aggregate scope). */
  location_id: string | null;
  reorder_point: number;
  safety_stock: number;
  enabled: number; // 0/1
  created_at: string;
  updated_at: string;
}

/** Replay registry for external/idempotent operations (e.g. sellForOrder). */
export interface InventoryIdempotencyRow {
  id: string;
  tenant_id: string;
  /** UNIQUE per tenant. */
  key: string;
  scope: string;
  result_json: string;
  created_at: string;
}

export interface InventoryDatabase extends CoreDatabase {
  inventory_locations: InventoryLocationRow;
  inventory_movements: InventoryMovementRow;
  inventory_stock_levels: InventoryStockLevelRow;
  inventory_reservations: InventoryReservationRow;
  inventory_count_sessions: InventoryCountSessionRow;
  inventory_count_lines: InventoryCountLineRow;
  inventory_transfers: InventoryTransferRow;
  inventory_transfer_lines: InventoryTransferLineRow;
  inventory_reorder_points: InventoryReorderPointRow;
  inventory_idempotency: InventoryIdempotencyRow;
}
