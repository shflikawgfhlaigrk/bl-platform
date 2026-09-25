/** Disposable UI acceptance store. All payments are simulated; no real processor calls. */
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { asCoreDb, createTenant } from '@blacklabel/core';
import { createTestDb } from '@blacklabel/db';
import { createProduct, createVariation, addBarcode } from '@blacklabel/catalog';
import { createLocation, applyMovement } from '@blacklabel/inventory';
import { stripeTerminalCheckoutProvider, stripeSignatureHeader } from '@blacklabel/orders';
import { createApp, type PlatformDatabase } from '../apps/api/src/app';
import { securityHeaders } from '../apps/api/src/security';

const secret = 'whsec_disposable_ui_preview';
const reader = 'tmr_simulated_preview';
let sequence = 0;
const intents = new Map<string, number>();
let platform: Awaited<ReturnType<typeof createApp>>;
let tenantId: string;
const provider = stripeTerminalCheckoutProvider({
  secretKey: 'sk_test_simulated_preview', webhookSecret: secret,
  transport: async (url, init) => {
    const form = new URLSearchParams(init.body);
    if (url.endsWith('/payment_intents')) {
      const id = `pi_preview_${++sequence}`; const amount = Number(form.get('amount'));
      intents.set(id, amount);
      return { status: 200, json: async () => ({ id, amount, status: 'requires_payment_method' }) };
    }
    if (url.endsWith('/process_payment_intent')) {
      const id = form.get('payment_intent')!;
      setTimeout(async () => {
        const raw = JSON.stringify({ id: `evt_${id}`, type: 'payment_intent.succeeded', data: { object: {
          id, status: 'succeeded', amount: intents.get(id), amount_received: intents.get(id), latest_charge: `ch_${id}`,
        } } });
        const result = await platform.app.request('/api/orders/webhooks/stripe_terminal', { method: 'POST',
          headers: { 'x-tenant-id': tenantId, 'content-type': 'application/json',
            'stripe-signature': stripeSignatureHeader(secret, Math.floor(Date.now() / 1000), raw) }, body: raw });
        if (!result.ok) console.error('Preview callback failed', result.status);
      }, 1800);
      return { status: 200, json: async () => ({ id: reader, status: 'online', action: { status: 'in_progress' } }) };
    }
    if (url.endsWith('/v1/refunds')) {
      return { status: 200, json: async () => ({ id: `re_${form.get('metadata[refund_id]')}`,
        status: 'succeeded', amount: Number(form.get('amount')), payment_intent: form.get('payment_intent'), charge: `ch_${form.get('payment_intent')}` }) };
    }
    throw new Error('Unsupported simulated operation');
  },
});
const db = createTestDb<PlatformDatabase>();
platform = await createApp({ db, adminMasterKey: Buffer.alloc(32, 43), checkoutProviders: [provider],
  posCardPresent: { provider: 'stripe_terminal', readerId: reader,
    verify: async () => ({ verified: true, readerId: reader, status: 'online', checkedAt: new Date().toISOString() }) },
});
const tenant = await createTenant(asCoreDb(db), { name: 'ONE Club · DEMO' }); tenantId = tenant.id;
await platform.seedTenant(tenantId, { ownerName: 'Club Operator' });
const location = await createLocation(db as never, tenantId, 'system', { name: 'Clubhouse test counter', kind: 'warehouse' });
for (const [name, sku, price] of [['ONE Club polo', 'POLO-01', 6500], ['Golf glove', 'GLV-01', 2500], ['Course cap', 'CAP-01', 3200], ['Bottled water', 'WTR-01', 300]] as const) {
  const product = await createProduct(db as never, tenantId, 'system', { sourceItemId: sku, name });
  const v = await createVariation(db as never, tenantId, 'system', platform.events, {
    productId: product.id, sourceVariationId: sku, name: 'Standard', sku, priceCents: price, trackInventory: true,
  });
  await addBarcode(db as never, tenantId, 'system', v.id, `036000${price}`);
  await applyMovement(db as never, platform.events, tenantId, 'system', { variationId: v.id, locationId: location.id, delta: 10, reason: 'received' });
}
for (const [route, body] of [['/api/pos/settings', { defaultLocationId: location.id, taxBps: 825, receiptFooter: 'Thank you for visiting ONE Club. Demonstration receipt — no real payment.' }], ['/api/pos/auth/bootstrap', { pin: '2468' }]] as const) {
  const res = await platform.app.request(route, { method: route.endsWith('settings') ? 'PUT' : 'POST',
    headers: { 'x-tenant-id': tenantId, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Preview setup failed: ${route} ${res.status}`);
}
const outer = new Hono(); outer.use('*', securityHeaders());
outer.get('/', (c) => c.html(readFileSync('apps/ui/public/index.html', 'utf8').replace('<body>',
  '<body><div class="preview-banner">ONE CLUB PREVIEW <span>Sample items &amp; prices · Simulated payments</span></div>')));
outer.use('/*', serveStatic({ root: './apps/ui/public' })); outer.route('/', platform.app);
serve({ hostname: '127.0.0.1', port: 8469, fetch: (req) => {
  const headers = new Headers(req.headers); headers.set('x-tenant-id', tenantId);
  return outer.fetch(new Request(req, { headers }));
} });
console.log('Disposable POS preview: http://127.0.0.1:8469/#/register (test PIN: 2468)');
