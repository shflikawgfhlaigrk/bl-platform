import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asCoreDb, createTenant } from '@blacklabel/core';
import { createTestDb } from '@blacklabel/db';
import { MemoryStorageProvider } from '@blacklabel/files';
import { createApp, type PlatformDatabase } from '../src/app';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-03T12:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

async function fixture() {
  const db = createTestDb<PlatformDatabase>();
  const platform = await createApp({ db, storage: new MemoryStorageProvider(), disableRateLimit: true, includeCheckoutSimulator: false });
  const tenantId = (await createTenant(asCoreDb(db), { name: 'Portal request fixture' })).id;
  await platform.seedTenant(tenantId);
  const request = (route: string, method = 'GET', body?: unknown, session?: string) => platform.app.request(`/api/${route}`, { method,
    headers: { 'x-tenant-id': tenantId, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(session ? { 'x-portal-session': session } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  async function data(route: string, method = 'GET', body?: unknown, session?: string) {
    const response = await request(route, method, body, session); const json = await response.json() as any;
    expect(response.status, JSON.stringify(json)).toBeLessThan(300); return json.data;
  }
  async function customer(email: string) {
    const customer = await data('crm/customers', 'POST', { name: email, email });
    const account = await data('portal-customer/accounts', 'POST', { name: 'Fixture customer', customerId: customer.id, email });
    await data('portal-customer/auth/request-link', 'POST', { email });
    const link = await db.selectFrom('portal_customer_login_tokens').selectAll().where('tenant_id', '=', tenantId)
      .where('account_id', '=', account.id).where('used_at', 'is', null).orderBy('created_at', 'desc').orderBy('id').executeTakeFirstOrThrow();
    const session = await data('portal-customer/auth/exchange', 'POST', { token: link.token });
    return { id: customer.id, accountId: account.id, session: session.sessionToken as string };
  }
  return { db, platform, tenantId, request, data, customer, close: async () => { platform.detachEngine(); await db.destroy(); } };
}

describe('customer requests connected to real work', () => {
  it('records repeat demand for an owned completed CRM job, exposes the owner queue and one response, and preserves original work', async () => {
    const f = await fixture();
    try {
      const customer = await f.customer('repeat@example.test');
      const other = await f.customer('other@example.test');
      const job = await f.data('crm/jobs', 'POST', { title: 'Completed fixture work', customer_id: customer.id, status: 'completed' });
      const body = { kind: 'repeat', referenceId: job.id, idempotencyKey: 'repeat-fixture', note: 'Please price this work for next month.' };
      const receipts = await Promise.all([f.data('portal-customer/me/requests', 'POST', body, customer.session), f.data('portal-customer/me/requests', 'POST', body, customer.session)]);
      expect(receipts[0].request.id).toBe(receipts[1].request.id);
      const queue = await f.data('portal-customer/requests?status=pending');
      expect(queue).toMatchObject([{ id: receipts[0].request.id, reference_id: job.id, customer_id: customer.id, status: 'pending' }]);
      expect((await f.request('portal-customer/me/requests', 'POST', { ...body, idempotencyKey: 'foreign-request' }, other.session)).status).toBe(404);
      expect(await f.data('portal-customer/me/requests', 'GET', undefined, other.session)).toEqual([]);
      await f.data(`portal-customer/requests/${queue[0].id}`, 'PATCH', { status: 'resolved', response: 'A new quote will follow after we confirm scope.', expectedVersion: 1 });
      expect(await f.data('portal-customer/me/requests', 'GET', undefined, customer.session)).toMatchObject([{ id: queue[0].id, status: 'resolved', response: 'A new quote will follow after we confirm scope.' }]);
      expect((await f.data(`crm/jobs/${job.id}`)).status).toBe('completed');
      expect(await f.db.selectFrom('crm_jobs').selectAll().where('tenant_id', '=', f.tenantId).where('customer_id', '=', customer.id).execute()).toHaveLength(1);
    } finally { await f.close(); }
  });

  it('records a preferred reschedule while preserving the real appointment and denies other customers', async () => {
    const f = await fixture();
    try {
      const customer = await f.customer('reschedule@example.test');
      const other = await f.customer('reschedule-other@example.test');
      const { id } = await f.platform.contracts.createAppointment!.createAppointment({ tenantId: f.tenantId, customerId: customer.id, startsAt: '2027-01-11T15:00:00.000Z', endsAt: '2027-01-11T16:00:00.000Z' });
      const before = await f.data(`scheduling/appointments/${id}`);
      const requestBody = { kind: 'reschedule', referenceId: id, idempotencyKey: 'reschedule-fixture', requestedStartsAt: '2027-01-12T10:00:00', timezone: 'America/Chicago' };
      const receipt = await f.data('portal-customer/me/requests', 'POST', requestBody, customer.session);
      expect(receipt.request).toMatchObject({ reference_id: id, requested_starts_at: '2027-01-12T16:00:00.000Z', requested_ends_at: '2027-01-12T17:00:00.000Z', status: 'pending' });
      const after = await f.data(`scheduling/appointments/${id}`);
      expect(after.starts_at).toBe(before.starts_at); expect(after.ends_at).toBe(before.ends_at); expect(after.status).toBe(before.status);
      expect((await f.request('portal-customer/me/requests', 'POST', { ...requestBody, idempotencyKey: 'foreign-reschedule' }, other.session)).status).toBe(404);
      const view = await f.platform.app.request('/api/portal-customer/ui', { headers: { 'x-tenant-id': f.tenantId, cookie: `portal_session=${customer.session}` } });
      expect(view.status).toBe(200);
      const html = await view.text(); expect(html).toContain('Request a reschedule'); expect(html).toContain('Your requests'); expect(html).toContain('Files and photos');
    } finally { await f.close(); }
  });

  it('uploads and downloads original bytes through real customer HTML screens and blocks other customers', async () => {
    const f = await fixture();
    try {
      const customer = await f.customer('upload@example.test');
      const other = await f.customer('upload-other@example.test');
      // Exceeds the generic 5 MB body limit, but fits the documented file path.
      const bytes = Buffer.alloc(6 * 1024 * 1024, 37);
      const form = new FormData(); form.set('file', new File([bytes], 'evidence.txt', { type: 'text/plain' }));
      const uploaded = await f.platform.app.request('/api/portal-customer/ui/uploads', { method: 'POST', headers: { 'x-tenant-id': f.tenantId, cookie: `portal_session=${customer.session}` }, body: form });
      expect(uploaded.status, await uploaded.clone().text()).toBe(303);
      const [file] = await f.data('portal-customer/me/files', 'GET', undefined, customer.session);
      expect(file).toMatchObject({ name: 'evidence.txt', sizeBytes: bytes.length });
      const downloaded = await f.platform.app.request(`/api/portal-customer/ui/files/${file.id}/content`, { headers: { 'x-tenant-id': f.tenantId, cookie: `portal_session=${customer.session}` } });
      expect(downloaded.status).toBe(200); expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
      const denied = await f.platform.app.request(`/api/portal-customer/ui/files/${file.id}/content`, { headers: { 'x-tenant-id': f.tenantId, cookie: `portal_session=${other.session}` } });
      expect(denied.status).toBe(404);
      const html = await (await f.platform.app.request('/api/portal-customer/ui', { headers: { 'x-tenant-id': f.tenantId, cookie: `portal_session=${customer.session}` } })).text();
      expect(html).toContain('Download evidence.txt');
    } finally { await f.close(); }
  }, 15_000);
});
