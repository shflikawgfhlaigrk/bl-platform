/**
 * @blacklabel/orders — the UNIFIED operational order model for NEW orders
 * (POS / storefront / manual / phone / invoice / show). Historical Square
 * sales stay in `retail_*`; this module references their ids as opaque strings
 * only (never joins). Money is always computed through core `computeTotals`.
 *
 * ── Events emitted (module.entity.verb; every payload carries `v: 1`) ────────
 *   orders.order.reserved   { v, orderId, lines[] }        (on reserve)
 *   orders.order.paid       { v, orderId, totalCents, lines[] }  (on pay/checkout)
 *   orders.tender.captured  { v, cashSessionId, orderId, tenderId, kind, amountCents, cashReceivedCents, changeDueCents, occurredAt }
 *   orders.order.fulfilled  { v, orderId, lines[] }        (all lines fulfilled)
 *   orders.order.returned   { v, orderId, returnId, lines[] }    (on refund)
 *   orders.refund.created   { v, cashSessionId, orderId, refundId, tenderId, tenderKind, amountCents, occurredAt }
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
 * `squareHostedCheckoutProvider` and `stripeTerminalCheckoutProvider` are
 * structurally complete with injected `transport` functions — apps/api
 * supplies real fetch behind admin credentials. Stripe Terminal creates a
 * card_present PaymentIntent, starts the reader action, and captures no tender
 * until a signed payment_intent.succeeded webhook is reconciled.
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
  PaymentAttemptRow,
  WebhookEventRow,
  OrderChannel,
  OrderStatus,
  OrderSource,
  LineFulfillmentState,
  TenderKind,
  TenderStatus,
  RefundStatus,
  ProviderRefundStatus,
  RestockDisposition,
  FulfillmentKind,
  FulfillmentStatus,
  CheckoutProviderKey,
  CheckoutSessionStatus,
  PaymentAttemptStatus,
} from './schema';

// Provider interface + adapters (no network — transport injected)
export {
  simulatorCheckoutProvider,
  squareHostedCheckoutProvider,
  stripeTerminalCheckoutProvider,
  simulatorSign,
  simulatorCompletionBody,
  squareSign,
  stripeSign,
  stripeSignatureHeader,
} from './providers';
export type {
  CheckoutProvider,
  CheckoutOrderSnapshot,
  CreateSessionResult,
  PreparedSessionResult,
  RedirectSessionResult,
  TerminalSessionResult,
  ParsedProviderEvent,
  VerifyWebhookResult,
  ParsedCompletion,
  ParsedPaymentUpdate,
  ParsedRefundUpdate,
  CancelSessionInput,
  ProviderRefundInput,
  ProviderRefundResult,
  HttpTransport,
  SimulatorProviderOptions,
  SquareProviderOptions,
  StripeTerminalProviderOptions,
} from './providers';

// Public service surface (state machine + helpers for tests/integrators)
export {
  ORDER_TRANSITIONS,
  PAYMENT_ATTEMPT_TRANSITIONS,
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
  cancelSplitPayment,
  addTender,
  listTenders,
  payOrder,
  createCheckoutSession,
  createPaymentAttempt,
  getPaymentAttempt,
  getPaymentAttemptRow,
  listPaymentAttempts,
  cancelPaymentAttempt,
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
  PaymentAttemptDto,
  OrderWithLines,
  LineInputSvc,
  CreateOrderInputSvc,
  UpdateOrderInputSvc,
  AddTenderInputSvc,
  PayManualInputSvc,
  CreateCheckoutResult,
  CreatePaymentAttemptInputSvc,
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
