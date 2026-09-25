import { describe, expect, it } from 'vitest';
import { asCoreDb, createTenant, createUser, id, nowIso } from '@blacklabel/core';
import { createTestDb } from '@blacklabel/db';
import {
  createProduct,
  createVariation,
  type CatalogDatabase,
} from '@blacklabel/catalog';
import {
  applyMovement,
  createLocation,
  getStock,
  type InventoryDatabase,
} from '@blacklabel/inventory';
import type {
  CancelSessionInput,
  CheckoutOrderSnapshot,
  CheckoutProvider,
} from '@blacklabel/orders';
import type { WorkforceDatabase } from '@blacklabel/workforce';
import {
  createApp,
  type CreateAppOptions,
  type PlatformDatabase,
} from '../src/app';

const KEY = Buffer.alloc(32, 19);
const CHECKED_AT = '2026-09-03T12:00:00.000Z';

type Platform = Awaited<ReturnType<typeof createApp>>;
type Json = Record<string, any>;

const inv = (db: unknown) => db as import('kysely').Kysely<InventoryDatabase>;
const cat = (db: unknown) => db as import('kysely').Kysely<CatalogDatabase>;

function headers(tenantId: string): Record<string, string> {
  return {
    'x-tenant-id': tenantId,
    'x-mags-csrf': '1',
    'content-type': 'application/json',
  };
}

async function json(response: Response): Promise<Json> {
  return (await response.json()) as Json;
}

async function request(
  platform: Platform,
  tenantId: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return platform.app.request(path, {
    method,
    headers: { ...headers(tenantId), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function assignCashier(db: unknown, tenantId: string): Promise<string> {
  const workforce = db as import('kysely').Kysely<WorkforceDatabase>;
  const user = await createUser(asCoreDb(db as never), tenantId, {
    name: 'POS facade cashier',
    email: 'pos-facade-cashier@local.invalid',
    role: 'member',
  });
  const role = await workforce
    .selectFrom('workforce_roles')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('key', '=', 'cashier')
    .executeTakeFirstOrThrow();
  await workforce
    .insertInto('workforce_user_roles')
    .values({
      id: id(),
      tenant_id: tenantId,
      user_id: user.id,
      role_id: role.id,
      created_at: nowIso(),
    })
    .execute();
  return user.id;
}

async function boot(options: Partial<CreateAppOptions> = {}) {
  const db = createTestDb<PlatformDatabase>();
  const platform = await createApp({ db, adminMasterKey: KEY, ...options });
  const tenant = await createTenant(asCoreDb(db), { name: 'POS Payment Facade Tenant' });
  await platform.seedTenant(tenant.id);
  return { db, platform, tenantId: tenant.id };
}

async function addLocation(db: unknown, tenantId: string, name: string) {
  return createLocation(inv(db), tenantId, 'owner', {
    name,
    kind: 'warehouse',
    oversellPolicy: 'deny',
  });
}

async function addTrackedVariation(
  db: unknown,
  platform: Platform,
  tenantId: string,
  locationId: string,
  key: string,
  priceCents: number,
  onHand: number,
) {
  const product = await createProduct(cat(db), tenantId, 'owner', {
    sourceItemId: `item-${key}`,
    name: `Product ${key}`,
  });
  const variation = await createVariation(cat(db), tenantId, 'owner', platform.events, {
    productId: product.id,
    sourceVariationId: `variation-${key}`,
    name: 'Default',
    sku: `SKU-${key}`,
    priceCents,
    trackInventory: true,
  });
  if (onHand > 0) {
    await applyMovement(inv(db), platform.events, tenantId, 'owner', {
      variationId: variation.id,
      locationId,
      delta: onHand,
      reason: 'received',
    });
  }
  return variation;
}

async function configure(
  platform: Platform,
  tenantId: string,
  defaultLocationId: string,
): Promise<void> {
  const response = await request(platform, tenantId, 'PUT', '/api/pos/settings', {
    defaultLocationId,
    taxBps: 0,
    receiptFooter: 'Payment facade receipt',
  });
  expect(response.status).toBe(200);
}

async function openDrawer(
  platform: Platform,
  tenantId: string,
  input: {
    drawerRef: string;
    registerRef: string;
    openingFloatCents?: number;
  },
) {
  const response = await request(platform, tenantId, 'POST', '/api/pos/drawer/open', {
    ...input,
    openingFloatCents: input.openingFloatCents ?? 10_000,
  });
  expect(response.status).toBe(201);
  return (await json(response)).data as Json;
}

async function createPosOrder(
  platform: Platform,
  tenantId: string,
  input: {
    cartId: string;
    totalCents?: number;
    qty?: number;
    cashSessionId?: string;
    registerId?: string;
  },
): Promise<{ response: Response; body: Json }> {
  const response = await request(platform, tenantId, 'POST', '/api/pos/orders', {
    cartId: input.cartId,
    registerId: input.registerId ?? 'register-main',
    ...(input.cashSessionId ? { cashSessionId: input.cashSessionId } : {}),
    taxBps: 0,
    lines: [
      {
        description: 'Deterministic test item',
        qty: input.qty ?? 1,
        unitPriceCents: input.totalCents ?? 2_000,
      },
    ],
  });
  return { response, body: await json(response) };
}

function cashPlan(
  amountCents: number,
  idempotencyKey: string,
  cashReceivedCents = amountCents,
) {
  return {
    tenders: [
      {
        kind: 'cash',
        amountCents,
        cashReceivedCents,
        idempotencyKey,
      },
    ],
  };
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function terminalFake(
  beforeReturn?: (order: CheckoutOrderSnapshot, invocation: number) => Promise<void>,
  beforeCancel?: (input: CancelSessionInput, invocation: number) => Promise<void>,
) {
  const creates: CheckoutOrderSnapshot[] = [];
  const cancels: CancelSessionInput[] = [];
  const provider: CheckoutProvider = {
    key: 'stripe_terminal',
    async createSession(order) {
      creates.push(order);
      await beforeReturn?.(order, creates.length);
      return {
        providerSessionRef: `pi_${order.paymentAttemptId}`,
        flow: 'terminal',
        terminal: {
          readerId: order.readerId ?? 'missing-reader',
          readerStatus: 'online',
          actionStatus: 'in_progress',
        },
      };
    },
    verifyWebhook() {
      return { valid: false, event: { id: 'evt_unused', type: 'unused' } };
    },
    parseCompletion() {
      return {
        providerSessionRef: 'pi_unused',
        amountCents: 0,
        tenderRef: 'ch_unused',
      };
    },
    async cancelSession(input) {
      cancels.push(input);
      await beforeCancel?.(input, cancels.length);
    },
  };
  return { provider, creates, cancels };
}

describe('POS cash payment facade', () => {
  it('records over-tendered cash once, returns change, and reconciles the drawer from the ledger', async () => {
    const { db, platform, tenantId } = await boot();
    const location = await addLocation(db, tenantId, 'Main store');
    await configure(platform, tenantId, location.id);
    const drawer = await openDrawer(platform, tenantId, {
      drawerRef: 'drawer-main',
      registerRef: 'register-main',
    });
    const sale = await createPosOrder(platform, tenantId, {
      cartId: 'cash-over-tender',
      cashSessionId: drawer.session.id,
      totalCents: 2_000,
    });
    expect(sale.response.status).toBe(201);

    const plan = cashPlan(2_000, 'cash-payment-1', 3_000);
    const paidResponse = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${sale.body.data.id}/pay`,
      plan,
    );
    expect(paidResponse.status).toBe(200);
    const paid = await json(paidResponse);
    expect(paid.created).toBe(true);
    expect(paid.data.status).toBe('paid');

    const receiptResponse = await request(
      platform,
      tenantId,
      'GET',
      `/api/pos/receipts/${sale.body.data.id}`,
    );
    expect(receiptResponse.status).toBe(200);
    const receipt = (await json(receiptResponse)).data;
    expect(receipt.order.receipt_number).toMatch(/^BL-\d{8}-/);
    expect(receipt.tenders).toHaveLength(1);
    expect(receipt.tenders[0]).toMatchObject({
      kind: 'cash',
      amount_cents: 2_000,
      cash_received_cents: 3_000,
      change_due_cents: 1_000,
      idempotency_key: 'cash-payment-1',
      status: 'captured',
    });
    expect(receipt).toMatchObject({
      amountPaidCents: 2_000,
      amountRefundedCents: 0,
      netPaidCents: 2_000,
    });

    const drawerResponse = await request(
      platform,
      tenantId,
      'GET',
      '/api/pos/drawer?drawerRef=drawer-main',
    );
    expect(drawerResponse.status).toBe(200);
    const afterSale = (await json(drawerResponse)).data;
    expect(afterSale.reconciliation).toMatchObject({
      openingFloatCents: 10_000,
      cashSalesCents: 2_000,
      cashRefundsCents: 0,
      movementCount: 1,
      effectiveExpectedCents: 12_000,
    });
    expect(afterSale.movements).toHaveLength(1);
    expect(afterSale.movements[0]).toMatchObject({
      kind: 'cash_sale',
      amount_cents: 2_000,
      tender_ref: receipt.tenders[0].id,
      order_ref: sale.body.data.id,
    });

    const replayResponse = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${sale.body.data.id}/pay`,
      plan,
    );
    expect(replayResponse.status).toBe(200);
    expect((await json(replayResponse)).created).toBe(false);
    const replayDrawer = await json(
      await request(platform, tenantId, 'GET', '/api/pos/drawer?drawerRef=drawer-main'),
    );
    expect(replayDrawer.data.reconciliation.movementCount).toBe(1);
    expect(replayDrawer.data.reconciliation.effectiveExpectedCents).toBe(12_000);

    const mismatch = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${sale.body.data.id}/pay`,
      cashPlan(2_000, 'cash-payment-1', 3_100),
    );
    expect(mismatch.status).toBe(409);
  });

  it('rejects duplicate tender keys, card-like manual sources, and external tenders without evidence', async () => {
    const { db, platform, tenantId } = await boot();
    const location = await addLocation(db, tenantId, 'Main store');
    await configure(platform, tenantId, location.id);
    const drawer = await openDrawer(platform, tenantId, {
      drawerRef: 'drawer-validation',
      registerRef: 'register-main',
    });

    const duplicate = await createPosOrder(platform, tenantId, {
      cartId: 'duplicate-plan',
      cashSessionId: drawer.session.id,
      totalCents: 2_000,
    });
    const duplicateResponse = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${duplicate.body.data.id}/pay`,
      {
        tenders: [
          { kind: 'cash', amountCents: 1_000, idempotencyKey: 'duplicate-key' },
          {
            kind: 'external',
            amountCents: 1_000,
            provider: 'paper_voucher',
            providerRef: 'voucher-1',
            idempotencyKey: 'duplicate-key',
          },
        ],
      },
    );
    expect(duplicateResponse.status).toBe(400);

    for (const [cartId, tender] of [
      [
        'manual-card',
        {
          kind: 'external',
          amountCents: 2_000,
          provider: 'stripe_terminal',
          providerRef: 'pi_forged',
          idempotencyKey: 'external-card-key',
        },
      ],
      [
        'external-no-ref',
        {
          kind: 'external',
          amountCents: 2_000,
          provider: 'paper_voucher',
          idempotencyKey: 'missing-ref-key',
        },
      ],
      [
        'external-no-source',
        {
          kind: 'external',
          amountCents: 2_000,
          providerRef: 'voucher-2',
          idempotencyKey: 'missing-source-key',
        },
      ],
    ] as const) {
      const sale = await createPosOrder(platform, tenantId, { cartId, totalCents: 2_000 });
      const response = await request(
        platform,
        tenantId,
        'POST',
        `/api/pos/orders/${sale.body.data.id}/pay`,
        { tenders: [tender] },
      );
      expect(response.status, cartId).toBe(400);
      const receipt = await json(
        await request(platform, tenantId, 'GET', `/api/pos/receipts/${sale.body.data.id}`),
      );
      expect(receipt.data.tenders, cartId).toEqual([]);
    }
  });

  it('fails closed for a missing, closed, wrong-register, or wrong-location cash drawer', async () => {
    const { db, platform, tenantId } = await boot();
    const main = await addLocation(db, tenantId, 'Main store');
    const remote = await addLocation(db, tenantId, 'Remote store');
    await configure(platform, tenantId, main.id);

    const missing = await createPosOrder(platform, tenantId, {
      cartId: 'missing-drawer',
      totalCents: 2_000,
    });
    const missingPay = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${missing.body.data.id}/pay`,
      cashPlan(2_000, 'missing-drawer-pay'),
    );
    expect(missingPay.status).toBe(400);

    const drawer = await openDrawer(platform, tenantId, {
      drawerRef: 'drawer-scope',
      registerRef: 'register-main',
    });
    const wrongRegister = await createPosOrder(platform, tenantId, {
      cartId: 'wrong-register',
      cashSessionId: drawer.session.id,
      registerId: 'register-other',
      totalCents: 2_000,
    });
    expect(wrongRegister.response.status).toBe(409);

    const closeable = await createPosOrder(platform, tenantId, {
      cartId: 'closed-drawer',
      cashSessionId: drawer.session.id,
      totalCents: 2_000,
    });
    expect(closeable.response.status).toBe(201);
    const closed = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/drawer/${drawer.session.id}/close`,
      { countedCents: 10_000 },
    );
    expect(closed.status).toBe(200);
    const closedPay = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${closeable.body.data.id}/pay`,
      cashPlan(2_000, 'closed-drawer-pay'),
    );
    expect(closedPay.status).toBe(409);

    const remoteDrawer = await openDrawer(platform, tenantId, {
      drawerRef: 'drawer-remote',
      registerRef: 'register-main',
    });
    await configure(platform, tenantId, remote.id);
    const wrongLocation = await createPosOrder(platform, tenantId, {
      cartId: 'wrong-location',
      cashSessionId: remoteDrawer.session.id,
      totalCents: 2_000,
    });
    expect(wrongLocation.response.status).toBe(409);
  });
});

describe('POS cash refund facade', () => {
  it('funds a cash refund from the current drawer once and reflects it in receipt and reconciliation', async () => {
    const { db, platform, tenantId } = await boot();
    const location = await addLocation(db, tenantId, 'Main store');
    await configure(platform, tenantId, location.id);
    const drawer = await openDrawer(platform, tenantId, {
      drawerRef: 'drawer-refunds',
      registerRef: 'register-main',
    });
    const sale = await createPosOrder(platform, tenantId, {
      cartId: 'refundable-cash',
      cashSessionId: drawer.session.id,
      totalCents: 1_000,
      qty: 2,
    });
    expect(sale.body.data.total_cents).toBe(2_000);
    expect(
      (
        await request(
          platform,
          tenantId,
          'POST',
          `/api/pos/orders/${sale.body.data.id}/pay`,
          cashPlan(2_000, 'refund-sale-tender', 2_500),
        )
      ).status,
    ).toBe(200);
    const initialReceipt = await json(
      await request(platform, tenantId, 'GET', `/api/pos/receipts/${sale.body.data.id}`),
    );
    const refundPayload = {
      tenderId: initialReceipt.data.tenders[0].id,
      cashSessionId: drawer.session.id,
      idempotencyKey: 'cash-refund-1',
      amountCents: 500,
      reason: 'Customer return',
      lines: [
        {
          lineId: initialReceipt.data.order.lines[0].id,
          qty: 1,
          disposition: 'none',
        },
      ],
    };

    const refundResponse = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${sale.body.data.id}/refunds`,
      refundPayload,
    );
    expect(refundResponse.status, JSON.stringify(await refundResponse.clone().json())).toBe(201);
    const refunded = await json(refundResponse);
    expect(refunded.created).toBe(true);
    expect(refunded.data.refund).toMatchObject({
      cash_session_id: drawer.session.id,
      idempotency_key: 'cash-refund-1',
      amount_cents: 500,
      status: 'completed',
    });

    const replayResponse = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${sale.body.data.id}/refunds`,
      refundPayload,
    );
    expect(replayResponse.status).toBe(200);
    const replay = await json(replayResponse);
    expect(replay.created).toBe(false);
    expect(replay.data.refund.id).toBe(refunded.data.refund.id);

    const mismatchedReplay = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${sale.body.data.id}/refunds`,
      { ...refundPayload, amountCents: 501 },
    );
    expect(mismatchedReplay.status).toBe(409);
    const duplicateLines = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${sale.body.data.id}/refunds`,
      {
        ...refundPayload,
        idempotencyKey: 'duplicate-refund-lines',
        lines: [refundPayload.lines[0], refundPayload.lines[0]],
      },
    );
    expect(duplicateLines.status).toBe(400);

    const receipt = await json(
      await request(platform, tenantId, 'GET', `/api/pos/receipts/${sale.body.data.id}`),
    );
    expect(receipt.data.refunds).toHaveLength(1);
    expect(receipt.data).toMatchObject({
      amountPaidCents: 2_000,
      amountRefundedCents: 500,
      netPaidCents: 1_500,
    });
    const drawerAfter = await json(
      await request(platform, tenantId, 'GET', '/api/pos/drawer?drawerRef=drawer-refunds'),
    );
    expect(drawerAfter.data.reconciliation).toMatchObject({
      openingFloatCents: 10_000,
      cashSalesCents: 2_000,
      cashRefundsCents: 500,
      movementCount: 2,
      effectiveExpectedCents: 11_500,
    });
    expect(drawerAfter.data.movements.filter((row: Json) => row.kind === 'cash_refund')).toHaveLength(1);
  });

  it('rejects cash refunds funded by a closed or wrong-location drawer', async () => {
    const { db, platform, tenantId } = await boot();
    const main = await addLocation(db, tenantId, 'Main store');
    const remote = await addLocation(db, tenantId, 'Remote store');
    await configure(platform, tenantId, main.id);
    const saleDrawer = await openDrawer(platform, tenantId, {
      drawerRef: 'drawer-sale',
      registerRef: 'register-main',
    });
    const sale = await createPosOrder(platform, tenantId, {
      cartId: 'refund-drawer-scope',
      cashSessionId: saleDrawer.session.id,
      totalCents: 1_000,
      qty: 2,
    });
    await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${sale.body.data.id}/pay`,
      cashPlan(2_000, 'refund-scope-sale'),
    );
    const receipt = await json(
      await request(platform, tenantId, 'GET', `/api/pos/receipts/${sale.body.data.id}`),
    );
    const baseRefund = {
      tenderId: receipt.data.tenders[0].id,
      amountCents: 500,
      lines: [{ lineId: receipt.data.order.lines[0].id, qty: 1, disposition: 'none' }],
    };

    const closed = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/drawer/${saleDrawer.session.id}/close`,
      { countedCents: 12_000 },
    );
    expect(closed.status).toBe(200);
    const closedRefund = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${sale.body.data.id}/refunds`,
      {
        ...baseRefund,
        cashSessionId: saleDrawer.session.id,
        idempotencyKey: 'closed-refund',
      },
    );
    expect(closedRefund.status).toBe(409);

    await configure(platform, tenantId, remote.id);
    const remoteDrawer = await openDrawer(platform, tenantId, {
      drawerRef: 'drawer-wrong-location',
      registerRef: 'register-main',
    });
    await configure(platform, tenantId, main.id);
    const wrongDrawerRefund = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${sale.body.data.id}/refunds`,
      {
        ...baseRefund,
        cashSessionId: remoteDrawer.session.id,
        idempotencyKey: 'wrong-drawer-refund',
      },
    );
    expect(wrongDrawerRefund.status).toBe(409);
  });
});

describe('POS inventory reservation recovery', () => {
  it('coalesces simultaneous identical carts into one claimed reserved order and reservation', async () => {
    const { db, platform, tenantId } = await boot();
    const location = await addLocation(db, tenantId, 'Same-cart race store');
    await configure(platform, tenantId, location.id);
    const variation = await addTrackedVariation(
      db,
      platform,
      tenantId,
      location.id,
      'same-cart-race',
      2_000,
      5,
    );
    const payload = {
      cartId: 'simultaneous-identical-cart',
      registerId: 'register-main',
      taxBps: 0,
      lines: [{ variationId: variation.id, qty: 1 }],
    };

    const responses = await Promise.all([
      request(platform, tenantId, 'POST', '/api/pos/orders', payload),
      request(platform, tenantId, 'POST', '/api/pos/orders', payload),
    ]);
    const bodies = await Promise.all(responses.map((response) => json(response)));
    expect(
      responses.map((response) => response.status).sort(),
      JSON.stringify(bodies),
    ).toEqual([200, 201]);
    expect(bodies.map((body) => body.created).sort()).toEqual([false, true]);
    expect(new Set(bodies.map((body) => body.data.id)).size).toBe(1);
    expect(bodies.every((body) => body.data.status === 'reserved')).toBe(true);
    const orderId = bodies[0].data.id as string;

    const orders = await db
      .selectFrom('orders_orders')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('source_order_id', '=', `pos:${payload.cartId}`)
      .execute();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ id: orderId, status: 'reserved' });
    const claims = await db
      .selectFrom('api_pos_order_claims')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('cart_id', '=', payload.cartId)
      .execute();
    expect(claims).toHaveLength(1);
    expect(claims[0].order_id).toBe(orderId);
    const reservations = await db
      .selectFrom('inventory_reservations')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('ref_type', '=', 'order')
      .where('ref_id', '=', orderId)
      .execute();
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      variation_id: variation.id,
      location_id: location.id,
      qty: 1,
      status: 'active',
    });
    const [stock] = await getStock(inv(db), tenantId, {
      variationId: variation.id,
      locationId: location.id,
    });
    expect(stock).toMatchObject({ onHand: 5, reserved: 1, available: 4 });
  });

  it('retries an all-or-nothing multi-line reservation before allowing the paid inventory transition', async () => {
    const { db, platform, tenantId } = await boot();
    const location = await addLocation(db, tenantId, 'Reservation store');
    await configure(platform, tenantId, location.id);
    const stocked = await addTrackedVariation(
      db,
      platform,
      tenantId,
      location.id,
      'reservation-stocked',
      1_000,
      2,
    );
    const initiallyEmpty = await addTrackedVariation(
      db,
      platform,
      tenantId,
      location.id,
      'reservation-empty',
      1_500,
      0,
    );
    const orderPayload = {
      cartId: 'multi-line-reservation-retry',
      registerId: 'register-main',
      taxBps: 0,
      lines: [
        { variationId: stocked.id, qty: 1 },
        { variationId: initiallyEmpty.id, qty: 1 },
      ],
    };

    const failed = await request(platform, tenantId, 'POST', '/api/pos/orders', orderPayload);
    expect(failed.status).toBe(409);
    const draft = await db
      .selectFrom('orders_orders')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('source_order_id', '=', `pos:${orderPayload.cartId}`)
      .executeTakeFirstOrThrow();
    expect(draft.status).toBe('draft');
    const afterFailure = await db
      .selectFrom('inventory_reservations')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('ref_type', '=', 'order')
      .where('ref_id', '=', draft.id)
      .execute();
    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0]).toMatchObject({
      variation_id: stocked.id,
      status: 'released',
    });
    const [stockedAfterFailure] = await getStock(inv(db), tenantId, {
      variationId: stocked.id,
      locationId: location.id,
    });
    expect(stockedAfterFailure).toMatchObject({ onHand: 2, reserved: 0, available: 2 });

    await applyMovement(inv(db), platform.events, tenantId, 'owner', {
      variationId: initiallyEmpty.id,
      locationId: location.id,
      delta: 2,
      reason: 'received',
    });
    const retry = await request(platform, tenantId, 'POST', '/api/pos/orders', orderPayload);
    expect(retry.status).toBe(200);
    const retried = await json(retry);
    expect(retried).toMatchObject({ created: false, data: { id: draft.id, status: 'reserved' } });

    const readyReservations = await db
      .selectFrom('inventory_reservations')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('ref_type', '=', 'order')
      .where('ref_id', '=', draft.id)
      .execute();
    expect(readyReservations.filter((row) => row.status === 'released')).toHaveLength(1);
    expect(readyReservations.filter((row) => row.status === 'active')).toHaveLength(2);
    const [stockedReady] = await getStock(inv(db), tenantId, {
      variationId: stocked.id,
      locationId: location.id,
    });
    const [emptyReady] = await getStock(inv(db), tenantId, {
      variationId: initiallyEmpty.id,
      locationId: location.id,
    });
    expect(stockedReady).toMatchObject({ onHand: 2, reserved: 1, available: 1 });
    expect(emptyReady).toMatchObject({ onHand: 2, reserved: 1, available: 1 });

    const paymentPlan = {
      tenders: [
        {
          kind: 'external',
          amountCents: 2_500,
          provider: 'paper_voucher',
          providerRef: 'voucher-multi-line',
          idempotencyKey: 'multi-line-payment',
        },
      ],
    };
    const paidResponse = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${draft.id}/pay`,
      paymentPlan,
    );
    expect(paidResponse.status).toBe(200);
    expect((await json(paidResponse)).data.status).toBe('paid');
    const paymentReplay = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${draft.id}/pay`,
      paymentPlan,
    );
    expect(paymentReplay.status).toBe(200);
    expect((await json(paymentReplay)).created).toBe(false);

    const [stockedPaid] = await getStock(inv(db), tenantId, {
      variationId: stocked.id,
      locationId: location.id,
    });
    const [emptyPaid] = await getStock(inv(db), tenantId, {
      variationId: initiallyEmpty.id,
      locationId: location.id,
    });
    expect(stockedPaid).toMatchObject({ onHand: 1, reserved: 0, available: 1 });
    expect(emptyPaid).toMatchObject({ onHand: 1, reserved: 0, available: 1 });
    const finalReservations = await db
      .selectFrom('inventory_reservations')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('ref_type', '=', 'order')
      .where('ref_id', '=', draft.id)
      .execute();
    expect(finalReservations.filter((row) => row.status === 'released')).toHaveLength(1);
    expect(finalReservations.filter((row) => row.status === 'converted')).toHaveLength(2);
  });
});

describe('POS order transition races', () => {
  it('commits exactly one terminal outcome when manual pay races order cancellation', async () => {
    const { db, platform, tenantId } = await boot();
    const location = await addLocation(db, tenantId, 'Transition store');
    await configure(platform, tenantId, location.id);
    const sale = await createPosOrder(platform, tenantId, {
      cartId: 'manual-pay-vs-cancel',
      totalCents: 2_000,
    });
    expect(sale.response.status).toBe(201);

    const [paidResponse, canceledResponse] = await Promise.all([
      request(
        platform,
        tenantId,
        'POST',
        `/api/pos/orders/${sale.body.data.id}/pay`,
        {
          tenders: [
            {
              kind: 'external',
              amountCents: 2_000,
              provider: 'paper_voucher',
              providerRef: 'pay-cancel-voucher',
              idempotencyKey: 'pay-cancel-tender',
            },
          ],
        },
      ),
      request(
        platform,
        tenantId,
        'POST',
        `/api/orders/orders/${sale.body.data.id}/cancel`,
      ),
    ]);
    expect([paidResponse.status, canceledResponse.status].sort()).toEqual([200, 409]);

    const receipt = await json(
      await request(platform, tenantId, 'GET', `/api/pos/receipts/${sale.body.data.id}`),
    );
    if (paidResponse.status === 200) {
      expect(canceledResponse.status).toBe(409);
      expect(receipt.data.order.status).toBe('paid');
      expect(receipt.data.tenders).toHaveLength(1);
      expect(receipt.data.tenders[0]).toMatchObject({
        idempotency_key: 'pay-cancel-tender',
        status: 'captured',
      });
      expect(receipt.data.amountPaidCents).toBe(2_000);
    } else {
      expect(paidResponse.status).toBe(409);
      expect(canceledResponse.status).toBe(200);
      expect(receipt.data.order.status).toBe('canceled');
      expect(receipt.data.tenders).toEqual([]);
      expect(receipt.data.amountPaidCents).toBe(0);
    }
  });
});

describe('POS card-present facade', () => {
  it('blocks cashier raw creation and rejects unclaimed generic channel-pos orders at the POS facade', async () => {
    const fake = terminalFake();
    const { db, platform, tenantId } = await boot({
      checkoutProviders: [fake.provider],
      posCardPresent: {
        provider: 'stripe_terminal',
        readerId: 'tmr_server_owned',
        verify: async () => ({
          verified: true,
          readerId: 'tmr_server_owned',
          status: 'online',
          checkedAt: CHECKED_AT,
        }),
      },
    });
    const location = await addLocation(db, tenantId, 'Main store');
    await configure(platform, tenantId, location.id);
    const cashierId = await assignCashier(db, tenantId);
    const cashier = { 'x-user-id': cashierId };

    const forgedOrder = {
      channel: 'pos',
      registerId: 'register-main',
      taxBps: 0,
      lines: [
        {
          description: 'Browser-forged one-cent item',
          qty: 1,
          unitPriceCents: 1,
        },
      ],
    };
    const cashierCreate = await request(
      platform,
      tenantId,
      'POST',
      '/api/orders/orders',
      forgedOrder,
      cashier,
    );
    expect(cashierCreate.status).toBe(403);

    // Defense in depth for pre-existing/imported rows: even a privileged raw
    // channel=pos order has no API POS claim and cannot enter either tender lane.
    const genericResponse = await request(
      platform,
      tenantId,
      'POST',
      '/api/orders/orders',
      forgedOrder,
    );
    expect(genericResponse.status).toBe(201);
    const generic = await json(genericResponse);
    expect(generic.data).toMatchObject({ channel: 'pos', total_cents: 1, status: 'draft' });

    const manualPay = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${generic.data.id}/pay`,
      {
        tenders: [
          {
            kind: 'external',
            amountCents: 1,
            provider: 'paper_voucher',
            providerRef: 'forged-order-payment',
            idempotencyKey: 'forged-order-manual-pay',
          },
        ],
      },
      cashier,
    );
    expect(manualPay.status).toBe(403);

    const cardPay = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${generic.data.id}/card-payments`,
      { idempotencyKey: 'forged-order-card-pay' },
      cashier,
    );
    expect(cardPay.status).toBe(403);
    const forgedReceipt = await request(
      platform,
      tenantId,
      'GET',
      `/api/pos/receipts/${generic.data.id}`,
      undefined,
      cashier,
    );
    expect(forgedReceipt.status).toBe(403);
    expect(fake.creates).toHaveLength(0);

    const stored = await json(
      await request(
        platform,
        tenantId,
        'GET',
        `/api/orders/orders/${generic.data.id}`,
        undefined,
        cashier,
      ),
    );
    expect(stored.data.status).toBe('draft');
    const tenders = await json(
      await request(
        platform,
        tenantId,
        'GET',
        `/api/orders/orders/${generic.data.id}/tenders`,
        undefined,
        cashier,
      ),
    );
    expect(tenders.data).toEqual([]);
  });

  it('reports a configured offline reader but keeps card tender disabled and blocks payment', async () => {
    const fake = terminalFake();
    const { db, platform, tenantId } = await boot({
      checkoutProviders: [fake.provider],
      posCardPresent: {
        provider: 'stripe_terminal',
        readerId: 'tmr_server_owned',
        verify: async () => ({
          verified: false,
          readerId: 'tmr_server_owned',
          status: 'offline',
          checkedAt: CHECKED_AT,
          code: 'reader_offline',
        }),
      },
    });
    const location = await addLocation(db, tenantId, 'Main store');
    await configure(platform, tenantId, location.id);

    const readiness = await json(
      await request(platform, tenantId, 'GET', '/api/pos/readiness'),
    );
    expect(readiness.data.operational).toBe(true);
    expect(readiness.data.tenders.cardPresent).toMatchObject({
      configured: true,
      enabled: false,
      provider: 'stripe_terminal',
      readerId: 'tmr_server_owned',
      readerStatus: 'offline',
      physicalReaderVerified: false,
      checkedAt: CHECKED_AT,
      code: 'reader_offline',
    });
    expect(readiness.data.blockers.map((item: Json) => item.code)).toContain('card_reader_not_verified');

    const sale = await createPosOrder(platform, tenantId, {
      cartId: 'offline-card',
      totalCents: 2_000,
    });
    const blocked = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${sale.body.data.id}/card-payments`,
      { idempotencyKey: 'offline-attempt' },
    );
    expect(blocked.status).toBe(409);
    expect(fake.creates).toHaveLength(0);
  });

  it('admits only one racing card attempt and releases the active-order claim on cancel', async () => {
    const providerEntered = signal();
    const releaseProvider = signal();
    const fake = terminalFake(async (_order, invocation) => {
      if (invocation !== 1) return;
      providerEntered.resolve();
      await releaseProvider.promise;
    });
    const { db, platform, tenantId } = await boot({
      checkoutProviders: [fake.provider],
      posCardPresent: {
        provider: 'stripe_terminal',
        readerId: 'tmr_race_server',
        verify: async () => ({
          verified: true,
          readerId: 'tmr_race_server',
          status: 'online',
          checkedAt: CHECKED_AT,
        }),
      },
    });
    const location = await addLocation(db, tenantId, 'Race store');
    await configure(platform, tenantId, location.id);
    const sale = await createPosOrder(platform, tenantId, {
      cartId: 'racing-card-attempts',
      totalCents: 2_000,
    });
    expect(sale.response.status, JSON.stringify(sale.body)).toBe(201);

    const firstPromise = request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${sale.body.data.id}/card-payments`,
      { idempotencyKey: 'race-attempt-a' },
    );
    await providerEntered.promise;

    let secondResponse: Response;
    try {
      secondResponse = await request(
        platform,
        tenantId,
        'POST',
        `/api/pos/orders/${sale.body.data.id}/card-payments`,
        { idempotencyKey: 'race-attempt-b' },
      );
    } finally {
      releaseProvider.resolve();
    }
    const firstResponse = await firstPromise;
    expect([firstResponse.status, secondResponse.status].sort()).toEqual([201, 409]);
    expect(fake.creates).toHaveLength(1);

    const active = await json(
      await request(
        platform,
        tenantId,
        'GET',
        `/api/pos/orders/${sale.body.data.id}/payment-attempts`,
      ),
    );
    expect(active.data).toHaveLength(1);
    expect(active.data[0]).toMatchObject({
      idempotency_key: 'race-attempt-a',
      status: 'processing',
      active_order_key: JSON.stringify([tenantId, sale.body.data.id]),
    });
    const receipt = await json(
      await request(platform, tenantId, 'GET', `/api/pos/receipts/${sale.body.data.id}`),
    );
    expect(receipt.data.tenders).toEqual([]);
    expect(receipt.data.amountPaidCents).toBe(0);

    const canceled = await json(
      await request(
        platform,
        tenantId,
        'POST',
        `/api/pos/payment-attempts/${active.data[0].id}/cancel`,
      ),
    );
    expect(canceled.data).toMatchObject({
      id: active.data[0].id,
      status: 'canceled',
      active_order_key: null,
    });
    const afterCancel = await json(
      await request(
        platform,
        tenantId,
        'GET',
        `/api/pos/orders/${sale.body.data.id}/payment-attempts`,
      ),
    );
    expect(afterCancel.data).toHaveLength(1);
    expect(afterCancel.data[0]).toMatchObject({
      status: 'canceled',
      active_order_key: null,
    });

    const replacementResponse = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${sale.body.data.id}/card-payments`,
      { idempotencyKey: 'race-attempt-after-cancel' },
    );
    expect(replacementResponse.status).toBe(201);
    const replacement = await json(replacementResponse);
    expect(replacement.data.attempt).toMatchObject({
      idempotency_key: 'race-attempt-after-cancel',
      status: 'processing',
      active_order_key: JSON.stringify([tenantId, sale.body.data.id]),
    });
    expect(fake.creates).toHaveLength(2);
  });

  it('does not let an in-flight cancel overwrite a verified webhook success', async () => {
    const cancelEntered = signal();
    const releaseCancel = signal();
    const fake = terminalFake(undefined, async (_input, invocation) => {
      if (invocation !== 1) return;
      cancelEntered.resolve();
      await releaseCancel.promise;
    });
    const provider: CheckoutProvider = {
      ...fake.provider,
      verifyWebhook(_headers, rawBody) {
        return { valid: true, event: JSON.parse(rawBody) as Json & { id: string; type: string } };
      },
      parseCompletion(event) {
        const data = event.data as Json;
        return {
          providerSessionRef: data.providerSessionRef as string,
          amountCents: data.amountCents as number,
          tenderRef: data.tenderRef as string,
        };
      },
      parsePaymentUpdate(event) {
        const completed = this.parseCompletion(event);
        return { ...completed, status: 'succeeded' };
      },
    };
    const { db, platform, tenantId } = await boot({
      checkoutProviders: [provider],
      posCardPresent: {
        provider: 'stripe_terminal',
        readerId: 'tmr_webhook_race',
        verify: async () => ({
          verified: true,
          readerId: 'tmr_webhook_race',
          status: 'online',
          checkedAt: CHECKED_AT,
        }),
      },
    });
    const location = await addLocation(db, tenantId, 'Webhook race store');
    await configure(platform, tenantId, location.id);
    const sale = await createPosOrder(platform, tenantId, {
      cartId: 'webhook-success-vs-cancel',
      totalCents: 2_000,
    });
    const attemptResponse = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${sale.body.data.id}/card-payments`,
      { idempotencyKey: 'webhook-cancel-attempt' },
    );
    expect(attemptResponse.status).toBe(201);
    const attempt = (await json(attemptResponse)).data.attempt;

    const cancelPromise = request(
      platform,
      tenantId,
      'POST',
      `/api/pos/payment-attempts/${attempt.id}/cancel`,
    );
    await cancelEntered.promise;
    let webhookResponse: Response;
    try {
      webhookResponse = await request(
        platform,
        tenantId,
        'POST',
        '/api/orders/webhooks/stripe_terminal',
        {
          id: 'evt_webhook_wins_cancel_race',
          type: 'payment_intent.succeeded',
          data: {
            providerSessionRef: attempt.provider_ref,
            amountCents: 2_000,
            tenderRef: 'ch_webhook_wins_cancel_race',
          },
        },
      );
    } finally {
      releaseCancel.resolve();
    }
    const cancelResponse = await cancelPromise;
    expect(webhookResponse.status).toBe(200);
    expect((await json(webhookResponse)).data.outcome).toBe('paid');
    expect(cancelResponse.status).toBe(409);

    const finalAttempt = await json(
      await request(platform, tenantId, 'GET', `/api/pos/payment-attempts/${attempt.id}`),
    );
    expect(finalAttempt.data).toMatchObject({
      status: 'succeeded',
      active_order_key: null,
    });
    const receipt = await json(
      await request(platform, tenantId, 'GET', `/api/pos/receipts/${sale.body.data.id}`),
    );
    expect(receipt.data.order.status).toBe('paid');
    expect(receipt.data.tenders).toHaveLength(1);
    expect(receipt.data.tenders[0]).toMatchObject({
      kind: 'provider',
      provider: 'stripe_terminal',
      provider_ref: 'ch_webhook_wins_cancel_race',
      amount_cents: 2_000,
      status: 'captured',
    });
    expect(receipt.data.amountPaidCents).toBe(2_000);
  });

  it('uses the server reader, leaves the order untendered while processing, replays, and cancels', async () => {
    const fake = terminalFake();
    let readerOnline = true;
    const { db, platform, tenantId } = await boot({
      checkoutProviders: [fake.provider],
      posCardPresent: {
        provider: 'stripe_terminal',
        readerId: 'tmr_server_owned',
        verify: async () => ({
          verified: readerOnline,
          readerId: 'tmr_server_owned',
          status: readerOnline ? 'online' : 'offline',
          checkedAt: CHECKED_AT,
        }),
      },
    });
    const location = await addLocation(db, tenantId, 'Main store');
    await configure(platform, tenantId, location.id);
    const drawer = await openDrawer(platform, tenantId, {
      drawerRef: 'drawer-card-fallback',
      registerRef: 'register-main',
    });
    const readiness = await json(
      await request(platform, tenantId, 'GET', '/api/pos/readiness'),
    );
    expect(readiness.data.tenders.cardPresent).toMatchObject({
      configured: true,
      enabled: true,
      readerId: 'tmr_server_owned',
      physicalReaderVerified: true,
    });

    const sale = await createPosOrder(platform, tenantId, {
      cartId: 'online-card',
      totalCents: 2_000,
      cashSessionId: drawer.session.id,
    });
    const firstResponse = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${sale.body.data.id}/card-payments`,
      {
        idempotencyKey: 'card-attempt-1',
        readerId: 'tmr_browser_forgery',
        provider: 'simulator',
      },
    );
    expect(firstResponse.status).toBe(201);
    const first = await json(firstResponse);
    expect(first.created).toBe(true);
    expect(first.data.attempt).toMatchObject({
      order_id: sale.body.data.id,
      provider: 'stripe_terminal',
      status: 'processing',
      amount_cents: 2_000,
      idempotency_key: 'card-attempt-1',
      reader_id: 'tmr_server_owned',
    });
    expect(first.data.terminal).toMatchObject({
      readerId: 'tmr_server_owned',
      readerStatus: 'online',
      actionStatus: 'in_progress',
    });
    expect(fake.creates).toHaveLength(1);
    expect(fake.creates[0]).toMatchObject({
      tenantId,
      orderId: sale.body.data.id,
      amountCents: 2_000,
      readerId: 'tmr_server_owned',
    });
    expect(fake.creates[0].idempotencyKey).toBe(`${tenantId}:card-attempt-1`);

    const receipt = await json(
      await request(platform, tenantId, 'GET', `/api/pos/receipts/${sale.body.data.id}`),
    );
    expect(receipt.data.order.status).toBe('reserved');
    expect(receipt.data.tenders).toEqual([]);
    expect(receipt.data.amountPaidCents).toBe(0);

    for (const fallback of [
      cashPlan(2_000, 'cash-while-card-active'),
      {
        tenders: [
          {
            kind: 'external',
            amountCents: 2_000,
            provider: 'paper_voucher',
            providerRef: 'voucher-active-card',
            idempotencyKey: 'external-while-card-active',
          },
        ],
      },
    ]) {
      const blockedFallback = await request(
        platform,
        tenantId,
        'POST',
        `/api/pos/orders/${sale.body.data.id}/pay`,
        fallback,
      );
      expect(blockedFallback.status).toBe(409);
    }
    const afterBlockedFallbacks = await json(
      await request(platform, tenantId, 'GET', `/api/pos/receipts/${sale.body.data.id}`),
    );
    expect(afterBlockedFallbacks.data.order.status).toBe('reserved');
    expect(afterBlockedFallbacks.data.tenders).toEqual([]);
    expect(afterBlockedFallbacks.data.amountPaidCents).toBe(0);

    // A network retry must return the durable attempt even if the reader went
    // offline after the original server-owned process action began.
    readerOnline = false;
    const replayResponse = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${sale.body.data.id}/card-payments`,
      { idempotencyKey: 'card-attempt-1' },
    );
    expect(replayResponse.status).toBe(200);
    const replay = await json(replayResponse);
    expect(replay.created).toBe(false);
    expect(replay.data.attempt.id).toBe(first.data.attempt.id);
    expect(fake.creates).toHaveLength(1);

    const otherSale = await createPosOrder(platform, tenantId, {
      cartId: 'online-card-key-conflict',
      totalCents: 2_000,
    });
    const conflictingReplay = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/orders/${otherSale.body.data.id}/card-payments`,
      { idempotencyKey: 'card-attempt-1' },
    );
    expect(conflictingReplay.status).toBe(409);
    expect(fake.creates).toHaveLength(1);

    const statusBefore = await json(
      await request(
        platform,
        tenantId,
        'GET',
        `/api/pos/payment-attempts/${first.data.attempt.id}`,
      ),
    );
    expect(statusBefore.data.status).toBe('processing');
    const canceledResponse = await request(
      platform,
      tenantId,
      'POST',
      `/api/pos/payment-attempts/${first.data.attempt.id}/cancel`,
    );
    expect(canceledResponse.status).toBe(200);
    expect((await json(canceledResponse)).data.status).toBe('canceled');
    expect(fake.cancels).toHaveLength(1);
    expect(fake.cancels[0]).toMatchObject({
      providerSessionRef: first.data.attempt.provider_ref,
      readerId: 'tmr_server_owned',
    });

    const statusAfter = await json(
      await request(
        platform,
        tenantId,
        'GET',
        `/api/pos/payment-attempts/${first.data.attempt.id}`,
      ),
    );
    expect(statusAfter.data.status).toBe('canceled');
    const attempts = await json(
      await request(
        platform,
        tenantId,
        'GET',
        `/api/pos/orders/${sale.body.data.id}/payment-attempts`,
      ),
    );
    expect(attempts.data).toHaveLength(1);
    expect(attempts.data[0].status).toBe('canceled');
    const canceledReceipt = await json(
      await request(platform, tenantId, 'GET', `/api/pos/receipts/${sale.body.data.id}`),
    );
    expect(canceledReceipt.data.tenders).toEqual([]);
    expect(canceledReceipt.data.amountPaidCents).toBe(0);
  });
});
