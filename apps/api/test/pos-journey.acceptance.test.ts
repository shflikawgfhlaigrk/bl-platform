import { describe, expect, it } from 'vitest';
import { asCoreDb, createTenant } from '@blacklabel/core';
import { createTestDb } from '@blacklabel/db';
import {
  addBarcode,
  createProduct,
  createVariation,
  type CatalogDatabase,
} from '@blacklabel/catalog';
import {
  applyMovement,
  createLocation,
  type InventoryDatabase,
} from '@blacklabel/inventory';
import {
  stripeSignatureHeader,
  stripeTerminalCheckoutProvider,
  type HttpTransport,
} from '@blacklabel/orders';
import * as Cart from '../../ui/public/src/cart.mjs';
import {
  createApp,
  type CreateAppOptions,
  type PlatformDatabase,
} from '../src/app';

const KEY = Buffer.alloc(32, 27);
const STRIPE_SECRET = 'sk_test_pos_journey';
const WEBHOOK_SECRET = 'whsec_pos_journey';
const STRIPE_NOW = 2_000_000_000;
const READER_ID = 'tmr_pos_journey';
const PAYMENT_INTENT_ID = 'pi_pos_journey';
const CHARGE_ID = 'ch_pos_journey';

type Platform = Awaited<ReturnType<typeof createApp>>;
type Json = Record<string, any>;
type TransportCall = { url: string; init: Parameters<HttpTransport>[1] };

const catalogDb = (db: unknown) => db as import('kysely').Kysely<CatalogDatabase>;
const inventoryDb = (db: unknown) => db as import('kysely').Kysely<InventoryDatabase>;

function headers(tenantId: string): Record<string, string> {
  return {
    'x-tenant-id': tenantId,
    'x-mags-csrf': '1',
    'content-type': 'application/json',
  };
}

async function body(response: Response): Promise<Json> {
  return (await response.json()) as Json;
}

async function request(
  platform: Platform,
  tenantId: string,
  method: string,
  path: string,
  payload?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ response: Response; body: Json }> {
  const response = await platform.app.request(path, {
    method,
    headers: { ...headers(tenantId), ...extraHeaders },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return { response, body: await body(response) };
}

async function boot(options: Partial<CreateAppOptions> = {}) {
  const db = createTestDb<PlatformDatabase>();
  const platform = await createApp({
    db,
    adminMasterKey: KEY,
    disableRateLimit: true,
    ...options,
  });
  const tenant = await createTenant(asCoreDb(db), { name: 'POS Journey Tenant' });
  await platform.seedTenant(tenant.id);
  return { db, platform, tenantId: tenant.id };
}

async function seedRegisterCatalog(
  db: PlatformDatabase extends never ? never : unknown,
  platform: Platform,
  tenantId: string,
) {
  const location = await createLocation(inventoryDb(db), tenantId, 'owner', {
    name: 'Acceptance Register',
    kind: 'warehouse',
    oversellPolicy: 'deny',
  });
  const product = await createProduct(catalogDb(db), tenantId, 'owner', {
    sourceItemId: 'acceptance-item',
    name: 'Acceptance Saddle Pad',
  });
  const variation = await createVariation(catalogDb(db), tenantId, 'owner', platform.events, {
    productId: product.id,
    sourceVariationId: 'acceptance-variation',
    name: 'Standard',
    sku: 'ACCEPT-PAD',
    priceCents: 1_500,
    trackInventory: true,
  });
  await addBarcode(catalogDb(db), tenantId, 'owner', variation.id, '036000291452', {
    isPrimary: true,
  });
  await applyMovement(inventoryDb(db), platform.events, tenantId, 'owner', {
    variationId: variation.id,
    locationId: location.id,
    delta: 10,
    reason: 'received',
  });
  return { location, variation };
}

async function configureFromSettings(
  platform: Platform,
  tenantId: string,
  locationId: string,
  taxBps: number,
  receiptFooter: string,
) {
  const locations = await request(platform, tenantId, 'GET', '/api/inventory/locations');
  expect(locations.response.status).toBe(200);
  expect(locations.body.data).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: locationId, archived: 0 })]),
  );

  const saved = await request(platform, tenantId, 'PUT', '/api/pos/settings', {
    defaultLocationId: locationId,
    taxBps,
    receiptFooter,
  });
  expect(saved.response.status).toBe(200);
  expect(saved.body.data).toMatchObject({
    defaultLocationId: locationId,
    taxBps,
    taxConfigured: true,
    receiptFooter,
    currency: 'USD',
  });

  const loaded = await request(platform, tenantId, 'GET', '/api/pos/settings');
  expect(loaded.response.status).toBe(200);
  expect(loaded.body.data).toEqual(saved.body.data);
}

async function catalogLookup(platform: Platform, tenantId: string) {
  const lookup = await request(
    platform,
    tenantId,
    'GET',
    '/api/pos/catalog?code=036000291452',
  );
  expect(lookup.response.status).toBe(200);
  expect(lookup.body.data).toMatchObject({ matchType: 'barcode' });
  expect(lookup.body.data.matches).toHaveLength(1);
  return lookup.body.data.matches[0] as Json;
}

function cartFromMatch(match: Json, cartId: string, qty: number, taxBps: number) {
  let cart = Cart.createCart({ id: cartId, now: '2026-09-03T12:00:00.000Z' });
  cart = Cart.addCartLine(cart, {
    variationId: match.variationId,
    description: match.name,
    sku: match.sku,
    barcode: match.barcode,
    qty,
    unitPriceCents: match.unitPriceCents,
  }, { lineId: `${cartId}-line`, now: '2026-09-03T12:00:00.000Z' });
  return Cart.setCartPricing(cart, { taxBps }, { now: '2026-09-03T12:00:00.000Z' });
}

function stripeFixture(uniqueIntents = false, pendingRefunds = false, failFirstRefund = false) {
  let intentNumber = 0;
  const calls: TransportCall[] = [];
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/v1/payment_intents')) {
      const form = new URLSearchParams(init.body);
      return {
        status: 200,
        json: async () => ({
          id: uniqueIntents ? `${PAYMENT_INTENT_ID}_${++intentNumber}` : PAYMENT_INTENT_ID,
          amount: Number(form.get('amount')),
          status: 'requires_payment_method',
        }),
      };
    }
    if (url.endsWith(`/v1/terminal/readers/${READER_ID}/process_payment_intent`)) {
      return {
        status: 200,
        json: async () => ({
          id: READER_ID,
          status: 'online',
          action: { type: 'process_payment_intent', status: 'in_progress' },
        }),
      };
    }
    if (url.endsWith('/v1/refunds')) {
      if (failFirstRefund) { failFirstRefund = false; throw new Error('ambiguous transport failure'); }
      const form = new URLSearchParams(init.body);
      return {
        status: 200,
        json: async () => ({
          id: uniqueIntents ? `re_${form.get('payment_intent')}` : 're_pos_journey',
          status: pendingRefunds ? 'pending' : 'succeeded',
          amount: Number(form.get('amount')),
          payment_intent: uniqueIntents ? form.get('payment_intent') : PAYMENT_INTENT_ID,
          charge: uniqueIntents ? `ch_${form.get('payment_intent')}` : CHARGE_ID,
        }),
      };
    }
    throw new Error(`unexpected Stripe request: ${url}`);
  };
  return {
    calls,
    provider: stripeTerminalCheckoutProvider({
      secretKey: STRIPE_SECRET,
      webhookSecret: WEBHOOK_SECRET,
      transport,
      nowSeconds: () => STRIPE_NOW,
    }),
  };
}

describe('POS UI/API acceptance journey', () => {
  it('settings -> readiness -> drawer -> catalog -> reserved split sale -> change -> receipt -> cash refund -> close', async () => {
    const { db, platform, tenantId } = await boot();
    const { location, variation } = await seedRegisterCatalog(db, platform, tenantId);
    await configureFromSettings(platform, tenantId, location.id, 825, 'Journey receipt');

    const readiness = await request(platform, tenantId, 'GET', '/api/pos/readiness');
    expect(readiness.response.status).toBe(200);
    expect(readiness.body.data).toMatchObject({
      ready: true,
      operational: true,
      settings: { defaultLocationId: location.id, taxBps: 825 },
      tenders: { cash: { enabled: true }, external: { enabled: true } },
    });

    const opened = await request(platform, tenantId, 'POST', '/api/pos/drawer/open', {
      drawerRef: 'acceptance-drawer',
      registerRef: 'acceptance-register',
      openingFloatCents: 10_000,
      note: 'Acceptance open',
    });
    expect(opened.response.status).toBe(201);
    const cashSessionId = opened.body.data.session.id as string;

    const match = await catalogLookup(platform, tenantId);
    expect(match).toMatchObject({
      variationId: variation.id,
      unitPriceCents: 1_500,
      stock: { onHand: 10, reserved: 0, available: 10 },
    });
    const cart = cartFromMatch(match, 'acceptance-split-cart', 2, 825);
    expect(Cart.cartTotals(cart)).toMatchObject({
      subtotalCents: 3_000,
      taxCents: 248,
      totalCents: 3_248,
    });

    const created = await request(platform, tenantId, 'POST', '/api/pos/orders', {
      ...Cart.toOrderPayload(cart),
      registerId: 'acceptance-register',
      cashSessionId,
    });
    expect(created.response.status).toBe(201);
    expect(created.body.data).toMatchObject({
      status: 'reserved',
      total_cents: 3_248,
      cash_session_id: cashSessionId,
    });
    const orderId = created.body.data.id as string;
    const lineId = created.body.data.lines[0].id as string;

    const reservedLookup = await catalogLookup(platform, tenantId);
    expect(reservedLookup.stock).toMatchObject({ onHand: 10, reserved: 2, available: 8 });

    const tenders = Cart.buildTenderPlan(3_248, [
      { kind: 'cash', amountCents: 1_000, cashReceivedCents: 1_500 },
      {
        kind: 'external',
        amountCents: 2_248,
        provider: 'paper_voucher',
        providerRef: 'voucher-acceptance-1',
      },
    ], { keyFactory: (kind) => `acceptance-${kind}-tender` });
    const paid = await request(platform, tenantId, 'POST', `/api/pos/orders/${orderId}/pay`, {
      tenders,
    });
    expect(paid.response.status).toBe(200);
    expect(paid.body.data.status).toBe('paid');

    const receipt = await request(platform, tenantId, 'GET', `/api/pos/receipts/${orderId}`);
    expect(receipt.response.status).toBe(200);
    expect(receipt.body.data.merchant).toMatchObject({
      name: 'POS Journey Tenant',
      receiptFooter: 'Journey receipt',
      currency: 'USD',
    });
    expect(receipt.body.data.tenders).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'cash',
        amount_cents: 1_000,
        cash_received_cents: 1_500,
        change_due_cents: 500,
        status: 'captured',
      }),
      expect.objectContaining({
        kind: 'external',
        amount_cents: 2_248,
        provider: 'paper_voucher',
        provider_ref: 'voucher-acceptance-1',
        status: 'captured',
      }),
    ]));
    expect(receipt.body.data).toMatchObject({
      amountPaidCents: 3_248,
      amountRefundedCents: 0,
      netPaidCents: 3_248,
    });
    expect(receipt.body.data.order.lines[0]).toMatchObject({
      qty: 2,
      returned_qty: 0,
      pending_return_qty: 0,
      returnable_qty: 2,
    });

    const cashTender = receipt.body.data.tenders.find((row: Json) => row.kind === 'cash');
    const refunded = await request(platform, tenantId, 'POST', `/api/pos/orders/${orderId}/refunds`, {
      tenderId: cashTender.id,
      cashSessionId,
      idempotencyKey: 'acceptance-cash-refund',
      amountCents: 500,
      reason: 'Acceptance return',
      lines: [{ lineId, qty: 1, disposition: 'restock' }],
    });
    expect(refunded.response.status).toBe(201);
    expect(refunded.body.data.refund).toMatchObject({
      cash_session_id: cashSessionId,
      amount_cents: 500,
      status: 'completed',
    });

    const refundedReceipt = await request(platform, tenantId, 'GET', `/api/pos/receipts/${orderId}`);
    expect(refundedReceipt.body.data).toMatchObject({
      amountPaidCents: 3_248,
      amountRefundedCents: 500,
      netPaidCents: 2_748,
    });
    expect(refundedReceipt.body.data.refunds).toHaveLength(1);
    expect(refundedReceipt.body.data.order.lines[0]).toMatchObject({
      qty: 2,
      returned_qty: 1,
      pending_return_qty: 0,
      returnable_qty: 1,
    });

    const drawer = await request(
      platform,
      tenantId,
      'GET',
      '/api/pos/drawer?drawerRef=acceptance-drawer',
    );
    expect(drawer.body.data.reconciliation).toMatchObject({
      openingFloatCents: 10_000,
      cashSalesCents: 1_000,
      cashRefundsCents: 500,
      effectiveExpectedCents: 10_500,
      movementCount: 2,
    });

    const closed = await request(platform, tenantId, 'POST', `/api/pos/drawer/${cashSessionId}/close`, {
      countedCents: 10_500,
      note: 'Acceptance close',
    });
    expect(closed.response.status).toBe(200);
    expect(closed.body.data).toMatchObject({
      session: { status: 'closed' },
      reconciliation: { countedCents: 10_500, varianceCents: 0 },
    });
  });

  it('verified reader -> durable attempt -> signed Stripe webhook -> paid receipt -> processor refund', async () => {
    const stripe = stripeFixture();
    const { db, platform, tenantId } = await boot({
      checkoutProviders: [stripe.provider],
      posCardPresent: {
        provider: 'stripe_terminal',
        readerId: READER_ID,
        verify: async () => ({
          verified: true,
          readerId: READER_ID,
          status: 'online',
          checkedAt: '2026-09-03T12:00:00.000Z',
        }),
      },
    });
    const { location } = await seedRegisterCatalog(db, platform, tenantId);
    await configureFromSettings(platform, tenantId, location.id, 0, 'Card journey receipt');

    const readiness = await request(platform, tenantId, 'GET', '/api/pos/readiness');
    expect(readiness.body.data.tenders.cardPresent).toMatchObject({
      enabled: true,
      configured: true,
      provider: 'stripe_terminal',
      readerId: READER_ID,
      readerStatus: 'online',
      physicalReaderVerified: true,
    });

    const match = await catalogLookup(platform, tenantId);
    const cart = cartFromMatch(match, 'acceptance-card-cart', 2, 0);
    let registerState = Cart.createRegisterState({
      active: cart,
      registerId: 'acceptance-card-register',
      now: '2026-09-03T12:00:00.000Z',
    });
    registerState = Cart.setPendingCheckout(registerState, {
      paymentKind: 'card_present',
      orderId: null,
      cartId: cart.id,
      orderIdempotencyKey: 'acceptance-card-order-key',
      attemptIdempotencyKey: 'acceptance-card-attempt-key',
      attemptId: null,
      startedAt: '2026-09-03T12:00:00.000Z',
    });
    registerState = Cart.deserializeRegisterState(Cart.serializeRegisterState(registerState));
    expect(registerState.pendingCheckout).toMatchObject({
      paymentKind: 'card_present',
      orderId: null,
      attemptIdempotencyKey: 'acceptance-card-attempt-key',
    });

    const created = await request(platform, tenantId, 'POST', '/api/pos/orders', {
      ...Cart.toOrderPayload(registerState.active),
      registerId: registerState.registerId,
    }, { 'idempotency-key': 'acceptance-card-order-key' });
    expect(created.response.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'reserved', total_cents: 3_000 });
    const orderId = created.body.data.id as string;
    const lineId = created.body.data.lines[0].id as string;
    if (registerState.pendingCheckout?.paymentKind !== 'card_present') {
      throw new Error('card pending state was not restored');
    }
    registerState = Cart.setPendingCheckout(registerState, {
      ...registerState.pendingCheckout,
      orderId,
    });

    const started = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${orderId}/card-payments`,
      { idempotencyKey: 'acceptance-card-attempt-key' },
      { 'idempotency-key': 'acceptance-card-attempt-key' },
    );
    expect(started.response.status).toBe(201);
    expect(started.body.data).toMatchObject({
      attempt: {
        order_id: orderId,
        provider: 'stripe_terminal',
        reader_id: READER_ID,
        amount_cents: 3_000,
        idempotency_key: 'acceptance-card-attempt-key',
        status: 'processing',
      },
      terminal: {
        readerId: READER_ID,
        readerStatus: 'online',
        actionStatus: 'in_progress',
      },
    });
    const attemptId = started.body.data.attempt.id as string;
    if (registerState.pendingCheckout?.paymentKind !== 'card_present') {
      throw new Error('card pending state was lost');
    }
    registerState = Cart.setPendingCheckout(registerState, {
      ...registerState.pendingCheckout,
      attemptId,
    });
    expect(Cart.deserializeRegisterState(Cart.serializeRegisterState(registerState)).pendingCheckout)
      .toMatchObject({ orderId, attemptId, attemptIdempotencyKey: 'acceptance-card-attempt-key' });

    const processingReceipt = await request(platform, tenantId, 'GET', `/api/pos/receipts/${orderId}`);
    expect(processingReceipt.body.data).toMatchObject({
      order: { status: 'reserved' },
      tenders: [],
      amountPaidCents: 0,
    });
    const replay = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${orderId}/card-payments`,
      { idempotencyKey: 'acceptance-card-attempt-key' },
    );
    expect(replay.response.status).toBe(200);
    expect(replay.body).toMatchObject({ created: false, data: { attempt: { id: attemptId } } });
    expect(stripe.calls.filter((call) => call.url.endsWith('/v1/payment_intents'))).toHaveLength(1);

    const webhookBody = JSON.stringify({
      id: 'evt_pos_journey_paid',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: PAYMENT_INTENT_ID,
          status: 'succeeded',
          amount: 3_000,
          amount_received: 3_000,
          latest_charge: CHARGE_ID,
        },
      },
    });
    const webhook = await platform.app.request('/api/orders/webhooks/stripe_terminal', {
      method: 'POST',
      headers: {
        ...headers(tenantId),
        'stripe-signature': stripeSignatureHeader(WEBHOOK_SECRET, STRIPE_NOW, webhookBody),
      },
      body: webhookBody,
    });
    expect(webhook.status).toBe(200);
    expect(await body(webhook)).toMatchObject({ data: { outcome: 'paid', orderId } });

    const attempt = await request(platform, tenantId, 'GET', `/api/pos/payment-attempts/${attemptId}`);
    expect(attempt.body.data).toMatchObject({ id: attemptId, status: 'succeeded' });
    const paidReceipt = await request(platform, tenantId, 'GET', `/api/pos/receipts/${orderId}`);
    expect(paidReceipt.body.data).toMatchObject({
      order: { status: 'paid' },
      amountPaidCents: 3_000,
      amountRefundedCents: 0,
      netPaidCents: 3_000,
    });
    expect(paidReceipt.body.data.tenders).toHaveLength(1);
    expect(paidReceipt.body.data.tenders[0]).toMatchObject({
      kind: 'provider',
      provider: 'stripe_terminal',
      provider_ref: CHARGE_ID,
      amount_cents: 3_000,
      status: 'captured',
    });

    const refunded = await request(platform, tenantId, 'POST', `/api/pos/orders/${orderId}/refunds`, {
      tenderId: paidReceipt.body.data.tenders[0].id,
      idempotencyKey: 'acceptance-processor-refund-key',
      amountCents: 1_500,
      reason: 'Processor acceptance return',
      lines: [{ lineId, qty: 1, disposition: 'restock' }],
    });
    expect(refunded.response.status).toBe(201);
    expect(refunded.body.data.refund).toMatchObject({
      provider: 'stripe_terminal',
      provider_ref: 're_pos_journey',
      provider_status: 'succeeded',
      amount_cents: 1_500,
      status: 'completed',
    });
    const refundCalls = stripe.calls.filter((call) => call.url.endsWith('/v1/refunds'));
    expect(refundCalls).toHaveLength(1);
    expect(refundCalls[0].init.headers['Idempotency-Key']).toBe(
      `${tenantId}:acceptance-processor-refund-key`,
    );

    const finalReceipt = await request(platform, tenantId, 'GET', `/api/pos/receipts/${orderId}`);
    expect(finalReceipt.body.data).toMatchObject({
      amountPaidCents: 3_000,
      amountRefundedCents: 1_500,
      netPaidCents: 1_500,
    });
    expect(finalReceipt.body.data.refunds).toHaveLength(1);
  });
});

describe('card split acceptance', () => {
  it.each(['cash', 'cards', 'cancel', 'pending_cancel', 'retry_cancel'] as const)('collects card portions then %s, preserving exact balance through replays', async (completion) => {
    const stripe = stripeFixture(true, completion === 'pending_cancel', completion === 'retry_cancel');
    const { db, platform, tenantId } = await boot({ checkoutProviders: [stripe.provider],
      posCardPresent: { provider: 'stripe_terminal', readerId: READER_ID,
        verify: async () => ({ verified: true, readerId: READER_ID, status: 'online', checkedAt: '2026-09-06T00:00:00Z' }) } });
    const { location } = await seedRegisterCatalog(db, platform, tenantId);
    await configureFromSettings(platform, tenantId, location.id, 0, 'Split test');
    const opened = await request(platform, tenantId, 'POST', '/api/pos/drawer/open', {
      drawerRef: 'split-drawer', registerRef: 'split-register', openingFloatCents: 10_000,
    });
    const cashSessionId = opened.body.data.session.id;
    const match = await catalogLookup(platform, tenantId);
    const cart = cartFromMatch(match, `split-${completion}`, 2, 0);
    const created = await request(platform, tenantId, 'POST', '/api/pos/orders', {
      ...Cart.toOrderPayload(cart), registerId: 'split-register', cashSessionId,
    });
    const orderId = created.body.data.id;
    const start = (key: string, amountCents?: number) => request(platform, tenantId, 'POST',
      `/api/pos/orders/${orderId}/card-payments`, { idempotencyKey: key, amountCents });
    const complete = async (intent: string, amount: number, event: string, expected: string) => {
      const raw = JSON.stringify({ id: event, type: 'payment_intent.succeeded', data: { object: {
        id: intent, status: 'succeeded', amount, amount_received: amount, latest_charge: `ch_${intent}`,
      } } });
      const res = await request(platform, tenantId, 'POST', '/api/orders/webhooks/stripe_terminal',
        JSON.parse(raw), { 'Stripe-Signature': stripeSignatureHeader(WEBHOOK_SECRET, STRIPE_NOW, raw) });
      expect(res.response.status).toBe(200);
      expect(res.body.data.outcome).toBe(expected);
    };
    expect((await start('too-much', 3_001)).response.status).toBe(409);
    const first = await start('card-1', 1_000);
    expect(first.response.status).toBe(201);
    expect(first.body.data.attempt.amount_cents).toBe(1_000);
    expect((await start('card-1', 1_001)).response.status).toBe(409);
    expect((await start('concurrent', 1_000)).response.status).toBe(409);
    const other = await createTenant(asCoreDb(db), { name: 'Other split tenant' });
    await platform.seedTenant(other.id);
    expect((await request(platform, other.id, 'GET', `/api/pos/orders/${orderId}/balance`)).response.status).toBe(404);
    await complete(`${PAYMENT_INTENT_ID}_1`, 1_000, 'evt_split_1', 'partially_paid');
    await complete(`${PAYMENT_INTENT_ID}_1`, 1_000, 'evt_split_1', 'partially_paid');
    let balance = await request(platform, tenantId, 'GET', `/api/pos/orders/${orderId}/balance`);
    expect(balance.body.data).toMatchObject({ totalCents: 3_000, capturedCents: 1_000, remainingCents: 2_000, status: 'reserved' });
    expect(balance.body.data.tenders).toHaveLength(1);
    expect((await request(platform, tenantId, 'POST', `/api/pos/orders/${orderId}/cancel`, {})).response.status).toBe(409);
    expect((await catalogLookup(platform, tenantId)).stock).toMatchObject({ onHand: 10, reserved: 2 });
    expect((await request(platform, tenantId, 'POST', `/api/pos/drawer/${cashSessionId}/close`, { countedCents: 10_000 })).response.status).toBe(409);
    const interimFinance = await request(platform, tenantId, 'GET', '/api/pos/finance/summary');
    expect(interimFinance.response.status).toBe(200);
    expect((await start('card-1', 1_000)).body.data.attempt.status).toBe('succeeded');
    expect((await start('over-remaining', 2_001)).response.status).toBe(409);
    if (completion === 'cancel' || completion === 'pending_cancel' || completion === 'retry_cancel') {
      const cancelPath = `/api/pos/orders/${orderId}/cancel-split`;
      expect((await request(platform, other.id, 'POST', cancelPath, {})).response.status).toBe(404);
      expect((await start('card-2', 750)).response.status).toBe(201);
      expect((await request(platform, tenantId, 'POST', cancelPath, {})).response.status).toBe(409);
      expect(stripe.calls.filter((call) => call.url.endsWith('/v1/refunds'))).toHaveLength(0);
      await complete(`${PAYMENT_INTENT_ID}_2`, 750, 'evt_split_2', 'partially_paid');
      const canceled = await request(platform, tenantId, 'POST', cancelPath, {});
      expect(canceled.response.status).toBe(completion === 'cancel' ? 200 : completion === 'retry_cancel' ? 502 : 202);
      if (completion === 'retry_cancel') {
        expect((await start('after-ambiguous-refund', 500)).response.status).toBe(409);
        expect((await request(platform, tenantId, 'POST', cancelPath, {})).response.status).toBe(200);
      }
      if (completion === 'pending_cancel') {
        expect((await start('after-cancellation', 500)).response.status).toBe(409);
        expect((await request(platform, tenantId, 'POST', `/api/pos/orders/${orderId}/pay`, {
          tenders: [{ kind: 'cash', amountCents: 1_250, idempotencyKey: 'cancellation-race' }],
        })).response.status).toBe(409);
        const snapshot = await request(platform, tenantId, 'GET', `/api/pos/orders/${orderId}/balance`);
        expect(snapshot.body.data).toMatchObject({ cancellationStarted: true, refundedCents: 0, netPaidCents: 1_750 });
        expect((await catalogLookup(platform, tenantId)).stock).toMatchObject({ onHand: 10, reserved: 2 });
        for (const [index, amount] of [[1, 1_000], [2, 750]]) {
          const intent = `${PAYMENT_INTENT_ID}_${index}`;
          const raw = JSON.stringify({ id: `evt_refund_split_${index}`, type: 'refund.updated', data: { object: {
            id: `re_${intent}`, object: 'refund', status: 'succeeded', amount, payment_intent: intent,
          } } });
          for (let replay = 0; replay < 2; replay++) {
            const response = await request(platform, tenantId, 'POST', '/api/orders/webhooks/stripe_terminal',
              JSON.parse(raw), { 'Stripe-Signature': stripeSignatureHeader(WEBHOOK_SECRET, STRIPE_NOW, raw) });
            expect(response.response.status).toBe(200);
            expect(response.body.data.outcome).toBe('refund_completed');
          }
        }
      }
      expect((await request(platform, tenantId, 'POST', cancelPath, {})).response.status).toBe(200);
      const refundCalls = stripe.calls.filter((call) => call.url.endsWith('/v1/refunds'));
      expect(refundCalls).toHaveLength(completion === 'retry_cancel' ? 3 : 2);
      if (completion === 'retry_cancel') {
        expect(refundCalls[0].init.headers['Idempotency-Key']).toBe(refundCalls[1].init.headers['Idempotency-Key']);
      }
      expect(refundCalls.slice(completion === 'retry_cancel' ? 1 : 0).map((call) => new URLSearchParams(call.init.body).get('payment_intent')))
        .toEqual([`${PAYMENT_INTENT_ID}_1`, `${PAYMENT_INTENT_ID}_2`]);
      expect((await request(platform, tenantId, 'GET', `/api/pos/orders/${orderId}/balance`)).body.data)
        .toMatchObject({ status: 'canceled', capturedCents: 1_750, refundedCents: 1_750, netPaidCents: 0 });
      expect((await catalogLookup(platform, tenantId)).stock).toMatchObject({ onHand: 10, reserved: 0 });
      const canceledReceipt = await request(platform, tenantId, 'GET', `/api/pos/receipts/${orderId}`);
      expect(canceledReceipt.body.data.netPaidCents).toBe(0);
      expect(canceledReceipt.body.data.refunds).toHaveLength(2);
      expect((await request(platform, tenantId, 'GET', '/api/pos/reconciliation')).body.data)
        .toMatchObject({ healthy: true, pendingCount: 0, errorCount: 0 });
      expect((await request(platform, tenantId, 'POST', `/api/pos/drawer/${cashSessionId}/close`, { countedCents: 10_000 })).response.status).toBe(200);
      return;
    }
    if (completion === 'cards') {
      expect((await start('card-2', 750)).response.status).toBe(201);
      await complete(`${PAYMENT_INTENT_ID}_2`, 750, 'evt_split_2', 'partially_paid');
      const last = await start('card-3');
      expect(last.body.data.attempt.amount_cents).toBe(1_250);
      await complete(`${PAYMENT_INTENT_ID}_3`, 1_250, 'evt_split_3', 'paid');
    } else {
      const plan = { tenders: [{ kind: 'cash', amountCents: 2_000, cashReceivedCents: 2_500, idempotencyKey: 'split-cash' }] };
      const paid = await request(platform, tenantId, 'POST', `/api/pos/orders/${orderId}/pay`, plan);
      expect(paid.response.status).toBe(200);
      expect((await request(platform, tenantId, 'POST', `/api/pos/orders/${orderId}/pay`, plan)).response.status).toBe(200);
      const closed = await request(platform, tenantId, 'POST', `/api/pos/drawer/${cashSessionId}/close`, { countedCents: 12_000 });
      expect(closed.body.data.reconciliation.varianceCents).toBe(0);
    }
    balance = await request(platform, tenantId, 'GET', `/api/pos/orders/${orderId}/balance`);
    expect(balance.body.data).toMatchObject({ capturedCents: 3_000, remainingCents: 0, status: 'paid' });
    expect(balance.body.data.tenders).toHaveLength(completion === 'cash' ? 2 : 3);
    expect((await catalogLookup(platform, tenantId)).stock).toMatchObject({ onHand: 8, reserved: 0 });
    const receipt = await request(platform, tenantId, 'GET', `/api/pos/receipts/${orderId}`);
    expect(receipt.body.data).toMatchObject({ amountPaidCents: 3_000, netPaidCents: 3_000 });
    if (completion === 'cards') {
      const firstTender = balance.body.data.tenders.find((t: Json) => t.provider_ref === `ch_${PAYMENT_INTENT_ID}_1`);
      const refund = await request(platform, tenantId, 'POST', `/api/pos/orders/${orderId}/refunds`, {
        tenderId: firstTender.id, amountCents: 500, idempotencyKey: 'first-card-refund',
        lines: [{ lineId: created.body.data.lines[0].id, qty: 1, disposition: 'none' }],
      });
      expect(refund.response.status).toBe(201);
      const refundCall = stripe.calls.find((call) => call.url.endsWith('/v1/refunds'))!;
      expect(new URLSearchParams(refundCall.init.body).get('payment_intent')).toBe(`${PAYMENT_INTENT_ID}_1`);
      const after = await request(platform, tenantId, 'GET', `/api/pos/receipts/${orderId}`);
      expect(after.body.data.netPaidCents).toBe(2_500);
    }
    expect((await request(platform, tenantId, 'GET', '/api/pos/reconciliation')).body.data).toMatchObject({ healthy: true, pendingCount: 0, errorCount: 0 });
  });
});
