import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '@blacklabel/core';
import { ordersRouter } from '../src/router';
import {
  stripeSign,
  stripeSignatureHeader,
  stripeTerminalCheckoutProvider,
  type HttpTransport,
} from '../src/providers';
import { headers, setup } from './helpers';

const STRIPE_SECRET = 'sk_test_orders';
const WEBHOOK_SECRET = 'whsec_orders';
const NOW = 2_000_000_000;

async function json(res: Response) {
  return (await res.json()) as any;
}

interface CapturedCall {
  url: string;
  init: Parameters<HttpTransport>[1];
}

function fakeStripeTransport() {
  const calls: CapturedCall[] = [];
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/v1/payment_intents')) {
      const form = new URLSearchParams(init.body);
      return {
        status: 200,
        json: async () => ({
          id: 'pi_pos_1',
          amount: Number(form.get('amount')),
          currency: form.get('currency'),
          status: 'requires_payment_method',
        }),
      };
    }
    if (url.endsWith('/process_payment_intent')) {
      return {
        status: 200,
        json: async () => ({
          id: 'tmr_reader_1',
          status: 'online',
          action: { type: 'process_payment_intent', status: 'in_progress' },
        }),
      };
    }
    if (url.endsWith('/cancel_action')) {
      return {
        status: 200,
        json: async () => ({ id: 'tmr_reader_1', status: 'online', action: null }),
      };
    }
    if (url.endsWith('/cancel')) {
      return {
        status: 200,
        json: async () => ({ id: 'pi_pos_1', status: 'canceled' }),
      };
    }
    throw new Error(`unexpected fake Stripe URL: ${url}`);
  };
  return { calls, transport };
}

function stripeProvider(transport: HttpTransport) {
  return stripeTerminalCheckoutProvider({
    secretKey: STRIPE_SECRET,
    webhookSecret: WEBHOOK_SECRET,
    transport,
    nowSeconds: () => NOW,
  });
}

function succeededBody(input: { eventId: string; intentId?: string; amountCents: number; chargeId?: string }) {
  return JSON.stringify({
    id: input.eventId,
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: input.intentId ?? 'pi_pos_1',
        object: 'payment_intent',
        status: 'succeeded',
        amount: input.amountCents,
        amount_received: input.amountCents,
        latest_charge: input.chargeId ?? 'ch_pos_1',
      },
    },
  });
}

function stripeWebhook(app: any, tenant: any, raw: string, timestamp = NOW) {
  return app.request('/webhooks/stripe_terminal', {
    method: 'POST',
    headers: {
      ...headers(tenant),
      'stripe-signature': stripeSignatureHeader(WEBHOOK_SECRET, timestamp, raw),
    },
    body: raw,
  });
}

async function createPosOrder(app: any, tenant: any, amountCents = 1_000, tipCents = 0) {
  return json(
    await app.request('/orders', {
      method: 'POST',
      headers: headers(tenant),
      body: JSON.stringify({
        channel: 'pos',
        registerId: 'reg-1',
        deviceId: 'device-1',
        cashierId: 'cashier-1',
        cashSessionId: 'cash-session-1',
        tipCents,
        lines: [{ description: 'Item', qty: 1, unitPriceCents: amountCents }],
      }),
    }),
  );
}

async function stripeApp() {
  const base = await setup();
  const fake = fakeStripeTransport();
  const provider = stripeProvider(fake.transport);
  const app = ordersRouter(
    { db: base.db, events: new EventBus(), contracts: {} },
    { providers: [provider] },
  );
  return { ...base, app, provider, calls: fake.calls };
}

describe('Stripe Terminal provider transport contract', () => {
  it('creates card_present PaymentIntent then starts the selected reader action', async () => {
    const fake = fakeStripeTransport();
    const provider = stripeProvider(fake.transport);
    const result = await provider.createSession({
      tenantId: 'tenant-1',
      orderId: 'order-1',
      paymentAttemptId: 'attempt-1',
      idempotencyKey: 'tenant-1:pay-1',
      amountCents: 12_345,
      readerId: 'tmr_reader_1',
    });

    expect(result).toMatchObject({
      providerSessionRef: 'pi_pos_1',
      flow: 'terminal',
      terminal: {
        readerId: 'tmr_reader_1',
        readerStatus: 'online',
        actionStatus: 'in_progress',
      },
    });
    expect(result.redirectUrl).toBeUndefined();
    expect(fake.calls).toHaveLength(2);

    const intent = fake.calls[0];
    expect(intent.url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(intent.init.method).toBe('POST');
    expect(intent.init.headers.Authorization).toBe(`Bearer ${STRIPE_SECRET}`);
    expect(intent.init.headers['Idempotency-Key']).toBe('tenant-1:pay-1');
    const intentForm = new URLSearchParams(intent.init.body);
    expect(Object.fromEntries(intentForm.entries())).toMatchObject({
      amount: '12345',
      currency: 'usd',
      capture_method: 'automatic',
      'metadata[tenant_id]': 'tenant-1',
      'metadata[order_id]': 'order-1',
      'metadata[payment_attempt_id]': 'attempt-1',
    });
    expect(intentForm.getAll('payment_method_types[]')).toEqual(['card_present']);

    const reader = fake.calls[1];
    expect(reader.url).toBe(
      'https://api.stripe.com/v1/terminal/readers/tmr_reader_1/process_payment_intent',
    );
    expect(new URLSearchParams(reader.init.body).get('payment_intent')).toBe('pi_pos_1');
    expect(reader.init.headers['Idempotency-Key']).toBe('tenant-1:pay-1:reader');
  });

  it('requires a reader and rejects a provider amount discrepancy before reader processing', async () => {
    const noReader = stripeProvider(async () => ({ status: 500, json: async () => ({}) }));
    await expect(
      noReader.createSession({ tenantId: 't', orderId: 'o', amountCents: 100 }),
    ).rejects.toThrow('requires a readerId');

    let calls = 0;
    const mismatch = stripeProvider(async () => {
      calls += 1;
      return { status: 200, json: async () => ({ id: 'pi_bad', amount: 99 }) };
    });
    await expect(
      mismatch.createSession({
        tenantId: 't',
        orderId: 'o',
        amountCents: 100,
        readerId: 'tmr_reader_1',
      }),
    ).rejects.toThrow('amount does not match');
    expect(calls).toBe(1);
  });
});

describe('Stripe webhook verification and parsing', () => {
  it('verifies v1 signatures with tolerance and rejects tampering, stale, and future timestamps', async () => {
    const provider = stripeProvider(async () => ({ status: 500, json: async () => ({}) }));
    const raw = succeededBody({ eventId: 'evt_sig', amountCents: 1_000 });
    const digest = stripeSign(WEBHOOK_SECRET, NOW, raw);
    expect(
      (
        await provider.verifyWebhook(
          { 'stripe-signature': `t=${NOW},v1=bad,v1=${digest}` },
          raw,
        )
      ).valid,
    ).toBe(true);
    expect(
      (
        await provider.verifyWebhook(
          { 'stripe-signature': stripeSignatureHeader(WEBHOOK_SECRET, NOW, `${raw} `) },
          raw,
        )
      ).valid,
    ).toBe(false);
    expect(
      (
        await provider.verifyWebhook(
          { 'stripe-signature': stripeSignatureHeader(WEBHOOK_SECRET, NOW - 301, raw) },
          raw,
        )
      ).valid,
    ).toBe(false);
    expect(
      (
        await provider.verifyWebhook(
          { 'stripe-signature': stripeSignatureHeader(WEBHOOK_SECRET, NOW + 301, raw) },
          raw,
        )
      ).valid,
    ).toBe(false);
    expect((await provider.verifyWebhook({ 'stripe-signature': 't=nope,v1=abc' }, raw)).valid).toBe(
      false,
    );
  });

  it('parses only succeeded PaymentIntents and normalizes failure details', () => {
    const provider = stripeProvider(async () => ({ status: 500, json: async () => ({}) }));
    const successEvent = JSON.parse(
      succeededBody({ eventId: 'evt_parse', amountCents: 7_777, chargeId: 'ch_7777' }),
    );
    expect(provider.parseCompletion(successEvent)).toEqual({
      providerSessionRef: 'pi_pos_1',
      amountCents: 7_777,
      tenderRef: 'ch_7777',
    });
    expect(() =>
      provider.parseCompletion({
        id: 'evt_fail',
        type: 'payment_intent.payment_failed',
        data: { object: { id: 'pi_pos_1', status: 'requires_payment_method', amount: 7_777 } },
      }),
    ).toThrow('not a successful PaymentIntent');
    expect(
      provider.parsePaymentUpdate?.({
        id: 'evt_fail',
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            id: 'pi_pos_1',
            status: 'requires_payment_method',
            last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds', message: 'No funds' },
          },
        },
      }),
    ).toEqual({
      providerSessionRef: 'pi_pos_1',
      status: 'failed',
      failureCode: 'insufficient_funds',
      failureMessage: 'No funds',
    });
  });
});

describe('Stripe Terminal order integration', () => {
  it('recovers an ambiguous PaymentIntent create and persists its reference before reader I/O', async () => {
    const base = await setup();
    const calls: CapturedCall[] = [];
    let intentCalls = 0;
    const transport: HttpTransport = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/v1/payment_intents')) {
        intentCalls += 1;
        if (intentCalls === 1) {
          // Models a connection loss after Stripe accepted the idempotent create.
          throw new Error('connection lost after remote accept');
        }
        return {
          status: 200,
          json: async () => ({ id: 'pi_recovered', amount: 1_000, status: 'requires_payment_method' }),
        };
      }
      if (url.endsWith('/process_payment_intent')) {
        const durable = await base.db
          .selectFrom('orders_payment_attempts')
          .select(['provider_ref', 'checkout_session_id', 'status'])
          .where('tenant_id', '=', base.tenantA.id)
          .where('idempotency_key', '=', 'recover-create')
          .executeTakeFirstOrThrow();
        expect(durable).toMatchObject({
          provider_ref: 'pi_recovered',
          status: 'processing',
        });
        expect(durable.checkout_session_id).toBeTruthy();
        return {
          status: 200,
          json: async () => ({
            id: 'tmr_reader_1',
            status: 'online',
            action: { type: 'process_payment_intent', status: 'in_progress' },
          }),
        };
      }
      throw new Error(`unexpected fake Stripe URL: ${url}`);
    };
    let app = ordersRouter(
      { db: base.db, events: new EventBus(), contracts: {} },
      { providers: [stripeProvider(transport)] },
    );
    const order = await createPosOrder(app, base.tenantA);
    const request = () => app.request(`/orders/${order.data.id}/payment-attempts`, {
      method: 'POST',
      headers: headers(base.tenantA),
      body: JSON.stringify({
        provider: 'stripe_terminal',
        idempotencyKey: 'recover-create',
        readerId: 'tmr_reader_1',
      }),
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await request()).status).toBe(500);
    } finally {
      errorLog.mockRestore();
    }
    const unresolved = await json(
      await app.request(`/orders/${order.data.id}/payment-attempts`, { headers: headers(base.tenantA) }),
    );
    expect(unresolved.data).toHaveLength(1);
    expect(unresolved.data[0]).toMatchObject({
      status: 'pending',
      provider_ref: null,
      failure_code: 'provider_request_unresolved',
    });

    // Recompose the router against the same durable DB to model a process restart.
    app = ordersRouter(
      { db: base.db, events: new EventBus(), contracts: {} },
      { providers: [stripeProvider(transport)] },
    );
    const recovered = await request();
    expect(recovered.status).toBe(200);
    expect((await json(recovered)).data.attempt).toMatchObject({
      id: unresolved.data[0].id,
      status: 'processing',
      provider_ref: 'pi_recovered',
      failure_code: null,
    });
    const intentRequests = calls.filter((call) => call.url.endsWith('/v1/payment_intents'));
    expect(intentRequests).toHaveLength(2);
    expect(intentRequests.map((call) => call.init.headers['Idempotency-Key'])).toEqual([
      `${base.tenantA.id}:recover-create`,
      `${base.tenantA.id}:recover-create`,
    ]);
  });

  it('includes tip in PaymentIntent, captures only after verified success, and replays safely', async () => {
    const { app, tenantA, calls } = await stripeApp();
    const order = await createPosOrder(app, tenantA, 1_000, 250);
    const attemptRes = await app.request(`/orders/${order.data.id}/payment-attempts`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({
        provider: 'stripe_terminal',
        idempotencyKey: 'stripe-attempt-1',
        readerId: 'tmr_reader_1',
      }),
    });
    expect(attemptRes.status).toBe(201);
    const attempt = await json(attemptRes);
    expect(attempt.data).toMatchObject({
      created: true,
      flow: 'terminal',
      terminal: { readerId: 'tmr_reader_1', readerStatus: 'online', actionStatus: 'in_progress' },
    });
    expect(attempt.data.attempt).toMatchObject({ status: 'processing', amount_cents: 1_250 });
    expect(new URLSearchParams(calls[0].init.body).get('amount')).toBe('1250');
    expect(
      (
        await json(
          await app.request(`/orders/${order.data.id}/tenders`, { headers: headers(tenantA) }),
        )
      ).data,
    ).toEqual([]);

    const raw = succeededBody({ eventId: 'evt_stripe_paid', amountCents: 1_250 });
    const paid = await stripeWebhook(app, tenantA, raw);
    expect(paid.status).toBe(200);
    expect((await json(paid)).data.outcome).toBe('paid');
    const orderAfter = await json(
      await app.request(`/orders/${order.data.id}`, { headers: headers(tenantA) }),
    );
    expect(orderAfter.data).toMatchObject({ status: 'paid', tip_cents: 250, total_cents: 1_250 });
    const attemptAfter = await json(
      await app.request(`/payment-attempts/${attempt.data.attempt.id}`, { headers: headers(tenantA) }),
    );
    expect(attemptAfter.data.status).toBe('succeeded');
    const tenders = await json(
      await app.request(`/orders/${order.data.id}/tenders`, { headers: headers(tenantA) }),
    );
    expect(tenders.data).toHaveLength(1);
    expect(tenders.data[0]).toMatchObject({
      provider: 'stripe_terminal',
      provider_ref: 'ch_pos_1',
      amount_cents: 1_250,
      status: 'captured',
    });

    // Exact webhook replay returns the stored outcome without another tender.
    expect((await json(await stripeWebhook(app, tenantA, raw))).data.outcome).toBe('paid');
    const tendersAfterReplay = await json(
      await app.request(`/orders/${order.data.id}/tenders`, { headers: headers(tenantA) }),
    );
    expect(tendersAfterReplay.data).toHaveLength(1);
    const webhookEvents = await json(await app.request('/webhooks', { headers: headers(tenantA) }));
    expect(webhookEvents.data).toHaveLength(1);
  });

  it('marks a signed provider failure and retains no tender', async () => {
    const { app, tenantA } = await stripeApp();
    const order = await createPosOrder(app, tenantA);
    const attempt = await json(
      await app.request(`/orders/${order.data.id}/payment-attempts`, {
        method: 'POST',
        headers: headers(tenantA),
        body: JSON.stringify({
          provider: 'stripe_terminal',
          idempotencyKey: 'stripe-fail',
          readerId: 'tmr_reader_1',
        }),
      }),
    );
    const raw = JSON.stringify({
      id: 'evt_stripe_failed',
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: 'pi_pos_1',
          status: 'requires_payment_method',
          last_payment_error: { code: 'card_declined', decline_code: 'do_not_honor', message: 'Declined' },
        },
      },
    });
    expect((await json(await stripeWebhook(app, tenantA, raw))).data.outcome).toBe('payment_failed');
    const attemptAfter = await json(
      await app.request(`/payment-attempts/${attempt.data.attempt.id}`, { headers: headers(tenantA) }),
    );
    expect(attemptAfter.data).toMatchObject({
      status: 'failed',
      failure_code: 'do_not_honor',
      failure_message: 'Declined',
    });
    const tenders = await json(
      await app.request(`/orders/${order.data.id}/tenders`, { headers: headers(tenantA) }),
    );
    expect(tenders.data).toEqual([]);
  });

  it('fails a signed amount mismatch and never inserts a tender', async () => {
    const { app, tenantA } = await stripeApp();
    const order = await createPosOrder(app, tenantA, 1_000);
    const attempt = await json(
      await app.request(`/orders/${order.data.id}/payment-attempts`, {
        method: 'POST',
        headers: headers(tenantA),
        body: JSON.stringify({
          provider: 'stripe_terminal',
          idempotencyKey: 'stripe-mismatch',
          readerId: 'tmr_reader_1',
        }),
      }),
    );
    const raw = succeededBody({ eventId: 'evt_stripe_mismatch', amountCents: 999 });
    expect((await json(await stripeWebhook(app, tenantA, raw))).data.outcome).toBe('amount_mismatch');
    const attemptAfter = await json(
      await app.request(`/payment-attempts/${attempt.data.attempt.id}`, { headers: headers(tenantA) }),
    );
    expect(attemptAfter.data).toMatchObject({ status: 'failed', failure_code: 'amount_mismatch' });
    const tenders = await json(
      await app.request(`/orders/${order.data.id}/tenders`, { headers: headers(tenantA) }),
    );
    expect(tenders.data).toEqual([]);
  });

  it('cancels reader action and PaymentIntent before marking the attempt canceled', async () => {
    const { app, tenantA, calls } = await stripeApp();
    const order = await createPosOrder(app, tenantA);
    const attempt = await json(
      await app.request(`/orders/${order.data.id}/payment-attempts`, {
        method: 'POST',
        headers: headers(tenantA),
        body: JSON.stringify({
          provider: 'stripe_terminal',
          idempotencyKey: 'stripe-cancel',
          readerId: 'tmr_reader_1',
        }),
      }),
    );
    const canceled = await app.request(`/payment-attempts/${attempt.data.attempt.id}/cancel`, {
      method: 'POST',
      headers: headers(tenantA),
    });
    expect((await json(canceled)).data.status).toBe('canceled');
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.stripe.com/v1/payment_intents',
      'https://api.stripe.com/v1/terminal/readers/tmr_reader_1/process_payment_intent',
      'https://api.stripe.com/v1/terminal/readers/tmr_reader_1/cancel_action',
      'https://api.stripe.com/v1/payment_intents/pi_pos_1/cancel',
    ]);
    expect(calls[2].init.headers['Idempotency-Key']).toContain('stripe-cancel:reader-cancel');
    expect(calls[3].init.headers['Idempotency-Key']).toContain('stripe-cancel:intent-cancel');
  });
});
