import { describe, expect, it } from 'vitest';
import { setup, headers } from './helpers';
import {
  createVendor,
  setCost,
  currentCost,
  catalogHistory,
} from '../src/service';

describe('vendors cost history + currentCost', () => {
  it('a new cost closes the prior open record; currentCost is boundary-exact', async () => {
    const { db, tenantA } = await setup();
    const vendor = await createVendor(db, tenantA.id, 'system', { name: 'CostCo Tack' });

    const T1 = '2026-01-01T00:00:00.000Z';
    const T2 = '2026-02-01T00:00:00.000Z';

    const e1 = await setCost(db, tenantA.id, 'system', vendor.id, {
      variationId: 'var_1',
      vendorSku: 'SKU1',
      costCents: 1000,
      casePackQty: 6,
      effectiveFrom: T1,
    });
    expect(e1.effective_to).toBeNull();

    const e2 = await setCost(db, tenantA.id, 'system', vendor.id, {
      variationId: 'var_1',
      vendorSku: 'SKU1',
      costCents: 1200,
      casePackQty: 6,
      effectiveFrom: T2,
    });
    expect(e2.effective_to).toBeNull();

    const history = await catalogHistory(db, tenantA.id, vendor.id, 'var_1');
    expect(history).toHaveLength(2);
    // Oldest first, and the old row is now closed at T2.
    expect(history[0].id).toBe(e1.id);
    expect(history[0].effective_to).toBe(T2);
    expect(history[1].id).toBe(e2.id);

    // Before T1 → no cost.
    expect(await currentCost(db, tenantA.id, 'var_1', vendor.id, '2025-12-31T23:59:59.999Z')).toBeUndefined();
    // In [T1, T2) → old cost 1000.
    expect((await currentCost(db, tenantA.id, 'var_1', vendor.id, '2026-01-15T00:00:00.000Z'))!.cost_cents).toBe(1000);
    // Exactly at the boundary T2 → the NEW row (1200) wins.
    expect((await currentCost(db, tenantA.id, 'var_1', vendor.id, T2))!.cost_cents).toBe(1200);
    // Just before T2 → still 1000.
    expect((await currentCost(db, tenantA.id, 'var_1', vendor.id, '2026-01-31T23:59:59.999Z'))!.cost_cents).toBe(1000);
    // After T2 → 1200.
    expect((await currentCost(db, tenantA.id, 'var_1', vendor.id, '2026-03-01T00:00:00.000Z'))!.cost_cents).toBe(1200);
  });

  it('rejects backdating a cost before the open record', async () => {
    const { db, tenantA } = await setup();
    const vendor = await createVendor(db, tenantA.id, 'system', { name: 'V' });
    await setCost(db, tenantA.id, 'system', vendor.id, {
      variationId: 'var_1',
      vendorSku: 'S',
      costCents: 500,
      casePackQty: 1,
      effectiveFrom: '2026-05-01T00:00:00.000Z',
    });
    await expect(
      setCost(db, tenantA.id, 'system', vendor.id, {
        variationId: 'var_1',
        vendorSku: 'S',
        costCents: 600,
        casePackQty: 1,
        effectiveFrom: '2026-04-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('catalog entries are tenant-scoped', async () => {
    const { db, tenantA, tenantB } = await setup();
    const vendor = await createVendor(db, tenantA.id, 'system', { name: 'V' });
    await setCost(db, tenantA.id, 'system', vendor.id, {
      variationId: 'var_1',
      vendorSku: 'S',
      costCents: 500,
      casePackQty: 1,
    });
    // Tenant B sees no history for A's vendor+variation.
    expect(await catalogHistory(db, tenantB.id, vendor.id, 'var_1')).toEqual([]);
    expect(await currentCost(db, tenantB.id, 'var_1', vendor.id)).toBeUndefined();
  });

  it('current-cost endpoint returns 404 when nothing is effective', async () => {
    const { app, db, tenantA } = await setup();
    const vendor = await createVendor(db, tenantA.id, 'system', { name: 'V' });
    const res = await app.request(
      `/vendors/${vendor.id}/catalog-entries/var_x/current-cost`,
      { headers: headers(tenantA) },
    );
    expect(res.status).toBe(404);
  });
});
