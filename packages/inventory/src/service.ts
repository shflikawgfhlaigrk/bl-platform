import type { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import {
  ApiError,
  asCoreDb,
  audit,
  id,
  nowIso,
  type EventBus,
  type Pagination,
} from '@blacklabel/core';
import type {
  CountSessionKind,
  TransferStatus,
  InventoryCountLineRow,
  InventoryCountSessionRow,
  InventoryDatabase,
  InventoryLocationRow,
  InventoryMovementRow,
  InventoryReorderPointRow,
  InventoryReservationRow,
  InventoryStockLevelRow,
  InventoryTransferLineRow,
  InventoryTransferRow,
  LocationKind,
  MovementReason,
  OversellPolicy,
} from './schema';

type Db = Kysely<InventoryDatabase>;

/* ================================================================== *
 * Constants & small helpers
 * ================================================================== */

/**
 * Negative movements that consume physically-available stock and are therefore
 * subject to the location's oversell policy. Reserve is gated separately in
 * `reserve()` because it consumes availability via the `reserved` column, not
 * on_hand. Corrections/adjustments/counts intentionally reflect reality and are
 * never blocked.
 */
const OVERSELL_GATED_REASONS: ReadonlySet<MovementReason> = new Set<MovementReason>([
  'sold',
  'transfer_out',
]);

function boolOf(n: number): boolean {
  return n === 1;
}

async function requireLocation(
  db: Db,
  tenantId: string,
  locationId: string,
): Promise<InventoryLocationRow> {
  const loc = await db
    .selectFrom('inventory_locations')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', locationId)
    .executeTakeFirst();
  if (!loc) throw ApiError.notFound(`location "${locationId}" not found`);
  return loc;
}

async function loadLevel(
  db: Db,
  tenantId: string,
  variationId: string,
  locationId: string,
): Promise<InventoryStockLevelRow | undefined> {
  return db
    .selectFrom('inventory_stock_levels')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('variation_id', '=', variationId)
    .where('location_id', '=', locationId)
    .executeTakeFirst();
}

async function sumOnHand(db: Db, tenantId: string, variationId: string): Promise<number> {
  const row = await db
    .selectFrom('inventory_stock_levels')
    .select((eb) => eb.fn.sum<number>('on_hand').as('total'))
    .where('tenant_id', '=', tenantId)
    .where('variation_id', '=', variationId)
    .executeTakeFirst();
  return Number(row?.total ?? 0);
}

/* ================================================================== *
 * applyMovement — THE single write path
 * ================================================================== */

export interface ApplyMovementInput {
  variationId: string;
  locationId: string;
  delta: number;
  reason: MovementReason;
  refType?: string | null;
  refId?: string | null;
  idempotencyKey?: string | null;
  note?: string | null;
  actor?: string;
  /** Internal: adjust the derived reserved column (reserve/release). Not persisted on the row. */
  reservedDelta?: number;
  /** Internal: force counted_ever=1 (count close). */
  markCounted?: boolean;
}

export interface ReorderCrossing {
  variationId: string;
  locationId: string;
  onHand: number;
  reorderPoint: number;
}

interface MovementTxResult {
  movement: InventoryMovementRow;
  level: InventoryStockLevelRow;
  oversold: boolean;
  deduped: boolean;
  crossings: ReorderCrossing[];
}

export interface ApplyMovementResult {
  movement: InventoryMovementRow;
  onHand: number;
  reserved: number;
  available: number;
  oversold: boolean;
  deduped: boolean;
}

/**
 * Core write, executed inside a caller-provided transaction. Validates the
 * location, enforces oversell policy for gated negative deltas, appends the
 * movement, and maintains the derived stock-levels row (on_hand === SUM(delta)).
 * Reorder crossings are returned (not emitted) so the caller can emit after the
 * commit succeeds.
 */
async function writeMovementTx(
  trx: Db,
  tenantId: string,
  actor: string,
  input: ApplyMovementInput,
): Promise<MovementTxResult> {
  const loc = await requireLocation(trx, tenantId, input.locationId);
  const reservedDelta = input.reservedDelta ?? 0;

  // Idempotent dedup: same key already applied → return prior movement, no write.
  if (input.idempotencyKey != null) {
    const prior = await trx
      .selectFrom('inventory_movements')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirst();
    if (prior) {
      const level = (await loadLevel(trx, tenantId, prior.variation_id, prior.location_id))!;
      return { movement: prior, level, oversold: false, deduped: true, crossings: [] };
    }
  }

  const existing = await loadLevel(trx, tenantId, input.variationId, input.locationId);
  const onHandBefore = existing?.on_hand ?? 0;
  const reservedBefore = existing?.reserved ?? 0;
  const onHandAfter = onHandBefore + input.delta;
  const reservedAfter = reservedBefore + reservedDelta;

  // Oversell policy on gated negative on_hand deltas.
  let oversold = false;
  if (input.delta < 0 && OVERSELL_GATED_REASONS.has(input.reason) && onHandAfter < 0) {
    const policy: OversellPolicy = loc.oversell_policy;
    if (policy === 'deny') {
      throw ApiError.conflict(
        `oversell denied for variation "${input.variationId}" at location "${input.locationId}": on_hand ${onHandBefore} + delta ${input.delta} < 0`,
        { onHand: onHandBefore, delta: input.delta, policy },
      );
    }
    oversold = true; // allow_flag
  }

  const now = nowIso();
  const movement: InventoryMovementRow = {
    id: id(),
    tenant_id: tenantId,
    variation_id: input.variationId,
    location_id: input.locationId,
    delta: input.delta,
    reason: input.reason,
    ref_type: input.refType ?? null,
    ref_id: input.refId ?? null,
    idempotency_key: input.idempotencyKey ?? null,
    note: input.note ?? null,
    actor,
    created_at: now,
  };
  await trx.insertInto('inventory_movements').values(movement).execute();

  // A count reconciliation marks the key as counted-at-least-once.
  const setCounted = input.markCounted || input.reason === 'counted';

  // Maintain the derived cache (check-then-insert; never ON CONFLICT).
  let level: InventoryStockLevelRow;
  if (existing) {
    level = {
      ...existing,
      on_hand: onHandAfter,
      reserved: reservedAfter,
      counted_ever: setCounted ? 1 : existing.counted_ever,
      last_movement_at: now,
      updated_at: now,
    };
    await trx
      .updateTable('inventory_stock_levels')
      .set({
        on_hand: level.on_hand,
        reserved: level.reserved,
        counted_ever: level.counted_ever,
        last_movement_at: level.last_movement_at,
        updated_at: level.updated_at,
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', existing.id)
      .execute();
  } else {
    level = {
      id: id(),
      tenant_id: tenantId,
      variation_id: input.variationId,
      location_id: input.locationId,
      on_hand: onHandAfter,
      reserved: reservedAfter,
      counted_ever: setCounted ? 1 : 0,
      last_movement_at: now,
      created_at: now,
      updated_at: now,
    };
    await trx.insertInto('inventory_stock_levels').values(level).execute();
  }

  // Reorder-point crossings — only on negative on_hand deltas, only when THIS
  // movement crossed from strictly-above to at-or-below (no re-emit).
  const crossings: ReorderCrossing[] = [];
  if (input.delta < 0) {
    const rps = await trx
      .selectFrom('inventory_reorder_points')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('variation_id', '=', input.variationId)
      .where('enabled', '=', 1)
      .execute();
    for (const rp of rps) {
      if (rp.location_id !== null && rp.location_id !== input.locationId) continue;
      const after =
        rp.location_id === null
          ? await sumOnHand(trx, tenantId, input.variationId)
          : level.on_hand;
      const before = after - input.delta; // delta < 0
      if (before > rp.reorder_point && after <= rp.reorder_point) {
        crossings.push({
          variationId: input.variationId,
          locationId: input.locationId,
          onHand: after,
          reorderPoint: rp.reorder_point,
        });
      }
    }
  }

  return { movement, level, oversold, deduped: false, crossings };
}

/** Emit stock.changed + any below_reorder_point events (call AFTER commit). */
async function emitMovementEvents(
  events: EventBus,
  tenantId: string,
  r: MovementTxResult,
): Promise<void> {
  if (r.deduped) return;
  await events.emit(tenantId, 'inventory.stock.changed', {
    v: 1,
    variationId: r.movement.variation_id,
    locationId: r.movement.location_id,
    delta: r.movement.delta,
    onHand: r.level.on_hand,
    movementId: r.movement.id,
    reason: r.movement.reason,
    ...(r.oversold ? { oversold: true } : {}),
  });
  for (const c of r.crossings) {
    await events.emit(tenantId, 'inventory.stock.below_reorder_point', {
      v: 1,
      variationId: c.variationId,
      locationId: c.locationId,
      onHand: c.onHand,
      reorderPoint: c.reorderPoint,
    });
  }
}

/** Public single write path: one movement in its own transaction. */
export async function applyMovement(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  input: ApplyMovementInput,
): Promise<ApplyMovementResult> {
  const r = await db.transaction().execute(async (trx) => {
    const res = await writeMovementTx(trx as unknown as Db, tenantId, actor, input);
    if (!res.deduped) {
      await audit(
        asCoreDb(trx),
        tenantId,
        actor,
        'inventory.movement.applied',
        'inventory.movement',
        res.movement.id,
        { reason: input.reason, delta: input.delta, locationId: input.locationId },
      );
    }
    return res;
  });
  await emitMovementEvents(events, tenantId, r);
  return {
    movement: r.movement,
    onHand: r.level.on_hand,
    reserved: r.level.reserved,
    available: r.level.on_hand - r.level.reserved,
    oversold: r.oversold,
    deduped: r.deduped,
  };
}

/** Correction of a mistake = a NEW compensating movement referencing the original. */
export async function correctMovement(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  originalMovementId: string,
  delta: number,
  note?: string | null,
): Promise<ApplyMovementResult> {
  const original = await db
    .selectFrom('inventory_movements')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', originalMovementId)
    .executeTakeFirst();
  if (!original) throw ApiError.notFound(`movement "${originalMovementId}" not found`);
  return applyMovement(db, events, tenantId, actor, {
    variationId: original.variation_id,
    locationId: original.location_id,
    delta,
    reason: 'correction',
    refType: 'correction_of',
    refId: originalMovementId,
    note: note ?? null,
  });
}

/* ================================================================== *
 * Locations CRUD
 * ================================================================== */

export interface CreateLocationInput {
  name: string;
  kind: LocationKind;
  showId?: string | null;
  oversellPolicy?: OversellPolicy;
}

export async function createLocation(
  db: Db,
  tenantId: string,
  actor: string,
  input: CreateLocationInput,
): Promise<InventoryLocationRow> {
  const now = nowIso();
  const row: InventoryLocationRow = {
    id: id(),
    tenant_id: tenantId,
    name: input.name,
    kind: input.kind,
    show_id: input.showId ?? null,
    oversell_policy: input.oversellPolicy ?? 'deny',
    archived: 0,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('inventory_locations').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'inventory.location.created', 'inventory.location', row.id, {
    name: row.name,
    kind: row.kind,
  });
  return row;
}

export async function listLocations(
  db: Db,
  tenantId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<InventoryLocationRow[]> {
  let q = db.selectFrom('inventory_locations').selectAll().where('tenant_id', '=', tenantId);
  if (!opts.includeArchived) q = q.where('archived', '=', 0);
  return q.orderBy('name').orderBy('id').execute();
}

export async function getLocation(
  db: Db,
  tenantId: string,
  locationId: string,
): Promise<InventoryLocationRow> {
  return requireLocation(db, tenantId, locationId);
}

export async function updateLocation(
  db: Db,
  tenantId: string,
  actor: string,
  locationId: string,
  patch: Partial<Pick<InventoryLocationRow, 'name' | 'kind' | 'show_id' | 'oversell_policy'>>,
): Promise<InventoryLocationRow> {
  await requireLocation(db, tenantId, locationId);
  const now = nowIso();
  await db
    .updateTable('inventory_locations')
    .set({ ...patch, updated_at: now })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', locationId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'inventory.location.updated', 'inventory.location', locationId, patch);
  return requireLocation(db, tenantId, locationId);
}

export async function archiveLocation(
  db: Db,
  tenantId: string,
  actor: string,
  locationId: string,
): Promise<InventoryLocationRow> {
  await requireLocation(db, tenantId, locationId);
  const now = nowIso();
  await db
    .updateTable('inventory_locations')
    .set({ archived: 1, updated_at: now })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', locationId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'inventory.location.archived', 'inventory.location', locationId);
  return requireLocation(db, tenantId, locationId);
}

/* ================================================================== *
 * Stock reads
 * ================================================================== */

export interface StockView {
  variationId: string;
  locationId: string;
  onHand: number;
  reserved: number;
  available: number;
  countedEver: boolean;
  lastMovementAt: string | null;
}

function toStockView(r: InventoryStockLevelRow): StockView {
  return {
    variationId: r.variation_id,
    locationId: r.location_id,
    onHand: r.on_hand,
    reserved: r.reserved,
    available: r.on_hand - r.reserved,
    countedEver: boolOf(r.counted_ever),
    lastMovementAt: r.last_movement_at,
  };
}

export async function getStock(
  db: Db,
  tenantId: string,
  filter: { variationId?: string; locationId?: string } = {},
): Promise<StockView[]> {
  let q = db.selectFrom('inventory_stock_levels').selectAll().where('tenant_id', '=', tenantId);
  if (filter.variationId) q = q.where('variation_id', '=', filter.variationId);
  if (filter.locationId) q = q.where('location_id', '=', filter.locationId);
  const rows = await q.orderBy('variation_id').orderBy('location_id').orderBy('id').execute();
  return rows.map(toStockView);
}

/** On-hand (+reserved/available) broken out by location for one variation. */
export async function onHandByLocation(
  db: Db,
  tenantId: string,
  variationId: string,
): Promise<StockView[]> {
  return getStock(db, tenantId, { variationId });
}

export interface MovementFilter {
  variationId?: string;
  locationId?: string;
  reason?: MovementReason;
}

export async function listMovements(
  db: Db,
  tenantId: string,
  filter: MovementFilter = {},
  page: Pagination = { limit: 50, offset: 0 },
): Promise<InventoryMovementRow[]> {
  let q = db.selectFrom('inventory_movements').selectAll().where('tenant_id', '=', tenantId);
  if (filter.variationId) q = q.where('variation_id', '=', filter.variationId);
  if (filter.locationId) q = q.where('location_id', '=', filter.locationId);
  if (filter.reason) q = q.where('reason', '=', filter.reason);
  return q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(page.limit).offset(page.offset).execute();
}

/* ================================================================== *
 * Reservations
 * ================================================================== */

export interface ReserveInput {
  variationId: string;
  locationId: string;
  qty: number;
  refType?: string | null;
  refId?: string | null;
  expiresAt?: string | null;
}

export interface ReserveResult {
  reservation: InventoryReservationRow;
  oversold: boolean;
  available: number;
}

/**
 * Atomic allocation. Reserve `qty` only when available (on_hand - reserved) >= qty.
 * Otherwise the location's oversell policy decides: deny → conflict; allow_flag →
 * reserve anyway with `oversold: true` (recorded on the reservation row and in
 * the emitted event payload).
 */
export async function reserve(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  input: ReserveInput,
): Promise<ReserveResult> {
  if (input.qty <= 0) throw ApiError.badRequest('reservation qty must be > 0');
  const out = await db.transaction().execute(async (trxRaw) => {
    const trx = trxRaw as unknown as Db;
    // A business reference makes reservation creation replay-safe. This is
    // critical for the POS/order event lane: the event can be delivered again
    // after a crash and must not reserve the same stock twice.
    if (input.refType && input.refId) {
      const prior = await trx
        .selectFrom('inventory_reservations')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('ref_type', '=', input.refType)
        .where('ref_id', '=', input.refId)
        .where('variation_id', '=', input.variationId)
        .where('location_id', '=', input.locationId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .executeTakeFirst();
      if (prior && (prior.status === 'active' || prior.status === 'converted')) {
        if (
          prior.variation_id !== input.variationId ||
          prior.location_id !== input.locationId ||
          prior.qty !== input.qty
        ) {
          throw ApiError.conflict(`reservation reference "${input.refType}:${input.refId}" was reused with different stock facts`);
        }
        const level = await loadLevel(trx, tenantId, prior.variation_id, prior.location_id);
        return {
          reservation: prior,
          oversold: prior.oversold === 1,
          available: (level?.on_hand ?? 0) - (level?.reserved ?? 0),
          mv: null as MovementTxResult | null,
        };
      }
    }
    const loc = await requireLocation(trx, tenantId, input.locationId);
    const level = await loadLevel(trx, tenantId, input.variationId, input.locationId);
    const available = (level?.on_hand ?? 0) - (level?.reserved ?? 0);
    let oversold = false;
    if (available < input.qty) {
      if (loc.oversell_policy === 'deny') {
        throw ApiError.conflict(
          `cannot reserve ${input.qty}: only ${available} available for variation "${input.variationId}" at location "${input.locationId}"`,
          { available, requested: input.qty },
        );
      }
      oversold = true; // allow_flag
    }
    const now = nowIso();
    const reservation: InventoryReservationRow = {
      id: id(),
      tenant_id: tenantId,
      variation_id: input.variationId,
      location_id: input.locationId,
      qty: input.qty,
      ref_type: input.refType ?? null,
      ref_id: input.refId ?? null,
      status: 'active',
      oversold: oversold ? 1 : 0,
      expires_at: input.expiresAt ?? null,
      created_at: now,
      updated_at: now,
    };
    await trx.insertInto('inventory_reservations').values(reservation).execute();
    // reserved movement: delta 0 on on_hand, +qty on the reserved column.
    const mv = await writeMovementTx(trx, tenantId, actor, {
      variationId: input.variationId,
      locationId: input.locationId,
      delta: 0,
      reason: 'reserved',
      refType: 'reservation',
      refId: reservation.id,
      reservedDelta: input.qty,
    });
    await audit(asCoreDb(trx), tenantId, actor, 'inventory.reservation.created', 'inventory.reservation', reservation.id, {
      qty: input.qty,
      oversold,
    });
    return { reservation, oversold, available: mv.level.on_hand - mv.level.reserved, mv };
  });
  if (out.mv) await emitMovementEvents(events, tenantId, out.mv);
  return {
    reservation: out.reservation,
    oversold: out.oversold,
    available: out.available,
  };
}

async function releaseReservationTx(
  trx: Db,
  tenantId: string,
  actor: string,
  reservation: InventoryReservationRow,
  newStatus: 'released' | 'expired' | 'converted',
): Promise<MovementTxResult> {
  const now = nowIso();
  await trx
    .updateTable('inventory_reservations')
    .set({ status: newStatus, updated_at: now })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', reservation.id)
    .execute();
  const mv = await writeMovementTx(trx, tenantId, actor, {
    variationId: reservation.variation_id,
    locationId: reservation.location_id,
    delta: 0,
    reason: 'released',
    refType: 'reservation',
    refId: reservation.id,
    reservedDelta: -reservation.qty,
  });
  await audit(asCoreDb(trx), tenantId, actor, 'inventory.reservation.released', 'inventory.reservation', reservation.id, {
    status: newStatus,
  });
  return mv;
}

export async function releaseReservation(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  reservationId: string,
): Promise<{ reservation: InventoryReservationRow; available: number }> {
  const out = await db.transaction().execute(async (trxRaw) => {
    const trx = trxRaw as unknown as Db;
    const reservation = await trx
      .selectFrom('inventory_reservations')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', reservationId)
      .executeTakeFirst();
    if (!reservation) throw ApiError.notFound(`reservation "${reservationId}" not found`);
    if (reservation.status !== 'active') {
      // Idempotent: already terminal, nothing to release.
      const level = await loadLevel(trx, tenantId, reservation.variation_id, reservation.location_id);
      return { reservation, available: (level?.on_hand ?? 0) - (level?.reserved ?? 0), mv: null as MovementTxResult | null };
    }
    const mv = await releaseReservationTx(trx, tenantId, actor, reservation, 'released');
    const updated = { ...reservation, status: 'released' as const };
    return { reservation: updated, available: mv.level.on_hand - mv.level.reserved, mv };
  });
  if (out.mv) await emitMovementEvents(events, tenantId, out.mv);
  return { reservation: out.reservation, available: out.available };
}

export interface SettleReservationsResult {
  refType: string;
  refId: string;
  disposition: 'released' | 'converted';
  settled: number;
  reservationIds: string[];
}

/**
 * Release or convert every ACTIVE reservation owned by one business reference.
 * The operation is atomic across the reference and replay-safe: a repeated call
 * sees no active rows and returns `settled: 0` without changing stock again.
 * `converted` is used when a reserved order becomes a completed sale;
 * `released` is used for cancellation/expiry-style abandonment.
 */
export async function settleReservationsForReference(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  refType: string,
  refId: string,
  disposition: 'released' | 'converted',
): Promise<SettleReservationsResult> {
  if (!refType.trim() || !refId.trim()) throw ApiError.badRequest('reservation reference is required');
  const out = await db.transaction().execute(async (trxRaw) => {
    const trx = trxRaw as unknown as Db;
    const rows = await trx
      .selectFrom('inventory_reservations')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('ref_type', '=', refType)
      .where('ref_id', '=', refId)
      .where('status', '=', 'active')
      .orderBy('id')
      .execute();
    const movements: MovementTxResult[] = [];
    for (const row of rows) {
      movements.push(await releaseReservationTx(trx, tenantId, actor, row, disposition));
    }
    return { rows, movements };
  });
  for (const movement of out.movements) await emitMovementEvents(events, tenantId, movement);
  return {
    refType,
    refId,
    disposition,
    settled: out.rows.length,
    reservationIds: out.rows.map((row) => row.id),
  };
}

/** Convert overdue active reservations → expired, releasing their reserved qty. */
export async function expireReservations(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  now: string,
): Promise<{ expired: number }> {
  const due = await db
    .selectFrom('inventory_reservations')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'active')
    .where('expires_at', 'is not', null)
    .where('expires_at', '<=', now)
    .orderBy('id')
    .execute();
  const emits: MovementTxResult[] = [];
  for (const reservation of due) {
    const mv = await db.transaction().execute(async (trxRaw) => {
      const trx = trxRaw as unknown as Db;
      // Re-read to stay safe against concurrent release.
      const fresh = await trx
        .selectFrom('inventory_reservations')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('id', '=', reservation.id)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (!fresh) return null;
      return releaseReservationTx(trx, tenantId, actor, fresh, 'expired');
    });
    if (mv) emits.push(mv);
  }
  for (const mv of emits) await emitMovementEvents(events, tenantId, mv);
  return { expired: emits.length };
}

export async function listReservations(
  db: Db,
  tenantId: string,
  filter: { status?: InventoryReservationRow['status']; variationId?: string } = {},
): Promise<InventoryReservationRow[]> {
  let q = db.selectFrom('inventory_reservations').selectAll().where('tenant_id', '=', tenantId);
  if (filter.status) q = q.where('status', '=', filter.status);
  if (filter.variationId) q = q.where('variation_id', '=', filter.variationId);
  return q.orderBy('created_at', 'desc').orderBy('id').execute();
}

/* ================================================================== *
 * sellForOrder — replay-safe sale reconciliation
 * ================================================================== */

export interface SellLine {
  variationId: string;
  qty: number;
  locationId: string;
}

export interface SellForOrderInput {
  orderId: string;
  lines: SellLine[];
  idempotencyKey: string;
}

export interface SellLineResult {
  variationId: string;
  locationId: string;
  movementId: string;
  onHand: number;
  oversold: boolean;
}

export interface SellForOrderResult {
  orderId: string;
  replayed: boolean;
  lines: SellLineResult[];
}

/**
 * Reconcile a completed sale to inventory. Replay-safe: the same
 * `idempotencyKey` returns the prior result and performs NO second decrement.
 */
export async function sellForOrder(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  input: SellForOrderInput,
): Promise<SellForOrderResult> {
  const { orderId, lines, idempotencyKey } = input;
  if (!idempotencyKey) throw ApiError.badRequest('idempotencyKey is required');

  const out = await db.transaction().execute(async (trxRaw) => {
    const trx = trxRaw as unknown as Db;
    const prior = await trx
      .selectFrom('inventory_idempotency')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('key', '=', idempotencyKey)
      .executeTakeFirst();
    if (prior) {
      return {
        result: JSON.parse(prior.result_json) as SellForOrderResult,
        mvs: [] as MovementTxResult[],
        replayed: true,
      };
    }

    const mvs: MovementTxResult[] = [];
    // If the order was reserved first, convert every reservation inside this
    // SAME inventory transaction before applying the sale movements. Without
    // this, on_hand and reserved both stay reduced after payment and available
    // stock is understated twice.
    const activeReservations = await trx
      .selectFrom('inventory_reservations')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('ref_type', '=', 'order')
      .where('ref_id', '=', orderId)
      .where('status', '=', 'active')
      .orderBy('id')
      .execute();
    for (const reservation of activeReservations) {
      mvs.push(await releaseReservationTx(trx, tenantId, actor, reservation, 'converted'));
    }

    const lineResults: SellLineResult[] = [];
    let i = 0;
    for (const line of lines) {
      const mv = await writeMovementTx(trx, tenantId, actor, {
        variationId: line.variationId,
        locationId: line.locationId,
        delta: -Math.abs(line.qty),
        reason: 'sold',
        refType: 'order',
        refId: orderId,
        idempotencyKey: `${idempotencyKey}:${i}`,
      });
      mvs.push(mv);
      lineResults.push({
        variationId: line.variationId,
        locationId: line.locationId,
        movementId: mv.movement.id,
        onHand: mv.level.on_hand,
        oversold: mv.oversold,
      });
      i += 1;
    }

    const result: SellForOrderResult = { orderId, replayed: false, lines: lineResults };
    await trx
      .insertInto('inventory_idempotency')
      .values({
        id: id(),
        tenant_id: tenantId,
        key: idempotencyKey,
        scope: 'sell_for_order',
        result_json: JSON.stringify(result),
        created_at: nowIso(),
      })
      .execute();
    await audit(asCoreDb(trx), tenantId, actor, 'inventory.order.sold', 'inventory.order', orderId, {
      lines: lines.length,
    });
    return { result, mvs, replayed: false };
  });

  if (out.replayed) return { ...out.result, replayed: true };
  for (const mv of out.mvs) await emitMovementEvents(events, tenantId, mv);
  return out.result;
}

/* ================================================================== *
 * Count sessions
 * ================================================================== */

export interface OpenCountSessionInput {
  locationId: string;
  kind: CountSessionKind;
  blind?: boolean;
  assignedTo?: string | null;
  recountThreshold?: number;
}

export async function openCountSession(
  db: Db,
  tenantId: string,
  actor: string,
  input: OpenCountSessionInput,
): Promise<InventoryCountSessionRow> {
  await requireLocation(db, tenantId, input.locationId);
  const now = nowIso();
  const row: InventoryCountSessionRow = {
    id: id(),
    tenant_id: tenantId,
    location_id: input.locationId,
    kind: input.kind,
    blind: input.blind ? 1 : 0,
    status: 'open',
    assigned_to: input.assignedTo ?? null,
    recount_threshold: input.recountThreshold ?? 0,
    signed_by: null,
    signed_at: null,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('inventory_count_sessions').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'inventory.count_session.opened', 'inventory.count_session', row.id, {
    kind: row.kind,
    blind: input.blind ?? false,
  });
  return row;
}

async function requireSession(
  db: Db,
  tenantId: string,
  sessionId: string,
): Promise<InventoryCountSessionRow> {
  const s = await db
    .selectFrom('inventory_count_sessions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', sessionId)
    .executeTakeFirst();
  if (!s) throw ApiError.notFound(`count session "${sessionId}" not found`);
  return s;
}

// Acquire a write lock on the session before inspecting or changing its lines.
// The conditional UPDATE is the shared serialization boundary for edits and
// closure (SQLite write lock; row lock on a row-locking database).
async function lockMutableCountSession(
  db: Db, tenantId: string, sessionId: string,
  statuses: InventoryCountSessionRow['status'][] = ['open', 'paused', 'review'],
): Promise<InventoryCountSessionRow> {
  const row = await db.updateTable('inventory_count_sessions')
    .set((eb) => ({ updated_at: eb.ref('updated_at') }))
    .where('tenant_id', '=', tenantId).where('id', '=', sessionId)
    .where('status', 'in', statuses).returningAll().executeTakeFirst();
  if (row) return row;
  const session = await requireSession(db, tenantId, sessionId);
  throw ApiError.conflict(`count session in status "${session.status}" is not mutable`);
}

async function countTransaction<T>(db: Db, run: (trx: Db) => Promise<T>): Promise<T> {
  if (db.isTransaction) return run(db);
  return db.transaction().execute((trx) => run(trx as unknown as Db));
}

export async function getCountSession(
  db: Db,
  tenantId: string,
  sessionId: string,
): Promise<InventoryCountSessionRow> {
  return requireSession(db, tenantId, sessionId);
}

/** Add a count line, snapshotting expected_qty from current on_hand. */
export async function addCountLine(
  db: Db,
  tenantId: string,
  actor: string,
  sessionId: string,
  variationId: string,
): Promise<InventoryCountLineRow> {
  return countTransaction(db, async (trx) => {
    const session = await lockMutableCountSession(trx, tenantId, sessionId, ['open', 'paused']);
    const level = await loadLevel(trx, tenantId, variationId, session.location_id);
    const now = nowIso();
    const row: InventoryCountLineRow = {
      id: id(),
      tenant_id: tenantId,
      session_id: sessionId,
      variation_id: variationId,
      expected_qty: level?.on_hand ?? 0,
      counted_qty: null,
      variance: null,
      recount_required: 0,
      recount_qty: null,
      approved: 0,
      created_at: now,
      updated_at: now,
    };
    await trx.insertInto('inventory_count_lines').values(row).execute();
    return row;
  });
}

async function requireLine(
  db: Db,
  tenantId: string,
  sessionId: string,
  lineId: string,
): Promise<InventoryCountLineRow> {
  const l = await db
    .selectFrom('inventory_count_lines')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('session_id', '=', sessionId)
    .where('id', '=', lineId)
    .executeTakeFirst();
  if (!l) throw ApiError.notFound(`count line "${lineId}" not found`);
  return l;
}

/** Apply the complete HTTP patch under one session lock and transaction. */
export async function patchCountLine(
  db: Db, tenantId: string, actor: string, sessionId: string, lineId: string,
  patch: { countedQty?: number; recountQty?: number; approved?: boolean },
): Promise<InventoryCountLineRow> {
  if (patch.countedQty === undefined && patch.recountQty === undefined && patch.approved !== true) {
    throw ApiError.badRequest('no line change provided');
  }
  for (const qty of [patch.countedQty, patch.recountQty]) {
    if (qty !== undefined && !Number.isInteger(qty)) throw ApiError.badRequest('count quantities must be integers');
  }
  return countTransaction(db, async (trx) => {
    const session = await lockMutableCountSession(trx, tenantId, sessionId);
    const line = await requireLine(trx, tenantId, sessionId, lineId);
    const update: Partial<InventoryCountLineRow> = { updated_at: nowIso() };
    if (patch.countedQty !== undefined) {
      const variance = patch.countedQty - line.expected_qty;
      Object.assign(update, { counted_qty: patch.countedQty, variance,
        recount_required: Math.abs(variance) > session.recount_threshold ? 1 : 0 });
    }
    if (patch.recountQty !== undefined) {
      Object.assign(update, { recount_qty: patch.recountQty, variance: patch.recountQty - line.expected_qty });
    }
    if (patch.approved === true) update.approved = 1;
    await trx.updateTable('inventory_count_lines').set(update)
      .where('tenant_id', '=', tenantId).where('session_id', '=', sessionId)
      .where('id', '=', lineId).execute();
    return requireLine(trx, tenantId, sessionId, lineId);
  });
}

/** Record a counted quantity; sets variance and recount_required per threshold. */
export async function recordCount(
  db: Db, tenantId: string, actor: string, sessionId: string, lineId: string, countedQty: number,
): Promise<InventoryCountLineRow> {
  return patchCountLine(db, tenantId, actor, sessionId, lineId, { countedQty });
}

/** Provide a recount value for a line flagged recount_required. */
export async function recordRecount(
  db: Db, tenantId: string, actor: string, sessionId: string, lineId: string, recountQty: number,
): Promise<InventoryCountLineRow> {
  return patchCountLine(db, tenantId, actor, sessionId, lineId, { recountQty });
}

export async function approveCountLine(
  db: Db, tenantId: string, actor: string, sessionId: string, lineId: string,
): Promise<InventoryCountLineRow> {
  return patchCountLine(db, tenantId, actor, sessionId, lineId, { approved: true });
}

export async function setCountSessionStatus(
  db: Db, tenantId: string, actor: string, sessionId: string,
  status: 'paused' | 'open' | 'review' | 'abandoned',
): Promise<InventoryCountSessionRow> {
  return countTransaction(db, async (trx) => {
    await lockMutableCountSession(trx, tenantId, sessionId, ['open', 'paused', 'review', 'abandoned']);
    await trx.updateTable('inventory_count_sessions').set({ status, updated_at: nowIso() })
      .where('tenant_id', '=', tenantId).where('id', '=', sessionId).execute();
    return requireSession(trx, tenantId, sessionId);
  });
}

export interface CountLineView extends Omit<InventoryCountLineRow, 'expected_qty'> {
  /** Hidden (null) while the session is blind and not yet in review/closed. */
  expected_qty: number | null;
}

/** List lines, hiding expected_qty for blind sessions until review/closed. */
export async function listCountLines(
  db: Db,
  tenantId: string,
  sessionId: string,
): Promise<CountLineView[]> {
  const session = await requireSession(db, tenantId, sessionId);
  const rows = await db
    .selectFrom('inventory_count_lines')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('session_id', '=', sessionId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const reveal = !boolOf(session.blind) || session.status === 'review' || session.status === 'closed';
  return rows.map((r) => ({ ...r, expected_qty: reveal ? r.expected_qty : null }));
}

/**
 * Close a count session. Requires signed_by; every variance line must be either
 * approved or recounted. Writes a `counted` movement for each line (delta =
 * counted - expected) atomically and emits `inventory.count.completed`.
 */
export async function closeCountSession(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  sessionId: string,
  signedBy: string,
): Promise<{ session: InventoryCountSessionRow; movementsWritten: number }> {
  if (!signedBy) throw ApiError.badRequest('signed_by is required to close a count session');

  const out = await db.transaction().execute(async (trxRaw) => {
    const trx = trxRaw as unknown as Db;
    const session = await lockMutableCountSession(trx, tenantId, sessionId);
    const lines = await trx
      .selectFrom('inventory_count_lines')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('session_id', '=', sessionId)
      .orderBy('id')
      .execute();

    for (const line of lines) {
      if (line.counted_qty === null) {
        throw ApiError.conflict(`count line "${line.id}" has no counted quantity`);
      }
      // Only lines whose variance exceeded the recount threshold gate the close;
      // they must be recounted or explicitly approved.
      if (line.recount_required === 1 && line.approved !== 1 && line.recount_qty === null) {
        throw ApiError.conflict(
          `variance line "${line.id}" must be approved or recounted before close`,
          { variance: (line.recount_qty ?? line.counted_qty)! - line.expected_qty },
        );
      }
    }

    const mvs: MovementTxResult[] = [];
    for (const line of lines) {
      const finalQty = line.recount_qty ?? line.counted_qty!;
      const delta = finalQty - line.expected_qty;
      const mv = await writeMovementTx(trx, tenantId, actor, {
        variationId: line.variation_id,
        locationId: session.location_id,
        delta,
        reason: 'counted',
        refType: 'count_session',
        refId: sessionId,
        markCounted: true,
      });
      mvs.push(mv);
    }

    const now = nowIso();
    await trx
      .updateTable('inventory_count_sessions')
      .set({ status: 'closed', signed_by: signedBy, signed_at: now, updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', sessionId)
      .execute();
    await audit(asCoreDb(trx), tenantId, actor, 'inventory.count_session.closed', 'inventory.count_session', sessionId, {
      signedBy,
      lines: lines.length,
    });
    const updated: InventoryCountSessionRow = {
      ...session,
      status: 'closed',
      signed_by: signedBy,
      signed_at: now,
      updated_at: now,
    };
    return { session: updated, mvs };
  });

  for (const mv of out.mvs) await emitMovementEvents(events, tenantId, mv);
  await events.emit(tenantId, 'inventory.count.completed', {
    v: 1,
    countSessionId: sessionId,
    locationId: out.session.location_id,
  });
  return { session: out.session, movementsWritten: out.mvs.length };
}

/* ================================================================== *
 * Transfers
 * ================================================================== */

export interface TransferLineInput {
  variationId: string;
  qtySent: number;
}

export async function createTransfer(
  db: Db,
  tenantId: string,
  actor: string,
  fromLocationId: string,
  toLocationId: string,
  lines: TransferLineInput[],
): Promise<{ transfer: InventoryTransferRow; lines: InventoryTransferLineRow[] }> {
  if (fromLocationId === toLocationId) throw ApiError.badRequest('from and to locations must differ');
  await requireLocation(db, tenantId, fromLocationId);
  await requireLocation(db, tenantId, toLocationId);
  if (lines.length === 0) throw ApiError.badRequest('transfer requires at least one line');

  const now = nowIso();
  const transfer: InventoryTransferRow = {
    id: id(),
    tenant_id: tenantId,
    from_location_id: fromLocationId,
    to_location_id: toLocationId,
    status: 'draft',
    reason: null,
    created_at: now,
    updated_at: now,
  };
  const lineRows: InventoryTransferLineRow[] = lines.map((l) => ({
    id: id(),
    tenant_id: tenantId,
    transfer_id: transfer.id,
    variation_id: l.variationId,
    qty_sent: l.qtySent,
    qty_received: null,
    created_at: now,
    updated_at: now,
  }));
  await db.transaction().execute(async (trxRaw) => {
    const trx = trxRaw as unknown as Db;
    await trx.insertInto('inventory_transfers').values(transfer).execute();
    await trx.insertInto('inventory_transfer_lines').values(lineRows).execute();
    await audit(asCoreDb(trx), tenantId, actor, 'inventory.transfer.created', 'inventory.transfer', transfer.id, {
      from: fromLocationId,
      to: toLocationId,
      lines: lineRows.length,
    });
  });
  return { transfer, lines: lineRows };
}

async function requireTransfer(db: Db, tenantId: string, transferId: string): Promise<InventoryTransferRow> {
  const t = await db
    .selectFrom('inventory_transfers')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', transferId)
    .executeTakeFirst();
  if (!t) throw ApiError.notFound(`transfer "${transferId}" not found`);
  return t;
}

export async function getTransfer(
  db: Db,
  tenantId: string,
  transferId: string,
): Promise<{ transfer: InventoryTransferRow; lines: InventoryTransferLineRow[] }> {
  const transfer = await requireTransfer(db, tenantId, transferId);
  const lines = await db
    .selectFrom('inventory_transfer_lines')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('transfer_id', '=', transferId)
    .orderBy('id')
    .execute();
  return { transfer, lines };
}

/** Ship: transfer_out movements from the source location; status → in_transit. */
export async function shipTransfer(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  transferId: string,
): Promise<InventoryTransferRow> {
  const out = await db.transaction().execute(async (trxRaw) => {
    const trx = trxRaw as unknown as Db;
    const transfer = await requireTransfer(trx, tenantId, transferId);
    if (transfer.status !== 'draft') throw ApiError.conflict(`cannot ship transfer in status "${transfer.status}"`);
    const lines = await trx
      .selectFrom('inventory_transfer_lines')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('transfer_id', '=', transferId)
      .orderBy('id')
      .execute();
    const mvs: MovementTxResult[] = [];
    for (const line of lines) {
      const mv = await writeMovementTx(trx, tenantId, actor, {
        variationId: line.variation_id,
        locationId: transfer.from_location_id,
        delta: -Math.abs(line.qty_sent),
        reason: 'transfer_out',
        refType: 'transfer',
        refId: transferId,
      });
      mvs.push(mv);
    }
    const now = nowIso();
    await trx
      .updateTable('inventory_transfers')
      .set({ status: 'in_transit', updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', transferId)
      .execute();
    await audit(asCoreDb(trx), tenantId, actor, 'inventory.transfer.shipped', 'inventory.transfer', transferId);
    return { transfer: { ...transfer, status: 'in_transit' as const }, mvs };
  });
  for (const mv of out.mvs) await emitMovementEvents(events, tenantId, mv);
  return out.transfer;
}

export interface ReceiveLineInput {
  lineId: string;
  qtyReceived: number;
}

/** Receive: transfer_in movements to the destination for qty_received; status → received. */
export async function receiveTransfer(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  transferId: string,
  receipts: ReceiveLineInput[],
): Promise<InventoryTransferRow> {
  const byLine = new Map(receipts.map((r) => [r.lineId, r.qtyReceived]));
  const out = await db.transaction().execute(async (trxRaw) => {
    const trx = trxRaw as unknown as Db;
    const transfer = await requireTransfer(trx, tenantId, transferId);
    if (transfer.status !== 'in_transit') {
      throw ApiError.conflict(`cannot receive transfer in status "${transfer.status}"`);
    }
    const lines = await trx
      .selectFrom('inventory_transfer_lines')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('transfer_id', '=', transferId)
      .orderBy('id')
      .execute();
    const mvs: MovementTxResult[] = [];
    const now = nowIso();
    for (const line of lines) {
      const qtyReceived = byLine.get(line.id) ?? 0;
      await trx
        .updateTable('inventory_transfer_lines')
        .set({ qty_received: qtyReceived, updated_at: now })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', line.id)
        .execute();
      if (qtyReceived > 0) {
        const mv = await writeMovementTx(trx, tenantId, actor, {
          variationId: line.variation_id,
          locationId: transfer.to_location_id,
          delta: Math.abs(qtyReceived),
          reason: 'transfer_in',
          refType: 'transfer',
          refId: transferId,
        });
        mvs.push(mv);
      }
    }
    await trx
      .updateTable('inventory_transfers')
      .set({ status: 'received', updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', transferId)
      .execute();
    await audit(asCoreDb(trx), tenantId, actor, 'inventory.transfer.received', 'inventory.transfer', transferId);
    return { transfer: { ...transfer, status: 'received' as const }, mvs };
  });
  for (const mv of out.mvs) await emitMovementEvents(events, tenantId, mv);
  return out.transfer;
}

/**
 * Close a transfer. Lines whose qty_received != qty_sent are discrepancies; when
 * any exist the transfer closes to status 'discrepancy' (still a terminal close)
 * and records the reason. Emits `inventory.transfer.closed` with discrepancyCount.
 */
export async function closeTransfer(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  transferId: string,
  reason?: string | null,
): Promise<{ transfer: InventoryTransferRow; discrepancyCount: number }> {
  const out = await db.transaction().execute(async (trxRaw) => {
    const trx = trxRaw as unknown as Db;
    const transfer = await requireTransfer(trx, tenantId, transferId);
    if (transfer.status !== 'received') {
      throw ApiError.conflict(`cannot close transfer in status "${transfer.status}"`);
    }
    const lines = await trx
      .selectFrom('inventory_transfer_lines')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('transfer_id', '=', transferId)
      .execute();
    let discrepancyCount = 0;
    for (const line of lines) {
      if ((line.qty_received ?? 0) !== line.qty_sent) discrepancyCount += 1;
    }
    const status: TransferStatus = discrepancyCount > 0 ? 'discrepancy' : 'closed';
    const now = nowIso();
    await trx
      .updateTable('inventory_transfers')
      .set({ status, reason: reason ?? null, updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', transferId)
      .execute();
    await audit(asCoreDb(trx), tenantId, actor, 'inventory.transfer.closed', 'inventory.transfer', transferId, {
      discrepancyCount,
      status,
    });
    return { transfer: { ...transfer, status, reason: reason ?? null }, discrepancyCount };
  });
  await events.emit(tenantId, 'inventory.transfer.closed', {
    v: 1,
    transferId,
    fromLocationId: out.transfer.from_location_id,
    toLocationId: out.transfer.to_location_id,
    discrepancyCount: out.discrepancyCount,
  });
  return out;
}

/* ================================================================== *
 * Kits
 * ================================================================== */

export interface KitComponentLine {
  variationId: string;
  qtyPer: number;
}

/** Consume components (negative) and produce the kit (positive), atomically. */
export async function assembleKit(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  kitVariationId: string,
  componentLines: KitComponentLine[],
  qty: number,
  locationId: string,
): Promise<{ movements: number }> {
  return kitOp(db, events, tenantId, actor, kitVariationId, componentLines, qty, locationId, 'assemble');
}

/** Inverse of assembleKit. */
export async function disassembleKit(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  kitVariationId: string,
  componentLines: KitComponentLine[],
  qty: number,
  locationId: string,
): Promise<{ movements: number }> {
  return kitOp(db, events, tenantId, actor, kitVariationId, componentLines, qty, locationId, 'disassemble');
}

async function kitOp(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  kitVariationId: string,
  componentLines: KitComponentLine[],
  qty: number,
  locationId: string,
  mode: 'assemble' | 'disassemble',
): Promise<{ movements: number }> {
  if (qty <= 0) throw ApiError.badRequest('kit qty must be > 0');
  const reason: MovementReason = mode === 'assemble' ? 'kit_assembled' : 'kit_disassembled';
  const kitSign = mode === 'assemble' ? 1 : -1;
  const out = await db.transaction().execute(async (trxRaw) => {
    const trx = trxRaw as unknown as Db;
    await requireLocation(trx, tenantId, locationId);
    const mvs: MovementTxResult[] = [];
    for (const comp of componentLines) {
      const mv = await writeMovementTx(trx, tenantId, actor, {
        variationId: comp.variationId,
        locationId,
        delta: -kitSign * Math.abs(comp.qtyPer) * qty,
        reason,
        refType: 'kit',
        refId: kitVariationId,
      });
      mvs.push(mv);
    }
    const kitMv = await writeMovementTx(trx, tenantId, actor, {
      variationId: kitVariationId,
      locationId,
      delta: kitSign * qty,
      reason,
      refType: 'kit',
      refId: kitVariationId,
    });
    mvs.push(kitMv);
    await audit(asCoreDb(trx), tenantId, actor, `inventory.kit.${mode}d`, 'inventory.kit', kitVariationId, {
      qty,
      components: componentLines.length,
    });
    return mvs;
  });
  for (const mv of out) await emitMovementEvents(events, tenantId, mv);
  return { movements: out.length };
}

/* ================================================================== *
 * Reorder points CRUD
 * ================================================================== */

export interface ReorderPointInput {
  variationId: string;
  locationId?: string | null;
  reorderPoint: number;
  safetyStock?: number;
  enabled?: boolean;
}

export async function createReorderPoint(
  db: Db,
  tenantId: string,
  actor: string,
  input: ReorderPointInput,
): Promise<InventoryReorderPointRow> {
  const now = nowIso();
  const row: InventoryReorderPointRow = {
    id: id(),
    tenant_id: tenantId,
    variation_id: input.variationId,
    location_id: input.locationId ?? null,
    reorder_point: input.reorderPoint,
    safety_stock: input.safetyStock ?? 0,
    enabled: input.enabled === false ? 0 : 1,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('inventory_reorder_points').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'inventory.reorder_point.created', 'inventory.reorder_point', row.id, {
    variationId: input.variationId,
    reorderPoint: input.reorderPoint,
  });
  return row;
}

export async function listReorderPoints(
  db: Db,
  tenantId: string,
  filter: { variationId?: string } = {},
): Promise<InventoryReorderPointRow[]> {
  let q = db.selectFrom('inventory_reorder_points').selectAll().where('tenant_id', '=', tenantId);
  if (filter.variationId) q = q.where('variation_id', '=', filter.variationId);
  return q.orderBy('variation_id').orderBy('id').execute();
}

export async function updateReorderPoint(
  db: Db,
  tenantId: string,
  actor: string,
  reorderPointId: string,
  patch: { reorderPoint?: number; safetyStock?: number; enabled?: boolean },
): Promise<InventoryReorderPointRow> {
  const existing = await db
    .selectFrom('inventory_reorder_points')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', reorderPointId)
    .executeTakeFirst();
  if (!existing) throw ApiError.notFound(`reorder point "${reorderPointId}" not found`);
  const now = nowIso();
  const set: Partial<InventoryReorderPointRow> = { updated_at: now };
  if (patch.reorderPoint !== undefined) set.reorder_point = patch.reorderPoint;
  if (patch.safetyStock !== undefined) set.safety_stock = patch.safetyStock;
  if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0;
  await db
    .updateTable('inventory_reorder_points')
    .set(set)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', reorderPointId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'inventory.reorder_point.updated', 'inventory.reorder_point', reorderPointId, patch);
  return (await db
    .selectFrom('inventory_reorder_points')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', reorderPointId)
    .executeTakeFirst())!;
}

export async function deleteReorderPoint(
  db: Db,
  tenantId: string,
  actor: string,
  reorderPointId: string,
): Promise<void> {
  const existing = await db
    .selectFrom('inventory_reorder_points')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', reorderPointId)
    .executeTakeFirst();
  if (!existing) throw ApiError.notFound(`reorder point "${reorderPointId}" not found`);
  await db
    .deleteFrom('inventory_reorder_points')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', reorderPointId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'inventory.reorder_point.deleted', 'inventory.reorder_point', reorderPointId);
}

/* ================================================================== *
 * Analytics
 * ================================================================== */

export interface AgingRow {
  variationId: string;
  locationId: string;
  onHand: number;
  lastPositiveAt: string | null;
  daysSinceLastPositive: number | null;
}

/** Stock aging: days since last positive (stock-adding) movement per key. */
export async function stockAging(
  db: Db,
  tenantId: string,
  now: string = nowIso(),
): Promise<AgingRow[]> {
  const levels = await db
    .selectFrom('inventory_stock_levels')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('variation_id')
    .orderBy('location_id')
    .orderBy('id')
    .execute();
  const nowDt = DateTime.fromISO(now, { zone: 'utc' });
  const out: AgingRow[] = [];
  for (const lv of levels) {
    const lastPos = await db
      .selectFrom('inventory_movements')
      .select((eb) => eb.fn.max('created_at').as('at'))
      .where('tenant_id', '=', tenantId)
      .where('variation_id', '=', lv.variation_id)
      .where('location_id', '=', lv.location_id)
      .where('delta', '>', 0)
      .executeTakeFirst();
    const at = (lastPos?.at as string | null) ?? null;
    const days = at ? Math.floor(nowDt.diff(DateTime.fromISO(at, { zone: 'utc' }), 'days').days) : null;
    out.push({
      variationId: lv.variation_id,
      locationId: lv.location_id,
      onHand: lv.on_hand,
      lastPositiveAt: at,
      daysSinceLastPositive: days,
    });
  }
  return out;
}

export interface VelocityResult {
  variationId: string;
  windowDays: number;
  unitsSold: number;
  unitsPerWeek: number;
}

/** Velocity: units sold per week over a window, from `sold` movements. */
export async function velocity(
  db: Db,
  tenantId: string,
  variationId: string,
  windowDays: number,
  now: string = nowIso(),
): Promise<VelocityResult> {
  const since = DateTime.fromISO(now, { zone: 'utc' }).minus({ days: windowDays }).toISO()!;
  const row = await db
    .selectFrom('inventory_movements')
    .select((eb) => eb.fn.sum<number>('delta').as('sum'))
    .where('tenant_id', '=', tenantId)
    .where('variation_id', '=', variationId)
    .where('reason', '=', 'sold')
    .where('created_at', '>=', since)
    .executeTakeFirst();
  const unitsSold = -Number(row?.sum ?? 0) || 0; // sold deltas are negative; `|| 0` kills -0
  const weeks = windowDays / 7;
  const unitsPerWeek = weeks > 0 ? unitsSold / weeks : 0;
  return { variationId, windowDays, unitsSold, unitsPerWeek };
}

export interface DaysOfSupplyResult {
  variationId: string;
  onHand: number;
  unitsPerWeek: number;
  /** on_hand / weekly velocity. HONEST null when velocity is 0 (never Infinity). */
  daysOfSupply: number | null;
}

export async function daysOfSupply(
  db: Db,
  tenantId: string,
  variationId: string,
  windowDays: number,
  now: string = nowIso(),
): Promise<DaysOfSupplyResult> {
  const v = await velocity(db, tenantId, variationId, windowDays, now);
  const onHand = await sumOnHand(db, tenantId, variationId);
  const daysOfSupplyVal = v.unitsPerWeek > 0 ? (onHand / v.unitsPerWeek) * 7 : null;
  return { variationId, onHand, unitsPerWeek: v.unitsPerWeek, daysOfSupply: daysOfSupplyVal };
}

export interface StockoutRow {
  variationId: string;
  locationId: string;
  onHand: number;
}

/** Stockouts: counted at least once (counted_ever=1) AND on_hand <= 0. */
export async function stockoutList(db: Db, tenantId: string): Promise<StockoutRow[]> {
  const rows = await db
    .selectFrom('inventory_stock_levels')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('counted_ever', '=', 1)
    .where('on_hand', '<=', 0)
    .orderBy('variation_id')
    .orderBy('location_id')
    .orderBy('id')
    .execute();
  return rows.map((r) => ({ variationId: r.variation_id, locationId: r.location_id, onHand: r.on_hand }));
}

export interface ShrinkSummary {
  damagedUnits: number;
  shrinkUnits: number;
  totalUnits: number;
}

/** Shrink summary: |delta| totals for damaged + shrink movements over an optional range. */
export async function shrinkSummary(
  db: Db,
  tenantId: string,
  range: { from?: string; to?: string } = {},
): Promise<ShrinkSummary> {
  let q = db
    .selectFrom('inventory_movements')
    .select(['reason', (eb) => eb.fn.sum<number>('delta').as('sum')])
    .where('tenant_id', '=', tenantId)
    .where('reason', 'in', ['damaged', 'shrink'])
    .groupBy('reason');
  if (range.from) q = q.where('created_at', '>=', range.from);
  if (range.to) q = q.where('created_at', '<=', range.to);
  const rows = await q.execute();
  let damaged = 0;
  let shrink = 0;
  for (const r of rows) {
    const units = Math.abs(Number(r.sum ?? 0));
    if (r.reason === 'damaged') damaged = units;
    else if (r.reason === 'shrink') shrink = units;
  }
  return { damagedUnits: damaged, shrinkUnits: shrink, totalUnits: damaged + shrink };
}

/* ================================================================== *
 * Conservation verification — the iron invariant
 * ================================================================== */

export interface ConservationDrift {
  variationId: string;
  locationId: string;
  cachedOnHand: number;
  ledgerOnHand: number;
  cachedReserved: number;
  activeReserved: number;
}

export interface ConservationReport {
  ok: boolean;
  checked: number;
  drift: ConservationDrift[];
}

/**
 * Recompute on_hand from the movement ledger (SUM(delta)) and reserved from
 * active reservations, comparing both against the cache. Reports any drift.
 */
export async function verifyConservation(db: Db, tenantId: string): Promise<ConservationReport> {
  const ledger = await db
    .selectFrom('inventory_movements')
    .select(['variation_id', 'location_id', (eb) => eb.fn.sum<number>('delta').as('sum')])
    .where('tenant_id', '=', tenantId)
    .groupBy(['variation_id', 'location_id'])
    .execute();
  const ledgerMap = new Map<string, number>();
  for (const r of ledger) ledgerMap.set(`${r.variation_id}\u0000${r.location_id}`, Number(r.sum ?? 0));

  const reservedRows = await db
    .selectFrom('inventory_reservations')
    .select(['variation_id', 'location_id', (eb) => eb.fn.sum<number>('qty').as('sum')])
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'active')
    .groupBy(['variation_id', 'location_id'])
    .execute();
  const reservedMap = new Map<string, number>();
  for (const r of reservedRows) reservedMap.set(`${r.variation_id}\u0000${r.location_id}`, Number(r.sum ?? 0));

  const levels = await db
    .selectFrom('inventory_stock_levels')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .execute();

  const drift: ConservationDrift[] = [];
  const seen = new Set<string>();
  for (const lv of levels) {
    const key = `${lv.variation_id}\u0000${lv.location_id}`;
    seen.add(key);
    const ledgerOnHand = ledgerMap.get(key) ?? 0;
    const activeReserved = reservedMap.get(key) ?? 0;
    if (lv.on_hand !== ledgerOnHand || lv.reserved !== activeReserved) {
      drift.push({
        variationId: lv.variation_id,
        locationId: lv.location_id,
        cachedOnHand: lv.on_hand,
        ledgerOnHand,
        cachedReserved: lv.reserved,
        activeReserved,
      });
    }
  }
  // Ledger keys with no cache row are also drift.
  for (const [key, ledgerOnHand] of ledgerMap) {
    if (!seen.has(key) && ledgerOnHand !== 0) {
      const [variationId, locationId] = key.split('\u0000');
      drift.push({
        variationId,
        locationId,
        cachedOnHand: 0,
        ledgerOnHand,
        cachedReserved: 0,
        activeReserved: reservedMap.get(key) ?? 0,
      });
    }
  }

  return { ok: drift.length === 0, checked: levels.length, drift };
}
