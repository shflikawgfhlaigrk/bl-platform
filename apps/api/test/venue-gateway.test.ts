import { describe, expect, it } from 'vitest';
import { createTestDb } from '@blacklabel/db';
import { asCoreDb, createTenant } from '@blacklabel/core';
import { createApp, type PlatformDatabase } from '../src/app';
import { createPosAuth, type PosAuthDatabase } from '../src/pos-auth';
import type { Kysely } from 'kysely';
import { venueGateway } from '../src/venue-gateway';
import { stripeTerminalCheckoutProvider, stripeSignatureHeader } from '@blacklabel/orders';

describe('single-register venue boundary', () => {
  it('requires sessions for headerless tools, ignores claimed tenants/owners and closes public bootstrap', async () => {
    const db = createTestDb<PlatformDatabase>();
    try {
      const provider = stripeTerminalCheckoutProvider({ secretKey: 'sk_test_unused', webhookSecret: 'whsec_venue_test', transport: async () => { throw new Error('No processor HTTP request is expected in this signature test.'); } });
      const platform = await createApp({ db, posNetworkMode: true, includeCheckoutSimulator: false, disableRateLimit: true, checkoutProviders: [provider] });
      const tenant = await createTenant(asCoreDb(db), { name: 'Venue' });
      const seeded = await platform.seedTenant(tenant.id);
      const gateway = venueGateway({ tenantId: tenant.id, origin: 'https://pos.example.test', fetch: r => platform.app.fetch(r) });
      const request = (path: string, init: RequestInit = {}) => gateway(new Request(`http://127.0.0.1:8480${path}`, init));
      const raw = JSON.stringify({ id: 'evt_unknown', type: 'payment_intent.succeeded', data: { object: { id: 'pi_unknown', status: 'succeeded', amount: 500, amount_received: 500 } } });
      const webhook = await request('/api/orders/webhooks/stripe_terminal', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripeSignatureHeader('whsec_venue_test', Math.floor(Date.now()/1000), raw) }, body: raw });
      expect(webhook.status).toBe(200);
      expect((await request('/api/orders/webhooks/simulator', { method: 'POST', body: '{}' })).status).toBe(401);
      expect((await request('/api/pos/bar/state', { headers: { 'x-user-id': seeded.ownerUserId, 'x-tenant-id': 'other' } })).status).toBe(401);
      expect((await request('/api/pos/auth/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"pin":"1234"}' })).status).toBe(403);
      // Provisioning is an in-process server operation, never an exposed route.
      const provision = await createPosAuth(db as unknown as Kysely<PosAuthDatabase>).router.request('/bootstrap', { method: 'POST', headers: { 'x-tenant-id': tenant.id, 'content-type': 'application/json' }, body: '{"pin":"1234"}' });
      expect(provision.status).toBe(201);
      const login = await request('/api/pos/auth/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: seeded.ownerUserId, pin: '1234' }) });
      expect(login.status).toBe(201); expect(login.headers.get('set-cookie')).toContain('Secure');
      const cookie = login.headers.get('set-cookie')!.split(';')[0];
      const readiness = await request('/api/pos/readiness', { headers: { cookie } });
      expect(((await readiness.json()) as { data: { providers: string[] } }).data.providers).toEqual(['stripe_terminal']);
      expect((await request('/api/pos/bar/state', { headers: { cookie, 'x-tenant-id': 'other', 'x-user-id': 'forged' } })).status).toBe(200);
      expect((await request('/api/pos/bar/state', { headers: { cookie, origin: 'https://other.test', 'x-mags-csrf': '1' } })).status).toBe(403);
    } finally { await db.destroy(); }
  });
});
