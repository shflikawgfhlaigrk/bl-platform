import { authenticatedFixture } from './authenticated-fixture';
import { afterEach, expect, it } from 'vitest';
import { Hono } from 'hono';
import { asCoreDb, createTenant, createUser, errorHandler } from '@blacklabel/core';
import { createTestDb, type Kysely } from '@blacklabel/db';
import { assignRole, createRole, type WorkforceDatabase } from '@blacklabel/workforce';
import { grantPermission } from '../../../packages/workforce/src/service';
import { createApp, type PlatformDatabase } from '../src/app';
import { rbacGuard } from '../src/rbac';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(f => f())); });

async function fixture() {
  const db = createTestDb<PlatformDatabase>(); cleanup.push(() => db.destroy());
  const wf = db as unknown as Kysely<WorkforceDatabase>;
  const platform = await createApp({ db, adminMasterKey: Buffer.alloc(32, 7), disableRateLimit: true });
  authenticatedFixture(platform);
  const tenant = await createTenant(asCoreDb(db), { name: 'F065 fixture' });
  const owner = await platform.seedTenant(tenant.id); const users: Record<string, string> = { owner: owner.ownerUserId };
  for (const key of ['manager', 'accountant_readonly', 'finance_writer']) {
    const user = await createUser(asCoreDb(db), tenant.id, { name: key, email: `${key}@local.invalid`, role: 'member' });
    const role = key === 'finance_writer' ? await createRole(wf, tenant.id, owner.ownerUserId, { key, name: key })
      : await db.selectFrom('workforce_roles').selectAll().where('tenant_id', '=', tenant.id).where('key', '=', key).executeTakeFirstOrThrow();
    if (key === 'finance_writer') await grantPermission(wf, tenant.id, owner.ownerUserId, role.id, 'finance.write');
    await assignRole(wf, tenant.id, owner.ownerUserId, user.id, role.id); users[key] = user.id;
  }
  // This worktree still trusts local caller identity. F064 tracks authentication separately.
  const call = (role: string, method: string, path: string, body?: unknown) => platform.app.request(path, { method,
    headers: { 'x-tenant-id': tenant.id, 'x-user-id': users[role], 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { db, platform, tenant, users, call };
}

it.each(['manager', 'accountant_readonly'])('%s cannot mutate any mounted finance/admin endpoint with read grants', async role => {
  const f = await fixture();
  const created = await f.call('owner', 'POST', '/api/admin/credentials', { name: 'fixture', provider: 'custom', payload: { apiKey: 'fixture-secret' } });
  expect(created.status).toBe(201); const id = (await created.json() as any).data.id;
  const rows = await f.db.selectFrom('admin_credentials').selectAll().execute();
  const audit = await f.db.selectFrom('audit_log').selectAll().execute();
  const routes = f.platform.app.routes.filter(r => r.method !== 'ALL' && !['GET', 'HEAD'].includes(r.method)
    && /^\/api\/(?:finance|admin)\//.test(r.path) && r.path !== '/api/finance/margin');
  expect(routes.length).toBeGreaterThanOrEqual(20);
  for (const route of routes) {
    const path = route.path.replace(/:[^/]+/g, id);
    expect((await f.call(role, route.method, path, { payload: { apiKey: 'forged' }, rows: [] })).status, `${route.method} ${path}`).toBe(403);
  }
  expect(await f.db.selectFrom('admin_credentials').selectAll().execute()).toEqual(rows);
  expect(await f.db.selectFrom('audit_log').selectAll().execute()).toEqual(audit);
  const read = await f.call(role, 'GET', '/api/admin/credentials'); expect(read.status).toBe(200); expect(await read.text()).not.toContain('fixture-secret');
  expect((await f.call(role, 'GET', '/api/finance/exports/payments.csv')).status).toBe(200);
  expect((await f.call(role, 'POST', '/api/finance/margin', { lines: [] })).status).toBe(200);
});

it('requires finance.close independently and retains authorized finance and credential operations', async () => {
  const f = await fixture();
  const open = await f.call('finance_writer', 'POST', '/api/finance/cash-sessions', { openedBy: 'fixture', openingFloatCents: 100 });
  expect(open.status).toBe(201); const session = (await open.json() as any).data;
  expect((await f.call('finance_writer', 'PUT', `/api/finance/cash-sessions/${session.id}/expected`, { expectedCents: 100 })).status).toBe(200);
  expect((await f.call('finance_writer', 'POST', `/api/finance/cash-sessions/${session.id}/close`, { closedBy: 'fixture', countedCents: 100 })).status).toBe(403);
  expect((await f.call('owner', 'POST', `/api/finance/cash-sessions/${session.id}/close`, { closedBy: 'fixture', countedCents: 100 })).status).toBe(200);
  const created = await f.call('owner', 'POST', '/api/admin/credentials', { name: 'fixture', provider: 'custom', payload: { apiKey: 'fixture' } });
  expect(created.status).toBe(201); const id = (await created.json() as any).data.id;
  expect((await f.call('owner', 'POST', `/api/admin/credentials/${id}/rotate`, { payload: { apiKey: 'new-fixture' } })).status).toBe(201);
  expect((await f.call('owner', 'DELETE', `/api/admin/credentials/${id}`)).status).toBe(200);
});

it('denies unknown privileged methods and paths even for the owner', async () => {
  const f = await fixture(); let calls = 0; const app = new Hono(); app.onError(errorHandler);
  app.use('/api/*', rbacGuard(f.db as never, async () => f.users.owner));
  app.post('/api/admin/unreviewed', c => { calls++; return c.json({ ok: true }); });
  app.post('/api/finance/unreviewed', c => { calls++; return c.json({ ok: true }); });
  for (const path of ['/api/admin/unreviewed', '/api/finance/unreviewed']) {
    expect((await app.request(path, { method: 'POST', headers: { 'x-tenant-id': f.tenant.id } })).status).toBe(403);
  }
  expect(calls).toBe(0);
});
