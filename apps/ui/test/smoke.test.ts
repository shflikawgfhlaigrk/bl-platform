import { authenticatedFixture } from '../../api/test/authenticated-fixture';
/**
 * Served-app smoke test. Boots the SAME `createApp` the real server binds,
 * wraps it in the SAME outer static-file server `server.ts` uses when UI_DIR is
 * set, then proves:
 *   1. GET / serves this package's index.html,
 *   2. the three API endpoints the shell depends on return the envelope shapes
 *      the UI parses ({data:[...]} lists and {data:{metrics:[...]}}).
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { asCoreDb, createTenant } from '@blacklabel/core';
import { createTestDb } from '@blacklabel/db';
import { createApp, type PlatformDatabase } from '../../api/src/app';

const here = path.dirname(fileURLToPath(import.meta.url));
const uiPublic = path.resolve(here, '../public');

async function boot() {
  const db = createTestDb<PlatformDatabase>();
  const platform = await createApp({ db });
  const tenant = await createTenant(asCoreDb(db), { name: 'Smoke Tenant' });
  const outer = new Hono();
  outer.use('/*', serveStatic({ root: uiPublic })); // UI_DIR = apps/ui/public
  outer.route('/', platform.app);
  authenticatedFixture({...platform,app:outer});
  return { outer, platform, tenantId: tenant.id };
}

describe('mags-ui served app smoke', () => {
  it('serves index.html at / from the UI directory', async () => {
    const { outer } = await boot();
    const res = await outer.request('/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>Mags Commerce OS</title>');
    expect(html).toContain('id="view-root"');
  });

  it('serves the app shell assets the service worker caches', async () => {
    const { outer } = await boot();
    const css = await outer.request('/app.css');
    expect(css.status).toBe(200);
    const appjs = await outer.request('/js/app.js');
    expect(appjs.status).toBe(200);
  });

  it('GET /api/actions returns a list envelope the UI parses', async () => {
    const { outer, tenantId } = await boot();
    const res = await outer.request('/api/actions', { headers: { 'x-tenant-id': tenantId } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.data)).toBe(true); // getList() reads body.data
  });

  it('GET /api/inventory/locations returns {data:[...]} the UI reads via getData', async () => {
    const { outer, tenantId } = await boot();
    const res = await outer.request('/api/inventory/locations', { headers: { 'x-tenant-id': tenantId } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('GET /api/dashboard/export returns {data:{metrics:[...]}} for the home tiles', async () => {
    const { outer, tenantId } = await boot();
    const res = await outer.request('/api/dashboard/export', { headers: { 'x-tenant-id': tenantId } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toBeTruthy();
    expect(Array.isArray(body.data.metrics)).toBe(true); // actions view iterates summary.metrics
  });

  it('still enforces the tenant header contract behind the static server', async () => {
    const { outer } = await boot();
    const res = await outer.request('/api/inventory/locations');
    expect(res.status).toBe(401); // verified user credential missing
  });
});
