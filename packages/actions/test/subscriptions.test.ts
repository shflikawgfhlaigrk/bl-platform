import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { registerActionsSubscriptions } from '../src/subscriptions';
import { listByKind, listQueue, open } from '../src/service';

describe('actions subscriptions — event-driven derivation', () => {
  it('inventory.stock.below_reorder_point opens a deduped sbrp action', async () => {
    const { db, events, tenantA } = await setup();
    registerActionsSubscriptions({ db, events, contracts: {} });

    const payload = { v: 1, variationId: 'var_1', locationId: 'loc_1', onHand: 1, reorderPoint: 5 };
    await events.emit(tenantA.id, 'inventory.stock.below_reorder_point', payload);
    // Duplicate/replay: still one action.
    await events.emit(tenantA.id, 'inventory.stock.below_reorder_point', payload);

    const queue = await listByKind(db, tenantA.id, 'stock_below_reorder_point');
    expect(queue).toHaveLength(1);
    expect(queue[0].dedupe_key).toBe('sbrp:var_1:loc_1');
    expect(queue[0].evidence).toMatchObject({ variationId: 'var_1', onHand: 1 });
    expect(queue[0].source_entity_id).toBe('var_1');
  });

  it('inventory.stock.changed auto-resolves sbrp only when onHand>0 AND reason=received', async () => {
    const { db, events, tenantA } = await setup();
    registerActionsSubscriptions({ db, events, contracts: {} });

    await events.emit(tenantA.id, 'inventory.stock.below_reorder_point', {
      v: 1,
      variationId: 'var_1',
      locationId: 'loc_1',
      onHand: 0,
      reorderPoint: 5,
    });
    expect(await listQueue(db, tenantA.id)).toHaveLength(1);

    // Wrong reason -> stays open.
    await events.emit(tenantA.id, 'inventory.stock.changed', {
      v: 1,
      variationId: 'var_1',
      locationId: 'loc_1',
      delta: 3,
      onHand: 3,
      movementId: 'm1',
      reason: 'adjustment',
    });
    expect(await listQueue(db, tenantA.id)).toHaveLength(1);

    // received with stock -> auto-resolved.
    await events.emit(tenantA.id, 'inventory.stock.changed', {
      v: 1,
      variationId: 'var_1',
      locationId: 'loc_1',
      delta: 10,
      onHand: 10,
      movementId: 'm2',
      reason: 'received',
    });
    const active = await listQueue(db, tenantA.id);
    expect(active).toHaveLength(0);
    const all = await listByKind(db, tenantA.id, 'stock_below_reorder_point');
    // still present in history, but resolved via auto
    const resolved = await listQueue(db, tenantA.id, { status: 'resolved' });
    expect(resolved).toHaveLength(1);
    expect(resolved[0].resolution_kind).toBe('auto');
    expect(all.length).toBe(0); // listByKind is active-only
  });

  it('inventory.transfer.closed opens transfer_not_received only when discrepancyCount>0', async () => {
    const { db, events, tenantA } = await setup();
    registerActionsSubscriptions({ db, events, contracts: {} });

    await events.emit(tenantA.id, 'inventory.transfer.closed', {
      v: 1,
      transferId: 't_clean',
      fromLocationId: 'l1',
      toLocationId: 'l2',
      discrepancyCount: 0,
    });
    expect(await listByKind(db, tenantA.id, 'transfer_not_received')).toHaveLength(0);

    await events.emit(tenantA.id, 'inventory.transfer.closed', {
      v: 1,
      transferId: 't_bad',
      fromLocationId: 'l1',
      toLocationId: 'l2',
      discrepancyCount: 2,
    });
    const rows = await listByKind(db, tenantA.id, 'transfer_not_received');
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe('transfer:t_bad');
  });

  it('purchasing.purchase_order.approved auto-resolves a po_awaiting_approval action', async () => {
    const { db, events, tenantA } = await setup();
    registerActionsSubscriptions({ db, events, contracts: {} });

    await open(db, events, tenantA.id, 'system', {
      kind: 'po_awaiting_approval',
      title: 'PO awaiting approval',
      priority: 'p2',
      dedupeKey: 'po:po_1',
      sourceEntityType: 'purchasing.purchase_order',
      sourceEntityId: 'po_1',
    });
    expect(await listQueue(db, tenantA.id)).toHaveLength(1);

    await events.emit(tenantA.id, 'purchasing.purchase_order.approved', {
      v: 1,
      purchaseOrderId: 'po_1',
      vendorId: 'v1',
      totalCents: 1000,
    });
    expect(await listQueue(db, tenantA.id)).toHaveLength(0);
  });

  it('shows.packing.required opens show_packing_incomplete', async () => {
    const { db, events, tenantA } = await setup();
    registerActionsSubscriptions({ db, events, contracts: {} });
    await events.emit(tenantA.id, 'shows.packing.required', { v: 1, showId: 'show_1' });
    const rows = await listByKind(db, tenantA.id, 'show_packing_incomplete');
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe('show_packing:show_1');
  });

  it('finance.payout.reconciliation_failed opens a p1 payout_mismatch', async () => {
    const { db, events, tenantA } = await setup();
    registerActionsSubscriptions({ db, events, contracts: {} });
    await events.emit(tenantA.id, 'finance.payout.reconciliation_failed', {
      v: 1,
      payoutId: 'po_x',
      deltaCents: -500,
    });
    const rows = await listByKind(db, tenantA.id, 'payout_mismatch');
    expect(rows).toHaveLength(1);
    expect(rows[0].priority).toBe('p1');
    expect(rows[0].evidence).toMatchObject({ deltaCents: -500 });
  });

  it('orders.order.fulfilled auto-resolves order_awaiting_fulfillment', async () => {
    const { db, events, tenantA } = await setup();
    registerActionsSubscriptions({ db, events, contracts: {} });
    await open(db, events, tenantA.id, 'system', {
      kind: 'order_awaiting_fulfillment',
      title: 'Order awaiting fulfillment',
      priority: 'p2',
      dedupeKey: 'order_fulfill:ord_1',
    });
    expect(await listQueue(db, tenantA.id)).toHaveLength(1);
    await events.emit(tenantA.id, 'orders.order.fulfilled', { v: 1, orderId: 'ord_1' });
    expect(await listQueue(db, tenantA.id)).toHaveLength(0);
  });

  it('unsubscribe detaches all handlers', async () => {
    const { db, events, tenantA } = await setup();
    const off = registerActionsSubscriptions({ db, events, contracts: {} });
    off();
    await events.emit(tenantA.id, 'shows.packing.required', { v: 1, showId: 'show_2' });
    expect(await listQueue(db, tenantA.id)).toHaveLength(0);
  });

  it('emits actions.action.created / resolved through the bus during derivation', async () => {
    const { db, events, tenantA } = await setup();
    registerActionsSubscriptions({ db, events, contracts: {} });
    const created: any[] = [];
    const resolved: any[] = [];
    events.on('actions.action.created', (e) => {
      created.push(e.payload);
    });
    events.on('actions.action.resolved', (e) => {
      resolved.push(e.payload);
    });

    await events.emit(tenantA.id, 'inventory.stock.below_reorder_point', {
      v: 1,
      variationId: 'var_9',
      locationId: 'loc_9',
      onHand: 0,
      reorderPoint: 4,
    });
    await events.emit(tenantA.id, 'inventory.stock.changed', {
      v: 1,
      variationId: 'var_9',
      locationId: 'loc_9',
      delta: 5,
      onHand: 5,
      movementId: 'm9',
      reason: 'received',
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ v: 1, kind: 'stock_below_reorder_point' });
    expect(resolved).toHaveLength(1);
  });
});
