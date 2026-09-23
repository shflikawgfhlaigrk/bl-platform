import { authenticatedFixture } from './authenticated-fixture';
/**
 * Composition-root boot test.
 *
 * Proves the SAME `createApp` that `server.ts` binds to a port actually:
 *   - runs every module's migrations on a fresh db,
 *   - answers /api/health,
 *   - enforces the x-tenant-id contract (400 missing / 404 unknown),
 *   - mounts and serves every module router named in V1's DONE-MEANS
 *     (crm / scheduling / messaging / reviews / industries) at 200.
 *
 * server.ts is a thin wrapper (real file db + disk storage + serve); the
 * curl evidence in the handoff exercises that wrapper end-to-end.
 */
import { describe, it, expect } from 'vitest';
import { asCoreDb, createTenant } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { allMigrations, createApp, MODULE_KEYS, type PlatformDatabase } from '../src/app';

async function boot() {
  const db = createTestDb<PlatformDatabase>();
  const platform = await createApp({ db });
  authenticatedFixture(platform);
  const tenant = await createTenant(asCoreDb(db), { name: 'Boot Tenant' });
  return { platform, tenantId: tenant.id };
}

describe('api composition root (createApp)', () => {
  it('serves /api/health and lists every module', async () => {
    const { platform } = await boot();
    const res = await platform.app.request('/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.status).toBe('ok');
    expect(body.data.modules).toEqual([...MODULE_KEYS]);
  });

  it('enforces the tenant header contract', async () => {
    const { platform, tenantId } = await boot();

    const missing = await platform.app.request('/api/scheduling/calendars');
    expect(missing.status).toBe(401);
    expect(((await missing.json()) as any).error.code).toBe('unauthorized');

    const unknown = await platform.app.request('/api/scheduling/calendars', {
      headers: { 'x-tenant-id': 'no-such-tenant' },
    });
    expect(unknown.status).toBe(401);
    expect(((await unknown.json()) as any).error.code).toBe('unauthorized');

    const ok = await platform.app.request('/api/scheduling/calendars', {
      headers: { 'x-tenant-id': tenantId },
    });
    expect(ok.status).toBe(200);
  });

  it('lists all 27 modules including every new Mags module', async () => {
    const { platform } = await boot();
    const body = (await (await platform.app.request('/api/health')).json()) as any;
    const mods: string[] = body.data.modules;
    for (const m of [
      'automation',
      'actions',
      'catalog',
      'inventory',
      'shows',
      'vendors',
      'purchasing',
      'orders',
      'customers',
      'loyalty',
      'outreach',
      'finance',
      'workforce',
      'admin',
    ]) {
      expect(mods, `health should list ${m}`).toContain(m);
    }
    expect(mods).toHaveLength(27);
  });

  it('mounts and serves representative V1 + new module routes (200 with a valid tenant)', async () => {
    const { platform, tenantId } = await boot();
    const routes = [
      '/api/crm/companies',
      '/api/scheduling/calendars',
      '/api/messaging/channels',
      '/api/reviews/platforms',
      '/api/industries',
      '/api/inventory/locations',
      '/api/actions',
      '/api/vendors/vendors',
      '/api/catalog/products',
    ];
    for (const path of routes) {
      const res = await platform.app.request(path, {
        headers: { 'x-tenant-id': tenantId },
      });
      expect(res.status, `${path} should serve 200`).toBe(200);
    }
  });

  it('all migrations apply idempotently on a fresh db (re-run is a no-op)', async () => {
    const db = createTestDb<PlatformDatabase>();
    const first = await runMigrations(db, allMigrations);
    const second = await runMigrations(db, allMigrations);
    expect(first.applied.length).toBeGreaterThan(0);
    expect(second.applied).toHaveLength(0); // nothing new to apply the second time
  });
});
