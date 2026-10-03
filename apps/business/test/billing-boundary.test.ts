import { describe, expect, it } from 'vitest';
import { asCoreDb, createTenant } from '@blacklabel/core';
import { createTestDb } from '@blacklabel/db';
import { createApp, type PlatformDatabase } from '../../api/src/app';
import { createBusinessApp } from '../src/app';

async function fixture() {
  const db = createTestDb<PlatformDatabase>();
  let app: ReturnType<typeof createBusinessApp>;
  const platform = await createApp({ db, businessPortals: true, disableRateLimit: true, includeCheckoutSimulator: false,
    browserSessionUser: async request => app?.resolveOwnerRequest(request) });
  const tenantId = (await createTenant(asCoreDb(db), { name: 'Billing approval boundary fixture' })).id;
  const { ownerUserId } = await platform.seedTenant(tenantId);
  app = createBusinessApp({ platform, tenantId, ownerUserId, accessToken: 'fixture-owner-key', version: 'fixture',
    settings: async () => ({ companyName: 'Billing fixture' }), saveSettings: async () => {}, asset: async () => new Uint8Array() });
  const request = (route: string, method = 'GET', body?: unknown, authorized = true) => app.request(`https://billing.example/api/${route}`, { method,
    headers: { ...(authorized ? { authorization: 'Bearer fixture-owner-key' } : {}), host: 'billing.example', origin: 'https://billing.example',
      'sec-fetch-site': 'same-origin', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = async (route: string, method = 'GET', body?: unknown) => {
    const response = await request(route, method, body), result = await response.json() as any;
    expect(response.status, JSON.stringify(result)).toBeLessThan(300); return result.data;
  };
  return { db, platform, request, data, close: async () => { platform.detachEngine(); await db.destroy(); } };
}

describe('installed billing approval boundary', () => {
  it('rejects submitted quote payloads without invoice, job or numbering side effects and preserves the approved handoff', async () => {
    const f = await fixture();
    try {
      const customer = await f.data('crm/customers', 'POST', { name: 'Approved scope customer' });
      const created = await f.data('quoting/quotes', 'POST', { customerId: customer.id, title: 'Actual service',
        lines: [{ description: 'Approved work', quantity: 1, unitPriceCents: 12550 }] });
      const quoteId = created.quote.id;
      for (const claimedId of ['invented-quote', quoteId]) {
        const denied = await f.request('billing/invoices/from-quote', 'POST', { quoteId: claimedId, customerId: customer.id,
          lines: [{ description: 'Unapproved replacement', quantity: 1, unitPriceCents: 999 }] });
        expect(denied.status).toBe(409);
        expect((await denied.json() as any).error.message).toContain('approved scope');
      }
      expect(await f.data('billing/invoices')).toEqual([]); expect(await f.data('crm/jobs')).toEqual([]);
      await f.data(`quoting/quotes/${quoteId}/send`, 'POST', {});
      await f.data(`quoting/quotes/${quoteId}/approve`, 'POST', { signerName: 'Fixture customer' });
      const converted = await f.data(`quoting/quotes/${quoteId}/convert`, 'POST', {});
      const invoice = await f.data(`billing/invoices/${converted.invoiceId}`);
      expect(invoice.number).toBe('INV-1'); expect(invoice.total_cents).toBe(12550);
      expect(invoice.lines).toMatchObject([{ description: 'Approved work', unit_price_cents: 12550 }]);
      expect((await f.request('billing/invoices/from-quote', 'POST', { quoteId, customerId: customer.id,
        lines: [{ description: 'Approved work', quantity: 1, unitPriceCents: 12550 }] })).status).toBe(409);
      expect(await f.data('billing/invoices')).toHaveLength(1); expect(await f.data('crm/jobs')).toHaveLength(1);
    } finally { await f.close(); }
  });

  it('requires owner authentication before revealing the legacy route boundary', async () => {
    const f = await fixture();
    try { expect((await f.request('billing/invoices/from-quote', 'POST', { quoteId: 'invented' }, false)).status).toBe(401); }
    finally { await f.close(); }
  });
});
