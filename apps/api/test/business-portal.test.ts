import { describe, expect, it } from 'vitest';
import { asCoreDb, createTenant } from '@blacklabel/core';
import { createTestDb } from '@blacklabel/db';
import { MemoryStorageProvider } from '@blacklabel/files';
import { createApp, type PlatformDatabase } from '../src/app';

async function fixture() {
  const db = createTestDb<PlatformDatabase>();
  const platform = await createApp({ db, storage: new MemoryStorageProvider(), disableRateLimit: true, includeCheckoutSimulator: false });
  const tenantId = (await createTenant(asCoreDb(db), { name: 'Business portal acceptance fixture' })).id;
  await platform.seedTenant(tenantId);
  async function request(route: string, method = 'GET', body?: unknown, session?: string, tenant = tenantId) {
    return platform.app.request(`/api/${route}`, { method, headers: { 'x-tenant-id': tenant,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(session ? { 'x-portal-session': session } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  }
  async function data(route: string, method = 'GET', body?: unknown, session?: string) {
    const response = await request(route, method, body, session); const json = await response.json() as any;
    expect(response.status, JSON.stringify(json)).toBeLessThan(300); return json.data;
  }
  async function customer(email: string) {
    const row = await data('crm/customers', 'POST', { name: email, email });
    const account = await data('portal-customer/accounts', 'POST', { name: 'Customer fixture', customerId: row.id, email });
    await data('portal-customer/auth/request-link', 'POST', { email });
    const link = await db.selectFrom('portal_customer_login_tokens').selectAll().where('tenant_id', '=', tenantId)
      .where('account_id', '=', account.id).where('used_at', 'is', null).orderBy('created_at', 'desc').orderBy('id').executeTakeFirstOrThrow();
    const { sessionToken } = await data('portal-customer/auth/exchange', 'POST', { token: link.token });
    return { id: row.id, session: sessionToken };
  }
  return { db, platform, tenantId, request, data, customer, close: async () => { platform.detachEngine(); await db.destroy(); } };
}

describe('connected business customer portal', () => {
  it('shows owned appointments, jobs and quotes; approval writes back to quoting with a real approval event', async () => {
    const f = await fixture();
    try {
      const a = await f.customer('customer-a@example.test'); const b = await f.customer('customer-b@example.test');
      const created = await f.data('quoting/quotes', 'POST', { customerId: a.id, title: 'Service estimate',
        lines: [{ description: 'Service', quantity: 2, unitPriceCents: 4500 }] });
      const quoteId = created.quote.id;
      expect(await f.data('portal-customer/me/quotes', 'GET', undefined, a.session)).toEqual([]);
      await f.data(`quoting/quotes/${quoteId}/send`, 'POST', {});
      const quotes = await f.data('portal-customer/me/quotes', 'GET', undefined, a.session);
      expect(quotes).toMatchObject([{ id: quoteId, totalCents: 9000, status: 'sent' }]);
      expect(await f.data('portal-customer/me/quotes', 'GET', undefined, b.session)).toEqual([]);
      expect((await f.request(`portal-customer/me/quotes/${quoteId}/approve`, 'POST', {}, b.session)).status).toBe(404);
      expect((await f.request(`portal-customer/me/quotes/${quoteId}/approve`, 'POST', {}, a.session)).status).toBe(400);
      expect((await f.request(`portal-customer/me/quotes/${quoteId}/approve`, 'POST', { expectedPayloadHash: 'f'.repeat(64) }, a.session)).status).toBe(409);
      const decision = await f.data(`portal-customer/me/quotes/${quoteId}/approve`, 'POST', { comment: 'Approved fixture scope', expectedPayloadHash: quotes[0].payloadHash }, a.session);
      expect(decision.decision).toBe('approved');
      const readback = await f.data(`quoting/quotes/${quoteId}`);
      expect(readback.quote.status).toBe('approved');
      expect(readback.approvalEvents.some((event: any) => event.id === decision.approvalEventId && event.event_type === 'approved')).toBe(true);
      await f.platform.contracts.createAppointment!.createAppointment({ tenantId: f.tenantId, customerId: a.id,
        startsAt: '2027-01-11T15:00:00.000Z', endsAt: '2027-01-11T16:00:00.000Z' });
      expect(await f.data('portal-customer/me/appointments', 'GET', undefined, a.session)).toHaveLength(1);
      expect(await f.data('portal-customer/me/appointments', 'GET', undefined, b.session)).toEqual([]);
      const job = await f.data('crm/jobs', 'POST', { title: 'Accepted service job', customer_id: a.id });
      expect(await f.data('portal-customer/me/jobs', 'GET', undefined, a.session)).toMatchObject([{ id: job.id, title: job.title }]);
      expect(await f.data('portal-customer/me/jobs', 'GET', undefined, b.session)).toEqual([]);
    } finally { await f.close(); }
  });

  it('keeps invoice balances exact, hides private invoices, and exposes manual collection as instructions', async () => {
    const f = await fixture();
    try {
      const a = await f.customer('billing-a@example.test'); const b = await f.customer('billing-b@example.test');
      const invoice = await f.data('billing/invoices', 'POST', { customerId: a.id, portalVisible: true,
        lines: [{ description: 'Work', quantity: 3, unitPriceCents: 3333 }] });
      await f.data(`billing/invoices/${invoice.id}/send`, 'POST', {});
      expect(await f.data('portal-customer/me/invoices', 'GET', undefined, a.session)).toMatchObject([{ id: invoice.id, balanceCents: 9999 }]);
      expect(await f.data('portal-customer/me/invoices', 'GET', undefined, b.session)).toEqual([]);
      await f.data(`billing/invoices/${invoice.id}/collection-plan`, 'PUT', { depositCents: 3000, depositDueAt: '2020-01-01T00:00:00.000Z', balanceDueAt: '2020-01-02T00:00:00.000Z' });
      expect(await f.data('portal-customer/me/invoices', 'GET', undefined, a.session)).toMatchObject([{ depositRemainingCents: 3000 }]);
      expect((await f.request(`portal-customer/me/invoices/${invoice.id}/reminder-preference`, 'PUT', { optedOut: true }, b.session)).status).toBe(404);
      await f.data(`portal-customer/me/invoices/${invoice.id}/reminder-preference`, 'PUT', { optedOut: true }, a.session);
      expect(await f.data('portal-customer/me/invoices', 'GET', undefined, a.session)).toMatchObject([{ remindersOptedOut: true }]);
      expect((await f.data(`billing/invoices/${invoice.id}/collection-plan`)).plan.opted_out).toBe(1);
      const deposit = await f.data(`portal-customer/me/invoices/${invoice.id}/pay`, 'POST', { purpose: 'deposit' }, a.session);
      expect(deposit).toMatchObject({ provider: 'manual', status: 'requires_action', amountCents: 3000 });
      expect((await f.request(`portal-customer/me/invoices/${invoice.id}/pay`, 'POST', { purpose: 'deposit' }, b.session)).status).toBe(404);
      const instructions = await f.data(`portal-customer/me/invoices/${invoice.id}/pay`, 'POST', {}, a.session);
      expect(instructions).toMatchObject({ provider: 'manual', status: 'requires_action', amountCents: 9999 });
      expect(instructions.clientSecret).toBeUndefined();
      expect((await f.data(`billing/invoices/${invoice.id}`)).paid_cents).toBe(0);
      expect((await f.request(`portal-customer/me/invoices/${invoice.id}/pay`, 'POST', {}, b.session)).status).toBe(404);
    } finally { await f.close(); }
  });

  it('stores and reads actual upload bytes; rejects foreign links, other customers and metadata-only uploads', async () => {
    const f = await fixture();
    try {
      const a = await f.customer('files-a@example.test'); const b = await f.customer('files-b@example.test');
      const bytes = Buffer.from('Customer-owned document fixture.');
      const upload = { fileName: 'service-notes.txt', contentType: 'text/plain', sizeBytes: bytes.length, contentBase64: bytes.toString('base64') };
      const bad = await f.request('portal-customer/me/uploads', 'POST', { ...upload, relatedEntityType: 'crm.customer', relatedEntityId: b.id }, a.session);
      expect(bad.status).toBe(404);
      const record = await f.data('portal-customer/me/uploads', 'POST', upload, a.session);
      const files = await f.data('portal-customer/me/files', 'GET', undefined, a.session);
      expect(files).toMatchObject([{ id: record.file_id, name: upload.fileName, sizeBytes: bytes.length }]);
      const content = await f.request(`portal-customer/me/files/${record.file_id}/content`, 'GET', undefined, a.session);
      expect(Buffer.from(await content.arrayBuffer())).toEqual(bytes);
      expect((await f.request(`portal-customer/me/files/${record.file_id}/content`, 'GET', undefined, b.session)).status).toBe(404);
      expect(await f.data('portal-customer/me/files', 'GET', undefined, b.session)).toEqual([]);
      expect((await f.request('portal-customer/me/uploads', 'POST', { ...upload, contentBase64: undefined }, a.session)).status).toBe(400);
    } finally { await f.close(); }
  });

  it('workflow lead updates mutate CRM and prove the requested stage', async () => {
    const f = await fixture();
    try {
      const workflow = await f.data('workflows', 'POST', { name: 'Qualify new leads', triggerEvent: 'crm.lead.created',
        actions: [{ type: 'update_lead_stage', config: { leadId: '{{payload.leadId}}', stage: 'qualified' } }] });
      const lead = await f.data('crm/leads', 'POST', { name: 'New prospect' });
      expect((await f.data(`crm/leads/${lead.id}`)).stage).toBe('qualified');
      const executions = await f.data(`workflows/executions?workflow_id=${workflow.id}`);
      expect(executions[0].status).toBe('succeeded');
    } finally { await f.close(); }
  });
});
