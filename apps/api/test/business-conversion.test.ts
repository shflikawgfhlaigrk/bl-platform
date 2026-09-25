import { describe, expect, it } from 'vitest';
import { asCoreDb, createTenant } from '@blacklabel/core';
import { createTestDb } from '@blacklabel/db';
import { createApp, type PlatformDatabase } from '../src/app';

async function setup() {
  const db = createTestDb<PlatformDatabase>(), platform = await createApp({ db, businessPortals: true, disableRateLimit: true, includeCheckoutSimulator: false });
  const tenantId = (await createTenant(asCoreDb(db), { name: 'Conversion fixture' })).id, owner = await platform.seedTenant(tenantId);
  const request = (route: string, method = 'GET', body?: unknown, tenant = tenantId, actor = owner.ownerUserId) => platform.app.request(`/api/${route}`, { method,
    headers: { 'x-tenant-id': tenant, 'x-user-id': actor, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = async (route: string, method = 'GET', body?: unknown) => { const response = await request(route, method, body); const result = await response.json() as any; expect(response.status, JSON.stringify(result)).toBeLessThan(300); return result.data; };
  const customer = await data('crm/customers', 'POST', { name: 'Conversion customer' });
  const created = await data('quoting/quotes', 'POST', { customerId: customer.id, title: 'Approved service', taxBps: 825, lines: [{ description: 'Work', quantity: 2, unitPriceCents: 3350 }] });
  const quoteId = created.quote.id;
  await data(`quoting/quotes/${quoteId}/send`, 'POST', {}); await data(`quoting/quotes/${quoteId}/approve`, 'POST', { signerName: 'Fixture customer' });
  return { db, platform, tenantId, customer, quoteId, data, request, close: async () => { platform.detachEngine(); await db.destroy(); } };
}
describe('business quote to job and invoice', () => {
  it('writes a real CRM job and exact invoice atomically and deduplicates repeated conversion requests', async () => {
    const f = await setup();
    try {
      const observed: string[] = []; f.platform.events.on('*', event => { if (event.type === 'crm.job.created' || event.type === 'billing.invoice.created') observed.push(event.type); });
      const [a, b] = await Promise.all([f.data(`quoting/quotes/${f.quoteId}/convert`, 'POST', {}), f.data(`quoting/quotes/${f.quoteId}/convert`, 'POST', {})]);
      expect(a.jobId).toBe(b.jobId); expect(a.invoiceId).toBe(b.invoiceId); expect(a.replayed).not.toBe(b.replayed);
      expect(await f.data('crm/jobs')).toMatchObject([{ id: a.jobId, title: 'Approved service', customer_id: f.customer.id }]);
      const invoices = await f.data('billing/invoices'); expect(invoices).toHaveLength(1); expect(invoices[0].total_cents).toBe((await f.data(`quoting/quotes/${f.quoteId}`)).quote.total_cents);
      expect(observed.filter(type => type === 'crm.job.created')).toHaveLength(1); expect(observed.filter(type => type === 'billing.invoice.created')).toHaveLength(1);
      expect(await f.data('dashboard/widgets/jobs')).toMatchObject({ available: true, total: 1, completed: 0 });
      expect(await f.data('dashboard/widgets/jobs?from=2100-01-01')).toMatchObject({ available: true, total: 0 });
      const other = (await createTenant(asCoreDb(f.db), { name: 'Other conversion tenant' })).id; const otherOwner = await f.platform.seedTenant(other);
      expect((await f.request(`quoting/quotes/${f.quoteId}/convert`, 'POST', {}, other)).status).toBe(403);
      expect((await f.request(`quoting/quotes/${f.quoteId}/convert`, 'POST', {}, other, otherOwner.ownerUserId)).status).toBe(404);
    } finally { await f.close(); }
  });
  it('rolls invoice and quote mutations back if job storage fails before commit', async () => {
    const f = await setup();
    try {
      await f.db.schema.dropTable('crm_jobs').execute();
      const failed = await f.request(`quoting/quotes/${f.quoteId}/convert`, 'POST', {}); expect(failed.status).toBe(500);
      expect(await f.data('billing/invoices')).toEqual([]);
      const quote = await f.data(`quoting/quotes/${f.quoteId}`); expect(quote.quote.converted_at).toBeNull(); expect(quote.quote.invoice_id).toBeNull();
      expect(await f.db.selectFrom('quoting_conversions').selectAll().where('tenant_id', '=', f.tenantId).execute()).toEqual([]);
    } finally { await f.close(); }
  });
  it('requires a still-existing customer before creating billable work', async () => {
    const f = await setup();
    try {
      await f.data(`crm/customers/${f.customer.id}`, 'DELETE');
      expect((await f.request(`quoting/quotes/${f.quoteId}/convert`, 'POST', {})).status).toBe(404); expect(await f.data('billing/invoices')).toEqual([]);
    } finally { await f.close(); }
  });
});
