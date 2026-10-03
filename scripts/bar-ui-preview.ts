/** Disposable UI acceptance store. All payments are simulated; no real processor calls. */
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { asCoreDb, createTenant } from '@blacklabel/core';
import { createTestDb } from '@blacklabel/db';
import { createLocation } from '@blacklabel/inventory';
import { stripeTerminalCheckoutProvider, stripeSignatureHeader } from '@blacklabel/orders';
import { createApp, type PlatformDatabase } from '../apps/api/src/app';
import { securityHeaders } from '../apps/api/src/security';
import { venueGateway } from '../apps/api/src/venue-gateway';

const secret = 'whsec_disposable_bar_preview';
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
const previewOptions = { db, adminMasterKey: Buffer.alloc(32, 43), checkoutProviders: [provider],
  posCardPresent: { provider: 'stripe_terminal', readerId: reader,
    verify: async () => ({ verified: true, readerId: reader, status: 'online', checkedAt: new Date().toISOString() }) },
};
platform = await createApp(previewOptions);
const tenant = await createTenant(asCoreDb(db), { name: 'ONE Club · DEMO' }); tenantId = tenant.id;
await platform.seedTenant(tenantId, { ownerName: 'Club Operator' });
const location = await createLocation(db as never, tenantId, 'system', { name: 'Bar practice drawer', kind: 'warehouse' });
for (const [route, body] of [['/api/pos/settings', { defaultLocationId: location.id, taxBps: 1000, receiptFooter: 'Thank you for visiting ONE Club. Demonstration receipt — no real payment.' }], ['/api/pos/auth/bootstrap', { pin: '2468' }]] as const) {
  const res = await platform.app.request(route, { method: route.endsWith('settings') ? 'PUT' : 'POST',
    headers: { 'x-tenant-id': tenantId, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Preview setup failed: ${route} ${res.status}`);
}
// These deliberately fictional practice items never seed a live venue.
async function seedBar(route: string, body: unknown) {
  const response = await platform.app.request(`/api/pos/bar/${route}`, { method: 'POST',
    headers: { 'x-tenant-id': tenantId, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Bar preview seed: ${response.status} ${await response.text()}`);
  return (await response.json() as any).data;
}
const tequila = await seedBar('stock', { name: 'Sample tequila', unit: 'ml', onHand: 6000, reason: 'Practice opening count' });
const beer = await seedBar('stock', { name: 'Sample draft servings', unit: 'unit', onHand: 100, reason: 'Practice opening count' });
await seedBar('menu', { name: 'Club Margarita', category: 'Cocktails', priceCents: 1200,
  recipe: [{ ingredientId: tequila.id, quantity: 45 }], modifiers: [{ id: 'style', name: 'Style', required: true,
    choices: [{ id: 'rocks', name: 'On the rocks', priceCents: 0 }, { id: 'spicy', name: 'Spicy', priceCents: 100 }] },
    { id: 'pour', name: 'Pour', choices: [{ id: 'double', name: 'Double', priceCents: 500, recipe: [{ ingredientId: tequila.id, quantity: 45 }] }] }] });
for (const [name, category, priceCents] of [
  ['Old Fashioned', 'Cocktails', 1400], ['Espresso Martini', 'Cocktails', 1500], ['Paloma', 'Cocktails', 1200],
  ['House Lager', 'Beer', 600], ['Local IPA', 'Beer', 800], ['Chardonnay', 'Wine', 1000], ['Cabernet', 'Wine', 1100],
  ['Club Soda', 'No alcohol', 300], ['Bottled Water', 'No alcohol', 300], ['Lemonade', 'No alcohol', 400],
] as const) await seedBar('menu', { name, category, priceCents, recipe: category === 'Beer' ? [{ ingredientId: beer.id, quantity: 1 }] : [] });
await seedBar('menu', { name: 'Club Burger', category: 'Food', prepStation: 'kitchen', priceCents: 1600,
  modifiers: [{ id: 'side', name: 'Side', required: true, choices: [{ id: 'fries', name: 'Fries', priceCents: 0 }, { id: 'salad', name: 'Side salad', priceCents: 200 }] }] });
await seedBar('menu', { name: 'Chicken Tenders', category: 'Food', prepStation: 'kitchen', priceCents: 1200 });
await seedBar('menu', { name: 'Fries', category: 'Food', prepStation: 'kitchen', priceCents: 500 });
const host = process.env.ONECLUB_PREVIEW_HOST || '127.0.0.1';
const port = Number(process.env.ONECLUB_PREVIEW_PORT || 8470);
const origin = new URL(process.env.ONECLUB_PREVIEW_ORIGIN || `http://${host}:${port}`).origin;
// A loopback listener exposed through HTTPS still requires staff sessions.
const networkExposed = host !== '127.0.0.1' || new URL(origin).protocol === 'https:';
if (host !== '127.0.0.1') {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255) ||
      !(octets[0] === 10 || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31))) {
    throw new Error('Use a specific private LAN address for iPad practice.');
  }
}
if (networkExposed) {
  // Bootstrap fixture data privately, then close the trusted-tool shortcut
  // before listening on the LAN. Every network client needs a staff session.
  platform.detachEngine();
  platform = await createApp({ ...previewOptions, posNetworkMode: true });
}
const outer = new Hono(); outer.use('*', securityHeaders());
outer.get('/', (c) => c.html(readFileSync('apps/ui/public/index.html', 'utf8').replace('<body>',
  '<body data-pos-profile="bar"><div class="preview-banner">ONE CLUB PREVIEW <span>PRACTICE MODE · Sample food, drinks, prices &amp; 10% tax · Simulated payments</span></div>')));
outer.use('/*', serveStatic({ root: './apps/ui/public' })); outer.route('/', platform.app);
const localFetch = (req: Request) => {
  const headers = new Headers(req.headers); headers.set('x-tenant-id', tenantId);
  return outer.fetch(new Request(req, { headers }));
};
serve({ hostname: host, port, fetch: networkExposed ? venueGateway({ origin, tenantId, fetch: req => outer.fetch(req) }) : localFetch });
console.log(`Disposable bar practice: ${origin}/#/bar (test PIN: 2468)`);
