import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '@blacklabel/core';
import { ordersRouter } from '../src/router';
import {
  simulatorCheckoutProvider,
  simulatorCompletionBody,
  simulatorSign,
  type CheckoutProvider,
} from '../src/providers';
import { PAYMENT_ATTEMPT_TRANSITIONS } from '../src/service';
import { headers, SIM_SECRET, setup } from './helpers';

async function json(res: Response) {
  return (await res.json()) as any;
}

async function createOrder(app: any, tenant: any, amountCents = 1_000, tipCents = 0) {
  return json(
    await app.request('/orders', {
      method: 'POST',
      headers: headers(tenant),
      body: JSON.stringify({
        channel: 'pos',
        registerId: 'register-1',
        cashierId: 'cashier-1',
        cashSessionId: 'cash-session-1',
        tipCents,
        lines: [{ description: 'Item', qty: 1, unitPriceCents: amountCents }],
      }),
    }),
  );
}

async function createAttempt(app: any, tenant: any, orderId: string, idempotencyKey = 'attempt-1') {
  return app.request(`/orders/${orderId}/payment-attempts`, {
    method: 'POST',
    headers: headers(tenant),
    body: JSON.stringify({ provider: 'simulator', idempotencyKey }),
  });
}

function postSimulatorWebhook(app: any, tenant: any, raw: string) {
  return app.request('/webhooks/simulator', {
    method: 'POST',
    headers: {
      ...headers(tenant),
      'x-mags-signature': simulatorSign(SIM_SECRET, raw),
    },
    body: raw,
  });
}

describe('payment attempt ledger', () => {
  it('is idempotent, tenant-isolated, and records no tender while processing', async () => {
    const base = await setup();
    let creates = 0;
    const simulatorBase = simulatorCheckoutProvider({ secret: SIM_SECRET });
    const countingProvider: CheckoutProvider = {
      ...simulatorBase,
      async createSession(order) {
        creates += 1;
        return simulatorBase.createSession(order);
      },
    };
    const app = ordersRouter(
      { db: base.db, events: new EventBus(), contracts: {} },
      { providers: [countingProvider] },
    );
    const order = await createOrder(app, base.tenantA, 1_000, 250);

    const firstRes = await createAttempt(app, base.tenantA, order.data.id, 'stable-key');
    expect(firstRes.status).toBe(201);
    const first = await json(firstRes);
    expect(first.data).toMatchObject({ created: true, flow: 'redirect' });
    expect(first.data.attempt).toMatchObject({
      order_id: order.data.id,
      status: 'processing',
      amount_cents: 1_250,
      idempotency_key: 'stable-key',
    });
    expect(first.data.session.amount_cents).toBe(1_250);
    expect(creates).toBe(1);

    const tenders = await json(
      await app.request(`/orders/${order.data.id}/tenders`, { headers: headers(base.tenantA) }),
    );
    expect(tenders.data).toEqual([]);

    const replayRes = await createAttempt(app, base.tenantA, order.data.id, 'stable-key');
    expect(replayRes.status).toBe(200);
    const replay = await json(replayRes);
    expect(replay.data.created).toBe(false);
    expect(replay.data.attempt.id).toBe(first.data.attempt.id);
    expect(creates).toBe(1);

    const listA = await json(
      await app.request(`/orders/${order.data.id}/payment-attempts`, {
        headers: headers(base.tenantA),
      }),
    );
    expect(listA.data).toHaveLength(1);
    expect(
      (
        await app.request(`/payment-attempts/${first.data.attempt.id}`, {
          headers: headers(base.tenantB),
        })
      ).status,
    ).toBe(404);
    const listB = await json(
      await app.request(`/orders/${order.data.id}/payment-attempts`, {
        headers: headers(base.tenantB),
      }),
    );
    expect(listB.data).toEqual([]);
    expect(
      (
        await app.request(`/payment-attempts/${first.data.attempt.id}/cancel`, {
          method: 'POST',
          headers: headers(base.tenantB),
        })
      ).status,
    ).toBe(404);

    // A different tenant may independently use the same idempotency key.
    const orderB = await createOrder(app, base.tenantB);
    expect((await createAttempt(app, base.tenantB, orderB.data.id, 'stable-key')).status).toBe(201);
  });

  it('binds an idempotency key to one request and blocks order mutation while active', async () => {
    const { app, tenantA } = await setup();
    const firstOrder = await createOrder(app, tenantA);
    const secondOrder = await createOrder(app, tenantA);
    expect((await createAttempt(app, tenantA, firstOrder.data.id, 'bound')).status).toBe(201);
    expect((await createAttempt(app, tenantA, firstOrder.data.id, 'another')).status).toBe(409);
    expect((await createAttempt(app, tenantA, secondOrder.data.id, 'bound')).status).toBe(409);
    expect(
      (
        await app.request(`/orders/${firstOrder.data.id}`, {
          method: 'PUT',
          headers: headers(tenantA),
          body: JSON.stringify({ tipCents: 50 }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await app.request(`/orders/${firstOrder.data.id}/cancel`, {
          method: 'POST',
          headers: headers(tenantA),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await app.request(`/orders/${firstOrder.data.id}`, {
          method: 'DELETE',
          headers: headers(tenantA),
        })
      ).status,
    ).toBe(409);
  });

  it('serializes concurrent repricing, cancellation, and deletion against the provider claim', async () => {
    const base = await setup();
    const snapshots = new Map<string, number>();
    const simulatorBase = simulatorCheckoutProvider({ secret: SIM_SECRET });
    const observingProvider: CheckoutProvider = {
      ...simulatorBase,
      async createSession(snapshot) {
        snapshots.set(snapshot.orderId, snapshot.amountCents);
        return simulatorBase.createSession(snapshot);
      },
    };
    const app = ordersRouter(
      { db: base.db, events: new EventBus(), contracts: {} },
      { providers: [observingProvider] },
    );

    const repriced = await createOrder(app, base.tenantA);
    const [repricingAttempt, repricing] = await Promise.all([
      createAttempt(app, base.tenantA, repriced.data.id, 'race-reprice'),
      app.request(`/orders/${repriced.data.id}`, {
        method: 'PUT',
        headers: headers(base.tenantA),
        body: JSON.stringify({
          lines: [{ description: 'Repriced item', qty: 1, unitPriceCents: 2_000 }],
        }),
      }),
    ]);
    expect([200, 409]).toContain(repricing.status);
    expect(repricingAttempt.status).toBe(201);
    const repricingAttemptBody = await json(repricingAttempt);
    const repricedAfter = await json(
      await app.request(`/orders/${repriced.data.id}`, { headers: headers(base.tenantA) }),
    );
    expect(repricingAttemptBody.data.attempt.amount_cents).toBe(repricedAfter.data.total_cents);
    expect(snapshots.get(repriced.data.id)).toBe(repricedAfter.data.total_cents);

    const canceled = await createOrder(app, base.tenantA);
    const [cancelAttempt, cancellation] = await Promise.all([
      createAttempt(app, base.tenantA, canceled.data.id, 'race-cancel'),
      app.request(`/orders/${canceled.data.id}/cancel`, {
        method: 'POST',
        headers: headers(base.tenantA),
      }),
    ]);
    const canceledAfter = await app.request(`/orders/${canceled.data.id}`, {
      headers: headers(base.tenantA),
    });
    if (cancelAttempt.status === 201) {
      expect(cancellation.status).toBe(409);
      expect(canceledAfter.status).toBe(200);
      expect((await json(canceledAfter)).data.status).not.toBe('canceled');
      expect(snapshots.has(canceled.data.id)).toBe(true);
    } else {
      expect(cancellation.status).toBe(200);
      expect((await json(canceledAfter)).data.status).toBe('canceled');
      expect(snapshots.has(canceled.data.id)).toBe(false);
    }

    const deleted = await createOrder(app, base.tenantA);
    const [deleteAttempt, deletion] = await Promise.all([
      createAttempt(app, base.tenantA, deleted.data.id, 'race-delete'),
      app.request(`/orders/${deleted.data.id}`, {
        method: 'DELETE',
        headers: headers(base.tenantA),
      }),
    ]);
    const deletedAfter = await app.request(`/orders/${deleted.data.id}`, {
      headers: headers(base.tenantA),
    });
    if (deleteAttempt.status === 201) {
      expect(deletion.status).toBe(409);
      expect(deletedAfter.status).toBe(200);
      expect(snapshots.has(deleted.data.id)).toBe(true);
    } else {
      expect(deletion.status).toBe(200);
      expect(deletedAfter.status).toBe(404);
      expect(snapshots.has(deleted.data.id)).toBe(false);
    }
  });

  it('blocks new manual tenders during an active attempt and after payment', async () => {
    const { app, tenantA } = await setup();
    const order = await createOrder(app, tenantA);
    const initialTenderRequest = {
      kind: 'cash',
      amountCents: 400,
      cashReceivedCents: 400,
      idempotencyKey: 'cash-before-attempt',
    };
    expect(
      (
        await app.request(`/orders/${order.data.id}/tenders`, {
          method: 'POST',
          headers: headers(tenantA),
          body: JSON.stringify(initialTenderRequest),
        })
      ).status,
    ).toBe(201);

    const created = await json(
      await createAttempt(app, tenantA, order.data.id, 'remaining-provider-balance'),
    );
    expect(created.data.attempt.amount_cents).toBe(600);
    const activeTender = await app.request(`/orders/${order.data.id}/tenders`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({
        kind: 'cash',
        amountCents: 100,
        cashReceivedCents: 100,
        idempotencyKey: 'cash-during-attempt',
      }),
    });
    expect(activeTender.status).toBe(409);

    // Exact retries are reads, not new money, and remain idempotent while the
    // order is active and after it reaches paid.
    const activeReplay = await app.request(`/orders/${order.data.id}/tenders`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify(initialTenderRequest),
    });
    expect(activeReplay.status).toBe(200);

    const raw = simulatorCompletionBody({
      eventId: 'evt-manual-provider-arbitration',
      providerSessionRef: created.data.session.provider_session_ref,
      amountCents: 600,
      tenderRef: 'txn-manual-provider-arbitration',
    });
    expect((await json(await postSimulatorWebhook(app, tenantA, raw))).data.outcome).toBe('paid');

    const paidTender = await app.request(`/orders/${order.data.id}/tenders`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({
        kind: 'external',
        amountCents: 1,
        idempotencyKey: 'external-after-paid',
      }),
    });
    expect(paidTender.status).toBe(409);
    const paidReplay = await app.request(`/orders/${order.data.id}/tenders`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify(initialTenderRequest),
    });
    expect(paidReplay.status).toBe(200);
    const tenders = await json(
      await app.request(`/orders/${order.data.id}/tenders`, { headers: headers(tenantA) }),
    );
    expect(tenders.data).toHaveLength(2);
  });

  it('cancels remotely first, stays idempotent, and ignores a late success webhook', async () => {
    const { app, tenantA } = await setup();
    const order = await createOrder(app, tenantA);
    const created = await json(await createAttempt(app, tenantA, order.data.id));
    const attemptId = created.data.attempt.id;
    const sessionRef = created.data.session.provider_session_ref;

    const canceledRes = await app.request(`/payment-attempts/${attemptId}/cancel`, {
      method: 'POST',
      headers: headers(tenantA),
    });
    expect(canceledRes.status).toBe(200);
    expect((await json(canceledRes)).data.status).toBe('canceled');
    const canceledAgain = await app.request(`/payment-attempts/${attemptId}/cancel`, {
      method: 'POST',
      headers: headers(tenantA),
    });
    expect((await json(canceledAgain)).data.status).toBe('canceled');

    const raw = simulatorCompletionBody({
      eventId: 'evt-after-cancel',
      providerSessionRef: sessionRef,
      amountCents: 1_000,
      tenderRef: 'txn-after-cancel',
    });
    const hook = await postSimulatorWebhook(app, tenantA, raw);
    expect((await json(hook)).data.outcome).toBe('attempt_canceled');
    const orderAfter = await json(
      await app.request(`/orders/${order.data.id}`, { headers: headers(tenantA) }),
    );
    expect(orderAfter.data.status).toBe('draft');
    const tenders = await json(
      await app.request(`/orders/${order.data.id}/tenders`, { headers: headers(tenantA) }),
    );
    expect(tenders.data).toEqual([]);
  });

  it('moves processing -> succeeded once and replays the create key after payment', async () => {
    const { app, tenantA } = await setup();
    const order = await createOrder(app, tenantA, 900, 100);
    const created = await json(await createAttempt(app, tenantA, order.data.id, 'paid-key'));
    const raw = simulatorCompletionBody({
      eventId: 'evt-paid-attempt',
      providerSessionRef: created.data.session.provider_session_ref,
      amountCents: 1_000,
      tenderRef: 'txn-paid-attempt',
    });
    expect((await json(await postSimulatorWebhook(app, tenantA, raw))).data.outcome).toBe('paid');

    const attempt = await json(
      await app.request(`/payment-attempts/${created.data.attempt.id}`, { headers: headers(tenantA) }),
    );
    expect(attempt.data.status).toBe('succeeded');
    expect(attempt.data.succeeded_at).toBeTruthy();
    const tenders = await json(
      await app.request(`/orders/${order.data.id}/tenders`, { headers: headers(tenantA) }),
    );
    expect(tenders.data).toHaveLength(1);
    expect(tenders.data[0]).toMatchObject({ status: 'captured', amount_cents: 1_000 });

    const replay = await createAttempt(app, tenantA, order.data.id, 'paid-key');
    expect(replay.status).toBe(200);
    expect((await json(replay)).data.attempt.status).toBe('succeeded');
    expect(
      (
        await app.request(`/payment-attempts/${created.data.attempt.id}/cancel`, {
          method: 'POST',
          headers: headers(tenantA),
        })
      ).status,
    ).toBe(409);
  });

  it('marks an amount mismatch failed and never retains a captured tender', async () => {
    const { app, tenantA } = await setup();
    const order = await createOrder(app, tenantA, 1_000);
    const created = await json(await createAttempt(app, tenantA, order.data.id));
    const raw = simulatorCompletionBody({
      eventId: 'evt-attempt-mismatch',
      providerSessionRef: created.data.session.provider_session_ref,
      amountCents: 999,
      tenderRef: 'txn-attempt-mismatch',
    });
    expect((await json(await postSimulatorWebhook(app, tenantA, raw))).data.outcome).toBe(
      'amount_mismatch',
    );
    const attempt = await json(
      await app.request(`/payment-attempts/${created.data.attempt.id}`, { headers: headers(tenantA) }),
    );
    expect(attempt.data).toMatchObject({ status: 'failed', failure_code: 'amount_mismatch' });
    const tenders = await json(
      await app.request(`/orders/${order.data.id}/tenders`, { headers: headers(tenantA) }),
    );
    expect(tenders.data).toEqual([]);
  });

  it('retains a failed ledger row when provider session creation throws', async () => {
    const base = await setup();
    const failingProvider: CheckoutProvider = {
      ...simulatorCheckoutProvider({ secret: SIM_SECRET }),
      async createSession() {
        throw new Error('reader offline');
      },
    };
    const app = ordersRouter(
      { db: base.db, events: new EventBus(), contracts: {} },
      { providers: [failingProvider] },
    );
    const order = await createOrder(app, base.tenantA);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await createAttempt(app, base.tenantA, order.data.id, 'failed-key')).status).toBe(500);
      const attempts = await json(
        await app.request(`/orders/${order.data.id}/payment-attempts`, {
          headers: headers(base.tenantA),
        }),
      );
      expect(attempts.data).toHaveLength(1);
      expect(attempts.data[0]).toMatchObject({
        status: 'failed',
        failure_code: 'provider_request_failed',
        failure_message: 'reader offline',
      });
      const replay = await createAttempt(app, base.tenantA, order.data.id, 'failed-key');
      expect(replay.status).toBe(200);
      expect((await json(replay)).data.attempt.status).toBe('failed');
    } finally {
      errorLog.mockRestore();
    }
  });

  it('publishes the closed transition matrix', () => {
    expect(PAYMENT_ATTEMPT_TRANSITIONS).toEqual({
      pending: ['processing', 'failed', 'canceled'],
      processing: ['succeeded', 'failed', 'canceled'],
      succeeded: [],
      failed: [],
      canceled: [],
    });
  });
});
