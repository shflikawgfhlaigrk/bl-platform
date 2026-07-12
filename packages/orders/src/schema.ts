import type { CoreDatabase } from '@blacklabel/core';

/**
 * Orders module schema — the UNIFIED operational order model for NEW orders
 * (POS / storefront / manual / phone / invoice / show). Historical Square
 * sales stay in the `retail_*` tables; this module never joins into them, it
 * only references their ids as opaque strings (see `source`/`source_order_id`).
 *
 * Conventions (see /CONVENTIONS.md): text ids from id(), ISO-8601 UTC text
 * timestamps from nowIso(), integer cents for money, basis points for
 * percentages, integer 0/1 booleans, JSON serialized to text.
 */

export type OrderChannel = 'pos' | 'storefront' | 'manual' | 'phone' | 'invoice' | 'show';

/**
 * Order lifecycle:
 *   draft -> reserved -> paid -> partially_fulfilled -> fulfilled
 *   draft|reserved -> canceled
 *   paid|partially_fulfilled|fulfilled -> partially_returned -> returned
 * See ORDER_TRANSITIONS in service.ts for the legal matrix.
 */
export type OrderStatus =
  | 'draft'
  | 'reserved'
  | 'paid'
  | 'partially_fulfilled'
  | 'fulfilled'
  | 'canceled'
  | 'returned'
  | 'partially_returned';

export type OrderSource = 'mags' | 'square';

export type LineFulfillmentState =
  | 'pending'
  | 'picked'
  | 'packed'
  | 'fulfilled'
  | 'returned'
  | 'canceled';

export type TenderKind = 'card' | 'cash' | 'external' | 'gift_card' | 'store_credit' | 'provider';

export type TenderStatus =
  | 'pending'
  | 'captured'
  | 'refunded'
  | 'partially_refunded'
  | 'failed'
  | 'voided';

export type RefundStatus = 'pending' | 'completed';

export type RestockDisposition = 'restock' | 'quarantine' | 'damaged' | 'none';

export type FulfillmentKind = 'pickup_show' | 'pickup_local' | 'ship';

export type FulfillmentStatus =
  | 'pending'
  | 'picking'
  | 'packed'
  | 'ready'
  | 'shipped'
  | 'delivered'
  | 'picked_up'
  | 'canceled';

export type CheckoutProviderKey = 'square_hosted' | 'simulator';

export type CheckoutSessionStatus = 'created' | 'completed' | 'expired' | 'canceled';

/** A unified order header. Money columns are integer cents, stored from core computeTotals. */
export interface OrderRow {
  id: string;
  tenant_id: string;
  channel: OrderChannel;
  status: OrderStatus;
  /** crm customer id (string reference only). Null = walk-up / anonymous. */
  customer_id: string | null;
  /** shows module show id (string reference only). */
  show_id: string | null;
  source: OrderSource;
  /** External order id for idempotency (unique per tenant WHEN present). */
  source_order_id: string | null;
  /** Order-level discount inputs (applied after line discounts, before tax). */
  discount_bps: number | null;
  discount_fixed_cents: number | null;
  tax_bps: number | null;
  /** Outputs of core computeTotals — integer cents. */
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  total_cents: number;
  note: string | null;
  /** Invoice/quote lane: 0/1 whether a draft order has been "sent" to the customer. */
  sent: number;
  sent_at: string | null;
  reserved_at: string | null;
  paid_at: string | null;
  fulfilled_at: string | null;
  canceled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderLineRow {
  id: string;
  tenant_id: string;
  order_id: string;
  /** 0-based ordering within the order. */
  position: number;
  /** catalog variation id (string reference). Null = custom / unassigned line. */
  variation_id: string | null;
  /** inventory location id (string reference) for stock-effect event payloads. */
  location_id: string | null;
  description: string;
  /** May be fractional. */
  qty: number;
  unit_price_cents: number;
  /** Line discount as JSON: {"bps":number,"fixedCents":number} — null if none. */
  discount: string | null;
  /** round(qty * unit_price_cents) after the line discount. */
  line_total_cents: number;
  fulfillment_state: LineFulfillmentState;
  created_at: string;
  updated_at: string;
}

export interface TenderRow {
  id: string;
  tenant_id: string;
  order_id: string;
  kind: TenderKind;
  amount_cents: number;
  provider: string | null;
  provider_ref: string | null;
  status: TenderStatus;
  /** Refunded amount so far (drives captured -> partially_refunded -> refunded). */
  refunded_cents: number;
  /** Idempotency key, unique per tenant (check-then-insert; no ON CONFLICT). */
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

export interface RefundRow {
  id: string;
  tenant_id: string;
  order_id: string;
  tender_id: string;
  amount_cents: number;
  reason: string | null;
  status: RefundStatus;
  created_at: string;
}

export interface RefundLineRow {
  id: string;
  tenant_id: string;
  refund_id: string;
  line_id: string;
  qty: number;
  disposition: RestockDisposition;
  created_at: string;
}

export interface FulfillmentRow {
  id: string;
  tenant_id: string;
  order_id: string;
  kind: FulfillmentKind;
  status: FulfillmentStatus;
  /** Shipping/pickup address JSON — null for shows / anonymous pickups. */
  address: string | null;
  tracking: string | null;
  staged_at: string | null;
  shipped_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FulfillmentLineRow {
  id: string;
  tenant_id: string;
  fulfillment_id: string;
  line_id: string;
  qty: number;
  created_at: string;
}

export interface CheckoutSessionRow {
  id: string;
  tenant_id: string;
  order_id: string;
  provider: CheckoutProviderKey;
  provider_session_ref: string;
  status: CheckoutSessionStatus;
  amount_cents: number;
  return_url: string | null;
  created_at: string;
  completed_at: string | null;
}

/** Every provider callback lands here first (replay-safe via event_ref). */
export interface WebhookEventRow {
  id: string;
  tenant_id: string;
  provider: string;
  /** Provider-side event id — unique per tenant (replay dedup). */
  event_ref: string;
  signature_valid: number;
  payload: string;
  processed: number;
  /** JSON-serialized outcome (e.g. "paid" / "amount_mismatch" / "invalid_signature"). */
  outcome: string | null;
  created_at: string;
}

export interface OrdersDatabase extends CoreDatabase {
  orders_orders: OrderRow;
  orders_lines: OrderLineRow;
  orders_tenders: TenderRow;
  orders_refunds: RefundRow;
  orders_refund_lines: RefundLineRow;
  orders_fulfillments: FulfillmentRow;
  orders_fulfillment_lines: FulfillmentLineRow;
  orders_checkout_sessions: CheckoutSessionRow;
  orders_webhook_events: WebhookEventRow;
}
