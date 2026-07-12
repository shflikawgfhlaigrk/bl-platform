/**
 * @blacklabel/orders — the UNIFIED operational order model for NEW orders
 * (POS / storefront / manual / phone / invoice / show). Historical Square
 * sales stay in `retail_*`; this module references their ids as opaque strings
 * only (never joins). Money is always computed through core `computeTotals`.
 *
 * ── Events emitted (module.entity.verb; every payload carries `v: 1`) ────────
 *   orders.order.reserved   { v, orderId, lines[] }        (on reserve)
 *   orders.order.paid       { v, orderId, totalCents, lines[] }  (on pay/checkout)
 *   orders.order.fulfilled  { v, orderId, lines[] }        (all lines fulfilled)
 *   orders.order.returned   { v, orderId, returnId, lines[] }    (on refund)
 *   orders.payment.mismatched { v, orderId, sessionId, expectedCents, receivedCents }
 *   orders.order.canceled   { v, orderId }                 (internal)
 *   orders.order.partially_fulfilled — audited only (no event payload consumers yet)
 *
 * ── INVENTORY LINKAGE IS BY CONTRACT ONLY ───────────────────────────────────
 * This package NEVER imports inventory. On reserve / paid / refund it EMITS the
 * events above; the integrator subscribes and applies stock effects. Each
 * stock-bearing event carries `lines: [{ variationId, qty, locationId? }]` for
 * reserve/paid/fulfilled, and `lines: [{ variationId, qty, disposition, locationId? }]`
 * for returns (disposition = restock|quarantine|damaged|none — only `restock`
 * should add stock back). Custom/unassigned lines (variation_id = null) are
 * OMITTED from these arrays — they have no inventory effect.
 *
 * ── Order state machine ─────────────────────────────────────────────────────
 *   draft ─reserve→ reserved ─pay→ paid ─fulfill→ (partially_fulfilled →) fulfilled
 *   draft|reserved ─cancel→ canceled            (paid orders are refunded, never deleted)
 *   paid|partially_fulfilled|fulfilled ─refund→ partially_returned → returned
 * Illegal transitions throw ApiError.conflict. `paid` requires
 * sum(captured tenders) == total_cents. All transitions are audited.
 *
 * ── Provider adapters (NO network in this package) ──────────────────────────
 * `CheckoutProvider` is the interface. `simulatorCheckoutProvider` is fully
 * implemented with REAL HMAC-SHA256 signature verification (node:crypto).
 * `squareHostedCheckoutProvider` is structurally complete with the injected
 * `transport` function — apps/api supplies real fetch behind admin credentials.
 * Webhook handling records every callback in orders_webhook_events FIRST
 * (replay-safe via unique event_ref), reconciles the amount against the
 * checkout session, and only then captures a tender + marks the order paid.
 *
 * ── Integrator wiring notes ─────────────────────────────────────────────────
 * - Mount `ordersRouter(deps, { providers: [...] })` at /api/orders. Providers
 *   default to [] (checkout returns 501 until configured).
 * - POST /webhooks/:provider needs the RAW request body for signature checks —
 *   apps/api must NOT pre-parse/replace it; this router reads `c.req.text()`.
 * - Subscribe to the events above to drive inventory (stock reservations /
 *   decrements / restock) and the actions module.
 */

export const MODULE_KEY = 'orders' as const;

// Migrations
export { ordersMigrations } from './migrations';

// Router factory
export { ordersRouter } from './router';
export type { OrdersRouterOptions } from './router';

// Schema / row types
export type {
  OrdersDatabase,
  OrderRow,
  OrderLineRow,
  TenderRow,
  RefundRow,
  RefundLineRow,
  FulfillmentRow,
  FulfillmentLineRow,
  CheckoutSessionRow,
  WebhookEventRow,
  OrderChannel,
  OrderStatus,
  OrderSource,
  LineFulfillmentState,
  TenderKind,
  TenderStatus,
  RefundStatus,
  RestockDisposition,
  FulfillmentKind,
  FulfillmentStatus,
  CheckoutProviderKey,
  CheckoutSessionStatus,
} from './schema';

// Provider interface + adapters (no network — transport injected)
export {
  simulatorCheckoutProvider,
  squareHostedCheckoutProvider,
  simulatorSign,
  simulatorCompletionBody,
  squareSign,
} from './providers';
export type {
  CheckoutProvider,
  CheckoutOrderSnapshot,
  CreateSessionResult,
  ParsedProviderEvent,
  VerifyWebhookResult,
  ParsedCompletion,
  HttpTransport,
  SimulatorProviderOptions,
  SquareProviderOptions,
} from './providers';

// Public service surface (state machine + helpers for tests/integrators)
export {
  ORDER_TRANSITIONS,
  canTransition,
  buildProviderRegistry,
  createOrder,
  getOrder,
  listOrders,
  updateOrder,
  deleteOrder,
  markOrderSent,
  reserveOrder,
  cancelOrder,
  addTender,
  listTenders,
  payOrder,
  createCheckoutSession,
  processWebhook,
  listWebhookEvents,
  createFulfillment,
  advanceFulfillment,
  listFulfillments,
  pickList,
  packingSlip,
  createRefund,
  listRefunds,
} from './service';
export type {
  OrdersCtx,
  OrderDto,
  LineDto,
  WebhookEventDto,
  OrderWithLines,
  LineInputSvc,
  CreateOrderInputSvc,
  UpdateOrderInputSvc,
  AddTenderInputSvc,
  PayManualInputSvc,
  CreateCheckoutResult,
  WebhookOutcome,
  ProcessWebhookResult,
  CreateFulfillmentInputSvc,
  FulfillmentLineInputSvc,
  CreateRefundInputSvc,
  RefundLineInputSvc,
  RefundResult,
  PickListItem,
  PackingSlip,
  ProviderRegistry,
} from './service';
