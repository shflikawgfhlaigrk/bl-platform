import { describe, expect, it } from 'vitest';
import { createTestDb } from '@blacklabel/db';
import { asCoreDb, createTenant } from '@blacklabel/core';
import { createApp, type PlatformDatabase } from '../../api/src/app';
import { createBusinessApp, type BusinessSettings } from '../src/app';

describe('BlackLabel business access boundary', () => {
  it('binds staff access to the installed company and protects customer/account administration', async () => {
    let app: ReturnType<typeof createBusinessApp>;
    let installedTenant = '';
    const db = createTestDb<PlatformDatabase>(), platform = await createApp({ db, disableRateLimit: true, includeCheckoutSimulator: false,
      businessPortals: true, browserSessionUser: async (request, tenantId) => tenantId === installedTenant ? app?.resolveOwnerRequest(request) : undefined });
    const a = (await createTenant(asCoreDb(db), { name: 'Company A fixture' })).id;
    installedTenant = a;
    const b = (await createTenant(asCoreDb(db), { name: 'Company B fixture' })).id;
    const ownerA = await platform.seedTenant(a); const ownerB = await platform.seedTenant(b);
    let settings: BusinessSettings = { companyName: 'Company A fixture' };
    app = createBusinessApp({ platform, tenantId: a, ownerUserId: ownerA.ownerUserId, accessToken: 'fixture-access-key',
      settings: async () => settings, saveSettings: async (next) => { settings = next; }, asset: async () => new Uint8Array(), version: 'fixture' });
    const request = (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => app.request(url, { method,
      headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    try {
      expect((await request('/api/crm/customers')).status).toBe(401);
      expect((await request('/api/portal-customer/accounts', 'POST', { customerId: 'fake', name: 'fake', email: 'fake@example.test' })).status).toBe(401);
      expect((await request('/api/portal-customer/me')).status).toBe(401);
      expect((await request('/api/business/login', 'POST', { token: 'fixture-access-key' }, { origin: 'https://foreign.example' })).status).toBe(403);
      const login = await request('/api/business/login', 'POST', { token: 'fixture-access-key' });
      expect(login.status).toBe(200);
      const cookie = login.headers.get('set-cookie')!.split(';')[0];
      const headers = { cookie, 'x-tenant-id': b, 'x-user-id': ownerB.ownerUserId, 'sec-fetch-site': 'same-origin', origin: 'http://localhost', host: 'localhost' };
      const created = await request('/api/crm/customers', 'POST', { name: 'Bound company customer' }, headers);
      expect(created.status, await created.clone().text()).toBe(201);
      const row = (await created.json() as any).data;
      expect(row.tenant_id).toBe(a);
      const audit = await request(`/api/business/audit?entityType=crm.customer&entityId=${row.id}`, 'GET', undefined, headers);
      expect(audit.status).toBe(200);
      expect((await audit.json() as any).data).toEqual(expect.arrayContaining([expect.objectContaining({ tenant_id: a, entity_id: row.id, action: 'crm.customer.created' })]));
      expect((await request(`/api/business/audit?entityType=crm.customer&entityId=${row.id}`)).status).toBe(401);
      const other = await platform.app.request('/api/crm/customers', { headers: { 'x-tenant-id': b, 'x-user-id': ownerB.ownerUserId } });
      expect((await other.json() as any).data).toEqual([]);
      const changed = await request('/api/business/settings', 'PATCH', { email: { apiKey: 'fixture-only-email-key', from: 'company@example.test' } }, headers);
      expect(changed.status).toBe(200);
      const readback = await request('/api/business/settings', 'GET', undefined, headers);
      expect(await readback.text()).not.toContain('fixture-only-email-key');
      const calendar = await request('/api/business/settings', 'PATCH', { googleCalendar: { calendarId: 'fixture@example.test', clientId: 'fixture-client', clientSecret: 'private-calendar-fixture', refreshToken: 'private-refresh-fixture' } }, headers);
      expect(calendar.status).toBe(200);
      const calendarRead = await request('/api/business/settings', 'GET', undefined, headers);
      const calendarText = await calendarRead.text(); expect(calendarText).not.toContain('private-calendar-fixture'); expect(calendarText).not.toContain('private-refresh-fixture');
      expect(JSON.parse(calendarText).data.googleCalendar).toEqual({ connected: true, calendarId: 'fixture@example.test' });
      const forwarded = await request('/api/portal-customer/ui/login');
      expect(forwarded.headers.get('referrer-policy')).toBe('strict-origin');
      expect(forwarded.headers.get('content-security-policy')).toContain("script-src 'self';");
      await request('/api/business/logout', 'POST', {}, headers);
      expect((await request('/api/crm/customers', 'GET', undefined, headers)).status).toBe(401);
    } finally { platform.detachEngine(); await db.destroy(); }
  });
});
