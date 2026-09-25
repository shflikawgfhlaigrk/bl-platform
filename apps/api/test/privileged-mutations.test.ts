import { afterEach, expect, it } from 'vitest';
import { asCoreDb, createTenant, createUser } from '@blacklabel/core';
import { createTestDb, type Kysely } from '@blacklabel/db';
import { assignRole, createRole, type WorkforceDatabase } from '@blacklabel/workforce';
import { grantPermission } from '../../../packages/workforce/src/service';
import { createApp, type PlatformDatabase } from '../src/app';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(f => f())); });
type Role = 'owner' | 'manager' | 'cashier' | 'purchasing' | 'accountant_readonly' | 'finance_writer';

async function fixture() {
  const db = createTestDb<PlatformDatabase>(); cleanup.push(() => db.destroy());
  const workforce = db as unknown as Kysely<WorkforceDatabase>;
  // Non-POS roles use the supported server-verified browser-session callback.
  const sessions = new Map<string, { userId: string; tenantId: string }>();
  const platform = await createApp({ db, adminMasterKey: Buffer.alloc(32, 9), disableRateLimit: true,
    browserSessionUser: async (request, tenantId) => { const s = sessions.get(request.headers.get('cookie') ?? ''); return s?.tenantId === tenantId ? s.userId : undefined; },
  });
  const tenant = await createTenant(asCoreDb(db), { name: 'Role mutation fixture' });
  const seeded = await platform.seedTenant(tenant.id);
  const cookies: Partial<Record<Role, string>> = {};
  async function call(role: Role, method: string, path: string, body?: unknown, tenantId = tenant.id) {
    return platform.app.request(path, { method, headers: {
      'x-tenant-id': tenantId, 'content-type': 'application/json', 'x-mags-csrf': '1', 'sec-fetch-site': 'same-origin',
      cookie: cookies[role] ?? '',
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  const boot = await call('owner', 'POST', '/api/pos/auth/bootstrap', { pin: '2468' });
  expect(boot.status).toBe(201); cookies.owner = boot.headers.get('set-cookie')!.split(';')[0];
  for (const role of ['cashier', 'manager'] as const) {
    const res = await call('owner', 'POST', '/api/pos/auth/operators', { name: role, email: `${role}@local.invalid`, role, pin: '2468' });
    expect(res.status).toBe(201); const user = ((await res.json()) as any).data;
    const login = await call('owner', 'POST', '/api/pos/auth/session', { userId: user.id, pin: '2468' });
    expect(login.status).toBe(201); cookies[role] = login.headers.get('set-cookie')!.split(';')[0];
  }
  for (const role of ['purchasing', 'accountant_readonly', 'finance_writer'] as const) {
    const user = await createUser(asCoreDb(db), tenant.id, { name: role, email: `${role}@local.invalid`, role: 'member' });
    const assigned = role === 'finance_writer'
      ? await createRole(workforce, tenant.id, seeded.ownerUserId, { key: role, name: role })
      : await db.selectFrom('workforce_roles').selectAll().where('tenant_id', '=', tenant.id).where('key', '=', role).executeTakeFirstOrThrow();
    if (role === 'finance_writer') await grantPermission(workforce, tenant.id, seeded.ownerUserId, assigned.id, 'finance.write');
    await assignRole(workforce, tenant.id, seeded.ownerUserId, user.id, assigned.id);
    cookies[role] = `fixture-session=${user.id}`; sessions.set(cookies[role]!, { userId: user.id, tenantId: tenant.id });
  }
  return { db, platform, tenant, call };
}

const FINANCE_WRITES: Array<[string, string, unknown]> = [
  ...['payments', 'refunds', 'payouts', 'disputes', 'vendor-bills', 'tax-evidence'].map(k => ['POST', `/api/finance/import/${k}`, { rows: [] }] as [string, string, unknown]),
  ['POST', '/api/finance/payout-matches/run', { sourcePayoutId: 'fixture' }],
  ['POST', '/api/finance/cash-sessions', { openedBy: 'fixture', openingFloatCents: 0 }],
  ['POST', '/api/finance/cash-sessions/missing/movements', { kind: 'paid_in', idempotencyKey: 'fixture', amountCents: 1, note: 'fixture' }],
  ['PUT', '/api/finance/cash-sessions/missing/expected', { expectedCents: 1 }],
  ['POST', '/api/finance/cash-sessions/missing/close', { closedBy: 'fixture', countedCents: 1 }],
  ['POST', '/api/finance/cash-sessions/missing/adjustments', { amountCents: 1, reason: 'fixture', createdBy: 'fixture' }],
  ['POST', '/api/finance/item-costs', {}],
  ['POST', '/api/finance/liability-snapshots', {}],
  ['POST', '/api/finance/tax-configs', {}],
];

it.each(['manager', 'accountant_readonly'] as const)('%s is denied all 15 retained finance mutations before state changes', async role => {
  const { db, call } = await fixture();
  const before = await db.selectFrom('finance_cash_sessions').selectAll().execute();
  for (const [method, path, body] of FINANCE_WRITES) {
    const res = await call(role, method, path, body); expect(res.status, `${role} ${method} ${path}: ${await res.text()}`).toBe(403);
  }
  expect(await db.selectFrom('finance_cash_sessions').selectAll().execute()).toEqual(before);
  expect((await call(role, 'GET', '/api/finance/cash-sessions')).status).toBe(200);
  expect((await call(role, 'GET', '/api/finance/exports/payments.csv')).status).toBe(200);
  expect((await call(role, 'POST', '/api/finance/margin', { lines: [] })).status).toBe(200);
});

it('requires admin.admin for credentials, settings, health mutation and backup operations', async () => {
  const { db, call } = await fixture();
  const credential = { name: 'private fixture', provider: 'custom', payload: { apiKey: 'fixture-only' } };
  const created = await call('owner', 'POST', '/api/admin/credentials', credential); expect(created.status).toBe(201);
  const id = ((await created.json()) as any).data.id;
  const before = await db.selectFrom('admin_credentials').selectAll().execute();
  const routes: Array<[string, string, unknown]> = [
    ['POST', '/api/admin/credentials', credential], ['POST', `/api/admin/credentials/${id}/rotate`, { payload: { value: 'changed' } }],
    ['DELETE', `/api/admin/credentials/${id}`, undefined], ['POST', `/api/admin/credentials/${id}/test`, {}],
    ['PUT', '/api/admin/settings', { fixture: true }], ['POST', '/api/admin/health/run', {}],
    ['POST', '/api/admin/backups/run', {}], ['POST', '/api/admin/backups/missing/verify', {}], ['POST', '/api/admin/backups/prune', { keepLast: 1, keepWeeklyForWeeks: 1 }],
  ];
  for (const role of ['manager', 'accountant_readonly'] as const) for (const [method, path, body] of routes) {
    const res = await call(role, method, path, body); expect(res.status, `${role} ${method} ${path}`).toBe(403);
  }
  expect(await db.selectFrom('admin_credentials').selectAll().execute()).toEqual(before);
  const read = await call('manager', 'GET', '/api/admin/credentials'); expect(read.status).toBe(200); expect(await read.text()).not.toContain('fixture-only');
  expect((await call('owner', 'POST', `/api/admin/credentials/${id}/rotate`, { payload: { apiKey: 'rotated-fixture' } })).status).toBe(201);
  expect((await call('owner', 'DELETE', `/api/admin/credentials/${id}`)).status).toBe(200);
});

it('keeps finance.write distinct from finance.close and preserves authorized cash operations', async () => {
  const { db, call } = await fixture();
  const open = await call('finance_writer', 'POST', '/api/finance/cash-sessions', { openedBy: 'fixture', openingFloatCents: 100 });
  expect(open.status).toBe(201); const id = ((await open.json()) as any).data.id;
  expect((await call('finance_writer', 'PUT', `/api/finance/cash-sessions/${id}/expected`, { expectedCents: 100 })).status).toBe(200);
  const before = await db.selectFrom('finance_cash_sessions').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  expect((await call('finance_writer', 'POST', `/api/finance/cash-sessions/${id}/close`, { closedBy: 'fixture', countedCents: 100 })).status).toBe(403);
  expect(await db.selectFrom('finance_cash_sessions').selectAll().where('id', '=', id).executeTakeFirstOrThrow()).toEqual(before);
  expect((await call('owner', 'POST', `/api/finance/cash-sessions/${id}/close`, { closedBy: 'fixture', countedCents: 100 })).status).toBe(200);
});

it('only outreach.arm can change the actual settings path and privileged delivery fields', async () => {
  const { db, call } = await fixture();
  const before = await db.selectFrom('outreach_settings').selectAll().execute();
  for (const role of ['cashier', 'manager', 'purchasing', 'accountant_readonly'] as const) {
    for (const patch of [{ armed: true }, { fromEmail: 'fixture@local.invalid' }, { providerCredentialRef: 'fixture' }, { dailyCapOverride: 999 }]) {
      expect((await call(role, 'PUT', '/api/outreach/settings', patch)).status).toBe(403);
    }
  }
  expect(await db.selectFrom('outreach_settings').selectAll().execute()).toEqual(before);
  expect((await call('owner', 'PUT', '/api/outreach/settings', { armed: true })).status).toBe(200);
  expect((await call('owner', 'PUT', '/api/outreach/settings', { armed: false })).status).toBe(200);
});

it('purchase approval cannot approve campaigns; outreach approval still works with no sends', async () => {
  const { db, call } = await fixture();
  const template = await call('manager', 'POST', '/api/outreach/templates', { name: 'fixture', kind: 'transactional', subjectTemplate: 'fixture', bodyTemplate: 'fixture' });
  expect(template.status).toBe(201); const templateId = ((await template.json()) as any).data.id;
  const campaign = await call('manager', 'POST', '/api/outreach/campaigns', { name: 'fixture', templateId });
  expect(campaign.status).toBe(201); const id = ((await campaign.json()) as any).data.id;
  const before = await db.selectFrom('outreach_campaigns').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  expect((await call('purchasing', 'POST', `/api/outreach/campaigns/${id}/approve`, {})).status).toBe(403);
  expect(await db.selectFrom('outreach_campaigns').selectAll().where('id', '=', id).executeTakeFirstOrThrow()).toEqual(before);
  expect((await call('manager', 'POST', `/api/outreach/campaigns/${id}/approve`, {})).status).toBe(200);
  expect((await call('purchasing', 'POST', '/api/purchasing/purchase-orders/missing/approve', {})).status).toBe(404);
  expect(await db.selectFrom('outreach_sends').selectAll().execute()).toEqual([]);
});

it('adjacent low-privilege roles cannot draft or directly process outreach delivery', async () => {
  const { call } = await fixture();
  for (const [method, path] of [
    ['POST', '/api/outreach/templates'], ['PUT', '/api/outreach/templates/missing'], ['DELETE', '/api/outreach/templates/missing'],
    ['POST', '/api/outreach/campaigns'], ['POST', '/api/outreach/campaigns/missing/audience'], ['POST', '/api/outreach/campaigns/missing/queue'],
    ['POST', '/api/outreach/sends'], ['POST', '/api/outreach/send-pending'],
  ]) expect((await call('cashier', method, path, {})).status, path).toBe(403);
});
