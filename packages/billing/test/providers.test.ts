import { describe, expect, it } from 'vitest';
import { billingCreateInvoiceContract } from '../src/service';
import { manualPaymentProvider, stubPaymentProvider } from '../src/providers';
import { api, json, makeInvoice, makeSentInvoice, setupBilling } from './helpers';

const setupWithStub = () => setupBilling({ providers: [manualPaymentProvider, stubPaymentProvider] });

describe('payment providers', () => {
  it('manual (offline) adapter issues collect-offline instructions for the remaining balance', async () => {
    const ctx = await setupBilling();
    const sent = await makeSentInvoice(ctx, ctx.tenantA.id);
    await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${sent.id}/payments`, {
      amountCents: 3_000,
    });

    const res = await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${sent.id}/payment-intents`, {});
    expect(res.status).toBe(201);
    const intent = (await json(res)).data;
    expect(intent.provider).toBe('manual');
    expect(intent.status).toBe('requires_action');
    expect(intent.amountCents).toBe(7_000); // 10000 total - 3000 already paid
    expect(intent.instructions).toContain('record it');
  });

  it('stub adapter is Stripe-shaped: pi_* intent id + client secret', async () => {
    const ctx = await setupWithStub();
    const sent = await makeSentInvoice(ctx, ctx.tenantA.id);
    const res = await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${sent.id}/payment-intents`, {
      provider: 'stub',
    });
    expect(res.status).toBe(201);
    const intent = (await json(res)).data;
    expect(intent.provider).toBe('stub');
    expect(intent.intentId).toMatch(/^pi_/);
    expect(intent.clientSecret).toContain('_secret_');
    expect(intent.status).toBe('requires_confirmation');
    expect(intent.amountCents).toBe(10_000);
  });

  it('rejects intents for unknown providers (501) and non-collectible invoices (409)', async () => {
    const ctx = await setupBilling();
    const sent = await makeSentInvoice(ctx, ctx.tenantA.id);
    const unknown = await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${sent.id}/payment-intents`, {
      provider: 'stripe',
    });
    expect(unknown.status).toBe(501);

    const draft = await makeInvoice(ctx, ctx.tenantA.id);
    const onDraft = await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${draft.id}/payment-intents`, {});
    expect(onDraft.status).toBe(409);
  });

  it('stub webhook (payment_intent.succeeded) records the payment and pays the invoice', async () => {
    const ctx = await setupWithStub();
    const paidEvents: any[] = [];
    ctx.events.on('billing.invoice.paid', (e) => {
      paidEvents.push(e);
    });
    const sent = await makeSentInvoice(ctx, ctx.tenantA.id, { customerId: 'hook-cust' });

    const res = await api(ctx.app, ctx.tenantA.id, 'POST', '/payments/webhooks/stub', {
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_hook_1',
          amount_received: 10_000,
          metadata: { invoiceId: sent.id },
        },
      },
    });
    expect(res.status).toBe(201);
    const body = (await json(res)).data;
    expect(body.outcome.kind).toBe('payment_succeeded');
    expect(body.event.processed).toBe(true);
    expect(body.event.provider).toBe('stub');
    expect(body.event.event_type).toBe('payment_intent.succeeded');

    const invoice = await json(await api(ctx.app, ctx.tenantA.id, 'GET', `/invoices/${sent.id}`));
    expect(invoice.data.status).toBe('paid');
    expect(invoice.data.paid_cents).toBe(10_000);
    expect(paidEvents).toHaveLength(1);
    expect(paidEvents[0].payload.invoiceId).toBe(sent.id);

    // The recorded payment carries provider provenance.
    const payments = await json(
      await api(ctx.app, ctx.tenantA.id, 'GET', `/invoices/${sent.id}/payments`),
    );
    expect(payments.data).toHaveLength(1);
    expect(payments.data[0]).toMatchObject({
      provider: 'stub',
      provider_ref: 'pi_hook_1',
      method: 'provider:stub',
    });

    // Raw event persisted in billing_webhook_events.
    const stored = await ctx.db
      .selectFrom('billing_webhook_events')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantA.id)
      .execute();
    expect(stored).toHaveLength(1);
    expect(stored[0].processed).toBe(1);
    expect(JSON.parse(stored[0].payload).type).toBe('payment_intent.succeeded');
  });

  it('a redelivered webhook (same provider ref) does not double-count the payment', async () => {
    const ctx = await setupWithStub();
    const sent = await makeSentInvoice(ctx, ctx.tenantA.id);
    const delivery = {
      type: 'payment_intent.succeeded',
      data: {
        object: { id: 'pi_retry_1', amount_received: 4_000, metadata: { invoiceId: sent.id } },
      },
    };

    const first = await api(ctx.app, ctx.tenantA.id, 'POST', '/payments/webhooks/stub', delivery);
    expect(first.status).toBe(201);
    expect((await json(first)).data.outcome.kind).toBe('payment_succeeded');

    // Provider retries the exact same event — must be ignored, not re-recorded.
    const second = await api(ctx.app, ctx.tenantA.id, 'POST', '/payments/webhooks/stub', delivery);
    expect(second.status).toBe(201);
    const redelivered = (await json(second)).data;
    expect(redelivered.outcome.kind).toBe('ignored');
    expect(redelivered.outcome.reason).toContain('duplicate delivery');
    expect(redelivered.event.processed).toBe(false);

    const invoice = await json(await api(ctx.app, ctx.tenantA.id, 'GET', `/invoices/${sent.id}`));
    expect(invoice.data.paid_cents).toBe(4_000); // counted once
    expect(invoice.data.status).toBe('partial');
    const payments = await json(
      await api(ctx.app, ctx.tenantA.id, 'GET', `/invoices/${sent.id}/payments`),
    );
    expect(payments.data).toHaveLength(1);

    // Both raw deliveries are persisted; only the first is processed.
    const stored = await ctx.db
      .selectFrom('billing_webhook_events')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantA.id)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    expect(stored).toHaveLength(2);
    expect(stored.map((r) => r.processed).sort()).toEqual([0, 1]);
  });

  it('ignores unhandled webhook types and manual-provider webhooks (still persisted)', async () => {
    const ctx = await setupWithStub();
    const other = await api(ctx.app, ctx.tenantA.id, 'POST', '/payments/webhooks/stub', {
      type: 'customer.updated',
    });
    expect(other.status).toBe(201);
    expect((await json(other)).data.outcome.kind).toBe('ignored');

    const manual = await api(ctx.app, ctx.tenantA.id, 'POST', '/payments/webhooks/manual', {
      type: 'payment_intent.succeeded',
    });
    expect((await json(manual)).data.outcome.kind).toBe('ignored');

    const unknown = await api(ctx.app, ctx.tenantA.id, 'POST', '/payments/webhooks/nope', {});
    expect(unknown.status).toBe(501);

    const stored = await ctx.db
      .selectFrom('billing_webhook_events')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantA.id)
      .execute();
    expect(stored).toHaveLength(2);
    expect(stored.every((r) => r.processed === 0)).toBe(true);
  });

  it("a webhook in tenant B's scope cannot pay tenant A's invoice", async () => {
    const ctx = await setupWithStub();
    const sent = await makeSentInvoice(ctx, ctx.tenantA.id);
    const res = await api(ctx.app, ctx.tenantB.id, 'POST', '/payments/webhooks/stub', {
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_x', amount_received: 10_000, metadata: { invoiceId: sent.id } } },
    });
    expect(res.status).toBe(404);
    const invoice = await json(await api(ctx.app, ctx.tenantA.id, 'GET', `/invoices/${sent.id}`));
    expect(invoice.data.status).toBe('sent');
    expect(invoice.data.paid_cents).toBe(0);
  });

  it('does not expose the unsigned stub provider from the default registry', async () => {
    const ctx = await setupBilling();
    const res = await api(ctx.app, ctx.tenantA.id, 'POST', '/payments/webhooks/stub', {
      type: 'payment_intent.succeeded',
    });
    expect(res.status).toBe(501);
  });

  it('serializes concurrent redeliveries so one provider reference is recorded once', async () => {
    const ctx = await setupWithStub();
    const sent = await makeSentInvoice(ctx, ctx.tenantA.id);
    const delivery = {
      type: 'payment_intent.succeeded',
      data: {
        object: { id: 'pi_concurrent_1', amount_received: 4_000, metadata: { invoiceId: sent.id } },
      },
    };

    const responses = await Promise.all([
      api(ctx.app, ctx.tenantA.id, 'POST', '/payments/webhooks/stub', delivery),
      api(ctx.app, ctx.tenantA.id, 'POST', '/payments/webhooks/stub', delivery),
    ]);
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    const outcomes = await Promise.all(responses.map(async (r) => (await json(r)).data.outcome.kind));
    expect(outcomes.sort()).toEqual(['ignored', 'payment_succeeded']);

    const payments = await json(
      await api(ctx.app, ctx.tenantA.id, 'GET', `/invoices/${sent.id}/payments`),
    );
    expect(payments.data).toHaveLength(1);
    expect(payments.data[0].provider_ref).toBe('pi_concurrent_1');
  });

  it('passes exact raw JSON and request headers to a production provider adapter', async () => {
    let observed: { rawBody: string; signature: string | undefined } | undefined;
    const ctx = await setupBilling({
      providers: [
        {
          key: 'signed',
          async createPaymentIntent() {
            throw new Error('not used');
          },
          async recordWebhookEvent(event) {
            observed = { rawBody: event.rawBody, signature: event.headers['x-provider-signature'] };
            return { kind: 'ignored' };
          },
        },
      ],
    });
    const rawBody = '{"type":"provider.event","data":{"value":1}}';
    const res = await ctx.app.request('/payments/webhooks/signed', {
      method: 'POST',
      headers: {
        'x-tenant-id': ctx.tenantA.id,
        'content-type': 'application/json',
        'x-provider-signature': 'sig_test',
      },
      body: rawBody,
    });
    expect(res.status).toBe(201);
    expect(observed).toEqual({ rawBody, signature: 'sig_test' });
  });

  it('does not apply a provider payment that lacks an idempotency reference', async () => {
    const ctx = await setupBilling({
      providers: [
        {
          key: 'missing-ref',
          async createPaymentIntent() {
            throw new Error('not used');
          },
          async recordWebhookEvent() {
            return { kind: 'payment_succeeded', invoiceId: 'unused', amountCents: 1_000 };
          },
        },
      ],
    });
    const res = await api(ctx.app, ctx.tenantA.id, 'POST', '/payments/webhooks/missing-ref', {
      type: 'payment.succeeded',
    });
    expect(res.status).toBe(201);
    expect((await json(res)).data.outcome).toEqual({
      kind: 'ignored',
      reason: 'payment event missing provider reference',
    });
    const payments = await json(await api(ctx.app, ctx.tenantA.id, 'GET', '/payments'));
    expect(payments.data).toEqual([]);
  });

  it('custom providers can be injected via BillingRouterOptions', async () => {
    const ctx = await setupBilling({
      providers: [
        manualPaymentProvider,
        stubPaymentProvider,
        {
          key: 'acme',
          async createPaymentIntent(input) {
            return {
              intentId: 'acme_intent_1',
              provider: 'acme',
              status: 'requires_confirmation',
              amountCents: input.amountCents,
            };
          },
          async recordWebhookEvent() {
            return { kind: 'ignored' };
          },
        },
      ],
    });
    const sent = await makeSentInvoice(ctx, ctx.tenantA.id);
    const res = await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${sent.id}/payment-intents`, {
      provider: 'acme',
    });
    expect(res.status).toBe(201);
    expect((await json(res)).data.intentId).toBe('acme_intent_1');
  });
});

describe('CreateInvoiceContract implementation', () => {
  it('creates an invoice from the cross-module contract input', async () => {
    const ctx = await setupBilling();
    const contract = billingCreateInvoiceContract(ctx.db, ctx.events);
    const { id } = await contract.createInvoice({
      tenantId: ctx.tenantA.id,
      customerId: 'contract-cust',
      lines: [
        { description: 'Contract line', quantity: 2, unitPriceCents: 2_000, discountBps: 1000 },
      ],
      taxBps: 500,
      memo: 'via contract',
      sourceEntityType: 'quoting.quote',
      sourceEntityId: 'q-1',
    });
    expect(id).toBeTruthy();

    const res = await json(await api(ctx.app, ctx.tenantA.id, 'GET', `/invoices/${id}`));
    expect(res.data.customer_id).toBe('contract-cust');
    expect(res.data.number).toBe('INV-1');
    expect(res.data.source_entity_id).toBe('q-1');
    // 2*2000=4000 -10% = 3600; tax 5% = 180; total 3780
    expect(res.data.total_cents).toBe(3_780);
    expect(res.data.lines).toHaveLength(1);
  });
});
