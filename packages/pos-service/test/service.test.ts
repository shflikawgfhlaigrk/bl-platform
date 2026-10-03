import { describe, expect, it } from 'vitest';
import {
  CONNECT_ACCOUNT_SETTINGS,
  InMemoryMerchantStore,
  createPosService,
  createStripeClient,
  merchantChecklist,
  stripeSignatureHeader,
  type PosServiceOptions,
} from '../src/index';
import { fakeStripe } from './fake-stripe';

const WEBHOOK_SECRET = 'whsec_pos_service_test';
const address = { line1: '100 Beach Blvd', city: 'Gulf Shores', state: 'AL', postalCode: '36542', country: 'US' as const };

function setup(stripeState: Parameters<typeof fakeStripe>[0] = {}, overrides: Partial<PosServiceOptions> = {}) {
  const stripe = fakeStripe(stripeState);
  const store = new InMemoryMerchantStore();
  let id = 0;
  const service = createPosService({
    store,
    stripe: createStripeClient({ secretKey: 'sk_test_platform', fetch: stripe.fetch }),
    onboarding: { returnUrl: 'https://pos.example.test/setup/done', refreshUrl: 'https://pos.example.test/setup/refresh' },
    now: () => new Date('2026-09-15T20:00:00.000Z'),
    newId: () => `mer_test_${++id}`,
    ...overrides,
  });
  const webhook = (event: Record<string, unknown>) => {
    const payload = JSON.stringify(event);
    const nowSeconds = 1_800_000_000;
    return service.handleWebhook({ payload, signatureHeader: stripeSignatureHeader(WEBHOOK_SECRET, nowSeconds, payload), secret: WEBHOOK_SECRET, nowSeconds });
  };
  return { stripe, store, service, webhook };
}

async function toDelivered(ctx: ReturnType<typeof setup>) {
  const merchant = await ctx.service.purchase({ purchaseRef: 'cs_test_1', businessName: 'Salt Life Cafe', contactEmail: 'Owner@SaltLife.test', address });
  await ctx.service.startOnboarding(merchant.id);
  await ctx.webhook({ id: 'evt_thin_1', object: 'v2.core.event', type: 'v2.core.account[configuration.merchant].capability_status_updated', related_object: { id: 'acct_1TestMerchant', type: 'v2.core.account' } });
  await ctx.webhook({ id: 'evt_hw_1', type: 'terminal.hardware_order.shipped', data: { object: { id: 'thor_1', status: 'shipped', metadata: { merchant_id: merchant.id }, shipment_tracking: [{ carrier: 'ups', tracking_number: '1ZTEST' }] } } });
  await ctx.webhook({ id: 'evt_hw_2', type: 'terminal.hardware_order.delivered', data: { object: { id: 'thor_1', status: 'delivered', metadata: { merchant_id: merchant.id } } } });
  return merchant.id;
}

describe('POS service: purchase to live', () => {
  it('runs the whole lifecycle with the Stripe requests a platform must send', async () => {
    const ctx = setup();
    const merchantId = await toDelivered(ctx);

    const account = ctx.stripe.calls.find((c) => c.path === '/v2/core/accounts')!;
    expect(account.headers['Idempotency-Key']).toBe(`pos-service:account:${merchantId}`);
    expect(account.json).toMatchObject({
      contact_email: 'owner@saltlife.test',
      display_name: 'Salt Life Cafe',
      identity: { country: 'us' },
      configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
      defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
      dashboard: 'full',
      metadata: { merchant_id: merchantId, purchase_ref: 'cs_test_1' },
    });
    expect(CONNECT_ACCOUNT_SETTINGS).toEqual({ dashboard: 'full', feesCollector: 'stripe', lossesCollector: 'stripe' });

    const link = ctx.stripe.calls.find((c) => c.path === '/v2/core/account_links')!;
    expect(link.json).toEqual({
      account: 'acct_1TestMerchant',
      use_case: { type: 'account_onboarding', account_onboarding: { configurations: ['merchant'], return_url: 'https://pos.example.test/setup/done', refresh_url: 'https://pos.example.test/setup/refresh' } },
    });

    const location = ctx.stripe.calls.find((c) => c.path === '/v1/terminal/locations')!;
    expect(location.headers['Stripe-Account']).toBe('acct_1TestMerchant');
    expect(location.form?.get('address[postal_code]')).toBe('36542');
    expect(location.form?.get('address[country]')).toBe('US');

    let merchant = await ctx.service.getMerchant(merchantId);
    expect(merchant.stage).toBe('reader_delivered');
    expect(merchant.hardwareOrder?.tracking).toEqual([{ carrier: 'ups', trackingNumber: '1ZTEST' }]);

    merchant = await ctx.service.registerReader(merchantId, { registrationCode: 'sepia-cerulean-aqua', label: 'Front counter' });
    const reader = ctx.stripe.calls.find((c) => c.method === 'POST' && c.path === '/v1/terminal/readers')!;
    expect(reader.headers['Stripe-Account']).toBe('acct_1TestMerchant');
    expect(reader.form?.get('location')).toBe('tml_TestLocation');
    expect(merchant.stage).toBe('reader_registered');

    merchant = await ctx.service.startTestSale(merchantId);
    const intent = ctx.stripe.calls.find((c) => c.path === '/v1/payment_intents')!;
    expect(intent.headers['Stripe-Account']).toBe('acct_1TestMerchant');
    expect(intent.form?.get('amount')).toBe('100');
    expect(intent.form?.get('payment_method_types[]')).toBe('card_present');
    expect(intent.form?.get('capture_method')).toBe('manual');
    expect(intent.form?.has('application_fee_amount')).toBe(false);
    expect(ctx.stripe.calls.some((c) => c.path === '/v1/terminal/readers/tmr_TestReader/process_payment_intent')).toBe(true);
    expect(merchant.testSale.status).toBe('waiting_for_card');

    const result = await ctx.webhook({ id: 'evt_pi_1', type: 'payment_intent.amount_capturable_updated', account: 'acct_1TestMerchant', data: { object: { id: 'pi_TestSale', metadata: { merchant_id: merchantId, purpose: 'go_live_test' } } } });
    expect(result).toEqual({ handled: true, action: 'test_sale_advanced', merchantId });
    merchant = await ctx.service.getMerchant(merchantId);
    expect(merchant.stage).toBe('live');
    expect(merchant.testSale).toMatchObject({ status: 'refunded', refundId: 're_TestRefund' });
    expect(ctx.stripe.calls.find((c) => c.path === '/v1/refunds')?.form?.has('refund_application_fee')).toBe(false);

    expect(merchant.history.map((h) => h.to)).toEqual([
      'account_created', 'onboarding', 'verified', 'location_ready', 'reader_shipped', 'reader_delivered', 'reader_registered', 'test_sale', 'live',
    ]);
    expect(merchant.messages.map((m) => m.kind)).toEqual(['onboarding_link', 'reader_shipped', 'reader_delivered', 'go_live']);
    expect(merchant.messages.every((m) => m.sentAt === null && m.to === 'owner@saltlife.test')).toBe(true);
    expect(merchantChecklist(merchant).steps.every((s) => s.done)).toBe(true);
  });

  it('adds our platform fee to real payments only when configured, and refunds it on the test sale', async () => {
    const ctx = setup({}, { platformFee: { basisPoints: 50, fixedCents: 5 } });
    expect(ctx.service.applicationFeeFor(10_000)).toBe(55);
    // Platform money rounds half up at each step (CONVENTIONS §7): 0.5 cents of percentage fee becomes 1.
    expect(ctx.service.applicationFeeFor(100)).toBe(6);
    expect(ctx.service.applicationFeeFor(99)).toBe(5);
    const merchantId = await toDelivered(ctx);
    await ctx.service.registerReader(merchantId, { registrationCode: 'code-1', label: 'Counter' });
    await ctx.service.startTestSale(merchantId);
    expect(ctx.stripe.calls.find((c) => c.path === '/v1/payment_intents')?.form?.get('application_fee_amount')).toBe('6');
    await ctx.service.advanceTestSale(merchantId);
    expect(ctx.stripe.calls.find((c) => c.path === '/v1/refunds')?.form?.get('refund_application_fee')).toBe('true');
  });
});

describe('POS service: things that go wrong', () => {
  it('blocks on requirements the merchant owes Stripe, and clears when Stripe activates payments', async () => {
    const ctx = setup({ cardPayments: 'restricted', requirements: [{ awaiting_action_from: 'user', description: 'identity.business_details.id_numbers', minimum_deadline: { status: 'past_due' } }] });
    const merchant = await ctx.service.purchase({ purchaseRef: 'cs_2', businessName: 'Shop', contactEmail: 'a@b.test', address });
    await ctx.service.startOnboarding(merchant.id);
    let record = await ctx.service.syncAccount({ merchantId: merchant.id });
    expect(record.stage).toBe('onboarding');
    expect(record.blocked?.code).toBe('requirements_due');
    await ctx.service.syncAccount({ merchantId: merchant.id });
    record = await ctx.service.getMerchant(merchant.id);
    expect(record.messages.filter((m) => m.kind === 'requirements_due')).toHaveLength(1);
    ctx.stripe.state.cardPayments = 'active';
    ctx.stripe.state.requirements = [];
    record = await ctx.service.syncAccount({ merchantId: merchant.id });
    expect(record.blocked).toBeNull();
    expect(record.stage).toBe('location_ready');
  });

  it('refuses reader registration and the test sale out of order', async () => {
    const ctx = setup();
    const merchant = await ctx.service.purchase({ purchaseRef: 'cs_3', businessName: 'Shop', contactEmail: 'a@b.test', address });
    await expect(ctx.service.registerReader(merchant.id, { registrationCode: 'x-1', label: 'Counter' })).rejects.toMatchObject({ code: 'not_ready' });
    await expect(ctx.service.startTestSale(merchant.id)).rejects.toMatchObject({ code: 'not_ready' });
    expect(ctx.stripe.calls).toHaveLength(0);
  });

  it('does not keep a reader this POS cannot drive', async () => {
    const ctx = setup({ readerDeviceType: 'stripe_m2' });
    const merchantId = await toDelivered(ctx);
    const record = await ctx.service.registerReader(merchantId, { registrationCode: 'x-2', label: 'Counter' });
    expect(record.stage).toBe('reader_delivered');
    expect(record.reader).toBeNull();
    expect(record.blocked?.code).toBe('incompatible_reader');
    expect(ctx.stripe.calls.some((c) => c.method === 'DELETE' && c.path === '/v1/terminal/readers/tmr_TestReader')).toBe(true);
  });

  it('flags an undeliverable reader and never moves a stage backwards on a late event', async () => {
    const ctx = setup();
    const merchantId = await toDelivered(ctx);
    let record = await ctx.service.recordHardwareOrder(merchantId, { id: 'thor_1', status: 'shipped' });
    expect(record.stage).toBe('reader_delivered');
    record = await ctx.service.recordHardwareOrder(merchantId, { id: 'thor_2', status: 'undeliverable' });
    expect(record.blocked?.code).toBe('hardware_undeliverable');
    expect(record.messages.at(-1)?.kind).toBe('hardware_problem');
  });

  it('holds hardware that ships before verification until the store location exists', async () => {
    const ctx = setup({ cardPayments: 'pending' });
    const merchant = await ctx.service.purchase({ purchaseRef: 'cs_4', businessName: 'Shop', contactEmail: 'a@b.test', address });
    await ctx.service.startOnboarding(merchant.id);
    let record = await ctx.service.recordHardwareOrder(merchant.id, { id: 'thor_9', status: 'delivered' });
    expect(record.stage).toBe('onboarding');
    ctx.stripe.state.cardPayments = 'active';
    record = await ctx.service.syncAccount({ merchantId: merchant.id });
    expect(record.stage).toBe('reader_delivered');
  });

  it('keeps waiting when Stripe reports the test sale before the card is tapped', async () => {
    const ctx = setup({ intentStatuses: ['requires_payment_method'] });
    const merchantId = await toDelivered(ctx);
    await ctx.service.registerReader(merchantId, { registrationCode: 'x-2', label: 'Counter' });
    await ctx.service.startTestSale(merchantId);
    const result = await ctx.webhook({ id: 'evt_pi_created', type: 'payment_intent.created', account: 'acct_1TestMerchant', data: { object: { id: 'pi_TestSale', status: 'requires_payment_method', metadata: { merchant_id: merchantId, purpose: 'go_live_test' } } } });
    expect(result).toEqual({ handled: true, action: 'test_sale_advanced', merchantId });
    let record = await ctx.service.getMerchant(merchantId);
    expect(record.testSale).toMatchObject({ status: 'waiting_for_card', failure: null });
    record = await ctx.service.advanceTestSale(merchantId);
    expect(record.testSale.status).toBe('waiting_for_card');
    await expect(ctx.service.startTestSale(merchantId)).rejects.toMatchObject({ code: 'test_sale_in_progress' });
  });

  it('marks a declined test sale failed and allows another attempt', async () => {
    const ctx = setup({ intentStatuses: ['requires_payment_method'], declineCode: 'card_declined' });
    const merchantId = await toDelivered(ctx);
    await ctx.service.registerReader(merchantId, { registrationCode: 'x-3', label: 'Counter' });
    await ctx.service.startTestSale(merchantId);
    let record = await ctx.service.advanceTestSale(merchantId);
    expect(record.testSale).toMatchObject({ status: 'failed', failure: 'card_declined' });
    expect(record.stage).toBe('test_sale');
    record = await ctx.service.startTestSale(merchantId);
    expect(record.testSale).toMatchObject({ attempt: 2, status: 'waiting_for_card', paymentIntentId: 'pi_TestSale2' });
    const intents = ctx.stripe.calls.filter((c) => c.path === '/v1/payment_intents');
    expect(intents.map((c) => c.headers['Idempotency-Key'])).toEqual([
      `pos-service:test-sale:${merchantId}:1:intent`,
      `pos-service:test-sale:${merchantId}:2:intent`,
    ]);
    // Stripe: a failed PaymentIntent is canceled before a new one exists, so the declined one can never be charged.
    const cancelIndex = ctx.stripe.calls.findIndex((c) => c.method === 'POST' && c.path === '/v1/payment_intents/pi_TestSale/cancel');
    const secondIntentIndex = ctx.stripe.calls.lastIndexOf(intents[1]);
    expect(cancelIndex).toBeGreaterThan(-1);
    expect(cancelIndex).toBeLessThan(secondIntentIndex);
    expect(ctx.stripe.calls[cancelIndex].headers['Idempotency-Key']).toBe(`pos-service:test-sale:${merchantId}:1:cancel`);
    // A late failure event for the canceled intent does not touch the new attempt.
    const late = await ctx.webhook({ id: 'evt_late_fail', type: 'payment_intent.payment_failed', account: 'acct_1TestMerchant', data: { object: { id: 'pi_TestSale', metadata: { merchant_id: merchantId, purpose: 'go_live_test' } } } });
    expect(late).toEqual({ handled: false, action: 'ignored' });
    expect((await ctx.service.getMerchant(merchantId)).testSale).toMatchObject({ attempt: 2, status: 'waiting_for_card' });
  });

  const readerEvent = (id: string, type: string, merchantIntent: string, failureCode?: string) => ({
    id,
    type,
    account: 'acct_1TestMerchant',
    data: {
      object: {
        id: 'tmr_TestReader',
        object: 'terminal.reader',
        action: {
          type: 'process_payment_intent',
          status: failureCode ? 'failed' : 'succeeded',
          failure_code: failureCode ?? null,
          process_payment_intent: { payment_intent: merchantIntent },
        },
      },
    },
  });

  async function toTestSale(ctx: ReturnType<typeof setup>) {
    const merchantId = await toDelivered(ctx);
    await ctx.service.registerReader(merchantId, { registrationCode: 'x-9', label: 'Counter' });
    await ctx.service.startTestSale(merchantId);
    return merchantId;
  }

  it('goes live from the reader success webhook Stripe recommends', async () => {
    const ctx = setup();
    const merchantId = await toTestSale(ctx);
    expect(await ctx.webhook(readerEvent('evt_reader_ok', 'terminal.reader.action_succeeded', 'pi_TestSale')))
      .toEqual({ handled: true, action: 'test_sale_advanced', merchantId });
    const record = await ctx.service.getMerchant(merchantId);
    expect(record.stage).toBe('live');
    expect(record.testSale).toMatchObject({ status: 'refunded', refundId: 're_TestRefund' });
    expect(await ctx.webhook(readerEvent('evt_reader_other', 'terminal.reader.action_succeeded', 'pi_SomeoneElse')))
      .toEqual({ handled: false, action: 'ignored' });
  });

  it('records a customer cancel on the reader, then retries on a fresh payment', async () => {
    const ctx = setup({ intentStatuses: ['requires_payment_method'] });
    const merchantId = await toTestSale(ctx);
    await ctx.webhook(readerEvent('evt_reader_cancel', 'terminal.reader.action_failed', 'pi_TestSale', 'customer_canceled'));
    let record = await ctx.service.getMerchant(merchantId);
    expect(record.testSale).toMatchObject({ status: 'failed', failure: 'customer_canceled' });
    record = await ctx.service.startTestSale(merchantId);
    expect(record.testSale).toMatchObject({ attempt: 2, paymentIntentId: 'pi_TestSale2', status: 'waiting_for_card', failure: null });
    expect(ctx.stripe.calls.some((c) => c.path === '/v1/payment_intents/pi_TestSale/cancel')).toBe(true);
  });

  it('finishes a card that was approved after a reader connection error instead of charging again', async () => {
    const ctx = setup({ intentStatuses: ['requires_payment_method'] });
    const merchantId = await toTestSale(ctx);
    await ctx.webhook(readerEvent('evt_reader_conn', 'terminal.reader.action_failed', 'pi_TestSale', 'connection_error'));
    expect((await ctx.service.getMerchant(merchantId)).testSale).toMatchObject({ status: 'failed', failure: 'connection_error' });
    // Stripe had authorized the card after all.
    ctx.stripe.state.intentStatuses = ['requires_capture'];
    const result = await ctx.webhook({ id: 'evt_capturable', type: 'payment_intent.amount_capturable_updated', account: 'acct_1TestMerchant', data: { object: { id: 'pi_TestSale', metadata: { merchant_id: merchantId, purpose: 'go_live_test' } } } });
    expect(result).toEqual({ handled: true, action: 'test_sale_advanced', merchantId });
    const record = await ctx.service.getMerchant(merchantId);
    expect(record.stage).toBe('live');
    expect(record.testSale).toMatchObject({ attempt: 1, status: 'refunded', failure: null });
    expect(ctx.stripe.calls.filter((c) => c.path === '/v1/payment_intents')).toHaveLength(1);
    expect(ctx.stripe.calls.some((c) => c.path.endsWith('/cancel'))).toBe(false);
  });

  it('lets an operator stop a stuck test sale, but never interrupts a card being authorized', async () => {
    const ctx = setup({ intentStatuses: ['requires_payment_method'], readerCancelError: 'terminal_reader_busy' });
    const merchantId = await toTestSale(ctx);
    await expect(ctx.service.cancelTestSale(merchantId)).rejects.toMatchObject({ code: 'reader_busy', status: 409 });
    expect((await ctx.service.getMerchant(merchantId)).testSale.status).toBe('waiting_for_card');

    ctx.stripe.state.readerCancelError = 'terminal_reader_offline';
    let record = await ctx.service.cancelTestSale(merchantId);
    expect(record.testSale).toMatchObject({ status: 'failed', failure: 'canceled_by_operator' });
    await expect(ctx.service.cancelTestSale(merchantId)).rejects.toMatchObject({ code: 'no_test_sale_waiting' });

    ctx.stripe.state.readerCancelError = undefined;
    record = await ctx.service.startTestSale(merchantId);
    expect(record.testSale).toMatchObject({ attempt: 2, status: 'waiting_for_card' });
    record = await ctx.service.cancelTestSale(merchantId);
    expect(record.testSale).toMatchObject({ attempt: 2, status: 'failed', failure: 'canceled_by_operator' });
    const cancels = ctx.stripe.calls.filter((c) => c.path === '/v1/terminal/readers/tmr_TestReader/cancel_action');
    expect(cancels.map((c) => c.headers['Idempotency-Key'])).toEqual([
      `pos-service:test-sale:${merchantId}:1:cancel_action`,
      `pos-service:test-sale:${merchantId}:1:cancel_action`,
      `pos-service:test-sale:${merchantId}:2:cancel_action`,
    ]);
  });

  it('blocks go-live when the test refund does not complete, and recovers once it is refunded by hand', async () => {
    const ctx = setup({ intentStatuses: ['requires_capture', 'succeeded'], refundStatus: 'failed' });
    const merchantId = await toTestSale(ctx);
    let record = await ctx.service.advanceTestSale(merchantId);
    expect(record.stage).toBe('test_sale');
    expect(record.testSale).toMatchObject({ status: 'failed', failure: 'refund_failed' });
    expect(record.blocked?.code).toBe('test_sale_refund_incomplete');
    await expect(ctx.service.startTestSale(merchantId)).rejects.toMatchObject({ code: 'test_sale_refund_incomplete' });

    record = await ctx.service.advanceTestSale(merchantId);
    expect(record.stage).toBe('test_sale');
    expect(ctx.stripe.calls.filter((c) => c.path === '/v1/refunds')).toHaveLength(1);

    ctx.stripe.state.chargeRefunded = true;
    record = await ctx.service.advanceTestSale(merchantId);
    expect(record.stage).toBe('live');
    expect(record.blocked).toBeNull();
    expect(record.testSale).toMatchObject({ status: 'refunded', failure: null });
    expect(ctx.stripe.calls.filter((c) => c.path === '/v1/refunds')).toHaveLength(1);
    expect(ctx.stripe.calls.filter((c) => c.path === '/v1/payment_intents')).toHaveLength(1);
  });

  it('accepts webhooks signed by any configured event destination and nothing else', async () => {
    const ctx = setup();
    const payload = JSON.stringify({ id: 'evt_multi', type: 'account.updated', data: { object: { id: 'acct_1Nobody' } } });
    const nowSeconds = 1_800_000_000;
    const secrets = ['whsec_thin_destination', WEBHOOK_SECRET];
    await expect(ctx.service.handleWebhook({ payload, signatureHeader: stripeSignatureHeader(WEBHOOK_SECRET, nowSeconds, payload), secret: secrets, nowSeconds }))
      .resolves.toEqual({ handled: false, action: 'ignored' });
    await expect(ctx.service.handleWebhook({ payload, signatureHeader: stripeSignatureHeader('whsec_attacker', nowSeconds, payload), secret: secrets, nowSeconds }))
      .rejects.toMatchObject({ code: 'invalid_signature' });
    await expect(ctx.service.handleWebhook({ payload, signatureHeader: stripeSignatureHeader(WEBHOOK_SECRET, nowSeconds, payload), secret: [], nowSeconds }))
      .rejects.toMatchObject({ code: 'invalid_signature', message: 'Webhook rejected: missing_secret.' });
  });

  it('rejects forged webhooks, skips duplicates, and ignores events for other accounts', async () => {
    const ctx = setup();
    const merchantId = await toDelivered(ctx);
    const payload = JSON.stringify({ id: 'evt_forged', type: 'account.updated', data: { object: { id: 'acct_1TestMerchant' } } });
    await expect(ctx.service.handleWebhook({ payload, signatureHeader: stripeSignatureHeader('whsec_wrong', 1_800_000_000, payload), secret: WEBHOOK_SECRET, nowSeconds: 1_800_000_000 }))
      .rejects.toMatchObject({ code: 'invalid_signature', status: 400 });
    expect(await ctx.webhook({ id: 'evt_hw_2', type: 'terminal.hardware_order.delivered', data: { object: { id: 'thor_1', status: 'delivered', metadata: { merchant_id: merchantId } } } }))
      .toEqual({ handled: false, action: 'duplicate' });
    expect(await ctx.webhook({ id: 'evt_other', type: 'account.updated', data: { object: { id: 'acct_1SomeoneElse' } } }))
      .toEqual({ handled: false, action: 'ignored' });
    await ctx.service.registerReader(merchantId, { registrationCode: 'x-4', label: 'Counter' });
    await ctx.service.startTestSale(merchantId);
    expect(await ctx.webhook({ id: 'evt_pi_wrong_account', type: 'payment_intent.succeeded', account: 'acct_1SomeoneElse', data: { object: { id: 'pi_TestSale', metadata: { merchant_id: merchantId, purpose: 'go_live_test' } } } }))
      .toEqual({ handled: false, action: 'ignored' });
    expect((await ctx.service.getMerchant(merchantId)).stage).toBe('test_sale');
  });

  it('refuses a merchant created in test mode when the service runs on a live key', async () => {
    const ctx = setup();
    const merchant = await ctx.service.purchase({ purchaseRef: 'cs_5', businessName: 'Shop', contactEmail: 'a@b.test', address });
    const live = createPosService({
      store: ctx.store,
      stripe: createStripeClient({ secretKey: 'sk_live_platform', fetch: ctx.stripe.fetch }),
      onboarding: { returnUrl: 'https://pos.example.test/done', refreshUrl: 'https://pos.example.test/refresh' },
    });
    await expect(live.startOnboarding(merchant.id)).rejects.toMatchObject({ code: 'mode_mismatch' });
  });

  it('validates purchases and configuration', async () => {
    const ctx = setup();
    await expect(ctx.service.purchase({ purchaseRef: 'cs_6', businessName: 'Shop', contactEmail: 'not-an-email', address })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(ctx.service.purchase({ purchaseRef: 'cs_6', businessName: 'Shop', contactEmail: 'a@b.test', address: { ...address, postalCode: '3654' } })).rejects.toMatchObject({ code: 'invalid_input' });
    const first = await ctx.service.purchase({ purchaseRef: 'cs_7', businessName: 'Shop', contactEmail: 'a@b.test', address });
    const again = await ctx.service.purchase({ purchaseRef: 'cs_7', businessName: 'Shop', contactEmail: 'a@b.test', address });
    expect(again.id).toBe(first.id);
    expect(() => setup({}, { onboarding: { returnUrl: 'http://insecure.test', refreshUrl: 'https://ok.test' } })).toThrow(/https/);
    expect(() => setup({}, { platformFee: { basisPoints: 5000, fixedCents: 0 } })).toThrow(/basis points/);
  });
});
