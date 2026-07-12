import { describe, expect, it } from 'vitest';
import { storefrontPublicRouter } from '../src/router';
import { publishStorefront, readProjection, getLiveRun } from '../src/publish';
import { projectionOnlyDb, seedLiveProjection, setup, fixtureSource } from './helpers';

describe('public router — isolation & shape', () => {
  it('serves pages with NO tenant header and querying ONLY the projection (no core tables exist)', async () => {
    const db = await projectionOnlyDb();
    const tenantId = 'mags-tack';
    await seedLiveProjection(db, tenantId);
    const app = storefrontPublicRouter({ db, tenantId, config: { brandName: 'Mags Tack' } });

    // No x-tenant-id header anywhere.
    const home = await app.request('/');
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain('Mags Tack');

    // An item page resolves (slug === sourceProductId in the seed).
    const item = await app.request('/item-p-halter.html');
    expect(item.status).toBe(200);
    expect(await item.text()).toContain('Ellany Leather Halter');

    // Unknown path → 404 page.
    const missing = await app.request('/item-does-not-exist.html');
    expect(missing.status).toBe(404);

    // Assets served.
    const css = await app.request('/assets/site.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
  });

  it('search endpoint ranks results from the projection', async () => {
    const db = await projectionOnlyDb();
    await seedLiveProjection(db, 'mags-tack');
    const app = storefrontPublicRouter({ db, tenantId: 'mags-tack' });
    const res = await app.request('/api/search?q=ellany');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data[0].name).toContain('Ellany');
  });

  it('cart-validate flags an out-of-stock and an unknown variation', async () => {
    const db = await projectionOnlyDb();
    const runId = await seedLiveProjection(db, 'mags-tack');
    // find the brush variation id (sv-brush-1 → out)
    const proj = await readProjection(db, 'mags-tack', runId);
    const brush = proj.items.find((i) => i.sourceProductId === 'p-brush')!.variations[0];
    const app = storefrontPublicRouter({ db, tenantId: 'mags-tack' });
    const res = await app.request('/api/cart-validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lines: [{ variationId: brush.id, qty: 1 }, { variationId: 'nope', qty: 1 }] }),
    });
    const body: any = await res.json();
    expect(body.data.allValid).toBe(false);
    expect(body.data.lines[0].reason).toBe('out_of_stock');
    expect(body.data.lines[1].reason).toBe('unknown_variation');
  });

  it('POST /api/orders forwards to the injected placeOrder fn', async () => {
    const db = await projectionOnlyDb();
    await seedLiveProjection(db, 'mags-tack');
    const calls: unknown[] = [];
    const app = storefrontPublicRouter({
      db,
      tenantId: 'mags-tack',
      placeOrder: (input) => { calls.push(input); return { orderId: 'o-123', oversold: false }; },
    });
    const res = await app.request('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lines: [{ variationId: 'v1', qty: 2 }] }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).data.orderId).toBe('o-123');
    expect(calls).toHaveLength(1);
  });

  it('returns 501 for order placement when no placeOrder is injected (honest static-adjacent state)', async () => {
    const db = await projectionOnlyDb();
    await seedLiveProjection(db, 'mags-tack');
    const app = storefrontPublicRouter({ db, tenantId: 'mags-tack' });
    const res = await app.request('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lines: [{ variationId: 'v1', qty: 1 }] }),
    });
    expect(res.status).toBe(501);
  });

  it('serves the live projection produced by a real publish (end to end)', async () => {
    const { db, tenantA } = await setup();
    await publishStorefront({ db, tenantId: tenantA.id, source: fixtureSource(), dataAsOf: '2026-07-11' });
    const live = await getLiveRun(db, tenantA.id);
    expect(live).toBeDefined();
    const app = storefrontPublicRouter({ db, tenantId: tenantA.id });
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Featured');
  });
});
