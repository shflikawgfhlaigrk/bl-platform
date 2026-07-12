/**
 * Cross-module event wiring — the deterministic glue that turns domain events
 * into inventory movements + owner actions. This is the "integration" the
 * modules deliberately DON'T do themselves (orders never imports inventory,
 * shows never moves stock): they emit; this file reacts.
 *
 * EVERY handler is idempotent and replay-tolerant. Two mechanisms:
 *   - the underlying service call is natively idempotent (inventory
 *     `sellForOrder` / `applyMovement` take an idempotencyKey), OR
 *   - the handler check-then-inserts a dedupe key (`claimOnce`) before a
 *     non-idempotent effect (inventory `reserve`, transfer ship/receive).
 * The EventBus already isolates a throwing handler, but we also wrap each
 * handler so a throw is logged and swallowed (log + continue), never breaking
 * the bus for sibling handlers.
 *
 * Event → handler → idempotency key (see the handler bodies):
 *   orders.order.reserved            → inventory.reserve         reserve:{orderId}:{variationId}
 *   orders.order.paid                → inventory.sellForOrder    order-paid:{orderId}
 *                                    + actions.unassigned_custom_sale  unassigned:{orderId}:{lineId}
 *   orders.order.returned            → inventory movement / action  return:{returnId}:{variationId}
 *   purchasing.purchase_order.received → inventory movement / action  receipt:{receiptId}:{variationId}
 *   shows.manifest.loaded            → inventory transfer (ship)  manifest_loaded:{manifestId}
 *   shows.manifest.returned          → inventory transfer (receive+close)  manifest_returned:{manifestId}
 *   customers.restock.requested      → actions.restock_demand_available  restock:{variationId}
 *   retail.import.quarantined        → actions.quarantined_import_record quarantine_import:{recordId}
 */
import type { Kysely } from 'kysely';
import type { EventBus, PlatformEvent } from '@blacklabel/core';
import type { Logger } from '@blacklabel/admin';
import {
  applyMovement,
  createTransfer,
  getTransfer,
  receiveTransfer,
  reserve,
  sellForOrder,
  shipTransfer,
  closeTransfer,
  type InventoryDatabase,
  type MovementReason,
} from '@blacklabel/inventory';
import { open as openAction, type ActionsDatabase } from '@blacklabel/actions';
import { getOrder, type OrdersDatabase } from '@blacklabel/orders';
import { getShow, type ShowsDatabase } from '@blacklabel/shows';
import { DispatcherRegistry } from '@blacklabel/automation';
import type { ApiDatabase } from './migrations';
import {
  CONFIG_KEYS,
  claimOnce,
  getConfig,
  resolveDefaultLocationId,
  setConfig,
} from './config';

const ACTOR = 'system';

/** Every module table lives in one db; narrow per module at the call site. */
type AnyDb = Kysely<
  InventoryDatabase & ActionsDatabase & OrdersDatabase & ShowsDatabase & ApiDatabase
>;
function as<T>(db: AnyDb): Kysely<T> {
  return db as unknown as Kysely<T>;
}

export interface WiringDeps {
  db: AnyDb;
  events: EventBus;
  logger: Logger;
  /** Process-wide default location fallback (single-tenant dev). */
  envDefaultLocationId?: string;
}

/** Wrap a handler so a throw is logged + swallowed (bus stays healthy). */
function safe<T>(
  logger: Logger,
  name: string,
  fn: (e: PlatformEvent<T>) => Promise<void>,
): (e: PlatformEvent<T>) => Promise<void> {
  return async (e) => {
    try {
      await fn(e);
    } catch (err) {
      logger.error('wiring handler failed', {
        handler: name,
        event: e.type,
        tenantId: e.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

interface StockLine {
  variationId: string;
  qty: number;
  locationId?: string;
  disposition?: 'restock' | 'quarantine' | 'damaged' | 'none';
}

/**
 * Register every cross-module handler. Returns an unsubscribe that detaches all.
 */
export function registerCrossModuleWiring(deps: WiringDeps): () => void {
  const { db, events, logger, envDefaultLocationId } = deps;
  const inv = as<InventoryDatabase>(db);
  const act = as<ActionsDatabase>(db);
  const apiDb = as<ApiDatabase>(db);
  const unsubs: Array<() => void> = [];

  const defaultLoc = (tenantId: string) =>
    resolveDefaultLocationId(apiDb, tenantId, envDefaultLocationId);

  const openSetupRequired = async (tenantId: string, dedupe: string, title: string, evidence: unknown) => {
    await openAction(act, events, tenantId, ACTOR, {
      kind: 'setup_required',
      title,
      priority: 'p2',
      dedupeKey: dedupe,
      evidence,
      sourceModule: 'api',
    });
  };

  /* ---------------- orders.order.reserved → reserve ---------------- */
  unsubs.push(
    events.on(
      'orders.order.reserved',
      safe<{ orderId: string; lines: StockLine[] }>(logger, 'reserve', async (e) => {
        const tenantId = e.tenantId;
        const { orderId, lines } = e.payload;
        let fallback: string | null | undefined;
        for (const line of lines) {
          if (!line.variationId) continue; // custom line — no inventory effect
          let loc = line.locationId;
          if (!loc) {
            fallback = fallback ?? (await defaultLoc(tenantId));
            loc = fallback ?? undefined;
          }
          if (!loc) {
            await openSetupRequired(
              tenantId,
              'setup:default_location',
              'Configure a default inventory location',
              { reason: 'order.reserved had a line with no location and no default is configured', orderId },
            );
            continue;
          }
          const key = `reserve:${orderId}:${line.variationId}`;
          if (!(await claimOnce(apiDb, tenantId, key))) continue; // replay
          await reserve(inv, events, tenantId, ACTOR, {
            variationId: line.variationId,
            locationId: loc,
            qty: line.qty,
            refType: 'order',
            refId: `${orderId}:${line.variationId}`,
          });
        }
      }),
    ),
  );

  /* ---------------- orders.order.paid → sell + custom-sale action ---------------- */
  unsubs.push(
    events.on(
      'orders.order.paid',
      safe<{ orderId: string; totalCents: number; lines: StockLine[] }>(logger, 'paid', async (e) => {
        const tenantId = e.tenantId;
        const { orderId, lines } = e.payload;
        // a) variation-backed lines → single idempotent sellForOrder.
        const sellLines: { variationId: string; qty: number; locationId: string }[] = [];
        let fallback: string | null | undefined;
        let missingLoc = false;
        for (const line of lines) {
          if (!line.variationId) continue;
          let loc = line.locationId;
          if (!loc) {
            fallback = fallback ?? (await defaultLoc(tenantId));
            loc = fallback ?? undefined;
          }
          if (!loc) {
            missingLoc = true;
            continue;
          }
          sellLines.push({ variationId: line.variationId, qty: line.qty, locationId: loc });
        }
        if (missingLoc) {
          await openSetupRequired(
            tenantId,
            'setup:default_location',
            'Configure a default inventory location',
            { reason: 'order.paid had a line with no location and no default is configured', orderId },
          );
        }
        if (sellLines.length > 0) {
          await sellForOrder(inv, events, tenantId, ACTOR, {
            orderId,
            lines: sellLines,
            idempotencyKey: `order-paid:${orderId}`,
          });
        }
        // b) custom/unassigned lines (variation_id === null) → an action each.
        const full = await getOrder(as<OrdersDatabase>(db), tenantId, orderId);
        if (full) {
          for (const l of full.lines) {
            if (l.variation_id !== null) continue;
            await openAction(act, events, tenantId, ACTOR, {
              kind: 'unassigned_custom_sale',
              title: 'Custom sale line has no catalog item',
              priority: 'p3',
              dedupeKey: `unassigned:${orderId}:${l.id}`,
              evidence: { orderId, lineId: l.id, name: (l as { name?: string }).name, qty: l.qty },
              deepLink: `/orders/${orderId}`,
              sourceModule: 'orders',
              sourceEntityType: 'orders.order',
              sourceEntityId: orderId,
            });
          }
        }
      }),
    ),
  );

  /* ---------------- orders.order.returned → restock / disposition ---------------- */
  unsubs.push(
    events.on(
      'orders.order.returned',
      safe<{ orderId: string; returnId: string; lines: StockLine[] }>(logger, 'returned', async (e) => {
        const tenantId = e.tenantId;
        const { orderId, returnId, lines } = e.payload;
        for (const line of lines) {
          if (!line.variationId) continue;
          const disposition = line.disposition ?? 'none';
          if (disposition === 'none') continue;
          const key = `return:${returnId}:${line.variationId}`;
          if (disposition === 'restock') {
            const loc = line.locationId ?? (await defaultLoc(tenantId)) ?? undefined;
            if (!loc) {
              await openSetupRequired(tenantId, 'setup:default_location', 'Configure a default inventory location', {
                reason: 'restock return with no location/default',
                orderId,
                returnId,
              });
              continue;
            }
            await applyMovement(inv, events, tenantId, ACTOR, {
              variationId: line.variationId,
              locationId: loc,
              delta: Math.abs(line.qty),
              reason: 'returned',
              refType: 'return',
              refId: returnId,
              idempotencyKey: key,
            });
          } else {
            // quarantine / damaged → the configured holding location, else action.
            const cfgKey =
              disposition === 'damaged' ? CONFIG_KEYS.damagedLocation : CONFIG_KEYS.quarantineLocation;
            const holdLoc = await getConfig(apiDb, tenantId, cfgKey);
            if (holdLoc) {
              const reason: MovementReason = disposition === 'damaged' ? 'damaged' : 'returned';
              await applyMovement(inv, events, tenantId, ACTOR, {
                variationId: line.variationId,
                locationId: holdLoc,
                delta: Math.abs(line.qty),
                reason,
                refType: 'return',
                refId: returnId,
                idempotencyKey: key,
              });
            } else {
              await openAction(act, events, tenantId, ACTOR, {
                kind: 'return_awaiting_disposition',
                title: `Returned item needs a ${disposition} location`,
                priority: 'p3',
                dedupeKey: `return_dispo:${returnId}:${line.variationId}`,
                evidence: { orderId, returnId, variationId: line.variationId, disposition },
                sourceModule: 'orders',
                sourceEntityType: 'orders.return',
                sourceEntityId: returnId,
              });
            }
          }
        }
      }),
    ),
  );

  /* ---------------- purchasing.purchase_order.received → receiving movements ---------------- */
  unsubs.push(
    events.on(
      'purchasing.purchase_order.received',
      safe<{
        purchaseOrderId: string;
        receiptId: string;
        lines: { variationId: string; qty: number; condition: 'ok' | 'damaged' | 'wrong_item'; unitCostCents: number }[];
      }>(logger, 'po_received', async (e) => {
        const tenantId = e.tenantId;
        const { purchaseOrderId, receiptId, lines } = e.payload;
        const receiveLoc = await defaultLoc(tenantId);
        for (const line of lines) {
          const key = `receipt:${receiptId}:${line.variationId}`;
          if (line.condition === 'ok') {
            if (!receiveLoc) {
              await openSetupRequired(tenantId, 'setup:default_location', 'Configure a default inventory location', {
                reason: 'PO received with no default receiving location',
                purchaseOrderId,
                receiptId,
              });
              continue;
            }
            await applyMovement(inv, events, tenantId, ACTOR, {
              variationId: line.variationId,
              locationId: receiveLoc,
              delta: Math.abs(line.qty),
              reason: 'received',
              refType: 'receipt',
              refId: receiptId,
              idempotencyKey: key,
            });
          } else if (line.condition === 'damaged') {
            const damagedLoc = await getConfig(apiDb, tenantId, CONFIG_KEYS.damagedLocation);
            if (damagedLoc) {
              await applyMovement(inv, events, tenantId, ACTOR, {
                variationId: line.variationId,
                locationId: damagedLoc,
                delta: Math.abs(line.qty),
                reason: 'damaged',
                refType: 'receipt',
                refId: receiptId,
                idempotencyKey: key,
              });
            } else {
              await openSetupRequired(
                tenantId,
                'setup:damaged_location',
                'Configure a damaged-goods location',
                { reason: 'PO received a damaged line with no damaged location', purchaseOrderId, receiptId, variationId: line.variationId },
              );
            }
          } else {
            // wrong_item → receipt/invoice mismatch action (no inventory effect).
            await openAction(act, events, tenantId, ACTOR, {
              kind: 'receipt_invoice_mismatch',
              title: 'Wrong item received against PO',
              priority: 'p2',
              dedupeKey: `rim:${receiptId}:${line.variationId}`,
              evidence: { purchaseOrderId, receiptId, variationId: line.variationId, condition: 'wrong_item' },
              sourceModule: 'purchasing',
              sourceEntityType: 'purchasing.receipt',
              sourceEntityId: receiptId,
            });
          }
        }
      }),
    ),
  );

  /* ---------------- shows.manifest.loaded → transfer (ship) ---------------- */
  unsubs.push(
    events.on(
      'shows.manifest.loaded',
      safe<{ manifestId: string; showId: string; lines: { variationId: string; packedQty: number }[] }>(
        logger,
        'manifest_loaded',
        async (e) => {
          const tenantId = e.tenantId;
          const { manifestId, showId, lines } = e.payload;
          const key = `manifest_loaded:${manifestId}`;
          if (!(await claimOnce(apiDb, tenantId, key))) return; // replay
          const warehouse = await defaultLoc(tenantId);
          const show = await getShow(as<ShowsDatabase>(db), tenantId, showId);
          const showLoc = show.location_id;
          if (!warehouse || !showLoc) {
            await openSetupRequired(
              tenantId,
              `setup:show_location:${showId}`,
              'Configure the warehouse + show inventory locations',
              { reason: 'manifest load-out needs both a default warehouse and a show location', showId, manifestId, hasWarehouse: !!warehouse, hasShowLocation: !!showLoc },
            );
            return;
          }
          const packLines = lines
            .filter((l) => l.variationId && l.packedQty > 0)
            .map((l) => ({ variationId: l.variationId, qtySent: l.packedQty }));
          if (packLines.length === 0) return;
          const { transfer } = await createTransfer(inv, tenantId, ACTOR, warehouse, showLoc, packLines);
          await shipTransfer(inv, events, tenantId, ACTOR, transfer.id);
          // Remember the transfer so the return handler can receive it back.
          await setConfig(apiDb, tenantId, `${CONFIG_KEYS.manifestTransferPrefix}${manifestId}`, transfer.id);
        },
      ),
    ),
  );

  /* ---------------- shows.manifest.returned → transfer (receive + close) ---------------- */
  unsubs.push(
    events.on(
      'shows.manifest.returned',
      safe<{
        manifestId: string;
        showId: string;
        lines: { variationId: string; packedQty: number; returnedQty: number }[];
      }>(logger, 'manifest_returned', async (e) => {
        const tenantId = e.tenantId;
        const { manifestId, lines } = e.payload;
        const key = `manifest_returned:${manifestId}`;
        if (!(await claimOnce(apiDb, tenantId, key))) return; // replay
        const transferId = await getConfig(apiDb, tenantId, `${CONFIG_KEYS.manifestTransferPrefix}${manifestId}`);
        if (!transferId) {
          await openSetupRequired(tenantId, `manifest_no_transfer:${manifestId}`, 'Show return without a load-out transfer', {
            reason: 'manifest.returned arrived but no load-out transfer was recorded (load-out never processed)',
            manifestId,
          });
          return;
        }
        const { lines: transferLines } = await getTransfer(inv, tenantId, transferId);
        const lineByVariation = new Map(transferLines.map((tl) => [tl.variation_id, tl.id]));
        const receipts = lines
          .filter((l) => lineByVariation.has(l.variationId))
          .map((l) => ({ lineId: lineByVariation.get(l.variationId)!, qtyReceived: Math.max(0, l.returnedQty) }));
        await receiveTransfer(inv, events, tenantId, ACTOR, transferId, receipts);
        // Close computes discrepancies (packed vs returned = sold/lost at the show)
        // and emits inventory.transfer.closed, which actions turns into a task.
        await closeTransfer(inv, events, tenantId, ACTOR, transferId, `show manifest ${manifestId} closeout`);
      }),
    ),
  );

  /* ---------------- customers.restock.requested → restock action ---------------- */
  unsubs.push(
    events.on(
      'customers.restock.requested',
      safe<{ variationId: string; customerId?: string }>(logger, 'restock', async (e) => {
        const tenantId = e.tenantId;
        const { variationId, customerId } = e.payload;
        await openAction(act, events, tenantId, ACTOR, {
          kind: 'restock_demand_available',
          title: 'Customer requested restock',
          priority: 'p3',
          dedupeKey: `restock:${variationId}`,
          evidence: { variationId, ...(customerId ? { customerId } : {}) },
          deepLink: `/inventory/variations/${variationId}`,
          sourceModule: 'customers',
          sourceEntityType: 'customers.restock_request',
          sourceEntityId: variationId,
        });
      }),
    ),
  );

  /* ---------------- retail.import.quarantined → action ---------------- */
  unsubs.push(
    events.on(
      'retail.import.quarantined',
      safe<{ quarantineId?: string; manifestId?: string; kind?: string }>(
        logger,
        'quarantined_import',
        async (e) => {
          const tenantId = e.tenantId;
          const p = e.payload;
          const recordId = p.quarantineId ?? p.manifestId ?? JSON.stringify(p);
          await openAction(act, events, tenantId, ACTOR, {
            kind: 'quarantined_import_record',
            title: 'Import record quarantined',
            priority: 'p2',
            dedupeKey: `quarantine_import:${recordId}`,
            evidence: p,
            sourceModule: 'retail',
            sourceEntityType: 'retail.import_record',
            sourceEntityId: String(recordId),
          });
        },
      ),
    ),
  );

  /* ---------------- retail.import.reconciliation_failed → action ---------------- */
  unsubs.push(
    events.on(
      'retail.import.reconciliation_failed',
      safe<{ manifestId?: string; kind?: string }>(logger, 'import_reconciliation_failed', async (e) => {
        const tenantId = e.tenantId;
        const p = e.payload;
        const manifestId = p.manifestId ?? 'unknown';
        await openAction(act, events, tenantId, ACTOR, {
          kind: 'import_failed',
          title: 'Import reconciliation failed',
          priority: 'p2',
          dedupeKey: `import_recon:${manifestId}:${p.kind ?? 'all'}`,
          evidence: p,
          sourceModule: 'retail',
          sourceEntityType: 'retail.import_manifest',
          sourceEntityId: String(manifestId),
        });
      }),
    ),
  );

  return () => {
    for (const u of unsubs) u();
  };
}

/* ------------------------------------------------------------------ *
 * Outbox dispatcher registry — the integrator's effect handlers.
 * ------------------------------------------------------------------ */

/**
 * Build the DispatcherRegistry the automation outbox drains through.
 *  - `po.send.email` / `campaign.send`: HONEST 501-style handlers. Real
 *    transports are founder-gated (admin-configured credentials); until then a
 *    throw marks the row failed with 'no transport configured' (it backs off and
 *    dead-letters — never silently "succeeds").
 *  - `noop.log`: a real no-op used to exercise rules end to end.
 */
export function buildDispatcherRegistry(logger: Logger): DispatcherRegistry {
  const registry = new DispatcherRegistry();
  const noTransport = (kind: string): never => {
    throw new Error(`no transport configured for "${kind}"`);
  };
  registry.register('po.send.email', () => noTransport('po.send.email'));
  registry.register('campaign.send', () => noTransport('campaign.send'));
  registry.register('noop.log', (job) => {
    logger.info('outbox noop.log', { outboxId: job.id, kind: job.kind });
  });
  return registry;
}
