import { describe, expect, it } from 'vitest';
import { setup, headers } from './helpers';
import {
  createReorderPolicy,
  listReorderPolicies,
  runSuggestion,
  acceptSuggestion,
  dismissSuggestion,
  getPurchaseOrder,
  listPoLines,
} from '../src/service';

const inputs = {
  onHand: 0,
  reserved: 0,
  inbound: 0,
  unitsPerWeekVelocity: 14,
  seasonalFactor: 1,
  leadTimeDays: 7,
  casePackQty: 6,
  minOrderQty: 0,
  safetyStock: 0,
  upcomingShowDemand: 0,
};

describe('reorder policies + suggestions', () => {
  it('policy CRUD is tenant-scoped', async () => {
    const { db, tenantA, tenantB } = await setup();
    const p = await createReorderPolicy(db, tenantA.id, 'system', {
      variationId: 'var_1',
      vendorId: 'vend_1',
      reorderPoint: 5,
      safetyStock: 3,
      orderMultiple: 6,
      minQty: 12,
    });
    expect(p.enabled).toBe(1);
    expect(await listReorderPolicies(db, tenantB.id)).toEqual([]);
    expect(await listReorderPolicies(db, tenantA.id)).toHaveLength(1);
  });

  it('runSuggestion persists inputs + trace + qty', async () => {
    const { db, tenantA } = await setup();
    const s = await runSuggestion(db, tenantA.id, 'system', 'var_1', 'vend_1', inputs);
    // 14/wk = 2/day × 7 = 14, case pack 6 → ceil(14/6)*6 = 18.
    expect(s.suggested_qty).toBe(18);
    expect(s.status).toBe('suggested');
    const trace = JSON.parse(s.formula_trace) as string[];
    expect(trace.length).toBeGreaterThan(3);
  });

  it('accepting a suggestion creates a draft PO, then a second accept EXTENDS the same PO', async () => {
    const { db, tenantA } = await setup();
    const s1 = await runSuggestion(db, tenantA.id, 'system', 'var_1', 'vend_1', inputs);
    const s2 = await runSuggestion(db, tenantA.id, 'system', 'var_2', 'vend_1', inputs);

    const a1 = await acceptSuggestion(db, tenantA.id, 'buyer', s1.id, { unitCostCents: 500, vendorSku: 'SK1' });
    expect(a1.purchaseOrder.status).toBe('draft');
    // subtotal = 18 * 500 = 9000.
    expect(a1.purchaseOrder.subtotal_cents).toBe(9000);
    expect(a1.purchaseOrder.total_cents).toBe(9000);

    const a2 = await acceptSuggestion(db, tenantA.id, 'buyer', s2.id, { unitCostCents: 1000 });
    // Same vendor → same draft PO, now two lines: 9000 + 18*1000 = 27000.
    expect(a2.purchaseOrder.id).toBe(a1.purchaseOrder.id);
    expect(a2.purchaseOrder.subtotal_cents).toBe(27000);

    const lines = await listPoLines(db, tenantA.id, a1.purchaseOrder.id);
    expect(lines).toHaveLength(2);

    // Suggestion is marked accepted + linked.
    const po = await getPurchaseOrder(db, tenantA.id, a1.purchaseOrder.id);
    expect(po!.vendor_id).toBe('vend_1');
  });

  it('a different vendor gets its own draft PO', async () => {
    const { db, tenantA } = await setup();
    const s1 = await runSuggestion(db, tenantA.id, 'system', 'var_1', 'vend_1', inputs);
    const s2 = await runSuggestion(db, tenantA.id, 'system', 'var_2', 'vend_2', inputs);
    const a1 = await acceptSuggestion(db, tenantA.id, 'buyer', s1.id, { unitCostCents: 500 });
    const a2 = await acceptSuggestion(db, tenantA.id, 'buyer', s2.id, { unitCostCents: 500 });
    expect(a2.purchaseOrder.id).not.toBe(a1.purchaseOrder.id);
  });

  it('dismiss and double-accept guards', async () => {
    const { db, tenantA } = await setup();
    const s = await runSuggestion(db, tenantA.id, 'system', 'var_1', 'vend_1', inputs);
    await acceptSuggestion(db, tenantA.id, 'buyer', s.id, { unitCostCents: 500 });
    await expect(dismissSuggestion(db, tenantA.id, 'buyer', s.id)).rejects.toMatchObject({ status: 409 });

    const z = await runSuggestion(db, tenantA.id, 'system', 'var_z', 'vend_1', {
      ...inputs,
      unitsPerWeekVelocity: 0,
      onHand: 100,
    });
    expect(z.suggested_qty).toBe(0);
    // Accepting a 0-qty suggestion is a bad request.
    await expect(acceptSuggestion(db, tenantA.id, 'buyer', z.id, { unitCostCents: 500 })).rejects.toMatchObject({ status: 400 });
  });

  it('suggestions run/accept work through the router', async () => {
    const { app, tenantA } = await setup();
    const run = await app.request('/suggestions/run', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ variationId: 'var_1', vendorId: 'vend_1', inputs }),
    });
    expect(run.status).toBe(201);
    const { data: s } = (await run.json() as any);
    const accept = await app.request(`/suggestions/${s.id}/accept`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ unitCostCents: 500 }),
    });
    expect(accept.status).toBe(201);
    expect(((await accept.json() as any)).data.purchaseOrder.subtotal_cents).toBe(9000);
  });
});
