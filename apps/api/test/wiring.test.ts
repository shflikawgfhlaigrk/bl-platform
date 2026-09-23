import { authenticatedFixture } from './authenticated-fixture';
/**
 * Cross-module event wiring — integration-level proof that the composition
 * root's glue turns domain events into inventory movements + owner actions,
 * idempotently and replay-tolerantly.
 */
import { describe, it, expect } from 'vitest';
import { asCoreDb, createTenant } from '@blacklabel/core';
import { createTestDb } from '@blacklabel/db';
import {
  applyMovement,
  createLocation,
  getStock,
  type InventoryDatabase,
} from '@blacklabel/inventory';
import { createOrder, type OrdersDatabase } from '@blacklabel/orders';
import { listByKind, type ActionsDatabase } from '@blacklabel/actions';
import {
  createShow,
  createVenue,
  setShowLocation,
  type ShowsDatabase,
} from '@blacklabel/shows';
import { createApp, type PlatformDatabase } from '../src/app';
import { CONFIG_KEYS, setConfig } from '../src/config';
import type { ApiDatabase } from '../src/migrations';

const KEY = Buffer.alloc(32, 7);

async function boot() {
  const db = createTestDb<PlatformDatabase>();
  const platform = await createApp({ db, adminMasterKey: KEY });
  authenticatedFixture(platform);
  const tenant = await createTenant(asCoreDb(db), { name: 'Wiring Tenant' });
  return { platform, db, tenantId: tenant.id };
}

const inv = (db: unknown) => db as import('kysely').Kysely<InventoryDatabase>;
const ord = (db: unknown) => db as import('kysely').Kysely<OrdersDatabase>;
const act = (db: unknown) => db as import('kysely').Kysely<ActionsDatabase>;
const shw = (db: unknown) => db as import('kysely').Kysely<ShowsDatabase>;
const api = (db: unknown) => db as import('kysely').Kysely<ApiDatabase>;

/** Seed a default warehouse location (config'd as default) + optional stock. */
async function seedWarehouse(
  platform: Awaited<ReturnType<typeof boot>>['platform'],
  db: unknown,
  tenantId: string,
  variations: { variationId: string; onHand: number }[],
) {
  const loc = await createLocation(inv(db), tenantId, 'system', {
    name: 'Warehouse',
    kind: 'warehouse',
    oversellPolicy: 'allow_flag',
  });
  await setConfig(api(db), tenantId, CONFIG_KEYS.defaultLocation, loc.id);
  for (const v of variations) {
    if (v.onHand !== 0) {
      await applyMovement(inv(db), platform.events, tenantId, 'system', {
        variationId: v.variationId,
        locationId: loc.id,
        delta: v.onHand,
        reason: 'received',
      });
    }
  }
  return loc.id;
}

async function onHand(db: unknown, tenantId: string, variationId: string, locationId: string) {
  const rows = await getStock(inv(db), tenantId, { variationId, locationId });
  return rows[0]?.onHand ?? 0;
}

describe('cross-module wiring', () => {
  it('orders.order.paid decrements stock exactly once, even when emitted twice (journey 8)', async () => {
    const { platform, db, tenantId } = await boot();
    const locId = await seedWarehouse(platform, db, tenantId, [{ variationId: 'v1', onHand: 10 }]);

    const payload = {
      v: 1,
      orderId: 'ord-1',
      totalCents: 300,
      lines: [{ variationId: 'v1', qty: 3, locationId: locId }],
    };
    await platform.events.emit(tenantId, 'orders.order.paid', payload);
    await platform.events.emit(tenantId, 'orders.order.paid', payload); // replay

    expect(await onHand(db, tenantId, 'v1', locId)).toBe(7);
  });

  it('orders.order.reserved reserves available stock once (replay-safe)', async () => {
    const { platform, db, tenantId } = await boot();
    const locId = await seedWarehouse(platform, db, tenantId, [{ variationId: 'v1', onHand: 10 }]);

    const payload = { v: 1, orderId: 'ord-2', lines: [{ variationId: 'v1', qty: 4, locationId: locId }] };
    await platform.events.emit(tenantId, 'orders.order.reserved', payload);
    await platform.events.emit(tenantId, 'orders.order.reserved', payload); // replay

    const rows = await getStock(inv(db), tenantId, { variationId: 'v1', locationId: locId });
    expect(rows[0]?.reserved).toBe(4);
    expect(rows[0]?.available).toBe(6);
  });

  it('order.paid with a null-variation line opens exactly one unassigned_custom_sale action', async () => {
    const { platform, db, tenantId } = await boot();
    const locId = await seedWarehouse(platform, db, tenantId, [{ variationId: 'v1', onHand: 10 }]);

    const { order, lines } = await createOrder({ db: ord(db), events: platform.events }, tenantId, 'system', {
      channel: 'pos',
      lines: [
        { variationId: 'v1', locationId: locId, description: 'catalog item', qty: 1, unitPriceCents: 100 },
        { description: 'custom engraving', qty: 1, unitPriceCents: 500 },
      ],
    });
    const variationLines = lines
      .filter((l) => l.variation_id)
      .map((l) => ({ variationId: l.variation_id as string, qty: l.qty, locationId: locId }));

    await platform.events.emit(tenantId, 'orders.order.paid', {
      v: 1,
      orderId: order.id,
      totalCents: 600,
      lines: variationLines,
    });

    const actions = await listByKind(act(db), tenantId, 'unassigned_custom_sale');
    expect(actions).toHaveLength(1);
    const customLine = lines.find((l) => l.variation_id === null)!;
    expect(actions[0].dedupe_key).toBe(`unassigned:${order.id}:${customLine.id}`);
  });

  it('purchasing.purchase_order.received applies ok/damaged movements and a wrong_item action', async () => {
    const { platform, db, tenantId } = await boot();
    const warehouse = await seedWarehouse(platform, db, tenantId, []);
    const damaged = await createLocation(inv(db), tenantId, 'system', { name: 'Damaged', kind: 'damaged' });
    await setConfig(api(db), tenantId, CONFIG_KEYS.damagedLocation, damaged.id);

    await platform.events.emit(tenantId, 'purchasing.purchase_order.received', {
      v: 1,
      purchaseOrderId: 'po-1',
      receiptId: 'rcpt-1',
      lines: [
        { variationId: 'ok1', qty: 5, condition: 'ok', unitCostCents: 100 },
        { variationId: 'dmg1', qty: 2, condition: 'damaged', unitCostCents: 100 },
        { variationId: 'wrong1', qty: 1, condition: 'wrong_item', unitCostCents: 100 },
      ],
    });

    expect(await onHand(db, tenantId, 'ok1', warehouse)).toBe(5);
    expect(await onHand(db, tenantId, 'dmg1', damaged.id)).toBe(2);
    const mismatch = await listByKind(act(db), tenantId, 'receipt_invoice_mismatch');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0].dedupe_key).toBe('rim:rcpt-1:wrong1');
  });

  it('shows.manifest.loaded ships a warehouse→show transfer idempotently', async () => {
    const { platform, db, tenantId } = await boot();
    const warehouse = await seedWarehouse(platform, db, tenantId, [{ variationId: 'v1', onHand: 10 }]);
    const showLoc = await createLocation(inv(db), tenantId, 'system', { name: 'Booth', kind: 'show' });

    const venue = await createVenue(shw(db), tenantId, 'system', { name: 'Fairgrounds', state: 'GA' });
    const show = await createShow(shw(db), platform.events, tenantId, 'system', {
      venueId: venue.id,
      name: 'Spring Show',
      startsOn: '2026-08-01',
      endsOn: '2026-08-03',
    });
    await setShowLocation(shw(db), tenantId, 'system', show.id, showLoc.id);

    const payload = {
      v: 1,
      manifestId: 'man-1',
      showId: show.id,
      lines: [{ variationId: 'v1', packedQty: 4 }],
    };
    await platform.events.emit(tenantId, 'shows.manifest.loaded', payload);
    await platform.events.emit(tenantId, 'shows.manifest.loaded', payload); // replay

    // Shipped 4 out of the warehouse exactly once.
    expect(await onHand(db, tenantId, 'v1', warehouse)).toBe(6);
  });

  it('customers.restock.requested opens a restock_demand_available action (deduped per variation)', async () => {
    const { platform, db, tenantId } = await boot();
    await platform.events.emit(tenantId, 'customers.restock.requested', { v: 1, variationId: 'v9' });
    await platform.events.emit(tenantId, 'customers.restock.requested', { v: 1, variationId: 'v9' });

    const actions = await listByKind(act(db), tenantId, 'restock_demand_available');
    expect(actions).toHaveLength(1);
    expect(actions[0].dedupe_key).toBe('restock:v9');
  });

  it('retail.import.quarantined opens a quarantined_import_record action', async () => {
    const { platform, db, tenantId } = await boot();
    await platform.events.emit(tenantId, 'retail.import.quarantined', {
      v: 1,
      manifestId: 'mani-1',
      quarantineId: 'q-1',
      kind: 'payment',
    });
    const actions = await listByKind(act(db), tenantId, 'quarantined_import_record');
    expect(actions).toHaveLength(1);
    expect(actions[0].dedupe_key).toBe('quarantine_import:q-1');
  });

  it('orders.order.returned with restock disposition adds stock back once', async () => {
    const { platform, db, tenantId } = await boot();
    const locId = await seedWarehouse(platform, db, tenantId, [{ variationId: 'v1', onHand: 5 }]);

    const payload = {
      v: 1,
      orderId: 'ord-9',
      returnId: 'ret-1',
      lines: [{ variationId: 'v1', qty: 2, disposition: 'restock', locationId: locId }],
    };
    await platform.events.emit(tenantId, 'orders.order.returned', payload);
    await platform.events.emit(tenantId, 'orders.order.returned', payload); // replay

    expect(await onHand(db, tenantId, 'v1', locId)).toBe(7);
  });
});
