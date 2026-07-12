import { describe, expect, it } from 'vitest';
import { EventBus } from '@blacklabel/core';
import {
  simulatorCheckoutProvider,
  simulatorCompletionBody,
  simulatorSign,
  squareHostedCheckoutProvider,
  squareSign,
  type HttpTransport,
} from '../src/providers';
import { collect, headers, SIM_SECRET, setup } from './helpers';

async function json(res: Response) {
  return (await res.json()) as any;
}

async function paidOrderWithSession(app: any, tenant: any, amountCents = 5000) {
  const order = await json(
    await app.request('/orders', {
      method: 'POST',
      headers: headers(tenant),
      body: JSON.stringify({ channel: 'storefront', lines: [{ variationId: 'v1', description: 'X', qty: 1, unitPriceCents: amountCents }] }),
    }),
  );
  const session = await json(
    await app.request(`/orders/${order.data.id}/checkout-sessions`, {
      method: 'POST',
      headers: headers(tenant),
      body: JSON.stringify({ provider: 'simulator', returnUrl: 'https://shop.mags.local/thanks' }),
    }),
  );
  return { orderId: order.data.id, sessionRef: session.data.session.provider_session_ref, redirectUrl: session.data.redirectUrl };
}

function postWebhook(app: any, tenant: any, rawBody: string, signature?: string) {
  const h: Record<string, string> = { 'x-tenant-id': tenant.id, 'content-type': 'application/json' };
  if (signature !== undefined) h['x-mags-signature'] = signature;
  return app.request('/webhooks/simulator', { method: 'POST', headers: h, body: rawBody });
}

describe('simulator checkout end-to-end', () => {
  it('create session -> signed webhook -> order paid', async () => {
    const { app, events, tenantA } = await setup();
    const paidEvents = collect(events, 'orders.order.paid');
    const { orderId, sessionRef, redirectUrl } = await paidOrderWithSession(app, tenantA);
    expect(redirectUrl).toContain(sessionRef);

    const raw = simulatorCompletionBody({ eventId: 'evt_1', providerSessionRef: sessionRef, amountCents: 5000, tenderRef: 'txn_1' });
    const res = await postWebhook(app, tenantA, raw, simulatorSign(SIM_SECRET, raw));
    expect(res.status).toBe(200);
    expect((await json(res)).data.outcome).toBe('paid');

    const order = await json(await app.request(`/orders/${orderId}`, { headers: headers(tenantA) }));
    expect(order.data.status).toBe('paid');
    expect(paidEvents).toHaveLength(1);

    // A provider tender was captured for the amount.
    const tenders = await json(await app.request(`/orders/${orderId}/tenders`, { headers: headers(tenantA) }));
    expect(tenders.data).toHaveLength(1);
    expect(tenders.data[0].kind).toBe('provider');
    expect(tenders.data[0].amount_cents).toBe(5000);
  });

  it('rejects a BAD signature and does not pay the order', async () => {
    const { app, tenantA } = await setup();
    const { orderId, sessionRef } = await paidOrderWithSession(app, tenantA);
    const raw = simulatorCompletionBody({ eventId: 'evt_bad', providerSessionRef: sessionRef, amountCents: 5000 });
    const res = await postWebhook(app, tenantA, raw, 'deadbeef-not-a-real-signature');
    expect(res.status).toBe(400);
    expect((await json(res)).data.outcome).toBe('invalid_signature');
    const order = await json(await app.request(`/orders/${orderId}`, { headers: headers(tenantA) }));
    expect(order.data.status).toBe('draft');
  });

  it('a DUPLICATE webhook (same event_ref) is a no-op returning the prior outcome', async () => {
    const { app, events, tenantA } = await setup();
    const paidEvents = collect(events, 'orders.order.paid');
    const { orderId, sessionRef } = await paidOrderWithSession(app, tenantA);
    const raw = simulatorCompletionBody({ eventId: 'evt_dup', providerSessionRef: sessionRef, amountCents: 5000, tenderRef: 'txn_dup' });
    const sig = simulatorSign(SIM_SECRET, raw);

    const first = await postWebhook(app, tenantA, raw, sig);
    expect((await json(first)).data.outcome).toBe('paid');
    const second = await postWebhook(app, tenantA, raw, sig);
    expect(second.status).toBe(200);
    expect((await json(second)).data.outcome).toBe('paid'); // prior outcome, replayed

    // No double payment: still exactly one paid event and one tender.
    expect(paidEvents).toHaveLength(1);
    const tenders = await json(await app.request(`/orders/${orderId}/tenders`, { headers: headers(tenantA) }));
    expect(tenders.data).toHaveLength(1);
    // And exactly one recorded webhook event.
    const events2 = await json(await app.request('/webhooks', { headers: headers(tenantA) }));
    expect(events2.data).toHaveLength(1);
  });

  it('an AMOUNT MISMATCH records the outcome, does NOT pay, and emits orders.payment.mismatched', async () => {
    const { app, events, tenantA } = await setup();
    const mismatched = collect(events, 'orders.payment.mismatched');
    const paidEvents = collect(events, 'orders.order.paid');
    const { orderId, sessionRef } = await paidOrderWithSession(app, tenantA, 5000);

    const raw = simulatorCompletionBody({ eventId: 'evt_mm', providerSessionRef: sessionRef, amountCents: 4200, tenderRef: 'txn_mm' });
    const res = await postWebhook(app, tenantA, raw, simulatorSign(SIM_SECRET, raw));
    expect(res.status).toBe(200);
    expect((await json(res)).data.outcome).toBe('amount_mismatch');

    const order = await json(await app.request(`/orders/${orderId}`, { headers: headers(tenantA) }));
    expect(order.data.status).toBe('draft');
    expect(paidEvents).toHaveLength(0);
    expect(mismatched).toHaveLength(1);
    expect(mismatched[0].payload).toMatchObject({ v: 1, orderId, expectedCents: 5000, receivedCents: 4200 });
  });

  it('an unknown session ref is recorded and not paid', async () => {
    const { app, tenantA } = await setup();
    const raw = simulatorCompletionBody({ eventId: 'evt_u', providerSessionRef: 'sim_sess_nope', amountCents: 100 });
    const res = await postWebhook(app, tenantA, raw, simulatorSign(SIM_SECRET, raw));
    expect((await json(res)).data.outcome).toBe('unknown_session');
  });

  it('webhook is tenant-scoped: tenant B cannot resolve tenant A session', async () => {
    const { app, tenantA, tenantB } = await setup();
    const { sessionRef } = await paidOrderWithSession(app, tenantA);
    const raw = simulatorCompletionBody({ eventId: 'evt_x', providerSessionRef: sessionRef, amountCents: 5000 });
    const res = await postWebhook(app, tenantB, raw, simulatorSign(SIM_SECRET, raw));
    expect((await json(res)).data.outcome).toBe('unknown_session');
  });
});

describe('checkout provider not configured', () => {
  it('returns 501 when the requested provider is absent', async () => {
    const { app, tenantA } = await setup();
    const order = await json(
      await app.request('/orders', {
        method: 'POST',
        headers: headers(tenantA),
        body: JSON.stringify({ channel: 'storefront', lines: [{ description: 'X', qty: 1, unitPriceCents: 100 }] }),
      }),
    );
    const res = await app.request(`/orders/${order.data.id}/checkout-sessions`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ provider: 'square_hosted' }),
    });
    expect(res.status).toBe(501);
  });
});

describe('simulator provider signature math (unit)', () => {
  it('verifies its own signature and rejects tampering', async () => {
    const provider = simulatorCheckoutProvider({ secret: 'abc' });
    const raw = simulatorCompletionBody({ eventId: 'e', providerSessionRef: 'sim_sess_1', amountCents: 100 });
    const good = await provider.verifyWebhook({ 'x-mags-signature': simulatorSign('abc', raw) }, raw);
    expect(good.valid).toBe(true);
    const bad = await provider.verifyWebhook({ 'x-mags-signature': simulatorSign('wrong', raw) }, raw);
    expect(bad.valid).toBe(false);
    const missing = await provider.verifyWebhook({}, raw);
    expect(missing.valid).toBe(false);
  });
});

describe('square-hosted provider (structural, injected transport)', () => {
  it('createSession posts the correct payload shape and parses payment_link', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;
    const transport: HttpTransport = async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      return {
        status: 200,
        json: async () => ({ payment_link: { id: 'plink_123', url: 'https://square.link/u/plink_123' } }),
      };
    };
    const provider = squareHostedCheckoutProvider({
      accessToken: 'sq-token',
      locationId: 'L1',
      signatureKey: 'sigkey',
      notificationUrl: 'https://api.mags.local/api/orders/webhooks/square_hosted',
      transport,
    });
    const result = await provider.createSession({ tenantId: 't', orderId: 'o1', amountCents: 2500 });
    expect(result.providerSessionRef).toBe('plink_123');
    expect(result.redirectUrl).toContain('plink_123');
    expect(capturedUrl).toContain('/v2/online-checkout/payment-links');
    expect(capturedBody.quick_pay.price_money).toMatchObject({ amount: 2500, currency: 'USD' });
    expect(capturedBody.quick_pay.location_id).toBe('L1');
  });

  it('verifies a Square-scheme HMAC (base64 over notificationUrl + body) and parses completion', async () => {
    const notificationUrl = 'https://api.mags.local/hook';
    const provider = squareHostedCheckoutProvider({
      accessToken: 't',
      locationId: 'L1',
      signatureKey: 'sigkey',
      notificationUrl,
      transport: async () => ({ status: 200, json: async () => ({}) }),
    });
    const raw = JSON.stringify({
      id: 'sqevt_1',
      type: 'payment.updated',
      data: { object: { payment: { id: 'pay_1', payment_link_id: 'plink_123', status: 'COMPLETED', amount_money: { amount: 2500, currency: 'USD' } } } },
    });
    const verified = await provider.verifyWebhook({ 'x-square-hmacsha256-signature': squareSign('sigkey', notificationUrl, raw) }, raw);
    expect(verified.valid).toBe(true);
    const completion = provider.parseCompletion(verified.event);
    expect(completion).toMatchObject({ providerSessionRef: 'plink_123', amountCents: 2500, tenderRef: 'pay_1' });

    const tampered = await provider.verifyWebhook({ 'x-square-hmacsha256-signature': 'AAAA' }, raw);
    expect(tampered.valid).toBe(false);
  });

  it('drives the full orders webhook lane with a Square provider + fake transport', async () => {
    const db = (await setup()).db;
    // Build a fresh app wired with the square provider so we exercise processWebhook end to end.
    const notificationUrl = 'https://api.mags.local/hook';
    const provider = squareHostedCheckoutProvider({
      accessToken: 't',
      locationId: 'L1',
      signatureKey: 'sigkey',
      notificationUrl,
      transport: async () => ({ status: 200, json: async () => ({ payment_link: { id: 'plink_sq', url: 'https://square.link/u/plink_sq' } }) }),
    });
    const events = new EventBus();
    const { ordersRouter } = await import('../src/router');
    const { createTenant, asCoreDb } = await import('@blacklabel/core');
    const tenant = await createTenant(asCoreDb(db), { name: 'Square Co' });
    const app = ordersRouter({ db: db as any, events, contracts: {} }, { providers: [provider] });

    const order = await json(
      await app.request('/orders', {
        method: 'POST',
        headers: { 'x-tenant-id': tenant.id, 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'storefront', lines: [{ variationId: 'v', description: 'X', qty: 1, unitPriceCents: 2500 }] }),
      }),
    );
    await app.request(`/orders/${order.data.id}/checkout-sessions`, {
      method: 'POST',
      headers: { 'x-tenant-id': tenant.id, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'square_hosted' }),
    });
    const raw = JSON.stringify({
      id: 'sqevt_paid',
      type: 'payment.updated',
      data: { object: { payment: { id: 'pay_9', payment_link_id: 'plink_sq', status: 'COMPLETED', amount_money: { amount: 2500 } } } },
    });
    const res = await app.request('/webhooks/square_hosted', {
      method: 'POST',
      headers: { 'x-tenant-id': tenant.id, 'content-type': 'application/json', 'x-square-hmacsha256-signature': squareSign('sigkey', notificationUrl, raw) },
      body: raw,
    });
    expect((await json(res)).data.outcome).toBe('paid');
    const paid = await json(await app.request(`/orders/${order.data.id}`, { headers: { 'x-tenant-id': tenant.id } }));
    expect(paid.data.status).toBe('paid');
  });
});
