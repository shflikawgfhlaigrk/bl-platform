import { describe, expect, it } from 'vitest';
import {
  applyMovement,
  createLocation,
  expireReservations,
  getStock,
  releaseReservation,
  reserve,
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
});
