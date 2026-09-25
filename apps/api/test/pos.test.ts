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
import { createApp, type PlatformDatabase } from '../src/app';

const KEY = Buffer.alloc(32, 4);
const cat = (db: unknown) => db as import('kysely').Kysely<CatalogDatabase>;
const inv = (db: unknown) => db as import('kysely').Kysely<InventoryDatabase>;

async function boot() {
  const db = createTestDb<PlatformDatabase>();
  const platform = await createApp({ db, adminMasterKey: KEY });
  const tenant = await createTenant(asCoreDb(db), { name: 'POS Tenant' });
  await platform.seedTenant(tenant.id);
  return { db, platform, tenantId: tenant.id };
}

function headers(tenantId: string): Record<string, string> {
  return {
    'x-tenant-id': tenantId,
    'x-mags-csrf': '1',
    'content-type': 'application/json',
  };
}

async function configure(
  platform: Awaited<ReturnType<typeof createApp>>,
  tenantId: string,
  locationId: string,
  taxBps = 825,
) {
  const res = await platform.app.request('/api/pos/settings', {
    method: 'PUT',
    headers: headers(tenantId),
    body: JSON.stringify({ defaultLocationId: locationId, taxBps, receiptFooter: 'Thank you.' }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

async function seedSellable(
  db: PlatformDatabase extends never ? never : unknown,
  platform: Awaited<ReturnType<typeof createApp>>,
  tenantId: string,
  priceCents: number | null = 2500,
) {
  const location = await createLocation(inv(db), tenantId, 'owner', {
    name: 'Front Register',
    kind: 'warehouse',
    oversellPolicy: 'deny',
  });
  const product = await createProduct(cat(db), tenantId, 'owner', {
    sourceItemId: 'item-' + Math.random().toString(36).slice(2),
    name: 'Saddle Pad',
  });
  const variation = await createVariation(cat(db), tenantId, 'owner', platform.events, {
    productId: product.id,
    sourceVariationId: 'var-' + Math.random().toString(36).slice(2),
    name: 'Medium',
    sku: 'PAD-M',
    priceCents,
    trackInventory: true,
  });
  await addBarcode(cat(db), tenantId, 'owner', variation.id, '036000291452', { isPrimary: true });
  await applyMovement(inv(db), platform.events, tenantId, 'owner', {
    variationId: variation.id,
    locationId: location.id,
    delta: 5,
    reason: 'received',
  });
  return { location, product, variation };
}

describe('POS composition facade', () => {
  it('reports explicit setup blockers and never advertises simulator as card-present', async () => {
    const { platform, tenantId } = await boot();
    const res = await platform.app.request('/api/pos/readiness', {
      headers: { 'x-tenant-id': tenantId },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.ready).toBe(false);
    expect(body.data.providers).toContain('simulator');
    expect(body.data.tenders.cardPresent).toMatchObject({
      enabled: false,
      configured: false,
      provider: null,
      physicalReaderVerified: false,
    });
    expect(body.data.blockers.map((item: any) => item.code)).toEqual(
      expect.arrayContaining(['default_location_required', 'tax_rate_required', 'card_present_not_configured']),
    );
  });

  it('returns register-ready catalog matches with price and location availability', async () => {
    const { db, platform, tenantId } = await boot();
    const { location, variation } = await seedSellable(db, platform, tenantId);
    await configure(platform, tenantId, location.id);

    const res = await platform.app.request('/api/pos/catalog?code=036000291452', {
      headers: { 'x-tenant-id': tenantId },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.matchType).toBe('barcode');
    expect(body.data.matches).toHaveLength(1);
    expect(body.data.matches[0]).toMatchObject({
      variationId: variation.id,
      name: 'Saddle Pad',
      variationName: 'Medium',
      sku: 'PAD-M',
      unitPriceCents: 2500,
      locationId: location.id,
      stock: { onHand: 5, reserved: 0, available: 5 },
    });
  });

  it('runs a cashier-safe drawer shift through open, movement, reconcile, and close', async () => {
    const { db, platform, tenantId } = await boot();
    const { location } = await seedSellable(db, platform, tenantId);
    await configure(platform, tenantId, location.id, 0);

    const opened = await platform.app.request('/api/pos/drawer/open', {
      method: 'POST',
      headers: headers(tenantId),
      body: JSON.stringify({
        drawerRef: 'front-drawer',
        registerRef: 'front-register',
        openingFloatCents: 10000,
      }),
    });
    expect(opened.status).toBe(201);
    const openedBody = (await opened.json()) as any;
    const sessionId = openedBody.data.session.id;
    expect(openedBody.data.reconciliation).toMatchObject({
      cashSessionId: sessionId,
      expectedMode: 'ledger',
      effectiveExpectedCents: 10000,
    });

    const loaded = await platform.app.request('/api/pos/drawer?drawerRef=front-drawer', {
      headers: { 'x-tenant-id': tenantId },
    });
    expect(loaded.status).toBe(200);
    expect(((await loaded.json()) as any).data.session.id).toBe(sessionId);

    const movementPayload = {
      kind: 'paid_in',
      amountCents: 500,
      note: 'Added coin rolls',
      idempotencyKey: 'coins-1',
    };
    const movement = await platform.app.request('/api/pos/drawer/' + sessionId + '/movements', {
      method: 'POST',
      headers: headers(tenantId),
      body: JSON.stringify(movementPayload),
    });
    expect(movement.status).toBe(201);
    expect(((await movement.json()) as any).data.reconciliation.effectiveExpectedCents).toBe(10500);
    const replay = await platform.app.request('/api/pos/drawer/' + sessionId + '/movements', {
      method: 'POST',
      headers: headers(tenantId),
      body: JSON.stringify(movementPayload),
    });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as any).created).toBe(false);

    const closed = await platform.app.request('/api/pos/drawer/' + sessionId + '/close', {
      method: 'POST',
      headers: headers(tenantId),
      body: JSON.stringify({ countedCents: 10500 }),
    });
    expect(closed.status).toBe(200);
    const closedBody = (await closed.json()) as any;
    expect(closedBody.data.session.status).toBe('closed');
    expect(closedBody.data.reconciliation).toMatchObject({
      countedCents: 10500,
      varianceCents: 0,
      movementCount: 1,
    });

    const none = await platform.app.request('/api/pos/drawer?drawerRef=front-drawer', {
      headers: { 'x-tenant-id': tenantId },
    });
    expect(((await none.json()) as any).data).toBeNull();
  });

  it('re-resolves catalog price and tax server-side and binds each cart id to its checkout facts', async () => {
    const { db, platform, tenantId } = await boot();
    const { location, variation } = await seedSellable(db, platform, tenantId);
    await configure(platform, tenantId, location.id, 825);
    const payload = {
      cartId: 'cart-one',
      registerId: 'front',
      deviceId: 'ipad-1',
      tipCents: 100,
      taxBps: 825,
      lines: [
        {
          variationId: variation.id,
          description: 'tampered browser description',
          qty: 1,
          unitPriceCents: 1,
        },
      ],
    };

    const first = await platform.app.request('/api/pos/orders', {
      method: 'POST',
      headers: headers(tenantId),
      body: JSON.stringify(payload),
    });
    const firstBody = (await first.json()) as any;
    expect(first.status, JSON.stringify(firstBody)).toBe(201);
    expect(firstBody.created).toBe(true);
    expect(firstBody.data.lines[0]).toMatchObject({
      description: 'Saddle Pad — Medium',
      unit_price_cents: 2500,
      location_id: location.id,
    });
    expect(firstBody.data).toMatchObject({
      subtotal_cents: 2500,
      tax_cents: 206,
      tip_cents: 100,
      total_cents: 2806,
      source_order_id: 'pos:cart-one',
      register_id: 'front',
      device_id: 'ipad-1',
    });
    expect(firstBody.data.cashier_id).toBeTruthy();
    expect(firstBody.data.receipt_number).toMatch(/^BL-\d{8}-/);

    const replay = await platform.app.request('/api/pos/orders', {
      method: 'POST',
      headers: headers(tenantId),
      body: JSON.stringify(payload),
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as any;
    expect(replayBody.created).toBe(false);
    expect(replayBody.data.id).toBe(firstBody.data.id);
    expect(replayBody.data.total_cents).toBe(2806);

    const conflictingReplay = await platform.app.request('/api/pos/orders', {
      method: 'POST',
      headers: headers(tenantId),
      body: JSON.stringify({
        ...payload,
        lines: [{ description: 'different replay', qty: 1, unitPriceCents: 99999 }],
      }),
    });
    expect(conflictingReplay.status).toBe(409);
    expect(((await conflictingReplay.json()) as any).error.message).toContain(
      'cartId is already bound to different checkout facts',
    );
  });

  it('rejects stale tax assertions and unpriced catalog items', async () => {
    const { db, platform, tenantId } = await boot();
    const { location, variation } = await seedSellable(db, platform, tenantId, null);
    await configure(platform, tenantId, location.id, 0);

    const stale = await platform.app.request('/api/pos/orders', {
      method: 'POST',
      headers: headers(tenantId),
      body: JSON.stringify({
        cartId: 'stale',
        taxBps: 825,
        lines: [{ variationId: variation.id, qty: 1, unitPriceCents: 1 }],
      }),
    });
    expect(stale.status).toBe(409);

    const unpriced = await platform.app.request('/api/pos/orders', {
      method: 'POST',
      headers: headers(tenantId),
      body: JSON.stringify({
        cartId: 'unpriced',
        taxBps: 0,
        lines: [{ variationId: variation.id, qty: 1, unitPriceCents: 1 }],
      }),
    });
    expect(unpriced.status).toBe(409);
  });

  it('returns a single receipt projection with merchant settings and payment totals', async () => {
    const { db, platform, tenantId } = await boot();
    const { location, variation } = await seedSellable(db, platform, tenantId);
    await configure(platform, tenantId, location.id, 0);
    const sale = await platform.app.request('/api/pos/orders', {
      method: 'POST',
      headers: headers(tenantId),
      body: JSON.stringify({
        cartId: 'receipt-cart',
        taxBps: 0,
        lines: [{ variationId: variation.id, qty: 1, unitPriceCents: 5 }],
      }),
    });
    const saleBody = (await sale.json()) as any;

    const receipt = await platform.app.request('/api/pos/receipts/' + saleBody.data.id, {
      headers: { 'x-tenant-id': tenantId },
    });
    expect(receipt.status).toBe(200);
    const body = (await receipt.json()) as any;
    expect(body.data.merchant).toEqual({
      name: 'POS Tenant',
      receiptFooter: 'Thank you.',
      currency: 'USD',
    });
    expect(body.data.cashier).toEqual({
      id: body.data.order.cashier_id,
      name: 'Owner',
    });
    expect(body.data.order.receipt_number).toBe(saleBody.data.receipt_number);
    expect(body.data.tenders).toEqual([]);
    expect(body.data.refunds).toEqual([]);
    expect(body.data.netPaidCents).toBe(0);
  });

  it('returns register stock with buyer-visible product and SKU identity', async () => {
    const { db, platform, tenantId } = await boot();
    const { location, variation } = await seedSellable(db, platform, tenantId);
    const response = await platform.app.request(`/api/pos/stock?locationId=${location.id}`, {
      headers: { 'x-tenant-id': tenantId },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.data).toEqual([
      expect.objectContaining({
        variationId: variation.id,
        locationId: location.id,
        name: 'Saddle Pad — Medium',
        variationName: 'Medium',
        sku: 'PAD-M',
        onHand: 5,
        reserved: 0,
        available: 5,
      }),
    ]);
  });
});
