import { describe, expect, it } from 'vitest';
import {
  applyMovement,
  correctMovement,
  createLocation,
  createReorderPoint,
  getStock,
  verifyConservation,
} from '../src/service';
import type { MovementReason } from '../src/schema';
import { capture, headers, lcg, randInt, setup } from './helpers';

describe('applyMovement — single write path', () => {
  it('appends a movement and maintains on_hand === SUM(delta)', async () => {
    const { db, events, tenantA } = await setup();
    const loc = await createLocation(db, tenantA.id, 'system', { name: 'WH', kind: 'warehouse' });
    await applyMovement(db, events, tenantA.id, 'u1', {
      variationId: 'v1',
      locationId: loc.id,
      delta: 10,
      reason: 'received',
    });
    await applyMovement(db, events, tenantA.id, 'u1', {
      variationId: 'v1',
      locationId: loc.id,
      delta: -3,
      reason: 'sold',
    });
    const [stock] = await getStock(db, tenantA.id, { variationId: 'v1' });
    expect(stock.onHand).toBe(7);
    const report = await verifyConservation(db, tenantA.id);
    expect(report.ok).toBe(true);
  });

  it('emits inventory.stock.changed with the full payload', async () => {
    const { db, events, tenantA } = await setup();
    const loc = await createLocation(db, tenantA.id, 'system', { name: 'WH', kind: 'warehouse' });
    const seen = capture(events, 'inventory.stock.changed');
    const res = await applyMovement(db, events, tenantA.id, 'u1', {
      variationId: 'v1',
      locationId: loc.id,
      delta: 5,
      reason: 'received',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toEqual({
      v: 1,
      variationId: 'v1',
      locationId: loc.id,
      delta: 5,
      onHand: 5,
      movementId: res.movement.id,
      reason: 'received',
    });
  });

  it('is idempotent: same idempotency_key twice → one movement, one decrement', async () => {
    const { db, events, tenantA } = await setup();
    const loc = await createLocation(db, tenantA.id, 'system', { name: 'WH', kind: 'warehouse' });
    await applyMovement(db, events, tenantA.id, 'u1', {
      variationId: 'v1',
      locationId: loc.id,
      delta: 10,
      reason: 'received',
    });
    const first = await applyMovement(db, events, tenantA.id, 'u1', {
      variationId: 'v1',
      locationId: loc.id,
      delta: -2,
      reason: 'sold',
      idempotencyKey: 'evt-1',
    });
    const second = await applyMovement(db, events, tenantA.id, 'u1', {
      variationId: 'v1',
      locationId: loc.id,
      delta: -2,
      reason: 'sold',
      idempotencyKey: 'evt-1',
    });
    expect(second.deduped).toBe(true);
    expect(second.movement.id).toBe(first.movement.id);
    const [stock] = await getStock(db, tenantA.id, { variationId: 'v1' });
    expect(stock.onHand).toBe(8);
    const movements = await db
      .selectFrom('inventory_movements')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .where('reason', '=', 'sold')
      .execute();
    expect(movements).toHaveLength(1);
  });

  it('oversell deny → conflict', async () => {
    const { db, events, tenantA } = await setup();
    const loc = await createLocation(db, tenantA.id, 'system', {
      name: 'WH',
      kind: 'warehouse',
      oversellPolicy: 'deny',
    });
    await applyMovement(db, events, tenantA.id, 'u1', {
      variationId: 'v1',
      locationId: loc.id,
      delta: 1,
      reason: 'received',
    });
    await expect(
      applyMovement(db, events, tenantA.id, 'u1', {
        variationId: 'v1',
        locationId: loc.id,
        delta: -5,
        reason: 'sold',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('oversell allow_flag → proceeds, oversold:true in result and event payload', async () => {
    const { db, events, tenantA } = await setup();
    const loc = await createLocation(db, tenantA.id, 'system', {
      name: 'Show Booth',
      kind: 'show',
      oversellPolicy: 'allow_flag',
    });
    const seen = capture(events, 'inventory.stock.changed');
    const res = await applyMovement(db, events, tenantA.id, 'u1', {
      variationId: 'v1',
      locationId: loc.id,
      delta: -5,
      reason: 'sold',
    });
    expect(res.oversold).toBe(true);
    expect(res.onHand).toBe(-5);
    expect(seen[0].payload).toMatchObject({ oversold: true, onHand: -5 });
  });

  it('correction writes a compensating movement referencing the original', async () => {
    const { db, events, tenantA } = await setup();
    const loc = await createLocation(db, tenantA.id, 'system', { name: 'WH', kind: 'warehouse' });
    const orig = await applyMovement(db, events, tenantA.id, 'u1', {
      variationId: 'v1',
      locationId: loc.id,
      delta: 10,
      reason: 'received',
    });
    const correction = await correctMovement(db, events, tenantA.id, 'u1', orig.movement.id, -10, 'miscount');
    expect(correction.movement.reason).toBe('correction');
    expect(correction.movement.ref_type).toBe('correction_of');
    expect(correction.movement.ref_id).toBe(orig.movement.id);
    const [stock] = await getStock(db, tenantA.id, { variationId: 'v1' });
    expect(stock.onHand).toBe(0);
  });

  it('exposes NO update or delete path for movements (append-only)', async () => {
    const svc = await import('../src/service');
    const names = Object.keys(svc).filter((n) => /movement/i.test(n));
    expect(names.sort()).toEqual(['applyMovement', 'correctMovement', 'listMovements']);
    // None of the exported movement fns mutate or delete existing ledger rows.
  });
});

describe('conservation invariant — randomized property test (seeded LCG)', () => {
  it('on_hand === SUM(delta) after a few hundred random movements', async () => {
    const { db, events, tenantA } = await setup();
    // allow_flag so random negatives never throw and we exercise sign freely.
    const loc = await createLocation(db, tenantA.id, 'system', {
      name: 'WH',
      kind: 'warehouse',
      oversellPolicy: 'allow_flag',
    });
    const loc2 = await createLocation(db, tenantA.id, 'system', {
      name: 'Trailer',
      kind: 'trailer',
      oversellPolicy: 'allow_flag',
    });
    const rng = lcg(20260712);
    const reasons: MovementReason[] = ['received', 'sold', 'adjusted', 'returned', 'damaged', 'shrink'];
    const vars = ['v1', 'v2', 'v3'];
    const locs = [loc.id, loc2.id];
    // Independent running totals per (variation, location).
    const expected = new Map<string, number>();

    for (let i = 0; i < 400; i++) {
      const variationId = vars[randInt(rng, 0, vars.length - 1)];
      const locationId = locs[randInt(rng, 0, locs.length - 1)];
      const delta = randInt(rng, -8, 8);
      const reason = reasons[randInt(rng, 0, reasons.length - 1)];
      await applyMovement(db, events, tenantA.id, 'u1', { variationId, locationId, delta, reason });
      const key = `${variationId} ${locationId}`;
      expected.set(key, (expected.get(key) ?? 0) + delta);
    }

    const report = await verifyConservation(db, tenantA.id);
    expect(report.ok).toBe(true);
    expect(report.drift).toEqual([]);

    // Independently confirm every cache row matches our tracked total.
    const levels = await getStock(db, tenantA.id);
    for (const lv of levels) {
      expect(lv.onHand).toBe(expected.get(`${lv.variationId} ${lv.locationId}`) ?? 0);
    }
  });
});

describe('reorder-point emission', () => {
  it('emits below_reorder_point only when a movement crosses the threshold (no re-emit)', async () => {
    const { db, events, tenantA } = await setup();
    const loc = await createLocation(db, tenantA.id, 'system', {
      name: 'WH',
      kind: 'warehouse',
      oversellPolicy: 'allow_flag',
    });
    await createReorderPoint(db, tenantA.id, 'system', {
      variationId: 'v1',
      locationId: loc.id,
      reorderPoint: 5,
    });
    await applyMovement(db, events, tenantA.id, 'u1', {
      variationId: 'v1',
      locationId: loc.id,
      delta: 10,
      reason: 'received',
    });
    const seen = capture(events, 'inventory.stock.below_reorder_point');
    // 10 -> 4 crosses 5.
    await applyMovement(db, events, tenantA.id, 'u1', {
      variationId: 'v1',
      locationId: loc.id,
      delta: -6,
      reason: 'sold',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toEqual({
      v: 1,
      variationId: 'v1',
      locationId: loc.id,
      onHand: 4,
      reorderPoint: 5,
    });
    // 4 -> 2 already at-or-below: NO re-emit.
    await applyMovement(db, events, tenantA.id, 'u1', {
      variationId: 'v1',
      locationId: loc.id,
      delta: -2,
      reason: 'sold',
    });
    expect(seen).toHaveLength(1);
  });

  it('aggregate (location_id null) reorder rows use the cross-location total', async () => {
    const { db, events, tenantA } = await setup();
    const wh = await createLocation(db, tenantA.id, 'system', { name: 'WH', kind: 'warehouse', oversellPolicy: 'allow_flag' });
    const tr = await createLocation(db, tenantA.id, 'system', { name: 'TR', kind: 'trailer', oversellPolicy: 'allow_flag' });
    await createReorderPoint(db, tenantA.id, 'system', { variationId: 'v1', locationId: null, reorderPoint: 5 });
    await applyMovement(db, events, tenantA.id, 'u1', { variationId: 'v1', locationId: wh.id, delta: 4, reason: 'received' });
    await applyMovement(db, events, tenantA.id, 'u1', { variationId: 'v1', locationId: tr.id, delta: 4, reason: 'received' });
    const seen = capture(events, 'inventory.stock.below_reorder_point');
    // Total 8 -> 4 (sell 4 from WH) crosses aggregate threshold 5.
    await applyMovement(db, events, tenantA.id, 'u1', { variationId: 'v1', locationId: wh.id, delta: -4, reason: 'sold' });
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toMatchObject({ onHand: 4, reorderPoint: 5, locationId: wh.id });
  });
});
