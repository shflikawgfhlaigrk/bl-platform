import { describe, expect, it } from 'vitest';
import {
  applyMovement,
  createLocation,
  expireReservations,
  getStock,
  releaseReservation,
  reserve,
  settleReservationsForReference,
  sellForOrder,
  verifyConservation,
} from '../src/service';
import { capture, setup } from './helpers';

async function seed(qty = 10) {
  const s = await setup();
  const loc = await createLocation(s.db, s.tenantA.id, 'system', {
    name: 'WH',
    kind: 'warehouse',
    oversellPolicy: 'deny',
  });
  await applyMovement(s.db, s.events, s.tenantA.id, 'u1', {
    variationId: 'v1',
    locationId: loc.id,
    delta: qty,
    reason: 'received',
  });
  return { ...s, loc };
}

describe('reservations', () => {
  it('atomic allocation: reserve reduces available (on_hand - reserved), not on_hand', async () => {
    const { db, events, tenantA, loc } = await seed(10);
    const r = await reserve(db, events, tenantA.id, 'u1', {
      variationId: 'v1',
      locationId: loc.id,
      qty: 4,
      refType: 'order',
      refId: 'ord_1',
    });
    expect(r.oversold).toBe(false);
    const [stock] = await getStock(db, tenantA.id, { variationId: 'v1' });
    expect(stock.onHand).toBe(10);
    expect(stock.reserved).toBe(4);
    expect(stock.available).toBe(6);
  });

  it('deny policy rejects reservation beyond available', async () => {
    const { db, events, tenantA, loc } = await seed(3);
    await expect(
      reserve(db, events, tenantA.id, 'u1', { variationId: 'v1', locationId: loc.id, qty: 5 }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('allow_flag policy reserves anyway with oversold:true', async () => {
    const s = await setup();
    const loc = await createLocation(s.db, s.tenantA.id, 'system', {
      name: 'Booth',
      kind: 'show',
      oversellPolicy: 'allow_flag',
    });
    await applyMovement(s.db, s.events, s.tenantA.id, 'u1', {
      variationId: 'v1',
      locationId: loc.id,
      delta: 2,
      reason: 'received',
    });
    const r = await reserve(s.db, s.events, s.tenantA.id, 'u1', { variationId: 'v1', locationId: loc.id, qty: 5 });
    expect(r.oversold).toBe(true);
    expect(r.reservation.oversold).toBe(1);
  });

  it('release recovers availability', async () => {
    const { db, events, tenantA, loc } = await seed(10);
    const r = await reserve(db, events, tenantA.id, 'u1', { variationId: 'v1', locationId: loc.id, qty: 4 });
    await releaseReservation(db, events, tenantA.id, 'u1', r.reservation.id);
    const [stock] = await getStock(db, tenantA.id, { variationId: 'v1' });
    expect(stock.reserved).toBe(0);
    expect(stock.available).toBe(10);
  });

  it('reacquires a released business reservation without replaying the terminal row', async () => {
    const { db, events, tenantA, loc } = await seed(10);
    const seen = capture(events, 'inventory.stock.changed');
    const input = {
      variationId: 'v1',
      locationId: loc.id,
      qty: 4,
      refType: 'order',
      refId: 'ord_release_then_retry',
    };

    const first = await reserve(db, events, tenantA.id, 'u1', input);
    await releaseReservation(db, events, tenantA.id, 'u1', first.reservation.id);
    const reacquired = await reserve(db, events, tenantA.id, 'u1', input);

    expect(reacquired.reservation.id).not.toBe(first.reservation.id);
    expect(reacquired.reservation.status).toBe('active');
    const rows = await db
      .selectFrom('inventory_reservations')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .where('ref_type', '=', 'order')
      .where('ref_id', '=', 'ord_release_then_retry')
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === first.reservation.id)?.status).toBe('released');
    expect(rows.find((row) => row.id === reacquired.reservation.id)?.status).toBe('active');
    const [stock] = await getStock(db, tenantA.id, { variationId: 'v1' });
    expect(stock).toMatchObject({ onHand: 10, reserved: 4, available: 6 });
    expect(seen).toHaveLength(3);
  });

  it('replays the same business reference without reserving or emitting twice', async () => {
    const { db, events, tenantA, loc } = await seed(10);
    const seen = capture(events, 'inventory.stock.changed');
    const input = {
      variationId: 'v1',
      locationId: loc.id,
      qty: 4,
      refType: 'order',
      refId: 'ord_replay',
    };

    const first = await reserve(db, events, tenantA.id, 'u1', input);
    const replay = await reserve(db, events, tenantA.id, 'u1', input);

    expect(replay.reservation.id).toBe(first.reservation.id);
    expect(seen).toHaveLength(1);
    const [stock] = await getStock(db, tenantA.id, { variationId: 'v1' });
    expect(stock.reserved).toBe(4);
    expect(stock.available).toBe(6);
  });

  it('rejects reuse of a business reference with a conflicting quantity', async () => {
    const { db, events, tenantA, loc } = await seed(10);
    const base = {
      variationId: 'v1',
      locationId: loc.id,
      refType: 'order',
      refId: 'ord_conflict',
    };
    await reserve(db, events, tenantA.id, 'u1', { ...base, qty: 2 });

    await expect(reserve(db, events, tenantA.id, 'u1', { ...base, qty: 3 })).rejects.toMatchObject({ status: 409 });
    const [stock] = await getStock(db, tenantA.id, { variationId: 'v1' });
    expect(stock.reserved).toBe(2);
  });

  it('settles every active reservation for an order and is replay-safe', async () => {
    const { db, events, tenantA, loc } = await seed(10);
    await reserve(db, events, tenantA.id, 'u1', {
      variationId: 'v1',
      locationId: loc.id,
      qty: 3,
      refType: 'order',
      refId: 'ord_release',
    });

    const first = await settleReservationsForReference(
      db,
      events,
      tenantA.id,
      'u1',
      'order',
      'ord_release',
      'released',
    );
    const replay = await settleReservationsForReference(
      db,
      events,
      tenantA.id,
      'u1',
      'order',
      'ord_release',
      'released',
    );

    expect(first.settled).toBe(1);
    expect(replay.settled).toBe(0);
    const [stock] = await getStock(db, tenantA.id, { variationId: 'v1' });
    expect(stock.onHand).toBe(10);
    expect(stock.reserved).toBe(0);
    expect(stock.available).toBe(10);
  });

  it('keeps a converted reservation terminal across conversion and late reserve replays', async () => {
    const { db, events, tenantA, loc } = await seed(10);
    const seen = capture(events, 'inventory.stock.changed');
    const input = {
      variationId: 'v1',
      locationId: loc.id,
      qty: 3,
      refType: 'order',
      refId: 'ord_converted_replay',
    };
    const original = await reserve(db, events, tenantA.id, 'u1', input);

    const converted = await settleReservationsForReference(
      db,
      events,
      tenantA.id,
      'u1',
      'order',
      'ord_converted_replay',
      'converted',
    );
    const conversionReplay = await settleReservationsForReference(
      db,
      events,
      tenantA.id,
      'u1',
      'order',
      'ord_converted_replay',
      'converted',
    );
    const lateReserveReplay = await reserve(db, events, tenantA.id, 'u1', input);

    expect(converted.settled).toBe(1);
    expect(conversionReplay.settled).toBe(0);
    expect(lateReserveReplay.reservation).toMatchObject({
      id: original.reservation.id,
      status: 'converted',
    });
    const rows = await db
      .selectFrom('inventory_reservations')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .where('ref_type', '=', 'order')
      .where('ref_id', '=', 'ord_converted_replay')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('converted');
    const [stock] = await getStock(db, tenantA.id, { variationId: 'v1' });
    expect(stock).toMatchObject({ onHand: 10, reserved: 0, available: 10 });
    expect(seen).toHaveLength(2);
  });

  it('expiry recovers availability (journey 9) and marks reservation expired', async () => {
    const { db, events, tenantA, loc } = await seed(10);
    await reserve(db, events, tenantA.id, 'u1', {
      variationId: 'v1',
      locationId: loc.id,
      qty: 3,
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    const active = await reserve(db, events, tenantA.id, 'u1', {
      variationId: 'v1',
      locationId: loc.id,
      qty: 2,
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const out = await expireReservations(db, events, tenantA.id, 'u1', '2026-07-12T00:00:00.000Z');
    expect(out.expired).toBe(1);
    const [stock] = await getStock(db, tenantA.id, { variationId: 'v1' });
    expect(stock.reserved).toBe(2); // only the non-expired one remains
    // The future reservation is still active.
    const rows = await db
      .selectFrom('inventory_reservations')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .where('id', '=', active.reservation.id)
      .execute();
    expect(rows[0].status).toBe('active');
    const report = await verifyConservation(db, tenantA.id);
    expect(report.ok).toBe(true);
  });
});

describe('sellForOrder — replay-safe (journey 8)', () => {
  it('decrements 3 -> 2 exactly once even when the event replays', async () => {
    const { db, events, tenantA, loc } = await seed(3);
    const input = {
      orderId: 'ord_99',
      idempotencyKey: 'square-evt-abc',
      lines: [{ variationId: 'v1', qty: 1, locationId: loc.id }],
    };
    const seen = capture(events, 'inventory.stock.changed');

    const first = await sellForOrder(db, events, tenantA.id, 'u1', input);
    expect(first.replayed).toBe(false);
    expect(first.lines[0].onHand).toBe(2);

    const replay = await sellForOrder(db, events, tenantA.id, 'u1', input);
    expect(replay.replayed).toBe(true);
    expect(replay.lines[0].onHand).toBe(2);

    const [stock] = await getStock(db, tenantA.id, { variationId: 'v1' });
    expect(stock.onHand).toBe(2); // exactly once
    expect(seen).toHaveLength(1); // no double emit on replay
  });

  it('converts an order reservation before selling so availability is reduced once', async () => {
    const { db, events, tenantA, loc } = await seed(10);
    await reserve(db, events, tenantA.id, 'u1', {
      variationId: 'v1',
      locationId: loc.id,
      qty: 3,
      refType: 'order',
      refId: 'ord_reserved_sale',
    });

    await sellForOrder(db, events, tenantA.id, 'u1', {
      orderId: 'ord_reserved_sale',
      idempotencyKey: 'paid:ord_reserved_sale',
      lines: [{ variationId: 'v1', locationId: loc.id, qty: 3 }],
    });

    const [stock] = await getStock(db, tenantA.id, { variationId: 'v1' });
    expect(stock.onHand).toBe(7);
    expect(stock.reserved).toBe(0);
    expect(stock.available).toBe(7);
    const rows = await db
      .selectFrom('inventory_reservations')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .where('ref_id', '=', 'ord_reserved_sale')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('converted');
  });
});
