import { describe, expect, it } from 'vitest';
import { asCoreDb, createTenant } from '@blacklabel/core';
import { createTestDb } from '@blacklabel/db';
import { createProduct, createVariation, type CatalogDatabase } from '@blacklabel/catalog';
import {
  applyMovement,
  createLocation,
  getStock,
  type InventoryDatabase,
} from '@blacklabel/inventory';
import { createRefund, type CreateRefundInputSvc, type OrdersDatabase } from '@blacklabel/orders';
import { createApp, type PlatformDatabase } from '../src/app';
import {
  discoverPosReconciliationEffects,
  drainPosReconciliation,
  type PosReconciliationDatabase,
} from '../src/pos-reconciliation';

const KEY = Buffer.alloc(32, 41);
type Platform = Awaited<ReturnType<typeof createApp>>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function remainsPending<T>(promise: Promise<T>): Promise<boolean> {
  return Promise.race([
    promise.then(() => false, () => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 20)),
  ]);
}

function headers(tenantId: string) {
  return {
    'x-tenant-id': tenantId,
    'x-mags-csrf': '1',
    'content-type': 'application/json',
  };
}

async function request(
  platform: Platform,
  tenantId: string,
  method: string,
  path: string,
  payload?: unknown,
) {
  const response = await platform.app.request(path, {
    method,
    headers: headers(tenantId),
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return { response, body: await response.json() as Record<string, any> };
}

async function fixture() {
  const db = createTestDb<PlatformDatabase>();
  const platform = await createApp({ db, adminMasterKey: KEY, disableRateLimit: true });
  const tenant = await createTenant(asCoreDb(db), { name: 'Durable POS Tenant' });
  await platform.seedTenant(tenant.id);
  const inventory = db as unknown as import('kysely').Kysely<InventoryDatabase>;
  const catalog = db as unknown as import('kysely').Kysely<CatalogDatabase>;
  const location = await createLocation(inventory, tenant.id, 'owner', {
    name: 'Register stock',
    kind: 'warehouse',
    oversellPolicy: 'deny',
  });
  const product = await createProduct(catalog, tenant.id, 'owner', {
    sourceItemId: 'durable-item',
    name: 'Durable item',
  });
  const variation = await createVariation(catalog, tenant.id, 'owner', platform.events, {
    productId: product.id,
    sourceVariationId: 'durable-variation',
    name: 'Default',
    sku: 'DURABLE-1',
    priceCents: 1_000,
    trackInventory: true,
  });
  await applyMovement(inventory, platform.events, tenant.id, 'owner', {
    variationId: variation.id,
    locationId: location.id,
    delta: 5,
    reason: 'received',
  });
  expect((await request(platform, tenant.id, 'PUT', '/api/pos/settings', {
    defaultLocationId: location.id,
    taxBps: 0,
  })).response.status).toBe(200);
  const drawer = await request(platform, tenant.id, 'POST', '/api/pos/drawer/open', {
    drawerRef: 'durable-drawer',
    registerRef: 'register-1',
    openingFloatCents: 5_000,
  });
  expect(drawer.response.status).toBe(201);
  const sale = await request(platform, tenant.id, 'POST', '/api/pos/orders', {
    cartId: 'durable-cart',
    registerId: 'register-1',
    cashSessionId: drawer.body.data.session.id,
    taxBps: 0,
    lines: [{ variationId: variation.id, qty: 1 }],
  });
  expect(sale.response.status).toBe(201);
  return {
    db,
    reconciliation: db as unknown as import('kysely').Kysely<PosReconciliationDatabase>,
    platform,
    tenantId: tenant.id,
    inventory,
    locationId: location.id,
    variationId: variation.id,
    cashSessionId: drawer.body.data.session.id as string,
    orderId: sale.body.data.id as string,
    orderLineId: sale.body.data.lines[0].id as string,
  };
}

describe('durable POS reconciliation', () => {
  it('leases a pending effect so parallel drainers execute it once', async () => {
    const f = await fixture();
    f.platform.detachEngine();
    const canceled = await request(
      f.platform,
      f.tenantId,
      'POST',
      `/api/orders/orders/${f.orderId}/cancel`,
    );
    expect(canceled.response.status).toBe(200);

    const entered = deferred();
    const release = deferred();
    let executions = 0;
    const unsubscribe = f.platform.events.on<{ variationId?: string }>(
      'inventory.stock.changed',
      async (event) => {
        if (event.tenantId !== f.tenantId || event.payload.variationId !== f.variationId) return;
        executions += 1;
        entered.resolve();
        await release.promise;
      },
    );

    const firstDrain = drainPosReconciliation(f.reconciliation, f.platform.events, {
      tenantId: f.tenantId,
      limit: 1,
    });
    await entered.promise;
    const secondResult = await drainPosReconciliation(f.reconciliation, f.platform.events, {
      tenantId: f.tenantId,
      limit: 1,
    });
    const claimed = await f.db
      .selectFrom('api_pos_reconciliation_effects')
      .select(['status', 'attempt_count', 'last_error'])
      .where('tenant_id', '=', f.tenantId)
      .where('source_ref', '=', f.orderId)
      .where('effect_type', '=', 'inventory_release')
      .executeTakeFirstOrThrow();
    release.resolve();
    const firstResult = await firstDrain;

    expect(firstResult).toMatchObject({ attempted: 1, completed: 1, failed: 0 });
    expect(secondResult).toMatchObject({ attempted: 0, completed: 0, failed: 0 });
    expect(claimed).toMatchObject({ status: 'pending', attempt_count: 1 });
    expect(claimed.last_error).toContain('execution_claim');
    expect(executions).toBe(1);
    expect(await f.db
      .selectFrom('api_pos_reconciliation_effects')
      .select(['status', 'attempt_count', 'last_error'])
      .where('tenant_id', '=', f.tenantId)
      .where('source_ref', '=', f.orderId)
      .where('effect_type', '=', 'inventory_release')
      .executeTakeFirstOrThrow()).toEqual({ status: 'completed', attempt_count: 1, last_error: null });
    unsubscribe();
  });

  it('does not let a late execution failure regress a completed effect', async () => {
    const f = await fixture();
    f.platform.detachEngine();
    expect((await request(
      f.platform,
      f.tenantId,
      'POST',
      `/api/orders/orders/${f.orderId}/cancel`,
    )).response.status).toBe(200);
    expect(await discoverPosReconciliationEffects(f.reconciliation, {
      tenantId: f.tenantId,
      limit: 1,
    })).toBe(1);

    const entered = deferred();
    const release = deferred();
    const delayedFailureEvents = {
      async emit() {
        entered.resolve();
        await release.promise;
        throw new Error('injected delayed event failure');
      },
    } as unknown as typeof f.platform.events;

    const draining = drainPosReconciliation(f.reconciliation, delayedFailureEvents, {
      tenantId: f.tenantId,
      limit: 1,
    });
    await entered.promise;
    const effect = await f.db
      .selectFrom('api_pos_reconciliation_effects')
      .select(['id', 'attempt_count', 'last_error'])
      .where('tenant_id', '=', f.tenantId)
      .where('source_ref', '=', f.orderId)
      .where('effect_type', '=', 'inventory_release')
      .executeTakeFirstOrThrow();
    const completedAt = new Date().toISOString();
    await f.db
      .updateTable('api_pos_reconciliation_effects')
      .set({
        status: 'completed',
        last_error: null,
        updated_at: completedAt,
        completed_at: completedAt,
      })
      .where('tenant_id', '=', f.tenantId)
      .where('id', '=', effect.id)
      .execute();
    release.resolve();
    const result = await draining;

    expect(result).toMatchObject({ attempted: 1, completed: 0, failed: 0 });
    expect(effect.attempt_count).toBe(1);
    expect(effect.last_error).toContain('execution_claim');
    expect(await f.db
      .selectFrom('api_pos_reconciliation_effects')
      .select(['status', 'attempt_count', 'last_error', 'completed_at'])
      .where('tenant_id', '=', f.tenantId)
      .where('id', '=', effect.id)
      .executeTakeFirstOrThrow()).toEqual({
        status: 'completed',
        attempt_count: 1,
        last_error: null,
        completed_at: completedAt,
      });
  });

  it('repairs sale and refund projections after restart exactly once', async () => {
    const f = await fixture();
    f.platform.detachEngine();
    const paid = await request(f.platform, f.tenantId, 'POST', `/api/orders/orders/${f.orderId}/pay`, {
      tenders: [{
        kind: 'cash',
        amountCents: 1_000,
        cashReceivedCents: 1_000,
        idempotencyKey: 'durable-cash-tender',
      }],
    });
    expect(paid.response.status).toBe(200);
    expect((await getStock(f.inventory, f.tenantId, {
      variationId: f.variationId,
      locationId: f.locationId,
    }))[0]).toMatchObject({ onHand: 5, reserved: 1 });
    expect(await f.db.selectFrom('finance_cash_movements').selectAll().execute()).toHaveLength(0);
    expect(await f.db.selectFrom('api_pos_finance_entries').selectAll().execute()).toHaveLength(0);

    const second = await createApp({ db: f.db, adminMasterKey: KEY, disableRateLimit: true });
    expect((await getStock(f.inventory, f.tenantId, {
      variationId: f.variationId,
      locationId: f.locationId,
    }))[0]).toMatchObject({ onHand: 4, reserved: 0 });
    expect(await f.db.selectFrom('finance_cash_movements').selectAll().execute()).toHaveLength(1);
    expect(await f.db.selectFrom('api_pos_finance_entries').selectAll().execute()).toHaveLength(1);

    const tender = await f.db
      .selectFrom('orders_tenders')
      .select('id')
      .where('tenant_id', '=', f.tenantId)
      .where('order_id', '=', f.orderId)
      .executeTakeFirstOrThrow();
    second.detachEngine();
    const refundInput = {
      tenderId: tender.id,
      cashSessionId: f.cashSessionId,
      idempotencyKey: 'durable-cash-refund',
      amountCents: 1_000,
      lines: [{ lineId: f.orderLineId, qty: 1, disposition: 'restock' }],
    } satisfies CreateRefundInputSvc;
    const bypass = await request(second, f.tenantId, 'POST', `/api/orders/orders/${f.orderId}/refunds`, refundInput);
    expect(bypass.response.status).toBe(409);
    expect(bypass.body.error.message).toContain('must be refunded through the POS refund endpoint');
    const refunded = await createRefund(
      {
        db: f.db as unknown as import('kysely').Kysely<OrdersDatabase>,
        events: second.events,
      },
      f.tenantId,
      'crash-simulation',
      f.orderId,
      refundInput,
    );
    expect(refunded.created).toBe(true);
    expect((await getStock(f.inventory, f.tenantId, {
      variationId: f.variationId,
      locationId: f.locationId,
    }))[0].onHand).toBe(4);

    const third = await createApp({ db: f.db, adminMasterKey: KEY, disableRateLimit: true });
    expect((await getStock(f.inventory, f.tenantId, {
      variationId: f.variationId,
      locationId: f.locationId,
    }))[0].onHand).toBe(5);
    expect(await f.db.selectFrom('finance_cash_movements').selectAll().execute()).toHaveLength(2);
    expect(await f.db.selectFrom('api_pos_finance_entries').selectAll().execute()).toHaveLength(2);

    const summary = await request(third, f.tenantId, 'GET', '/api/pos/finance/summary');
    expect(summary.response.status).toBe(200);
    expect(summary.body.data).toMatchObject({
      grossTenderedSalesCents: 1_000,
      completedRefundsCents: 1_000,
      netSalesBeforeFeesCents: 0,
      processorFeesCents: null,
      settlementNetCents: null,
      unknownFeeEntryCount: 2,
      pendingReconciliationCount: 0,
    });
    const entries = await request(third, f.tenantId, 'GET', '/api/pos/finance/entries');
    expect(entries.response.status).toBe(200);
    expect(entries.body.data).toEqual([
      expect.objectContaining({ entry_type: 'refund', cashier_name: 'Owner', receipt_number: expect.any(String) }),
      expect.objectContaining({ entry_type: 'payment', cashier_name: 'Owner', receipt_number: expect.any(String) }),
    ]);
    await request(third, f.tenantId, 'POST', '/api/pos/reconciliation/drain');
    expect(await f.db.selectFrom('inventory_movements').select('id')
      .where('ref_type', '=', 'order').where('ref_id', '=', f.orderId).where('reason', '=', 'sold').execute())
      .toHaveLength(1);
    expect(await f.db.selectFrom('inventory_movements').select('id')
      .where('ref_type', '=', 'return').where('reason', '=', 'returned').execute())
      .toHaveLength(1);
    expect(await f.db.selectFrom('finance_cash_movements').selectAll().execute()).toHaveLength(2);
    expect(await f.db.selectFrom('api_pos_finance_entries').selectAll().execute()).toHaveLength(2);
    third.detachEngine();
  });

  it('drains a missed cash tender before allowing drawer close', async () => {
    const f = await fixture();
    f.platform.detachEngine();
    expect((await request(f.platform, f.tenantId, 'POST', `/api/orders/orders/${f.orderId}/pay`, {
      tenders: [{ kind: 'cash', amountCents: 1_000, idempotencyKey: 'close-gate-tender' }],
    })).response.status).toBe(200);
    expect(await f.db.selectFrom('finance_cash_movements').selectAll().execute()).toHaveLength(0);
    const closed = await request(
      f.platform,
      f.tenantId,
      'POST',
      `/api/pos/drawer/${f.cashSessionId}/close`,
      { countedCents: 6_000 },
    );
    expect(closed.response.status).toBe(200);
    expect(closed.body.data.session).toMatchObject({ status: 'closed', expected_cents: 6_000 });
    expect(await f.db.selectFrom('finance_cash_movements').selectAll().execute()).toHaveLength(1);
  });

  it('releases canceled POS reservations on restart when the event consumer missed the commit', async () => {
    const f = await fixture();
    f.platform.detachEngine();
    const canceled = await request(
      f.platform,
      f.tenantId,
      'POST',
      `/api/orders/orders/${f.orderId}/cancel`,
    );
    expect(canceled.response.status).toBe(200);
    expect((await getStock(f.inventory, f.tenantId, {
      variationId: f.variationId,
      locationId: f.locationId,
    }))[0]).toMatchObject({ onHand: 5, reserved: 1 });

    const restarted = await createApp({ db: f.db, adminMasterKey: KEY, disableRateLimit: true });
    expect((await getStock(f.inventory, f.tenantId, {
      variationId: f.variationId,
      locationId: f.locationId,
    }))[0]).toMatchObject({ onHand: 5, reserved: 0 });
    expect(await f.db
      .selectFrom('inventory_reservations')
      .select('status')
      .where('tenant_id', '=', f.tenantId)
      .where('ref_type', '=', 'order')
      .where('ref_id', '=', f.orderId)
      .executeTakeFirstOrThrow()).toMatchObject({ status: 'released' });
    expect(await f.db
      .selectFrom('api_pos_reconciliation_effects')
      .select(['effect_type', 'status'])
      .where('tenant_id', '=', f.tenantId)
      .where('source_ref', '=', f.orderId)
      .where('effect_type', '=', 'inventory_release')
      .executeTakeFirstOrThrow()).toEqual({ effect_type: 'inventory_release', status: 'completed' });
    restarted.detachEngine();
  });

  it('serializes drawer close behind an in-flight cash payment', async () => {
    const f = await fixture();
    const entered = deferred();
    const release = deferred();
    const unsubscribe = f.platform.events.on('orders.order.paid', async () => {
      entered.resolve();
      await release.promise;
    });

    const paying = request(f.platform, f.tenantId, 'POST', `/api/pos/orders/${f.orderId}/pay`, {
      tenders: [{ kind: 'cash', amountCents: 1_000, idempotencyKey: 'serialized-cash-pay' }],
    });
    await entered.promise;
    const closing = request(
      f.platform,
      f.tenantId,
      'POST',
      `/api/pos/drawer/${f.cashSessionId}/close`,
      { countedCents: 6_000 },
    );
    expect(await remainsPending(closing)).toBe(true);
    release.resolve();
    const [paid, closed] = await Promise.all([paying, closing]);
    expect(paid.response.status).toBe(200);
    expect(closed.response.status).toBe(200);
    expect(closed.body.data.session).toMatchObject({ status: 'closed', expected_cents: 6_000 });
    unsubscribe();
    f.platform.detachEngine();
  });

  it('serializes drawer close behind an in-flight cash refund', async () => {
    const f = await fixture();
    expect((await request(f.platform, f.tenantId, 'POST', `/api/pos/orders/${f.orderId}/pay`, {
      tenders: [{ kind: 'cash', amountCents: 1_000, idempotencyKey: 'refund-race-sale' }],
    })).response.status).toBe(200);
    const tender = await f.db
      .selectFrom('orders_tenders')
      .select('id')
      .where('tenant_id', '=', f.tenantId)
      .where('order_id', '=', f.orderId)
      .executeTakeFirstOrThrow();
    const entered = deferred();
    const release = deferred();
    const unsubscribe = f.platform.events.on('orders.refund.created', async () => {
      entered.resolve();
      await release.promise;
    });

    const refunding = request(f.platform, f.tenantId, 'POST', `/api/pos/orders/${f.orderId}/refunds`, {
      tenderId: tender.id,
      cashSessionId: f.cashSessionId,
      idempotencyKey: 'serialized-cash-refund',
      amountCents: 1_000,
      lines: [{ lineId: f.orderLineId, qty: 1, disposition: 'restock' }],
    });
    await entered.promise;
    const closing = request(
      f.platform,
      f.tenantId,
      'POST',
      `/api/pos/drawer/${f.cashSessionId}/close`,
      { countedCents: 5_000 },
    );
    expect(await remainsPending(closing)).toBe(true);
    release.resolve();
    const [refunded, closed] = await Promise.all([refunding, closing]);
    expect(refunded.response.status).toBe(201);
    expect(closed.response.status).toBe(200);
    expect(closed.body.data.session).toMatchObject({ status: 'closed', expected_cents: 5_000 });
    unsubscribe();
    f.platform.detachEngine();
  });
});
