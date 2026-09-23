import { authenticatedFixture } from './authenticated-fixture';
/**
 * Security hardening + RBAC (journey 18) at the composition root.
 */
import { describe, it, expect } from 'vitest';
import { asCoreDb, createTenant, createUser, id, nowIso } from '@blacklabel/core';
import { createTestDb } from '@blacklabel/db';
import type { WorkforceDatabase } from '@blacklabel/workforce';
import { createApp, type CreateAppOptions, type PlatformDatabase } from '../src/app';

const KEY = Buffer.alloc(32, 7);

async function boot(opts: Partial<CreateAppOptions> = {}) {
  const db = createTestDb<PlatformDatabase>();
  const platform = await createApp({ db, adminMasterKey: KEY, ...opts });
  authenticatedFixture(platform);
  const tenant = await createTenant(asCoreDb(db), { name: 'Sec Tenant' });
  return { platform, db, tenantId: tenant.id };
}

describe('security headers', () => {
  it('sets CSP / nosniff / no-referrer / DENY on every response', async () => {
    const { platform } = await boot();
    const res = await platform.app.request('/api/health');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('x-correlation-id')).toBeTruthy();
  });
});

describe('static serving fallback', () => {
  it('GET / returns the honest api-only JSON when no UI is configured', async () => {
    const { platform } = await boot();
    const res = await platform.app.request('/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'api-only' });
  });
});

describe('origin / CSRF', () => {
  it('rejects a cross-origin browser mutation 403 but allows a loopback tool call', async () => {
    const { platform, tenantId } = await boot();

    // Cross-origin browser mutation (Origin present, foreign host, no CSRF header).
    const blocked = await platform.app.request('/api/inventory/locations', {
      method: 'POST',
      headers: {
        'x-tenant-id': tenantId,
        'content-type': 'application/json',
        Origin: 'http://evil.example',
      },
      body: JSON.stringify({ name: 'WH', kind: 'warehouse' }),
    });
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe('csrf_blocked');

    // Loopback tool: no Origin header → allowed → real 201.
    const ok = await platform.app.request('/api/inventory/locations', {
      method: 'POST',
      headers: { 'x-tenant-id': tenantId, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'WH', kind: 'warehouse' }),
    });
    expect(ok.status).toBe(201);

    // Cross-origin but carrying the custom header → allowed.
    const csrfd = await platform.app.request('/api/inventory/locations', {
      method: 'POST',
      headers: {
        'x-tenant-id': tenantId,
        'content-type': 'application/json',
        Origin: 'http://evil.example',
        'x-mags-csrf': '1',
      },
      body: JSON.stringify({ name: 'WH2', kind: 'warehouse' }),
    });
    expect(csrfd.status).toBe(201);
  });
});

describe('rate limiting', () => {
  it('returns 429 once the per-route-group bucket is exhausted (injected clock)', async () => {
    const { platform } = await boot({ rateLimit: { generalPerMinute: 3, now: () => 1000 } });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await platform.app.request('/api/health')).status);
    }
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes[3]).toBe(429);
    expect(codes[4]).toBe(429);
  });
});

describe('RBAC (journey 18)', () => {
  async function assignCashier(db: unknown, tenantId: string): Promise<string> {
    const wdb = db as import('kysely').Kysely<WorkforceDatabase>;
    const user = await createUser(asCoreDb(db as never), tenantId, {
      name: 'Casey Cashier',
      email: 'cashier@local.invalid',
      role: 'member',
    });
    const role = await wdb
      .selectFrom('workforce_roles')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('key', '=', 'cashier')
      .executeTakeFirstOrThrow();
    await wdb
      .insertInto('workforce_user_roles')
      .values({ id: id(), tenant_id: tenantId, user_id: user.id, role_id: role.id, created_at: nowIso() })
      .execute();
    return user.id;
  }

  const GUARDED: { method: string; path: string; body?: unknown }[] = [
    { method: 'POST', path: '/api/purchasing/purchase-orders/nope/approve', body: {} },
    { method: 'GET', path: '/api/customers/export' },
    { method: 'GET', path: '/api/finance/cash-sessions' },
    { method: 'GET', path: '/api/admin/credentials' },
  ];

  it('denies a cashier on guarded routes and allows the owner', async () => {
    const { platform, db, tenantId } = await boot();
    await platform.seedTenant(tenantId); // owner + built-in roles
    const cashierId = await assignCashier(db, tenantId);

    for (const r of GUARDED) {
      const init: RequestInit = {
        method: r.method,
        headers: { 'x-tenant-id': tenantId, 'x-user-id': cashierId, 'content-type': 'application/json' },
        ...(r.body !== undefined ? { body: JSON.stringify(r.body) } : {}),
      };
      const denied = await platform.app.request(r.path, init);
      expect(denied.status, `cashier should be 403 on ${r.method} ${r.path}`).toBe(403);
    }

    // Owner (default acting user — no x-user-id) passes the guard (any non-403).
    for (const r of GUARDED) {
      const init: RequestInit = {
        method: r.method,
        headers: { 'x-tenant-id': tenantId, 'content-type': 'application/json' },
        ...(r.body !== undefined ? { body: JSON.stringify(r.body) } : {}),
      };
      const res = await platform.app.request(r.path, init);
      expect(res.status, `owner should pass the guard on ${r.method} ${r.path}`).not.toBe(403);
    }
  });
});
