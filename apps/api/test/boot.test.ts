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
import { createTestDb } from '@blacklabel/db';
import { createApp, MODULE_KEYS, type PlatformDatabase } from '../src/app';

async function boot() {
  const db = createTestDb<PlatformDatabase>();
  const platform = await createApp({ db });
  const tenant = await createTenant(asCoreDb(db), { name: 'Boot Tenant' });
  return { platform, tenantId: tenant.id };
}

describe('api composition root (createApp)', () => {
  it('serves /api/health and lists every module', async () => {
    const { platform } = await boot();
    const res = await platform.app.request('/api/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('ok');
    expect(body.data.modules).toEqual([...MODULE_KEYS]);
  });

  it('enforces the tenant header contract', async () => {
    const { platform, tenantId } = await boot();

    const missing = await platform.app.request('/api/scheduling/calendars');
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe('tenant_header_missing');

    const unknown = await platform.app.request('/api/scheduling/calendars', {
      headers: { 'x-tenant-id': 'no-such-tenant' },
    });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.code).toBe('tenant_unknown');

    const ok = await platform.app.request('/api/scheduling/calendars', {
      headers: { 'x-tenant-id': tenantId },
    });
    expect(ok.status).toBe(200);
  });

  it('mounts and serves every V1 module route (200 with a valid tenant)', async () => {
    const { platform, tenantId } = await boot();
    const routes = [
      '/api/crm/companies',
      '/api/scheduling/calendars',
      '/api/messaging/channels',
      '/api/reviews/platforms',
      '/api/industries',
    ];
    for (const path of routes) {
      const res = await platform.app.request(path, {
        headers: { 'x-tenant-id': tenantId },
      });
      expect(res.status, `${path} should serve 200`).toBe(200);
    }
  });
});
