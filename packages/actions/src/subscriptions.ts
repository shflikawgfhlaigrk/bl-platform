import type { ModuleDeps } from '@blacklabel/core';
import type { ActionsDatabase } from './schema';
import { autoResolveByDedupeKey, open } from './service';

/**
 * Event-driven action derivation. The integrator calls this once with the
 * actions module's deps; it subscribes to the canonical event catalog
 * (CONTRACTS-MAGS §2) and turns domain conditions into (deduped) actions or
 * auto-resolves them. Every handler is idempotent — the dedupe_key does the
 * work, so replayed/duplicate events never create duplicates and auto-resolves
 * of already-resolved / never-opened conditions are safe no-ops.
 *
 * Returns an unsubscribe function that detaches every handler.
 *
 * Rules (deterministic):
 *  - inventory.stock.below_reorder_point → OPEN stock_below_reorder_point
 *      dedupe `sbrp:{variationId}:{locationId}`
 *  - inventory.stock.changed (onHand > 0 AND reason === 'received') →
 *      AUTO-RESOLVE the matching sbrp action (stock replenished by a receipt)
 *  - inventory.transfer.closed (discrepancyCount > 0) → OPEN transfer_not_received
 *      dedupe `transfer:{transferId}`
 *  - purchasing.purchase_order.approved → AUTO-RESOLVE po_awaiting_approval
 *      dedupe `po:{purchaseOrderId}`
 *  - shows.packing.required → OPEN show_packing_incomplete
 *      dedupe `show_packing:{showId}`
 *  - finance.payout.reconciliation_failed → OPEN payout_mismatch
 *      dedupe `payout:{payoutId}`
 *  - orders.order.fulfilled → AUTO-RESOLVE order_awaiting_fulfillment
 *      dedupe `order_fulfill:{orderId}`
 */
export function registerActionsSubscriptions(deps: ModuleDeps<ActionsDatabase>): () => void {
  const { db, events } = deps;
  const actor = 'system';
  const unsubs: Array<() => void> = [];

  unsubs.push(
    events.on('inventory.stock.below_reorder_point', async (e) => {
      const p = e.payload as {
        variationId: string;
        locationId: string;
        onHand?: number;
        reorderPoint?: number;
      };
      await open(db, events, e.tenantId, actor, {
        kind: 'stock_below_reorder_point',
        title: `Stock below reorder point`,
        priority: 'p2',
        dedupeKey: `sbrp:${p.variationId}:${p.locationId}`,
        evidence: p,
        deepLink: `/inventory/variations/${p.variationId}`,
        sourceModule: 'inventory',
        sourceEntityType: 'inventory.variation',
        sourceEntityId: p.variationId,
      });
    }),
  );

  unsubs.push(
    events.on('inventory.stock.changed', async (e) => {
      const p = e.payload as {
        variationId: string;
        locationId: string;
        onHand?: number;
        reason?: string;
      };
      if ((p.onHand ?? 0) > 0 && p.reason === 'received') {
        await autoResolveByDedupeKey(
          db,
          events,
          e.tenantId,
          actor,
          `sbrp:${p.variationId}:${p.locationId}`,
          { reason: 'received', onHand: p.onHand },
        );
      }
    }),
  );

  unsubs.push(
    events.on('inventory.transfer.closed', async (e) => {
      const p = e.payload as {
        transferId: string;
        fromLocationId?: string;
        toLocationId?: string;
        discrepancyCount?: number;
      };
      if ((p.discrepancyCount ?? 0) > 0) {
        await open(db, events, e.tenantId, actor, {
          kind: 'transfer_not_received',
          title: `Transfer closed with ${p.discrepancyCount} discrepanc${
            p.discrepancyCount === 1 ? 'y' : 'ies'
          }`,
          priority: 'p2',
          dedupeKey: `transfer:${p.transferId}`,
          evidence: p,
          deepLink: `/inventory/transfers/${p.transferId}`,
          sourceModule: 'inventory',
          sourceEntityType: 'inventory.transfer',
          sourceEntityId: p.transferId,
        });
      }
    }),
  );

  unsubs.push(
    events.on('purchasing.purchase_order.approved', async (e) => {
      const p = e.payload as { purchaseOrderId: string };
      await autoResolveByDedupeKey(
        db,
        events,
        e.tenantId,
        actor,
        `po:${p.purchaseOrderId}`,
        { via: 'purchasing.purchase_order.approved' },
      );
    }),
  );

  unsubs.push(
    events.on('shows.packing.required', async (e) => {
      const p = e.payload as { showId: string };
      await open(db, events, e.tenantId, actor, {
        kind: 'show_packing_incomplete',
        title: `Show packing incomplete`,
        priority: 'p2',
        dedupeKey: `show_packing:${p.showId}`,
        evidence: p,
        deepLink: `/shows/${p.showId}/packing`,
        sourceModule: 'shows',
        sourceEntityType: 'shows.show',
        sourceEntityId: p.showId,
      });
    }),
  );

  unsubs.push(
    events.on('finance.payout.reconciliation_failed', async (e) => {
      const p = e.payload as { payoutId: string; deltaCents?: number };
      await open(db, events, e.tenantId, actor, {
        kind: 'payout_mismatch',
        title: `Payout reconciliation failed`,
        priority: 'p1',
        dedupeKey: `payout:${p.payoutId}`,
        evidence: p,
        deepLink: `/finance/payouts/${p.payoutId}`,
        sourceModule: 'finance',
        sourceEntityType: 'finance.payout',
        sourceEntityId: p.payoutId,
      });
    }),
  );

  unsubs.push(
    events.on('orders.order.fulfilled', async (e) => {
      const p = e.payload as { orderId: string };
      await autoResolveByDedupeKey(
        db,
        events,
        e.tenantId,
        actor,
        `order_fulfill:${p.orderId}`,
        { via: 'orders.order.fulfilled' },
      );
    }),
  );

  return () => {
    for (const u of unsubs) u();
  };
}
