import { describe, expect, it } from 'vitest';
import { asCoreDb, createTenant } from '@blacklabel/core';
import { createTestDb } from '@blacklabel/db';
import { MemoryStorageProvider } from '@blacklabel/files';
import { createApp, type PlatformDatabase } from '../../api/src/app';
import { businessEmployeeFiles } from '../../api/src/business-wiring';
import { createBusinessApp } from '../src/app';

async function fixture() {
  const db = createTestDb<PlatformDatabase>(), storage = new MemoryStorageProvider();
  let app: ReturnType<typeof createBusinessApp>;
  const platform = await createApp({ db, storage, businessPortals: true, disableRateLimit: true, includeCheckoutSimulator: false,
    browserSessionUser: async request => app?.resolveOwnerRequest(request) });
  const tenantId = (await createTenant(asCoreDb(db), { name: 'Team acceptance fixture' })).id;
  const { ownerUserId } = await platform.seedTenant(tenantId);
  app = createBusinessApp({ platform, tenantId, ownerUserId, accessToken: 'fixture-owner-key', version: 'fixture',
    settings: async () => ({ companyName: 'Team fixture' }), saveSettings: async () => {}, asset: async () => new Uint8Array(), employeeFiles: businessEmployeeFiles(db, platform.events, storage) });
  const request = (route: string, method = 'GET', body?: unknown, cookie?: string) => app.request(`https://team.example/api/${route}`, { method,
    headers: { ...(cookie ? { cookie } : { authorization: 'Bearer fixture-owner-key' }), host: 'team.example', origin: 'https://team.example', 'sec-fetch-site': 'same-origin', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = async (route: string, method = 'GET', body?: unknown, cookie?: string) => { const r = await request(route, method, body, cookie), b = await r.json() as any; expect(r.status, JSON.stringify(b)).toBeLessThan(300); return b.data; };
  const employee = async (name: string, role = 'worker') => {
    const person = await data('portal-employee/employees', 'POST', { name, email: `${name}@example.test`, role });
    const issued = await data(`portal-employee/employees/${person.id}/tokens`, 'POST', {});
    const login = await request('business/team/login', 'POST', { token: issued.token }); expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).toContain('Secure');
    return { ...person, issued, cookie: login.headers.get('set-cookie')!.split(';')[0] };
  };
  return { db, platform, app, tenantId, request, data, employee, close: async () => { platform.detachEngine(); await db.destroy(); } };
}
describe('customer-installed team and review journeys', () => {
  it('authorizes browser quote forms through the customer session while anonymous forms only reach sign-in', async () => {
    const f = await fixture();
    try {
      const customer = await f.data('crm/customers', 'POST', { name: 'Portal form fixture' });
      const account = await f.data('portal-customer/accounts', 'POST', { customerId: customer.id, name: 'Form customer', email: 'form@example.test' });
      const created = await f.data('quoting/quotes', 'POST', { customerId: customer.id, title: 'Form quote', lines: [{ description: 'Work', quantity: 1, unitPriceCents: 1200 }] });
      const quoteId = created.quote.id; await f.data(`quoting/quotes/${quoteId}/send`, 'POST', {});
      const route = `portal-customer/ui/quotes/${quoteId}/approve`;
      const anonymous = await f.request(route, 'POST', undefined, 'unrelated=fixture');
      expect(anonymous.status).toBe(302); expect(anonymous.headers.get('location')).toContain('/ui/login');
      expect((await f.data(`quoting/quotes/${quoteId}`)).quote.status).toBe('sent');
      await f.data('portal-customer/auth/request-link', 'POST', { email: 'form@example.test' });
      const token = await f.db.selectFrom('portal_customer_login_tokens').select('token').where('tenant_id', '=', f.tenantId).where('account_id', '=', account.id).where('used_at', 'is', null).orderBy('created_at', 'desc').orderBy('id').executeTakeFirstOrThrow();
      const session = await f.data('portal-customer/auth/exchange', 'POST', { token: token.token });
      const response = await f.request(route, 'POST', undefined, `portal_session=${session.sessionToken}`);
      expect(response.status, await response.clone().text()).toBe(302);
      expect(response.headers.get('referrer-policy')).toBe('strict-origin');
      expect((await f.data(`quoting/quotes/${quoteId}`)).quote.status).toBe('approved');
    } finally { await f.close(); }
  });
  it('binds team sessions, stores photo bytes, rejects other workers and revoked access', async () => {
    const f = await fixture();
    try {
      const a = await f.employee('worker-a'), b = await f.employee('worker-b'), manager = await f.employee('manager', 'manager');
      const work = await f.data('portal-employee/assignments', 'POST', { employeeId: a.id, kind: 'job', title: 'Verify assigned work' });
      const path = `business/team/assignments/${work.id}/photos`;
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=';
      const photo = { name: 'work.png', mime: 'image/png', contentBase64: png };
      expect((await f.request(path, 'POST', photo, b.cookie)).status).toBe(403);
      expect((await f.request(path, 'POST', { ...photo, contentBase64: Buffer.from('not a photo').toString('base64') }, a.cookie)).status).toBe(400);
      const stored = await f.data(path, 'POST', photo, a.cookie);
      const readback = await f.request(`${path}/${stored.photo.file_id}`, 'GET', undefined, a.cookie);
      expect(Buffer.from(await readback.arrayBuffer())).toEqual(Buffer.from(png, 'base64'));
      expect((await f.request(`${path}/${stored.photo.file_id}`, 'GET', undefined, b.cookie)).status).toBe(403);
      expect((await f.request(`${path}/${stored.photo.file_id}`, 'GET', undefined, manager.cookie)).status).toBe(200);
      expect((await f.request('crm/customers', 'GET', undefined, a.cookie)).status).toBe(401);
      expect((await f.request(`portal-employee/portal/assignments/${work.id}/comments`, 'POST', { body: 'Worker role denied' }, a.cookie)).status).toBe(403);
      await f.data(`portal-employee/portal/assignments/${work.id}/comments`, 'POST', { body: 'Manager review recorded' }, manager.cookie);
      expect(await f.data(`portal-employee/portal/assignments/${work.id}/logs`, 'GET', undefined, a.cookie)).toMatchObject([{ kind: 'manager_comment', body: 'Manager review recorded' }]);
      await f.data(`portal-employee/employees/${a.id}`, 'PATCH', { active: false });
      expect((await f.request('portal-employee/portal/me', 'GET', undefined, a.cookie)).status).toBe(401);
      expect((await f.request(`${path}/${stored.photo.file_id}`, 'GET', undefined, a.cookie)).status).toBe(401);
    } finally { await f.close(); }
  });
  it('uses the employee timezone across midnight and daylight saving while clock/checklist work persists', async () => {
    const f = await fixture();
    try {
      const a = await f.employee('timezone-worker');
      const work = await f.data('portal-employee/assignments', 'POST', { employeeId: a.id, kind: 'job', title: 'Late local work', scheduledAt: '2026-11-02T05:30:00.000Z' });
      const own = `portal-employee/portal`;
      const local = await f.data(`${own}/my/schedule?date=2026-11-01&timezone=America%2FChicago`, 'GET', undefined, a.cookie);
      expect(local.assignments).toMatchObject([{ id: work.id }]);
      expect((await f.data(`${own}/my/schedule?date=2026-11-01&timezone=UTC`, 'GET', undefined, a.cookie)).assignments).toEqual([]);
      const checklist = await f.data(`portal-employee/assignments/${work.id}/checklists`, 'POST', { name: 'Completion', items: ['Verify work'] });
      await f.data(`${own}/checklist-items/${checklist.items[0].id}/check`, 'POST', { checked: true }, a.cookie);
      expect((await f.data(`${own}/assignments/${work.id}/checklists`, 'GET', undefined, a.cookie))[0].items[0].checked).toBe(true);
      await f.data(`${own}/clock-in`, 'POST', {}, a.cookie); const out = await f.data(`${own}/clock-out`, 'POST', {}, a.cookie); expect(out.clock_out_at).toBeTruthy();
      expect(await f.data(`${own}/my/time-entries`, 'GET', undefined, a.cookie)).toHaveLength(1);
    } finally { await f.close(); }
  });
  it('allows token-scoped public feedback without giving owner access and records a real submitted response', async () => {
    const f = await fixture();
    try {
      const customer = await f.data('crm/customers', 'POST', { name: 'Review fixture customer' });
      const request = await f.data('reviews/requests', 'POST', { customerId: customer.id });
      const link = await f.data(`reviews/requests/${request.id}/link`);
      const cookie = 'unrelated-cookie=fixture';
      expect((await f.request(`reviews/public/requests/${link.token}`, 'GET', undefined, cookie)).status).toBe(200);
      const submitted = await f.data(`reviews/public/requests/${link.token}/submit`, 'POST', { rating: 3, comment: 'Fixture feedback recorded' }, cookie);
      expect(submitted.response.rating).toBe(3);
      expect((await f.request('reviews/requests', 'GET', undefined, cookie)).status).toBe(401);
      expect((await f.data(`reviews/requests/${request.id}`)).status).toBe('completed');
    } finally { await f.close(); }
  });
});
