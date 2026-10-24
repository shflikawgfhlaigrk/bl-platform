/** Local-only browser fixture: real business UI/API, synthetic in-memory records. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { asCoreDb, createTenant } from '@blacklabel/core';
import { createTestDb } from '@blacklabel/db';
import { createApp, type PlatformDatabase } from '../../api/src/app';
import { createBusinessApp } from '../src/app';
import { businessFetch } from '../src/transport';

const prefix = process.argv[2];
if (!prefix) throw new Error('Provide an absolute evidence-file prefix.');
const db = createTestDb<PlatformDatabase>();
let app: ReturnType<typeof createBusinessApp>;
const platform = await createApp({ db, businessPortals: true, disableRateLimit: true,
  includeCheckoutSimulator: false, browserSessionUser: async request => app?.resolveOwnerRequest(request) });
const tenantId = (await createTenant(asCoreDb(db), { name: 'Synthetic customer E2E company' })).id;
const { ownerUserId } = await platform.seedTenant(tenantId);
const settings = { companyName: 'Synthetic customer E2E company' };
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
app = createBusinessApp({ platform, tenantId, ownerUserId, accessToken: 'local-customer-e2e-only',
  version: 'local-customer-e2e', settings: async () => settings, saveSettings: async value => { Object.assign(settings, value); },
  asset: async name => fs.readFile(path.join(publicDir, name)) });
const data = async (route: string, method = 'GET', body?: unknown) => {
  const response = await platform.app.request(`/api/${route}`, { method,
    headers: { 'x-tenant-id': tenantId, 'x-user-id': ownerUserId, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json() as any;
  if (!response.ok) throw new Error(`${method} ${route}: ${JSON.stringify(result)}`);
  return result.data;
};
const customer = await data('crm/customers', 'POST', { name: 'Synthetic offline customer' });
const invoice = await data('billing/invoices', 'POST', { customerId: customer.id,
  memo: 'Customer E2E: two separate cash installments',
  lines: [{ description: 'Synthetic service', quantity: 1, unitPriceCents: 10000 }] });
await data(`billing/invoices/${invoice.id}/send`, 'POST', {});
for (let index = 1; index < 200; index++) await data('billing/invoices', 'POST', {
  customerId: customer.id, memo: `Synthetic scale record ${index}`,
  lines: [{ description: 'Synthetic scale record', quantity: 1, unitPriceCents: 100 }] });
const quote = await data('quoting/quotes', 'POST', { customerId: customer.id,
  title: 'Synthetic approved quote with unused optional line',
  lines: [{ description: 'Approved work', quantity: 1, unitPriceCents: 12550 },
    { description: 'Unused optional item', quantity: 0, unitPriceCents: 9000 }] });
await data(`quoting/quotes/${quote.quote.id}/send`, 'POST', {});
await data(`quoting/quotes/${quote.quote.id}/approve`, 'POST', { signerName: 'Synthetic fixture customer' });

const requests: { method: string; path: string; status: number }[] = [];
let acknowledgementLost = false;
async function snapshot() {
  const rows = await db.selectFrom('billing_invoices').select(['id', 'number', 'status', 'total_cents', 'paid_cents'])
    .where('tenant_id', '=', tenantId).execute();
  const state = { checkedAt: new Date().toISOString(), synthetic: true, production: false,
    originalInvoice: rows.find(row => row.id === invoice.id), invoiceCount: rows.length,
    otherNonScaleInvoices: rows.filter(row => row.id !== invoice.id && row.total_cents !== 100),
    payments: await db.selectFrom('billing_payments').select(['id', 'invoice_id', 'amount_cents', 'method', 'external_ref'])
      .where('tenant_id', '=', tenantId).execute(),
    paymentReceipts: await db.selectFrom('billing_payment_receipts').select(['payment_id', 'receipt_ref'])
      .where('tenant_id', '=', tenantId).execute(),
    quotes: await db.selectFrom('quoting_quotes').select(['id', 'status', 'converted_at']).where('tenant_id', '=', tenantId).execute(),
    jobs: await db.selectFrom('crm_jobs').select(['id', 'title']).where('tenant_id', '=', tenantId).execute(),
    workflows: await db.selectFrom('workflows_workflows').select(['id', 'name', 'enabled', 'trigger_event'])
      .where('tenant_id', '=', tenantId).execute(),
    tasks: await db.selectFrom('workflows_tasks').select(['id', 'title', 'related_entity_type', 'related_entity_id'])
      .where('tenant_id', '=', tenantId).execute(),
    acknowledgementLost, requests };
  await fs.writeFile(`${prefix}-state.json`, `${JSON.stringify(state, null, 2)}\n`);
}
let tail = Promise.resolve();
const serial = <T>(operation: () => Promise<T>) => { const result = tail.then(operation); tail = result.then(() => {}, () => {}); return result; };
const transport = { port: 0 };
let stopped = false;
async function stop() {
  if (stopped) return; stopped = true;
  await snapshot();
  if ('closeIdleConnections' in server) server.closeIdleConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  platform.detachEngine(); await db.destroy();
  clearTimeout(expiry); console.log('Local customer fixture stopped.');
}
const server = serve({ hostname: '127.0.0.1', port: 0, fetch: businessFetch(transport, async (request, env) => {
  const url = new URL(request.url);
  if (url.pathname === '/__fixture/finish' && request.method === 'POST') {
    setTimeout(() => void stop(), 50); return Response.json({ stopped: true });
  }
  const response = await app.fetch(request, env);
  if (url.pathname.startsWith('/api/')) {
    let returnedStatus = response.status;
    if (!acknowledgementLost && request.method === 'POST' && url.pathname === `/api/billing/invoices/${invoice.id}/payments` && response.ok) {
      acknowledgementLost = true; returnedStatus = 503;
      requests.push({ method: request.method, path: url.pathname + url.search, status: returnedStatus }); await snapshot();
      return Response.json({ error: { message: 'Synthetic receipt acknowledgement lost after commit. Retry this payment.' } }, { status: 503 });
    }
    requests.push({ method: request.method, path: url.pathname + url.search, status: returnedStatus }); await snapshot();
  }
  return response;
}, serial) }, async info => {
  transport.port = info.port;
  await snapshot();
  console.log(JSON.stringify({ origin: `http://127.0.0.1:${info.port}`, invoiceId: invoice.id,
    quoteId: quote.quote.id, initialInvoices: 200, synthetic: true }));
});
const expiry = setTimeout(() => void stop(), 20 * 60 * 1000);
