import { describe, expect, it } from 'vitest';
import { asCoreDb, coreMigrations, EventBus, listAuditEntries } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { posServiceMigrations, posServiceRouter, type PosServiceDatabase } from '@blacklabel/pos-service';
import { purchase, setupRouter } from './helpers';

const body = async (response: Response): Promise<any> => response.json();

const capabilityEvent = (id: string) => ({
  id,
  object: 'v2.core.event',
  type: 'v2.core.account[configuration.merchant].capability_status_updated',
  related_object: { id: 'acct_1TestMerchant', type: 'v2.core.account' },
});

describe('pos-service migrations', () => {
  it('apply on a fresh db after core migrations and are idempotent', async () => {
    const db = createTestDb<PosServiceDatabase>();
    const all = [...coreMigrations, ...posServiceMigrations];
    const first = await runMigrations(db, all);
    expect(first.applied).toContain('pos-service.0001_merchants_webhook_events');
    expect(await db.selectFrom('pos_service_merchants').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('pos_service_webhook_events').selectAll().execute()).toEqual([]);
    const second = await runMigrations(db, all);
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBe(all.length);
  });
});

describe('pos-service router: purchase to live', () => {
  it('runs the whole service through the API with audit entries and events', async () => {
    const ctx = await setupRouter();

    const created = await ctx.json(ctx.A, 'POST', '/merchants', purchase, { 'x-user-id': 'usr_owner' });
    expect(created.status).toBe(201);
    const merchant = await ctx.data(created);
    expect(merchant).toMatchObject({ stage: 'purchased', livemode: false, replayed: false });
    const merchantId: string = merchant.id;

    const replay = await ctx.json(ctx.A, 'POST', '/merchants', purchase);
    expect(replay.status).toBe(200);
    expect(await ctx.data(replay)).toMatchObject({ id: merchantId, replayed: true });

    const onboarding = await ctx.data(ctx.json(ctx.A, 'POST', `/merchants/${merchantId}/onboarding`, undefined, { 'x-user-id': 'usr_owner' }));
    expect(onboarding.stage).toBe('onboarding');
    expect(onboarding.onboardingLink.url).toMatch(/^https:\/\/accounts\.stripe\.com\//);

    let hook = await ctx.webhook(ctx.A, capabilityEvent('evt_thin_1'));
    expect(hook.status).toBe(200);
    expect(await ctx.data(hook)).toEqual({ handled: true, action: 'account_synced', merchantId });

    // An order placed in the Stripe Dashboard, recorded by an operator.
    const shipped = await ctx.json(ctx.A, 'POST', `/merchants/${merchantId}/hardware-orders`, {
      id: 'thor_1',
      object: 'terminal.hardware_order',
      status: 'shipped',
      shipment_tracking: [{ carrier: 'ups', tracking_number: '1ZTEST' }],
      metadata: { merchant_id: merchantId },
    });
    expect(shipped.status).toBe(200);
    expect((await ctx.data(shipped)).stage).toBe('reader_shipped');

    hook = await ctx.webhook(ctx.A, {
      id: 'evt_hw_2',
      type: 'terminal.hardware_order.delivered',
      data: { object: { id: 'thor_1', status: 'delivered', metadata: { merchant_id: merchantId } } },
    });
    expect((await ctx.data(hook)).action).toBe('hardware_order_recorded');

    const reader = await ctx.data(ctx.json(ctx.A, 'POST', `/merchants/${merchantId}/readers`, { registrationCode: 'sepia-cerulean-aqua', label: 'Front counter' }));
    expect(reader.stage).toBe('reader_registered');

    const sale = await ctx.data(ctx.json(ctx.A, 'POST', `/merchants/${merchantId}/test-sale`));
    expect(sale.testSale.status).toBe('waiting_for_card');
    const noop = await ctx.json(ctx.A, 'POST', `/merchants/${merchantId}/readers`, { registrationCode: 'second-reader', label: 'Patio' });
    expect(noop.status).toBe(409);
    expect((await body(noop)).error.code).toBe('reader_already_registered');

    hook = await ctx.webhook(ctx.A, {
      id: 'evt_pi_1',
      type: 'payment_intent.amount_capturable_updated',
      account: 'acct_1TestMerchant',
      data: { object: { id: 'pi_TestSale', metadata: { merchant_id: merchantId, purpose: 'go_live_test' } } },
    });
    expect((await ctx.data(hook)).action).toBe('test_sale_advanced');

    const detail = await ctx.data(ctx.json(ctx.A, 'GET', `/merchants/${merchantId}`));
    expect(detail.stage).toBe('live');
    expect(detail.testSale).toMatchObject({ status: 'refunded', refundId: 're_TestRefund' });
    expect(detail.checklist.steps.every((step: { done: boolean }) => step.done)).toBe(true);

    const list = await body(await ctx.json(ctx.A, 'GET', '/merchants?limit=10'));
    expect(list).toMatchObject({ limit: 10, offset: 0 });
    expect(list.data).toEqual([expect.objectContaining({ id: merchantId, stage: 'live', stripeAccountId: 'acct_1TestMerchant' })]);
    expect(list.data[0]).not.toHaveProperty('contactEmail');
    expect(list.data[0]).not.toHaveProperty('messages');

    // Events: one per lifecycle step, one per prepared message, no customer details in any payload.
    const types = ctx.seen.map((e) => e.type);
    expect(types[0]).toBe('pos_service.merchant.created');
    expect(ctx.seen.filter((e) => e.type === 'pos_service.merchant.stage_changed').map((e) => e.payload.to)).toEqual([
      'account_created', 'onboarding', 'verified', 'location_ready', 'reader_shipped', 'reader_delivered', 'reader_registered', 'test_sale', 'live',
    ]);
    expect(ctx.seen.filter((e) => e.type === 'pos_service.message.prepared').map((e) => e.payload.kind)).toEqual([
      'onboarding_link', 'reader_shipped', 'reader_delivered', 'go_live',
    ]);
    expect(ctx.seen.every((e) => e.tenantId === ctx.A && e.payload.merchantId === merchantId && e.payload.v === 1)).toBe(true);
    const eventText = JSON.stringify(ctx.seen);
    for (const secret of ['owner@saltlife.test', 'Salt Life Cafe', 'Beach Blvd', 'accounts.stripe.com', '1ZTEST']) {
      expect(eventText).not.toContain(secret);
    }

    // Audit: operator actions carry the operator, Stripe-driven changes carry "system".
    const entries = await listAuditEntries(asCoreDb(ctx.db), ctx.A, 'pos_service.merchant', merchantId);
    const oldestFirst = [...entries].reverse();
    expect(oldestFirst[0]).toMatchObject({ action: 'pos_service.merchant.created', actor: 'usr_owner' });
    expect(oldestFirst[1]).toMatchObject({ action: 'pos_service.merchant.updated', actor: 'usr_owner' });
    expect(entries.some((e) => e.actor === 'system')).toBe(true);
    const auditText = JSON.stringify(entries);
    expect(auditText).not.toContain('owner@saltlife.test');
    expect(auditText).not.toContain('accounts.stripe.com');

    // Sending is the relationship owner's job; the API records that it happened, once.
    const messageId = detail.messages[0].id;
    const sent = await ctx.data(ctx.json(ctx.A, 'POST', `/merchants/${merchantId}/messages/${messageId}/sent`, undefined, { 'x-user-id': 'usr_owner' }));
    expect(sent.messages[0].sentAt).toBe('2026-09-15T20:00:00.000Z');
    const again = await ctx.data(ctx.json(ctx.A, 'POST', `/merchants/${merchantId}/messages/${messageId}/sent`));
    expect(again.version).toBe(sent.version);
    const missing = await ctx.json(ctx.A, 'POST', `/merchants/${merchantId}/messages/msg_nope/sent`);
    expect(missing.status).toBe(404);
    expect((await body(missing)).error.code).toBe('message_not_found');
  });

  it('does not write, bump the version, or audit when a sync changes nothing', async () => {
    const ctx = await setupRouter();
    const merchant = await ctx.data(ctx.json(ctx.A, 'POST', '/merchants', purchase));
    await ctx.json(ctx.A, 'POST', `/merchants/${merchant.id}/onboarding`);
    const first = await ctx.data(ctx.json(ctx.A, 'POST', `/merchants/${merchant.id}/sync`));
    expect(first.stage).toBe('location_ready');
    const auditCount = (await listAuditEntries(asCoreDb(ctx.db), ctx.A, 'pos_service.merchant', merchant.id)).length;
    const eventCount = ctx.seen.length;
    const second = await ctx.data(ctx.json(ctx.A, 'POST', `/merchants/${merchant.id}/sync`));
    expect(second.version).toBe(first.version);
    expect((await listAuditEntries(asCoreDb(ctx.db), ctx.A, 'pos_service.merchant', merchant.id)).length).toBe(auditCount);
    expect(ctx.seen.length).toBe(eventCount);
    expect(ctx.stripe.calls.filter((c) => c.path === '/v1/terminal/locations')).toHaveLength(1);
  });
});

describe('pos-service router: stuck test sale', () => {
  it('cancels a test sale the reader is still waiting on', async () => {
    const ctx = await setupRouter({ intentStatuses: ['requires_payment_method'] });
    const merchant = await ctx.data(ctx.json(ctx.A, 'POST', '/merchants', purchase));
    const id = merchant.id;
    await ctx.json(ctx.A, 'POST', `/merchants/${id}/onboarding`);
    await ctx.json(ctx.A, 'POST', `/merchants/${id}/sync`);
    await ctx.json(ctx.A, 'POST', `/merchants/${id}/hardware-orders`, { id: 'thor_7', status: 'delivered' });
    await ctx.json(ctx.A, 'POST', `/merchants/${id}/readers`, { registrationCode: 'code-7', label: 'Counter' });
    expect((await ctx.data(ctx.json(ctx.A, 'POST', `/merchants/${id}/test-sale`))).testSale.status).toBe('waiting_for_card');

    const canceled = await ctx.json(ctx.A, 'POST', `/merchants/${id}/test-sale/cancel`, undefined, { 'x-user-id': 'usr_owner' });
    expect(canceled.status).toBe(200);
    expect((await ctx.data(canceled)).testSale).toMatchObject({ status: 'failed', failure: 'canceled_by_operator' });

    const again = await ctx.json(ctx.A, 'POST', `/merchants/${id}/test-sale/cancel`);
    expect(again.status).toBe(409);
    expect((await body(again)).error.code).toBe('no_test_sale_waiting');
  });
});

describe('pos-service router: tenant isolation', () => {
  it('never lets another tenant read, change, or webhook a merchant', async () => {
    const ctx = await setupRouter();
    const merchant = await ctx.data(ctx.json(ctx.A, 'POST', '/merchants', purchase));
    await ctx.json(ctx.A, 'POST', `/merchants/${merchant.id}/onboarding`);
    const before = await ctx.data(ctx.json(ctx.A, 'GET', `/merchants/${merchant.id}`));

    expect((await ctx.json(ctx.B, 'GET', `/merchants/${merchant.id}`)).status).toBe(404);
    expect(await ctx.data(ctx.json(ctx.B, 'GET', '/merchants'))).toEqual([]);
    for (const path of ['onboarding', 'sync', 'test-sale', 'test-sale/advance', 'test-sale/cancel']) {
      expect((await ctx.json(ctx.B, 'POST', `/merchants/${merchant.id}/${path}`)).status).toBe(404);
    }
    expect((await ctx.json(ctx.B, 'POST', `/merchants/${merchant.id}/readers`, { registrationCode: 'code-1', label: 'Counter' })).status).toBe(404);
    expect((await ctx.json(ctx.B, 'POST', `/merchants/${merchant.id}/hardware-orders`, { id: 'thor_1', status: 'delivered' })).status).toBe(404);
    expect((await ctx.json(ctx.B, 'POST', `/merchants/${merchant.id}/messages/${before.messages[0].id}/sent`)).status).toBe(404);

    // A's Stripe account event delivered under B's tenant is ignored, and B's ledger does not consume A's event.
    const foreign = await ctx.webhook(ctx.B, capabilityEvent('evt_shared'));
    expect(await ctx.data(foreign)).toEqual({ handled: false, action: 'ignored' });

    // The same purchase reference in B is B's own, separate merchant.
    const bPurchase = await ctx.json(ctx.B, 'POST', '/merchants', purchase);
    expect(bPurchase.status).toBe(201);
    expect((await ctx.data(bPurchase)).id).not.toBe(merchant.id);

    expect(await ctx.data(ctx.json(ctx.A, 'GET', `/merchants/${merchant.id}`))).toEqual(before);
    expect(ctx.seen.filter((e) => e.tenantId === ctx.B).map((e) => e.type)).toEqual(['pos_service.merchant.created']);

    const own = await ctx.webhook(ctx.A, capabilityEvent('evt_shared'));
    expect((await ctx.data(own)).action).toBe('account_synced');
  });

  it('requires the tenant header', async () => {
    const ctx = await setupRouter();
    const response = await ctx.app.request('/merchants');
    expect(response.status).toBe(400);
    expect((await body(response)).error.code).toBe('tenant_header_missing');
  });
});

describe('pos-service router: failures', () => {
  it('rejects unsigned and forged webhooks and applies a redelivered event once', async () => {
    const ctx = await setupRouter();
    const merchant = await ctx.data(ctx.json(ctx.A, 'POST', '/merchants', purchase));
    await ctx.json(ctx.A, 'POST', `/merchants/${merchant.id}/onboarding`);

    const unsigned = await ctx.app.request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'x-tenant-id': ctx.A, 'content-type': 'application/json' },
      body: JSON.stringify(capabilityEvent('evt_unsigned')),
    });
    expect(unsigned.status).toBe(400);
    expect((await body(unsigned)).error.code).toBe('invalid_signature');

    const forged = await ctx.webhook(ctx.A, capabilityEvent('evt_forged'), 'whsec_attacker');
    expect(forged.status).toBe(400);
    expect((await ctx.data(ctx.json(ctx.A, 'GET', `/merchants/${merchant.id}`))).stage).toBe('onboarding');

    expect((await ctx.data(ctx.webhook(ctx.A, capabilityEvent('evt_real')))).action).toBe('account_synced');
    expect(await ctx.data(ctx.webhook(ctx.A, capabilityEvent('evt_real')))).toEqual({ handled: false, action: 'duplicate' });
    expect(ctx.stripe.calls.filter((c) => c.path === '/v1/terminal/locations')).toHaveLength(1);
  });

  it('reports a Stripe refusal as 502 with Stripe details and leaves the merchant unchanged', async () => {
    const ctx = await setupRouter({ failPath: '/v2/core/accounts' });
    const merchant = await ctx.data(ctx.json(ctx.A, 'POST', '/merchants', purchase));
    const response = await ctx.json(ctx.A, 'POST', `/merchants/${merchant.id}/onboarding`);
    expect(response.status).toBe(502);
    expect((await body(response)).error).toMatchObject({
      code: 'stripe_error',
      details: { stripeStatus: 400, stripeCode: 'resource_missing', requestId: 'req_fail' },
    });
    expect(await ctx.data(ctx.json(ctx.A, 'GET', `/merchants/${merchant.id}`))).toMatchObject({ stage: 'purchased', version: 1, stripeAccountId: null });
  });

  it('answers 501 for Stripe work until Connect is configured, and still serves reads', async () => {
    const ctx = await setupRouter({}, { stripe: null, webhookSecrets: [] });
    const purchaseAttempt = await ctx.json(ctx.A, 'POST', '/merchants', purchase);
    expect(purchaseAttempt.status).toBe(501);
    expect((await body(purchaseAttempt)).error.code).toBe('stripe_not_configured');
    expect((await ctx.webhook(ctx.A, capabilityEvent('evt_1'))).status).toBe(501);
    expect(await ctx.data(ctx.json(ctx.A, 'GET', '/merchants'))).toEqual([]);
    expect(await ctx.data(ctx.json(ctx.A, 'GET', '/config'))).toEqual({
      stripeConfigured: false,
      webhookConfigured: false,
      livemode: null,
      connect: { dashboard: 'full', feesCollector: 'stripe', lossesCollector: 'stripe' },
      platformFee: { basisPoints: 0, fixedCents: 0 },
      testSaleAmountCents: 100,
      compatibleReaderTypes: ['bbpos_wisepos_e', 'stripe_s700'],
    });
  });

  it('validates bodies, including smuggled tenant ids', async () => {
    const ctx = await setupRouter();
    const badEmail = await ctx.json(ctx.A, 'POST', '/merchants', { ...purchase, contactEmail: 'not-an-email' });
    expect(badEmail.status).toBe(400);
    expect((await body(badEmail)).error.code).toBe('validation_error');
    expect((await ctx.json(ctx.A, 'POST', '/merchants', { ...purchase, tenant_id: ctx.B })).status).toBe(400);
    expect((await ctx.json(ctx.A, 'POST', '/merchants', { ...purchase, address: { ...purchase.address, country: 'CA' } })).status).toBe(400);
    const notJson = await ctx.app.request('/merchants', { method: 'POST', headers: { 'x-tenant-id': ctx.A, 'content-type': 'application/json' }, body: '{' });
    expect(notJson.status).toBe(400);
    const merchant = await ctx.data(ctx.json(ctx.A, 'POST', '/merchants', purchase));
    expect((await ctx.json(ctx.A, 'POST', `/merchants/${merchant.id}/hardware-orders`, { id: 'order-1', status: 'shipped' })).status).toBe(400);
    expect((await ctx.json(ctx.A, 'POST', `/merchants/${merchant.id}/readers`, { registrationCode: 'code-1' })).status).toBe(400);
    expect(await ctx.data(ctx.json(ctx.A, 'GET', '/merchants'))).toHaveLength(1);
  });

  it('refuses an insecure configuration when the app is assembled', () => {
    const deps = { db: createTestDb<PosServiceDatabase>(), events: new EventBus(), contracts: {} };
    expect(() => posServiceRouter(deps, { onboarding: { returnUrl: 'http://pos.example.test/done', refreshUrl: 'https://pos.example.test/refresh' } })).toThrow(/https/);
    expect(() => posServiceRouter(deps, {
      onboarding: { returnUrl: 'https://pos.example.test/done', refreshUrl: 'https://pos.example.test/refresh' },
      platformFee: { basisPoints: 2500, fixedCents: 0 },
    })).toThrow(/basis points/);
  });
});
