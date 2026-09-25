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
  const tenant = await createTenant(asCoreDb(db), { name: 'Sec Tenant' });
  return { platform, db, tenantId: tenant.id };
}

describe('security headers', () => {
  it('sets CSP / nosniff / no-referrer / DENY on every response', async () => {
    const { platform } = await boot();
    const res = await platform.app.request('/api/health');
    const csp = res.headers.get('Content-Security-Policy');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("script-src 'unsafe-inline'");
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
  it('rejects cross-origin CSRF, allows loopback tools, and still requires a signed browser session', async () => {
    const { platform, tenantId } = await boot();
    await platform.seedTenant(tenantId);

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

    // The CSRF header clears the origin gate, but it is not authentication.
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
    expect(csrfd.status).toBe(401);

    const signedIn = await platform.app.request('/api/pos/auth/bootstrap', {
      method: 'POST',
      headers: {
        'x-tenant-id': tenantId,
        'content-type': 'application/json',
        'x-mags-csrf': '1',
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({ pin: '2468' }),
    });
    expect(signedIn.status).toBe(201);
    const cookie = signedIn.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toBeTruthy();

    // Cross-origin + explicit CSRF proof + an authenticated operator is allowed.
    const authenticated = await platform.app.request('/api/inventory/locations', {
      method: 'POST',
      headers: {
        'x-tenant-id': tenantId,
        'content-type': 'application/json',
        Origin: 'http://evil.example',
        'x-mags-csrf': '1',
        cookie: String(cookie),
      },
      body: JSON.stringify({ name: 'WH3', kind: 'warehouse' }),
    });
    expect(authenticated.status).toBe(201);
  });
});

describe('rate limiting', () => {
  it('returns 429 once the per-source bucket is exhausted (injected clock)', async () => {
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
  async function assignRole(
    db: unknown,
    tenantId: string,
    roleKey: 'cashier' | 'manager' | 'inventory',
  ): Promise<string> {
    const wdb = db as import('kysely').Kysely<WorkforceDatabase>;
    const user = await createUser(asCoreDb(db as never), tenantId, {
      name: `Security ${roleKey}`,
      email: `${roleKey}@local.invalid`,
      role: 'member',
    });
    const role = await wdb
      .selectFrom('workforce_roles')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('key', '=', roleKey)
      .executeTakeFirstOrThrow();
    await wdb
      .insertInto('workforce_user_roles')
      .values({ id: id(), tenant_id: tenantId, user_id: user.id, role_id: role.id, created_at: nowIso() })
      .execute();
    return user.id;
  }

  const GUARDED: { method: string; path: string; body?: unknown }[] = [
    { method: 'POST', path: '/api/purchasing/purchase-orders/nope/approve', body: {} },
    { method: 'GET', path: '/api/finance/cash-sessions' },
    { method: 'GET', path: '/api/admin/credentials' },
    { method: 'POST', path: '/api/automation/rules', body: {} },
    { method: 'POST', path: '/api/automation/evaluate', body: {} },
    { method: 'POST', path: '/api/automation/outbox/nope/replay', body: {} },
    { method: 'POST', path: '/api/automation/outbox/nope/cancel', body: {} },
    { method: 'POST', path: '/api/automation/outbox/run-once', body: {} },
    { method: 'POST', path: '/api/billing/invoices/nope/payments', body: { amountCents: 100 } },
    { method: 'GET', path: '/api/scheduling/staff' },
    { method: 'POST', path: '/api/scheduling/staff', body: {} },
  ];

  const AUTOMATION_ADMIN_GUARDED = [
    '/api/automation/rules',
    '/api/automation/evaluate',
    '/api/automation/approvals/nope/approve',
    '/api/automation/approvals/nope/reject',
    '/api/automation/outbox/nope/replay',
    '/api/automation/outbox/nope/cancel',
    '/api/automation/outbox/run-once',
  ];

  it('denies a cashier on guarded routes and allows the owner', async () => {
    const { platform, db, tenantId } = await boot();
    await platform.seedTenant(tenantId); // owner + built-in roles
    const cashierId = await assignRole(db, tenantId, 'cashier');

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

  it('requires automation.admin even when the user has unrelated approval permissions', async () => {
    const { platform, db, tenantId } = await boot();
    await platform.seedTenant(tenantId);
    const managerId = await assignRole(db, tenantId, 'manager');

    for (const path of AUTOMATION_ADMIN_GUARDED) {
      const denied = await platform.app.request(path, {
        method: 'POST',
        headers: { 'x-tenant-id': tenantId, 'x-user-id': managerId, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(denied.status, `manager should be 403 on POST ${path}`).toBe(403);
    }
  });

  it('separates order reads, register writes, and refunds by permission', async () => {
    const { platform, db, tenantId } = await boot();
    await platform.seedTenant(tenantId);
    const cashierId = await assignRole(db, tenantId, 'cashier');
    const inventoryId = await assignRole(db, tenantId, 'inventory');
    const headers = (userId: string) => ({
      'x-tenant-id': tenantId,
      'x-user-id': userId,
      'content-type': 'application/json',
      'x-mags-csrf': '1',
    });

    const cashierRead = await platform.app.request('/api/orders/orders', {
      headers: headers(cashierId),
    });
    expect(cashierRead.status).toBe(200);

    const cashierCreate = await platform.app.request('/api/orders/orders', {
      method: 'POST',
      headers: headers(cashierId),
      body: JSON.stringify({ channel: 'pos', lines: [] }),
    });
    expect(cashierCreate.status).toBe(403);

    const cashierReprice = await platform.app.request('/api/orders/orders/nope', {
      method: 'PUT',
      headers: headers(cashierId),
      body: JSON.stringify({ lines: [{ description: 'repriced', qty: 1, unitPriceCents: 1 }] }),
    });
    expect(cashierReprice.status).toBe(403);

    const cashierPosCreate = await platform.app.request('/api/pos/orders', {
      method: 'POST',
      headers: headers(cashierId),
      body: JSON.stringify({ cartId: 'cashier-cart', lines: [{ description: 'x', qty: 1, unitPriceCents: 1 }] }),
    });
    expect(cashierPosCreate.status).not.toBe(403);

    const cashierRefund = await platform.app.request('/api/orders/orders/nope/refunds', {
      method: 'POST',
      headers: headers(cashierId),
      body: JSON.stringify({}),
    });
    expect(cashierRefund.status).toBe(403);

    const cashierPosRefund = await platform.app.request('/api/pos/orders/nope/refunds', {
      method: 'POST',
      headers: headers(cashierId),
      body: JSON.stringify({}),
    });
    expect(cashierPosRefund.status).toBe(403);

    const cashierGenericPay = await platform.app.request('/api/orders/orders/nope/pay', {
      method: 'POST',
      headers: headers(cashierId),
      body: JSON.stringify({ tenders: [] }),
    });
    expect(cashierGenericPay.status).toBe(403);

    const cashierPosPay = await platform.app.request('/api/pos/orders/nope/pay', {
      method: 'POST',
      headers: headers(cashierId),
      body: JSON.stringify({ tenders: [] }),
    });
    expect(cashierPosPay.status).not.toBe(403);

    const inventoryRead = await platform.app.request('/api/orders/orders', {
      headers: headers(inventoryId),
    });
    expect(inventoryRead.status).toBe(403);

    const ownerRefund = await platform.app.request('/api/orders/orders/nope/refunds', {
      method: 'POST',
      headers: { 'x-tenant-id': tenantId, 'content-type': 'application/json', 'x-mags-csrf': '1' },
      body: JSON.stringify({}),
    });
    expect(ownerRefund.status).not.toBe(403);

    const ownerPosRefund = await platform.app.request('/api/pos/orders/nope/refunds', {
      method: 'POST',
      headers: { 'x-tenant-id': tenantId, 'content-type': 'application/json', 'x-mags-csrf': '1' },
      body: JSON.stringify({}),
    });
    expect(ownerPosRefund.status).not.toBe(403);
  });

  it('keeps POS finance and reconciliation controls out of the cashier role', async () => {
    const { platform, db, tenantId } = await boot();
    await platform.seedTenant(tenantId);
    const cashierId = await assignRole(db, tenantId, 'cashier');
    const managerId = await assignRole(db, tenantId, 'manager');
    const headers = (userId: string) => ({
      'x-tenant-id': tenantId,
      'x-user-id': userId,
      'content-type': 'application/json',
      'x-mags-csrf': '1',
    });

    for (const path of ['/api/pos/finance/summary', '/api/pos/reconciliation']) {
      const denied = await platform.app.request(path, { headers: headers(cashierId) });
      expect(denied.status, `cashier should be 403 on GET ${path}`).toBe(403);

      const managerRead = await platform.app.request(path, { headers: headers(managerId) });
      expect(managerRead.status, `manager should read GET ${path}`).toBe(200);
    }

    const managerDrain = await platform.app.request('/api/pos/reconciliation/drain', {
      method: 'POST',
      headers: headers(managerId),
      body: '{}',
    });
    expect(managerDrain.status).toBe(403);

    const ownerDrain = await platform.app.request('/api/pos/reconciliation/drain', {
      method: 'POST',
      headers: { 'x-tenant-id': tenantId, 'content-type': 'application/json', 'x-mags-csrf': '1' },
      body: '{}',
    });
    expect(ownerDrain.status).not.toBe(403);
  });
});
