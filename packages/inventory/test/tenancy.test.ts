import { describe, expect, it } from 'vitest';
import { createLocation, headers, setup } from './helpers';

describe('router happy path + tenancy denial', () => {
  it('CRUD a location, apply a movement, read stock through the router', async () => {
    const { app, tenantA } = await setup();
    const loc = await createLocation(app, tenantA, { name: 'WH', kind: 'warehouse' });

    const mv = await app.request('/movements', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ variationId: 'v1', locationId: loc.id, delta: 7, reason: 'received' }),
    });
    expect(mv.status).toBe(201);

    const stock = await app.request('/stock?variationId=v1', { headers: headers(tenantA) });
    const stockJson = (await stock.json()) as { data: Array<{ onHand: number; available: number }> };
    expect(stockJson.data[0].onHand).toBe(7);
    expect(stockJson.data[0].available).toBe(7);

    const cons = await app.request('/conservation', { headers: headers(tenantA) });
    const consJson = (await cons.json()) as { data: { ok: boolean } };
    expect(consJson.data.ok).toBe(true);
  });

  it('missing x-tenant-id → 400', async () => {
    const { app } = await setup();
    const res = await app.request('/locations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'WH', kind: 'warehouse' }),
    });
    expect(res.status).toBe(400);
  });

  it('tenant B cannot see tenant A locations', async () => {
    const { app, tenantA, tenantB } = await setup();
    await createLocation(app, tenantA, { name: 'A-WH', kind: 'warehouse' });
    const res = await app.request('/locations', { headers: headers(tenantB) });
    const json = (await res.json()) as { data: unknown[] };
    expect(json.data).toEqual([]);
  });

  it('tenant B gets 404 fetching tenant A location by id, and A is untouched', async () => {
    const { app, tenantA, tenantB } = await setup();
    const loc = await createLocation(app, tenantA, { name: 'A-WH', kind: 'warehouse' });
    const denied = await app.request(`/locations/${loc.id}`, { headers: headers(tenantB) });
    expect(denied.status).toBe(404);
    const patchDenied = await app.request(`/locations/${loc.id}`, {
      method: 'PATCH',
      headers: headers(tenantB),
      body: JSON.stringify({ name: 'hijacked' }),
    });
    expect(patchDenied.status).toBe(404);
    const ok = await app.request(`/locations/${loc.id}`, { headers: headers(tenantA) });
    const okJson = (await ok.json()) as { data: { name: string } };
    expect(okJson.data.name).toBe('A-WH');
  });

  it("tenant B cannot see tenant A stock or movements", async () => {
    const { app, tenantA, tenantB } = await setup();
    const loc = await createLocation(app, tenantA, { name: 'A-WH', kind: 'warehouse' });
    await app.request('/movements', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ variationId: 'v1', locationId: loc.id, delta: 5, reason: 'received' }),
    });
    const stock = await app.request('/stock?variationId=v1', { headers: headers(tenantB) });
    expect(((await stock.json()) as { data: unknown[] }).data).toEqual([]);
    const moves = await app.request('/movements?variationId=v1', { headers: headers(tenantB) });
    expect(((await moves.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it('tenant B cannot post a movement against tenant A location (404)', async () => {
    const { app, tenantA, tenantB } = await setup();
    const loc = await createLocation(app, tenantA, { name: 'A-WH', kind: 'warehouse' });
    const res = await app.request('/movements', {
      method: 'POST',
      headers: headers(tenantB),
      body: JSON.stringify({ variationId: 'v1', locationId: loc.id, delta: 5, reason: 'received' }),
    });
    expect(res.status).toBe(404);
  });

  it('audit rows are written for mutations and scoped to the tenant', async () => {
    const { app, db, tenantA } = await setup();
    const loc = await createLocation(app, tenantA, { name: 'WH', kind: 'warehouse' });
    await app.request('/movements', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ variationId: 'v1', locationId: loc.id, delta: 5, reason: 'received' }),
    });
    const audits = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .execute();
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('inventory.location.created');
    expect(actions).toContain('inventory.movement.applied');
  });
});
