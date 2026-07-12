import { z, type ZodTypeAny } from 'zod';

/**
 * Event schema registry — a Zod schema for every canonical event in
 * CONTRACTS-MAGS §2. Each payload carries `v: 1` plus its minimum fields.
 * Schemas `.passthrough()` so real payloads may carry extra fields; only the
 * documented minimum is enforced. evaluate() uses `validateEvent` to record
 * validation failures as a distinct outcome instead of throwing.
 */

const nonEmpty = z.string().min(1);
const cents = z.number().int();
const v1 = z.literal(1);

export const eventSchemas: Record<string, ZodTypeAny> = {
  'catalog.variation.changed': z.object({ v: v1, variationId: nonEmpty }).passthrough(),
  'catalog.publication.changed': z
    .object({ v: v1, itemIds: z.array(nonEmpty) })
    .passthrough(),
  'inventory.count.completed': z
    .object({ v: v1, countSessionId: nonEmpty, locationId: nonEmpty })
    .passthrough(),
  'inventory.stock.changed': z
    .object({
      v: v1,
      variationId: nonEmpty,
      locationId: nonEmpty,
      delta: z.number().int(),
      onHand: z.number().int(),
      movementId: nonEmpty,
      reason: nonEmpty,
    })
    .passthrough(),
  'inventory.stock.below_reorder_point': z
    .object({
      v: v1,
      variationId: nonEmpty,
      locationId: nonEmpty,
      onHand: z.number().int(),
      reorderPoint: z.number().int(),
    })
    .passthrough(),
  'inventory.transfer.closed': z
    .object({
      v: v1,
      transferId: nonEmpty,
      fromLocationId: nonEmpty,
      toLocationId: nonEmpty,
      discrepancyCount: z.number().int(),
    })
    .passthrough(),
  'shows.show.scheduled': z.object({ v: v1, showId: nonEmpty, startsAt: nonEmpty }).passthrough(),
  'shows.packing.required': z.object({ v: v1, showId: nonEmpty }).passthrough(),
  'shows.show.closed': z.object({ v: v1, showId: nonEmpty }).passthrough(),
  'purchasing.purchase_order.approved': z
    .object({ v: v1, purchaseOrderId: nonEmpty, vendorId: nonEmpty, totalCents: cents })
    .passthrough(),
  'purchasing.purchase_order.received': z
    .object({ v: v1, purchaseOrderId: nonEmpty, receiptId: nonEmpty })
    .passthrough(),
  'orders.order.reserved': z.object({ v: v1, orderId: nonEmpty }).passthrough(),
  'orders.order.paid': z.object({ v: v1, orderId: nonEmpty, totalCents: cents }).passthrough(),
  'orders.order.fulfilled': z.object({ v: v1, orderId: nonEmpty }).passthrough(),
  'orders.order.returned': z.object({ v: v1, orderId: nonEmpty, returnId: nonEmpty }).passthrough(),
  'customers.consent.changed': z
    .object({ v: v1, customerId: nonEmpty, channel: nonEmpty, state: nonEmpty })
    .passthrough(),
  'customers.restock.requested': z
    .object({ v: v1, variationId: nonEmpty, customerId: nonEmpty.optional() })
    .passthrough(),
  'outreach.delivery.changed': z.object({ v: v1, sendId: nonEmpty, state: nonEmpty }).passthrough(),
  'finance.payout.reconciliation_failed': z
    .object({ v: v1, payoutId: nonEmpty, deltaCents: cents })
    .passthrough(),
  'actions.action.created': z.object({ v: v1, actionId: nonEmpty, kind: nonEmpty }).passthrough(),
  'actions.action.resolved': z.object({ v: v1, actionId: nonEmpty }).passthrough(),
};

/** Canonical event names known to the registry. */
export const KNOWN_MAGS_EVENTS = Object.keys(eventSchemas);

export interface ValidateEventResult {
  ok: boolean;
  /** Human-readable messages; empty when ok. */
  errors: string[];
  /** True when the type has no registered schema (nothing to enforce). */
  unknown: boolean;
}

/**
 * Validate an event payload against its registered schema.
 * Unknown event types validate OK (`unknown:true`) — modules may emit internal
 * events the registry does not know, and those must not be blocked.
 */
export function validateEvent(type: string, payload: unknown): ValidateEventResult {
  const schema = eventSchemas[type];
  if (!schema) return { ok: true, errors: [], unknown: true };
  const parsed = schema.safeParse(payload);
  if (parsed.success) return { ok: true, errors: [], unknown: false };
  const errors = parsed.error.issues.map(
    (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
  );
  return { ok: false, errors, unknown: false };
}
