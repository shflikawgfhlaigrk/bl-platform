import { describe, expect, it } from 'vitest';
import {
  applyMovement,
  assembleKit,
  createLocation,
  daysOfSupply,
  disassembleKit,
  getStock,
  shrinkSummary,
  stockAging,
  stockoutList,
  velocity,
  verifyConservation,
} from '../src/service';
import { setup } from './helpers';

describe('analytics', () => {
  it('velocity computes units-per-week from sold movements over a window', async () => {
    const { db, events, tenantA } = await setup();
    const loc = await createLocation(db, tenantA.id, 'system', { name: 'WH', kind: 'warehouse', oversellPolicy: 'allow_flag' });
    await applyMovement(db, events, tenantA.id, 'u1', { variationId: 'v1', locationId: loc.id, delta: 100, reason: 'received' });
    // 14 units sold "now" (all within window).
    await applyMovement(db, events, tenantA.id, 'u1', { variationId: 'v1', locationId: loc.id, delta: -14, reason: 'sold' });
    const v = await velocity(db, tenantA.id, 'v1', 28);
    expect(v.unitsSold).toBe(14);
    expect(v.unitsPerWeek).toBeCloseTo(3.5, 5); // 14 / (28/7)
  });

  it('days-of-supply is an HONEST null when velocity is 0 (never Infinity)', async () => {
    const { db, events, tenantA } = await setup();
    const loc = await createLocation(db, tenantA.id, 'system', { name: 'WH', kind: 'warehouse' });
    await applyMovement(db, events, tenantA.id, 'u1', { variationId: 'v1', locationId: loc.id, delta: 50, reason: 'received' });
    const dos = await daysOfSupply(db, tenantA.id, 'v1', 28);
    expect(dos.unitsPerWeek).toBe(0);
    expect(dos.daysOfSupply).toBeNull();
  });

  it('days-of-supply divides on_hand by weekly velocity when velocity > 0', async () => {
    const { db, events, tenantA } = await setup();
    const loc = await createLocation(db, tenantA.id, 'system', { name: 'WH', kind: 'warehouse', oversellPolicy: 'allow_flag' });
    await applyMovement(db, events, tenantA.id, 'u1', { variationId: 'v1', locationId: loc.id, delta: 28, reason: 'received' });
    await applyMovement(db, events, tenantA.id, 'u1', { variationId: 'v1', locationId: loc.id, delta: -14, reason: 'sold' });
    // on_hand 14, velocity 3.5/wk → 14/3.5 = 4 weeks = 28 days.
    const dos = await daysOfSupply(db, tenantA.id, 'v1', 28);
    expect(dos.onHand).toBe(14);
    expect(dos.daysOfSupply).toBeCloseTo(28, 5);
  });

  it('stockout list = counted_ever AND on_hand <= 0', async () => {
    const { db, events, tenantA } = await setup();
    const loc = await createLocation(db, tenantA.id, 'system', { name: 'WH', kind: 'warehouse', oversellPolicy: 'allow_flag' });
    // v1: counted then sold below zero → stockout.
    await applyMovement(db, events, tenantA.id, 'u1', { variationId: 'v1', locationId: loc.id, delta: 2, reason: 'received' });
    await applyMovement(db, events, tenantA.id, 'u1', { variationId: 'v1', locationId: loc.id, delta: -2, reason: 'counted' });
    await applyMovement(db, events, tenantA.id, 'u1', { variationId: 'v1', locationId: loc.id, delta: 0, reason: 'counted' });
    // v2: never counted, on_hand 0 → NOT a stockout.
    await applyMovement(db, events, tenantA.id, 'u1', { variationId: 'v2', locationId: loc.id, delta: 0, reason: 'received' });
    const outs = await stockoutList(db, tenantA.id);
    expect(outs.map((o) => o.variationId)).toEqual(['v1']);
  });

  it('shrink summary totals damaged + shrink movement magnitudes', async () => {
    const { db, events, tenantA } = await setup();
    const loc = await createLocation(db, tenantA.id, 'system', { name: 'WH', kind: 'warehouse', oversellPolicy: 'allow_flag' });
    await applyMovement(db, events, tenantA.id, 'u1', { variationId: 'v1', locationId: loc.id, delta: -3, reason: 'damaged' });
    await applyMovement(db, events, tenantA.id, 'u1', { variationId: 'v1', locationId: loc.id, delta: -2, reason: 'shrink' });
    const s = await shrinkSummary(db, tenantA.id);
    expect(s).toEqual({ damagedUnits: 3, shrinkUnits: 2, totalUnits: 5 });
  });

  it('stock aging reports days since last positive movement', async () => {
    const { db, events, tenantA } = await setup();
    const loc = await createLocation(db, tenantA.id, 'system', { name: 'WH', kind: 'warehouse' });
    await applyMovement(db, events, tenantA.id, 'u1', { variationId: 'v1', locationId: loc.id, delta: 5, reason: 'received' });
    const rows = await stockAging(db, tenantA.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].lastPositiveAt).not.toBeNull();
    expect(rows[0].daysSinceLastPositive).toBeGreaterThanOrEqual(0);
  });
});

describe('kits', () => {
  it('assemble consumes components and produces the kit, conserving stock', async () => {
    const { db, events, tenantA } = await setup();
    const loc = await createLocation(db, tenantA.id, 'system', { name: 'WH', kind: 'warehouse' });
    await applyMovement(db, events, tenantA.id, 'u1', { variationId: 'compA', locationId: loc.id, delta: 10, reason: 'received' });
    await applyMovement(db, events, tenantA.id, 'u1', { variationId: 'compB', locationId: loc.id, delta: 10, reason: 'received' });

    await assembleKit(db, events, tenantA.id, 'u1', 'kit1', [
      { variationId: 'compA', qtyPer: 2 },
      { variationId: 'compB', qtyPer: 1 },
    ], 3, loc.id);

    const a = await getStock(db, tenantA.id, { variationId: 'compA' });
    const b = await getStock(db, tenantA.id, { variationId: 'compB' });
    const kit = await getStock(db, tenantA.id, { variationId: 'kit1' });
    expect(a[0].onHand).toBe(4); // 10 - 2*3
    expect(b[0].onHand).toBe(7); // 10 - 1*3
    expect(kit[0].onHand).toBe(3);
    expect((await verifyConservation(db, tenantA.id)).ok).toBe(true);
  });

  it('disassemble is the inverse', async () => {
    const { db, events, tenantA } = await setup();
    const loc = await createLocation(db, tenantA.id, 'system', { name: 'WH', kind: 'warehouse' });
    await applyMovement(db, events, tenantA.id, 'u1', { variationId: 'compA', locationId: loc.id, delta: 10, reason: 'received' });
    await applyMovement(db, events, tenantA.id, 'u1', { variationId: 'kit1', locationId: loc.id, delta: 5, reason: 'received' });
    await disassembleKit(db, events, tenantA.id, 'u1', 'kit1', [{ variationId: 'compA', qtyPer: 2 }], 2, loc.id);
    const a = await getStock(db, tenantA.id, { variationId: 'compA' });
    const kit = await getStock(db, tenantA.id, { variationId: 'kit1' });
    expect(a[0].onHand).toBe(14); // 10 + 2*2
    expect(kit[0].onHand).toBe(3); // 5 - 2
    expect((await verifyConservation(db, tenantA.id)).ok).toBe(true);
  });
});
