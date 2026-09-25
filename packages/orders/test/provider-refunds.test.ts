import { describe, expect, it } from 'vitest';
import { EventBus } from '@blacklabel/core';
import { ordersRouter } from '../src/router';
import {
  simulatorCompletionBody,
  simulatorSign,
  stripeSignatureHeader,
  stripeTerminalCheckoutProvider,
  type HttpTransport,
} from '../src/providers';
import { headers, setup, SIM_SECRET } from './helpers';

const STRIPE_SECRET = 'sk_test_refunds';
const WEBHOOK_SECRET = 'whsec_refunds';
const NOW = 2_000_000_000;

async function json(response: Response) {
  return (await response.json()) as any;
}

type RefundBehavior =
  | 'success'
  | 'pending'
  | 'declined'
  | 'mismatch'
  | 'transport_failure'
  | 'callback_race_mismatch';

async function stripeRefundHarness(behavior: RefundBehavior = 'success') {
  const base = await setup();
  const calls: { url: string; init: Parameters<HttpTransport>[1] }[] = [];
  let app: ReturnType<typeof ordersRouter>;
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/v1/payment_intents')) {
      const form = new URLSearchParams(init.body);
      return {
        status: 200,
        json: async () => ({
          id: 'pi_refund_1',
          amount: Number(form.get('amount')),
          status: 'requires_payment_method',
        }),
      };
    }
    if (url.endsWith('/process_payment_intent')) {
      return {
        status: 200,
        json: async () => ({
          id: 'tmr_refund_reader',
          status: 'online',
          action: { type: 'process_payment_intent', status: 'in_progress' },
        }),
      };
    }
    if (url.endsWith('/v1/refunds')) {
      if (behavior === 'transport_failure') throw new Error('socket closed');
      const form = new URLSearchParams(init.body);
      const amount = Number(form.get('amount'));
      if (behavior === 'callback_race_mismatch') {
        const webhookBody = JSON.stringify({
          id: 'evt_refund_callback_wins_race',
          type: 'refund.updated',
          data: {
            object: {
              id: 're_callback_winner',
              object: 'refund',
              status: 'succeeded',
              amount,
              payment_intent: 'pi_refund_1',
              charge: 'ch_refund_1',
              metadata: {
                tenant_id: base.tenantA.id,
                order_id: form.get('metadata[order_id]'),
                refund_id: form.get('metadata[refund_id]'),
              },
            },
          },
        });
        const callback = await app.request('/webhooks/stripe_terminal', {
          method: 'POST',
          headers: {
            ...headers(base.tenantA),
            'stripe-signature': stripeSignatureHeader(WEBHOOK_SECRET, NOW, webhookBody),
          },
          body: webhookBody,
        });
        if (callback.status !== 200) throw new Error('race callback did not complete');
        return {
          status: 200,
          json: async () => ({
            id: 're_http_loser',
            status: 'succeeded',
            amount,
            payment_intent: 'pi_refund_1',
            charge: 'ch_refund_1',
          }),
        };
      }
      if (behavior === 'declined') {
        return {
          status: 200,
          json: async () => ({
            id: 're_refund_declined',
            status: 'failed',
            amount,
            payment_intent: 'pi_refund_1',
            charge: 'ch_refund_1',
            failure_reason: 'declined',
          }),
        };
      }
      if (behavior === 'mismatch') {
        return {
          status: 200,
          json: async () => ({
            id: 're_refund_mismatch',
            status: 'succeeded',
            amount: amount + 1,
            payment_intent: 'pi_wrong',
            charge: 'ch_wrong',
          }),
        };
      }
      if (behavior === 'pending') {
        return {
          status: 200,
          json: async () => ({
            id: 're_refund_pending',
            status: 'pending',
            amount,
            payment_intent: 'pi_refund_1',
            charge: 'ch_refund_1',
          }),
        };
      }
      return {
        status: 200,
        json: async () => ({
          id: 're_refund_1',
          status: 'succeeded',
          amount,
          payment_intent: 'pi_refund_1',
          charge: 'ch_refund_1',
        }),
      };
    }
    throw new Error(`unexpected Stripe URL: ${url}`);
  };
  const provider = stripeTerminalCheckoutProvider({
    secretKey: STRIPE_SECRET,
    webhookSecret: WEBHOOK_SECRET,
    transport,
    nowSeconds: () => NOW,
  });
  const events = new EventBus();
  app = ordersRouter(
    { db: base.db, events, contracts: {} },
    { providers: [provider] },
  );
  const order = await json(
    await app.request('/orders', {
      method: 'POST',
      headers: headers(base.tenantA),
      body: JSON.stringify({
        channel: 'pos',
        cashSessionId: 'drawer-refund',
        lines: [
          {
            variationId: 'var-refund',
            locationId: 'loc-refund',
            description: 'Refundable item',
            qty: 2,
            unitPriceCents: 1_000,
          },
        ],
      }),
    }),
  );
  await app.request(`/orders/${order.data.id}/payment-attempts`, {
    method: 'POST',
    headers: headers(base.tenantA),
    body: JSON.stringify({
      provider: 'stripe_terminal',
      idempotencyKey: 'pay-refund-order',
      readerId: 'tmr_refund_reader',
    }),
  });
  const webhookBody = JSON.stringify({
    id: 'evt_refund_paid',
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: 'pi_refund_1',
        status: 'succeeded',
        amount: 2_000,
        amount_received: 2_000,
        latest_charge: 'ch_refund_1',
      },
    },
  });
  const webhook = await app.request('/webhooks/stripe_terminal', {
    method: 'POST',
    headers: {
      ...headers(base.tenantA),
      'stripe-signature': stripeSignatureHeader(WEBHOOK_SECRET, NOW, webhookBody),
    },
    body: webhookBody,
  });
  expect((await json(webhook)).data.outcome).toBe('paid');
  const tenders = await json(
    await app.request(`/orders/${order.data.id}/tenders`, { headers: headers(base.tenantA) }),
  );
  return {
    ...base,
    app,
    events,
    orderId: order.data.id as string,
    lineId: order.data.lines[0].id as string,
    tenderId: tenders.data[0].id as string,
    calls,
  };
}

function refundRequest(
  harness: { app: any; tenantA: any; orderId: string; lineId: string; tenderId: string },
  overrides: Record<string, unknown> = {},
) {
  return harness.app.request(`/orders/${harness.orderId}/refunds`, {
    method: 'POST',
    headers: headers(harness.tenantA),
    body: JSON.stringify({
      tenderId: harness.tenderId,
      idempotencyKey: 'provider-refund-1',
      amountCents: 1_000,
      reason: 'return',
      lines: [{ lineId: harness.lineId, qty: 1, disposition: 'restock' }],
      ...overrides,
    }),
  });
}

async function refundState(
  harness: { app: any; tenantA: any; orderId: string },
) {
  const order = await json(
    await harness.app.request(`/orders/${harness.orderId}`, { headers: headers(harness.tenantA) }),
  );
  const tenders = await json(
    await harness.app.request(`/orders/${harness.orderId}/tenders`, {
      headers: headers(harness.tenantA),
    }),
  );
  const refunds = await json(
    await harness.app.request(`/orders/${harness.orderId}/refunds`, {
      headers: headers(harness.tenantA),
    }),
  );
  return { order: order.data, tenders: tenders.data, refunds: refunds.data };
}

describe('provider-backed refunds', () => {
  it('uses the succeeded PaymentIntent, commits a reconciled Stripe refund, and replays once', async () => {
    const harness = await stripeRefundHarness();
    const first = await refundRequest(harness);
    expect(first.status).toBe(201);
    const body = await json(first);
    expect(body.data.refund).toMatchObject({
      provider: 'stripe_terminal',
      provider_ref: 're_refund_1',
      provider_status: 'succeeded',
      amount_cents: 1_000,
      status: 'completed',
    });
    expect(body.data.order.status).toBe('partially_returned');

    const refundCalls = harness.calls.filter((call) => call.url.endsWith('/v1/refunds'));
    expect(refundCalls).toHaveLength(1);
    const call = refundCalls[0];
    expect(call.init.headers.Authorization).toBe(`Bearer ${STRIPE_SECRET}`);
    expect(call.init.headers['Idempotency-Key']).toBe(
      `${harness.tenantA.id}:provider-refund-1`,
    );
    expect(Object.fromEntries(new URLSearchParams(call.init.body).entries())).toMatchObject({
      payment_intent: 'pi_refund_1',
      amount: '1000',
      'metadata[tenant_id]': harness.tenantA.id,
      'metadata[order_id]': harness.orderId,
      'metadata[refund_id]': body.data.refund.id,
    });
    expect(new URLSearchParams(call.init.body).has('charge')).toBe(false);

    const replay = await refundRequest(harness);
    expect(replay.status).toBe(200);
    expect((await json(replay)).data.refund.id).toBe(body.data.refund.id);
    expect(harness.calls.filter((entry) => entry.url.endsWith('/v1/refunds'))).toHaveLength(1);

    const conflict = await refundRequest(harness, { amountCents: 999 });
    expect(conflict.status).toBe(409);
    expect(harness.calls.filter((entry) => entry.url.endsWith('/v1/refunds'))).toHaveLength(1);
    const state = await refundState(harness);
    expect(state.refunds).toHaveLength(1);
    expect(state.tenders[0]).toMatchObject({
      status: 'partially_refunded',
      refunded_cents: 1_000,
    });
  });

  it('holds a pending processor refund inert until a signed webhook completes it', async () => {
    const harness = await stripeRefundHarness('pending');
    const response = await refundRequest(harness);
    expect(response.status).toBe(202);
    const pending = await json(response);
    expect(pending.data.refund).toMatchObject({
      provider_ref: 're_refund_pending',
      provider_status: 'pending',
      status: 'pending',
    });
    const beforeHook = await refundState(harness);
    expect(beforeHook.order.status).toBe('paid');
    expect(beforeHook.tenders[0]).toMatchObject({ status: 'captured', refunded_cents: 0 });

    const webhookBody = JSON.stringify({
      id: 'evt_refund_completed',
      type: 'refund.updated',
      data: {
        object: {
          id: 're_refund_pending',
          object: 'refund',
          status: 'succeeded',
          amount: 1_000,
          payment_intent: 'pi_refund_1',
          charge: 'ch_refund_1',
          metadata: {
            tenant_id: harness.tenantA.id,
            order_id: harness.orderId,
            refund_id: pending.data.refund.id,
          },
        },
      },
    });
    const headersWithSignature = {
      ...headers(harness.tenantA),
      'stripe-signature': stripeSignatureHeader(WEBHOOK_SECRET, NOW, webhookBody),
    };
    const webhook = await harness.app.request('/webhooks/stripe_terminal', {
      method: 'POST',
      headers: headersWithSignature,
      body: webhookBody,
    });
    expect(webhook.status).toBe(200);
    expect(await json(webhook)).toMatchObject({
      data: { outcome: 'refund_completed', orderId: harness.orderId },
    });

    const completed = await refundState(harness);
    expect(completed.order.status).toBe('partially_returned');
    expect(completed.tenders[0]).toMatchObject({
      status: 'partially_refunded',
      refunded_cents: 1_000,
    });
    expect(completed.refunds[0]).toMatchObject({
      id: pending.data.refund.id,
      provider_status: 'succeeded',
      status: 'completed',
      active_tender_key: null,
    });

    const duplicate = await harness.app.request('/webhooks/stripe_terminal', {
      method: 'POST',
      headers: headersWithSignature,
      body: webhookBody,
    });
    expect((await json(duplicate)).data.outcome).toBe('refund_completed');
    expect((await refundState(harness)).tenders[0].refunded_cents).toBe(1_000);
  });

  it('rejects an HTTP refund reference that disagrees with a callback that won the race', async () => {
    const harness = await stripeRefundHarness('callback_race_mismatch');
    const response = await refundRequest(harness);
    expect(response.status).toBe(502);
    expect(await json(response)).toMatchObject({
      error: { code: 'provider_refund_failed' },
    });
    const state = await refundState(harness);
    expect(state.refunds).toHaveLength(1);
    expect(state.refunds[0]).toMatchObject({
      provider_ref: 're_callback_winner',
      provider_status: 'succeeded',
      status: 'completed',
    });
    expect(state.tenders[0]).toMatchObject({
      status: 'partially_refunded',
      refunded_cents: 1_000,
    });
  });

  it('completes a callback-persisted success despite a stale pending HTTP result', async () => {
    const harness = await stripeRefundHarness('pending');
    const first = await refundRequest(harness);
    expect(first.status).toBe(202);
    const pending = await json(first);

    // Exact intermediate state when a callback has persisted success but has
    // not yet committed tender, return, and inventory effects.
    await harness.db
      .updateTable('orders_refunds')
      .set({ provider_status: 'succeeded' })
      .where('tenant_id', '=', harness.tenantA.id)
      .where('id', '=', pending.data.refund.id)
      .execute();

    const staleReplay = await refundRequest(harness);
    expect(staleReplay.status).toBe(200);
    const state = await refundState(harness);
    expect(state.refunds[0]).toMatchObject({
      provider_ref: 're_refund_pending',
      provider_status: 'succeeded',
      status: 'completed',
      active_tender_key: null,
    });
    expect(state.order.status).toBe('partially_returned');
    expect(state.tenders[0]).toMatchObject({
      status: 'partially_refunded',
      refunded_cents: 1_000,
    });
  });

  it.each([
    ['processor decline', 'declined' as const],
    ['response mismatch', 'mismatch' as const],
    ['transport failure', 'transport_failure' as const],
  ])('keeps sale state unchanged and retains a durable attempt on %s', async (_label, behavior) => {
    const harness = await stripeRefundHarness(behavior);
    const before = await refundState(harness);
    const response = await refundRequest(harness);
    expect(response.status).toBe(502);
    expect(await json(response)).toMatchObject({
      error: { code: 'provider_refund_failed' },
    });
    const after = await refundState(harness);
    expect(after.order).toEqual(before.order);
    expect(after.tenders).toEqual(before.tenders);
    expect(after.refunds).toHaveLength(1);
    expect(after.refunds[0]).toMatchObject({
      provider: 'stripe_terminal',
      provider_status: behavior === 'declined' ? 'failed' : 'pending',
      status: behavior === 'declined' ? 'failed' : 'pending',
    });
  });

  it('returns 501 when the configured tender provider has no refund capability', async () => {
    const harness = await setup();
    const order = await json(
      await harness.app.request('/orders', {
        method: 'POST',
        headers: headers(harness.tenantA),
        body: JSON.stringify({
          channel: 'storefront',
          lines: [{ variationId: 'v-no-refund', description: 'Item', qty: 1, unitPriceCents: 500 }],
        }),
      }),
    );
    const session = await json(
      await harness.app.request(`/orders/${order.data.id}/checkout-sessions`, {
        method: 'POST',
        headers: headers(harness.tenantA),
        body: JSON.stringify({ provider: 'simulator' }),
      }),
    );
    const raw = simulatorCompletionBody({
      eventId: 'evt_no_refund_support',
      providerSessionRef: session.data.session.provider_session_ref,
      amountCents: 500,
      tenderRef: 'sim_tender_no_refund',
    });
    await harness.app.request('/webhooks/simulator', {
      method: 'POST',
      headers: {
        ...headers(harness.tenantA),
        'x-mags-signature': simulatorSign(SIM_SECRET, raw),
      },
      body: raw,
    });
    const tenders = await json(
      await harness.app.request(`/orders/${order.data.id}/tenders`, {
        headers: headers(harness.tenantA),
      }),
    );
    const response = await harness.app.request(`/orders/${order.data.id}/refunds`, {
      method: 'POST',
      headers: headers(harness.tenantA),
      body: JSON.stringify({
        tenderId: tenders.data[0].id,
        idempotencyKey: 'unsupported-refund',
        amountCents: 500,
        lines: [{ lineId: order.data.lines[0].id, qty: 1, disposition: 'restock' }],
      }),
    });
    expect(response.status).toBe(501);
    expect(await json(response)).toMatchObject({
      error: { code: 'provider_refund_not_supported' },
    });
    const refunds = await json(
      await harness.app.request(`/orders/${order.data.id}/refunds`, {
        headers: headers(harness.tenantA),
      }),
    );
    expect(refunds.data).toEqual([]);
  });
});
