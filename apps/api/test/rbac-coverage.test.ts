import { afterEach, expect, it } from 'vitest';
import { Hono } from 'hono';
import { asCoreDb, createTenant, createUser, errorHandler } from '@blacklabel/core';
import { createTestDb, type Kysely } from '@blacklabel/db';
import { assignRole, createRole, type WorkforceDatabase, type WorkforcePermission } from '@blacklabel/workforce';
import { grantPermission } from '../../../packages/workforce/src/service';
import { createApp, type PlatformDatabase } from '../src/app';
import { defaultRbacRules, isIndependentAuthRoute, isKnownRbacRoute, rbacGuard } from '../src/rbac';
import routeInventory from '../src/rbac-routes.json';
import { setConfig, CONFIG_KEYS } from '../src/config';
import type { ApiDatabase } from '../src/migrations';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(f => f())); });

async function fixture() {
  const db = createTestDb<PlatformDatabase>(); cleanup.push(() => db.destroy());
  const wf = db as unknown as Kysely<WorkforceDatabase>;
  const sessions = new Map<string, { tenantId: string; userId: string }>();
  const platform = await createApp({ db, adminMasterKey: Buffer.alloc(32, 7), disableRateLimit: true,
    browserSessionUser: async (req, tenantId) => {
      const s = sessions.get(req.headers.get('cookie') ?? ''); return s?.tenantId === tenantId ? s.userId : undefined;
    },
  });
  const tenant = await createTenant(asCoreDb(db), { name: 'RBAC fixture' });
  const { ownerUserId } = await platform.seedTenant(tenant.id);
  const cookies: Record<string, string> = {};
  const users: Record<string, string> = { owner: ownerUserId };
  async function call(role: string, method: string, path: string, body?: unknown, tenantId = tenant.id) {
    return platform.app.request(path, { method, headers: {
      'x-tenant-id': tenantId, 'content-type': 'application/json', 'x-mags-csrf': '1',
      'sec-fetch-site': 'same-origin', cookie: cookies[role] ?? '', 'x-user-id': ownerUserId,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function data(role: string, method: string, path: string, body?: unknown) {
    const r = await call(role, method, path, body); const value = await r.json() as any;
    expect(r.status, `${method} ${path}: ${JSON.stringify(value)}`).toBeLessThan(300); return value.data;
  }
  const boot = await call('owner', 'POST', '/api/pos/auth/bootstrap', { pin: '2468' });
  expect(boot.status).toBe(201); cookies.owner = boot.headers.get('set-cookie')!.split(';')[0];
  const cashier = await data('owner', 'POST', '/api/pos/auth/operators', { name: 'cashier', email: 'cashier@local.invalid', role: 'cashier', pin: '2468' });
  users.cashier = cashier.id;
  const login = await call('owner', 'POST', '/api/pos/auth/session', { userId: cashier.id, pin: '2468' });
  expect(login.status).toBe(201); cookies.cashier = login.headers.get('set-cookie')!.split(';')[0];
  async function addRole(key: string, permissions?: WorkforcePermission[]) {
    const user = await createUser(asCoreDb(db), tenant.id, { name: key, email: `${key}@local.invalid`, role: 'member' });
    const role = permissions ? await createRole(wf, tenant.id, ownerUserId, { key, name: key })
      : await db.selectFrom('workforce_roles').selectAll().where('tenant_id', '=', tenant.id).where('key', '=', key).executeTakeFirstOrThrow();
    for (const p of permissions ?? []) await grantPermission(wf, tenant.id, ownerUserId, role.id, p);
    await assignRole(wf, tenant.id, ownerUserId, user.id, role.id);
    users[key] = user.id; cookies[key] = `verified-fixture=${user.id}`;
    sessions.set(cookies[key], { userId: user.id, tenantId: tenant.id });
  }
  for (const role of ['manager', 'inventory', 'purchasing', 'accountant_readonly']) await addRole(role);
  async function catalog() {
    const p = await data('owner', 'POST', '/api/catalog/products', { sourceItemId: 'fixture', name: 'Fixture' });
    return data('owner', 'POST', '/api/catalog/variations', { productId: p.id, sourceVariationId: 'fixture', priceCents: 100, trackInventory: true });
  }
  return { db, platform, tenant, users, cookies, call, data, addRole, catalog };
}

it('denies unclassified routes even for an owner and without a tenant header', async () => {
  const f = await fixture(); let invoked = 0;
  const app = new Hono(); app.onError(errorHandler);
  app.use('/api/*', rbacGuard(f.db as never, async () => f.users.owner));
  app.post('/api/unclassified-write', c => { invoked++; return c.json({ ok: true }); });
  app.post('/api/catalog/new-sensitive-operation', c => { invoked++; return c.json({ ok: true }); });
  for (const p of ['/api/unclassified-write', '/api/catalog/new-sensitive-operation']) {
    for (const headers of [{}, { 'x-tenant-id': f.tenant.id }]) {
      expect((await app.request(p, { method: 'POST', headers })).status).toBe(403);
    }
  }
  expect(invoked).toBe(0);
});

it('blocks cashier and read-only catalog repricing, archive and inventory flags while retaining lookups', async () => {
  const f = await fixture(); const variation = await f.catalog();
  const before = await f.db.selectFrom('catalog_variations').selectAll().execute();
  for (const role of ['cashier', 'accountant_readonly']) for (const patch of [{ priceCents: 1 }, { archived: true }, { trackInventory: false }]) {
    expect((await f.call(role, 'PATCH', `/api/catalog/variations/${variation.id}`, patch)).status).toBe(403);
  }
  expect(await f.db.selectFrom('catalog_variations').selectAll().execute()).toEqual(before);
  expect((await f.call('cashier', 'GET', `/api/catalog/variations/${variation.id}`)).status).toBe(200);
  expect((await f.call('manager', 'PATCH', `/api/catalog/variations/${variation.id}`, { priceCents: 200 })).status).toBe(200);
});

it('denies employee creation, admin promotion and token issuance and records the verified administrator', async () => {
  const f = await fixture(); await f.addRole('staff_admin', ['workforce.admin']);
  const employee = await f.data('staff_admin', 'POST', '/api/portal-employee/employees', { name: 'Worker', email: 'worker@local.invalid' });
  for (const role of ['cashier', 'manager', 'accountant_readonly']) {
    for (const [method, path, body] of [
      ['POST', '/api/portal-employee/employees', { name: 'forged', email: 'forged@local.invalid', role: 'admin' }],
      ['PATCH', `/api/portal-employee/employees/${employee.id}`, { role: 'admin' }],
      ['POST', `/api/portal-employee/employees/${employee.id}/tokens`, {}],
    ] as const) expect((await f.call(role, method, path, body)).status).toBe(403);
  }
  expect((await f.db.selectFrom('portal_employee_employees').selectAll().execute()).length).toBe(1);
  const token = await f.data('staff_admin', 'POST', `/api/portal-employee/employees/${employee.id}/tokens`, {});
  expect(token.token).toBeTruthy();
  const logs = await f.db.selectFrom('audit_log').selectAll().where('action', 'in', ['portal_employee.employee.created', 'portal_employee.token.issued']).execute();
  expect(logs.length).toBe(2); expect(logs.every(r => r.actor === f.users.staff_admin)).toBe(true);
});

it('protects eligible invoice voiding and sibling financial writes while preserving authorized invoice lifecycle', async () => {
  const f = await fixture(); const invoice = await f.data('owner', 'POST', '/api/billing/invoices', { customerId: 'fixture-customer', lines: [{ description: 'fixture', quantity: 1, unitPriceCents: 100 }] });
  const before = await f.db.selectFrom('billing_invoices').selectAll().execute();
  for (const role of ['cashier', 'manager', 'accountant_readonly']) {
    expect((await f.call(role, 'POST', `/api/billing/invoices/${invoice.id}/void`, {})).status).toBe(403);
    expect((await f.call(role, 'PUT', `/api/billing/invoices/${invoice.id}`, { memo: 'forged' })).status).toBe(403);
  }
  expect(await f.db.selectFrom('billing_invoices').selectAll().execute()).toEqual(before);
  expect((await f.call('accountant_readonly', 'GET', '/api/billing/invoices')).status).toBe(200);
  expect((await f.call('owner', 'POST', `/api/billing/invoices/${invoice.id}/void`, {})).status).toBe(200);
});

it('requires inventory write, count and transfer separately before movements or body-based approval', async () => {
  const f = await fixture(); const variation = await f.catalog();
  const location = await f.data('inventory', 'POST', '/api/inventory/locations', { name: 'Warehouse', kind: 'warehouse' });
  const session = await f.data('inventory', 'POST', '/api/inventory/count-sessions', { locationId: location.id, kind: 'full' });
  const line = await f.data('inventory', 'POST', `/api/inventory/count-sessions/${session.id}/lines`, { variationId: variation.id });
  const before = await f.db.selectFrom('inventory_count_lines').selectAll().execute();
  const movement = { variationId: variation.id, locationId: location.id, delta: 5, reason: 'received' };
  expect((await f.call('cashier', 'POST', '/api/inventory/movements', movement)).status).toBe(403);
  expect((await f.call('cashier', 'PATCH', `/api/inventory/count-sessions/${session.id}/lines/${line.id}`, { countedQty: 5, approved: true })).status).toBe(403);
  expect(await f.db.selectFrom('inventory_count_lines').selectAll().execute()).toEqual(before);
  expect(await f.db.selectFrom('inventory_movements').selectAll().execute()).toEqual([]);
  await f.addRole('stock_writer', ['inventory.write']);
  expect((await f.call('stock_writer', 'POST', '/api/inventory/count-sessions', { locationId: location.id, kind: 'cycle' })).status).toBe(403);
  expect((await f.call('stock_writer', 'POST', '/api/inventory/transfers', {})).status).toBe(403);
  expect((await f.call('stock_writer', 'POST', '/api/inventory/movements', movement)).status).toBe(201);
  expect((await f.call('inventory', 'PATCH', `/api/inventory/count-sessions/${session.id}/lines/${line.id}`, { countedQty: 5, approved: true })).status).toBe(200);
});

it('denies purchasing writes before PO rows or receiving inventory effects, preserving purchasing approvals', async () => {
  const f = await fixture(); const variation = await f.catalog();
  const vendor = await f.data('owner', 'POST', '/api/vendors/vendors', { name: 'Fixture vendor' });
  const input = { vendorId: vendor.id, lines: [{ variationId: variation.id, qtyOrdered: 5, unitCostCents: 100 }] };
  expect((await f.call('cashier', 'POST', '/api/purchasing/purchase-orders', input)).status).toBe(403);
  const po = await f.data('purchasing', 'POST', '/api/purchasing/purchase-orders', input);
  await f.data('purchasing', 'POST', `/api/purchasing/purchase-orders/${po.id}/submit`, {});
  expect((await f.call('cashier', 'POST', `/api/purchasing/purchase-orders/${po.id}/approve`, {})).status).toBe(403);
  await f.data('purchasing', 'POST', `/api/purchasing/purchase-orders/${po.id}/approve`, {});
  await f.data('purchasing', 'POST', `/api/purchasing/purchase-orders/${po.id}/send`, {});
  const location = await f.data('inventory', 'POST', '/api/inventory/locations', { name: 'Receiving', kind: 'warehouse' });
  await setConfig(f.db as unknown as Kysely<ApiDatabase>, f.tenant.id, CONFIG_KEYS.defaultLocation, location.id);
  const line = await f.db.selectFrom('purchasing_po_lines').selectAll().where('purchase_order_id', '=', po.id).executeTakeFirstOrThrow();
  const receipt = { lines: [{ poLineId: line.id, qtyReceived: 5, condition: 'ok' }] };
  const before = await f.db.selectFrom('purchasing_purchase_orders').selectAll().execute();
  expect((await f.call('cashier', 'POST', `/api/purchasing/purchase-orders/${po.id}/receipts`, receipt)).status).toBe(403);
  expect(await f.db.selectFrom('purchasing_purchase_orders').selectAll().execute()).toEqual(before);
  expect(await f.db.selectFrom('inventory_movements').selectAll().execute()).toEqual([]);
  const received = await f.data('purchasing', 'POST', `/api/purchasing/purchase-orders/${po.id}/receipts`, receipt);
  expect(received.purchaseOrder.status).toBe('received');
  const movement = await f.db.selectFrom('inventory_movements').selectAll().executeTakeFirstOrThrow();
  expect(movement.delta).toBe(5); expect(movement.location_id).toBe(location.id);
});

it('denies workforce publication overrides, time exports and handoffs and preserves authenticated audit actors', async () => {
  const f = await fixture(); await f.addRole('staff_admin', ['workforce.admin']);
  const body = { userId: f.users.cashier, startsAt: '2026-10-01T12:00:00Z', endsAt: '2026-10-01T16:00:00Z', kind: 'shop', published: true, override: true };
  expect((await f.call('cashier', 'POST', '/api/workforce/schedules', body)).status).toBe(403);
  const schedule = await f.data('staff_admin', 'POST', '/api/workforce/schedules', body);
  expect((await f.call('manager', 'POST', `/api/workforce/schedules/${schedule.id}/publish`, { override: true })).status).toBe(403);
  expect((await f.call('cashier', 'POST', '/api/workforce/time-exports', { rows: [] })).status).toBe(403);
  expect((await f.call('cashier', 'POST', '/api/workforce/handoffs', { fromUser: f.users.owner, body: 'forged' })).status).toBe(403);
  const log = await f.db.selectFrom('audit_log').selectAll().where('action', '=', 'workforce.schedule.created').executeTakeFirstOrThrow();
  expect(log.actor).toBe(f.users.staff_admin);
});

it('requires show-close authority for financial closeout and closing transitions', async () => {
  const f = await fixture(); await f.addRole('show_writer', ['shows.read', 'shows.write']);
  const venue = await f.data('manager', 'POST', '/api/shows/venues', { name: 'Fixture venue', state: 'GA' });
  const input = { venueId: venue.id, name: 'Fixture show', startsOn: '2026-10-01', endsOn: '2026-10-02' };
  expect((await f.call('cashier', 'POST', '/api/shows/shows', input)).status).toBe(403);
  const show = await f.data('show_writer', 'POST', '/api/shows/shows', input);
  expect((await f.call('show_writer', 'PATCH', `/api/shows/shows/${show.id}/closeout`, { cashCountedCents: 10 })).status).toBe(403);
  expect((await f.call('show_writer', 'POST', `/api/shows/shows/${show.id}/transition`, { to: 'closing' })).status).toBe(403);
  expect((await f.call('show_writer', 'POST', `/api/shows/shows/${show.id}/transition`, { to: 'packing' })).status).toBe(200);
});

it('requires action write authority and assignment ownership, preserving owner and own-action operations', async () => {
  const f = await fixture(); await f.addRole('action_writer', ['actions.read', 'actions.write']);
  const opened = await f.data('owner', 'POST', '/api/actions', { kind: 'setup_required', priority: 'p2', title: 'Owner fixture', dedupeKey: 'owner-fixture', ownerUserId: f.users.owner });
  const action = opened;
  for (const role of ['cashier', 'action_writer']) for (const [operation, body] of [
    ['resolve', { kind: 'manual' }], ['snooze', { until: '2027-01-01T00:00:00Z', reason: 'fixture' }], ['assign', { ownerUserId: f.users[role] }],
  ] as const) expect((await f.call(role, 'POST', `/api/actions/${action.id}/${operation}`, body)).status).toBe(403);
  expect((await f.db.selectFrom('actions_actions').selectAll().where('id', '=', action.id).executeTakeFirstOrThrow()).status).toBe('open');
  await f.data('owner', 'POST', `/api/actions/${action.id}/assign`, { ownerUserId: f.users.action_writer });
  expect((await f.call('action_writer', 'POST', `/api/actions/${action.id}/resolve`, { kind: 'manual' })).status).toBe(200);
});

it('requires a reviewed disposition for every assembled API handler and preserves explicit independent auth', async () => {
  const f = await fixture(); const rules = defaultRbacRules();
  const reviewed = new Set(routeInventory.map(([method, path]) => `${method} ${path}`));
  for (const route of f.platform.app.routes.filter(r => r.method !== 'ALL' && r.path.startsWith('/api/'))) {
    expect(reviewed.has(`${route.method} ${route.path}`), `unreviewed ${route.method} ${route.path}`).toBe(true);
    const path = route.path.replace(/:[^/]+/g, 'fixture').replace(/\*/g, 'fixture');
    expect(isKnownRbacRoute(route.method, path), path).toBe(true);
    expect(isIndependentAuthRoute(route.method, path) || rules.some(rule => rule.test(route.method, path)), path).toBe(true);
  }
  expect((await f.platform.app.request('/api/health')).status).toBe(200);
  expect((await f.call('cashier', 'HEAD', '/api/catalog/variations')).status).toBe(200);
  for (const path of ['/api/customers/export', '/api/admin-new', '/api/pos/auth/admin-bypass']) {
    expect((await f.call('owner', 'POST', path, {})).status).toBe(403);
  }
});

it.each(['cashier', 'accountant_readonly'])('%s cannot mutate any mounted sibling endpoint in the reported modules', async role => {
  const f = await fixture();
  const modules = new Set(['catalog', 'inventory', 'purchasing', 'vendors', 'billing', 'shows', 'workforce', 'portal-employee', 'actions']);
  const routes = [...new Map(f.platform.app.routes.filter(r => r.method !== 'ALL' && !['GET', 'HEAD', 'OPTIONS'].includes(r.method)
    && modules.has(r.path.split('/')[2]) && !r.path.startsWith('/api/portal-employee/portal')).map(r => [`${r.method} ${r.path}`, r])).values()];
  expect(routes.length).toBeGreaterThanOrEqual(135);
  const audit = await f.db.selectFrom('audit_log').selectAll().execute();
  for (const route of routes) {
    const path = route.path.replace(/:[^/]+/g, 'fixture');
    const res = await f.call(role, route.method, path, { approved: true, override: true, published: true, to: 'closed' });
    expect(res.status, `${role} ${route.method} ${path}: ${await res.text()}`).toBe(403);
  }
  expect(await f.db.selectFrom('audit_log').selectAll().execute()).toEqual(audit);
});

it('keeps action assignment and dedupe edits tenant-bound and prevents cross-owner evidence replacement', async () => {
  const f = await fixture(); await f.addRole('action_writer', ['actions.write']);
  const input = { kind: 'setup_required', priority: 'p2', title: 'Private action', dedupeKey: 'private', ownerUserId: f.users.owner, evidence: { untouched: true } };
  const action = await f.data('owner', 'POST', '/api/actions', input);
  expect((await f.call('action_writer', 'POST', '/api/actions', { ...input, ownerUserId: null, evidence: { forged: true } })).status).toBe(403);
  const other = await createTenant(asCoreDb(f.db), { name: 'Other tenant' });
  const outsider = await createUser(asCoreDb(f.db), other.id, { name: 'Other user', email: 'other@local.invalid', role: 'owner' });
  expect((await f.call('owner', 'POST', `/api/actions/${action.id}/assign`, { ownerUserId: outsider.id })).status).toBe(404);
  const row = await f.db.selectFrom('actions_actions').selectAll().where('id', '=', action.id).executeTakeFirstOrThrow();
  expect(row.owner_user_id).toBe(f.users.owner); expect(JSON.parse(row.evidence!)).toEqual({ untouched: true });
});
