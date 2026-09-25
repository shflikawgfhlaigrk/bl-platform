import { createHmac, timingSafeEqual } from 'node:crypto';
import { id } from '@blacklabel/core';
import type { CheckoutProviderKey } from './schema';

/**
 * Checkout provider abstraction — NO NETWORK lives in this module. Adapters
 * describe HOW to talk to a hosted-checkout processor; the actual transport
 * (fetch) is INJECTED as a function dependency so tests inject a fake and
 * production wiring (apps/api, behind admin credentials) supplies real fetch
 * LATER. The orders service only ever calls these interface methods.
 */

/** Minimal snapshot the service hands a provider to open a checkout session. */
export interface CheckoutOrderSnapshot {
  tenantId: string;
  orderId: string;
  paymentAttemptId?: string;
  /** Stable request key supplied to provider transports that support it. */
  idempotencyKey?: string;
  amountCents: number;
  currency?: string;
  returnUrl?: string;
  /** Required by server-driven card-present providers unless configured globally. */
  readerId?: string;
  /** Line descriptions for the hosted page, when the provider wants them. */
  lineItems?: { description: string; qty: number; unitPriceCents: number }[];
}

export interface RedirectSessionResult {
  providerSessionRef: string;
  flow: 'redirect';
  redirectUrl: string;
  providerData?: Record<string, unknown>;
}

export interface TerminalSessionResult {
  providerSessionRef: string;
  flow: 'terminal';
  redirectUrl?: undefined;
  terminal: {
    readerId: string;
    readerStatus?: string;
    actionStatus?: string;
  };
  providerData?: Record<string, unknown>;
}

/** Hosted checkouts redirect; server-driven terminals return reader state. */
export type CreateSessionResult = RedirectSessionResult | TerminalSessionResult;

/**
 * Provider session identity returned before an external device/action starts.
 * Services persist this boundary before calling `startPreparedSession` so a
 * process crash can never orphan a remotely-created payment reference.
 */
export interface PreparedSessionResult {
  providerSessionRef: string;
  providerData?: Record<string, unknown>;
}

/** Normalized, already-JSON-parsed provider event (carries a stable `id`). */
export interface ParsedProviderEvent {
  /** Provider-side event id — the replay/idempotency key. */
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface VerifyWebhookResult {
  valid: boolean;
  /** Parsed event; present even when invalid so the raw event can be recorded. */
  event: ParsedProviderEvent;
}

export interface ParsedCompletion {
  providerSessionRef: string;
  amountCents: number;
  /** Provider-side tender/charge reference — the tender idempotency key. */
  tenderRef: string;
}

export interface ParsedPaymentUpdate {
  providerSessionRef: string;
  status: 'succeeded' | 'failed' | 'canceled';
  amountCents?: number;
  tenderRef?: string;
  failureCode?: string;
  failureMessage?: string;
  /** Signed provider metadata used only to recover a pre-webhook local bind. */
  tenantId?: string;
  orderId?: string;
  paymentAttemptId?: string;
}

export interface ParsedRefundUpdate {
  providerRefundRef: string;
  providerPaymentRef: string;
  status: 'succeeded' | 'pending' | 'failed' | 'canceled';
  amountCents: number;
  failureCode?: string;
  /** Signed provider metadata used to bind a callback racing the HTTP response. */
  tenantId?: string;
  orderId?: string;
  refundId?: string;
}

export interface CancelSessionInput {
  providerSessionRef: string;
  readerId?: string;
  idempotencyKey: string;
}

export interface ProviderRefundInput {
  tenantId: string;
  orderId: string;
  /** Durable local refund id created before provider I/O. */
  refundId: string;
  amountCents: number;
  idempotencyKey: string;
  /** Captured provider tender/charge reference. */
  providerPaymentRef: string;
  /** Provider checkout/payment session (Stripe PaymentIntent) when available. */
  providerSessionRef?: string;
}

export interface ProviderRefundResult {
  providerRefundRef: string;
  /** Normalized reference matching providerSessionRef, otherwise providerPaymentRef. */
  providerPaymentRef: string;
  status: 'succeeded' | 'pending' | 'failed' | 'canceled';
  amountCents: number;
  failureCode?: string;
}

export interface CheckoutProvider {
  readonly key: CheckoutProviderKey;
  /** Open a hosted checkout or begin a server-driven terminal action. */
  createSession(order: CheckoutOrderSnapshot): Promise<CreateSessionResult>;
  /**
   * Optional two-phase boundary for server-driven terminals. Preparation must
   * be idempotent for `order.idempotencyKey` and must not start the reader.
   */
  prepareSession?(order: CheckoutOrderSnapshot): Promise<PreparedSessionResult>;
  /** Start/replay the device action after `providerSessionRef` is durable. */
  startPreparedSession?(
    order: CheckoutOrderSnapshot,
    prepared: PreparedSessionResult,
  ): Promise<CreateSessionResult>;
  /** Verify the raw callback body against its signature header(s). */
  verifyWebhook(
    headers: Record<string, string | undefined>,
    rawBody: string,
  ): VerifyWebhookResult | Promise<VerifyWebhookResult>;
  /** Extract the completion facts the service reconciles against the order. */
  parseCompletion(event: ParsedProviderEvent): ParsedCompletion;
  /** Optional richer status parser for failed/canceled provider events. */
  parsePaymentUpdate?(event: ParsedProviderEvent): ParsedPaymentUpdate | null;
  /** Optional asynchronous refund callback parser. */
  parseRefundUpdate?(event: ParsedProviderEvent): ParsedRefundUpdate | null;
  /** Cancel a remote session/action before the local attempt is canceled. */
  cancelSession?(session: CancelSessionInput): Promise<void>;
  /** Issue an idempotent processor refund and return its reconciled state. */
  refund?(input: ProviderRefundInput): Promise<ProviderRefundResult>;
}

/** Transport injected into network-facing adapters. Shaped like a subset of fetch. */
export type HttpTransport = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

/* ================================================================== *
 * Simulator provider — fully implemented, deterministic, REAL HMAC.
 * ================================================================== */

export interface SimulatorProviderOptions {
  /** HMAC-SHA256 secret used to sign/verify webhook bodies. */
  secret: string;
  /** Header the signature is read from. Defaults to "x-mags-signature". */
  signatureHeader?: string;
  /** Base URL of the simulated hosted checkout page. */
  checkoutBaseUrl?: string;
}

const SIM_DEFAULT_HEADER = 'x-mags-signature';
const SIM_DEFAULT_BASE = 'https://checkout.simulator.local';

/** Deterministic HMAC-SHA256 hex signature of a raw body. Exposed for tests. */
export function simulatorSign(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/** Build the exact JSON body the simulator will sign as a "completed" event. */
export function simulatorCompletionBody(input: {
  eventId?: string;
  providerSessionRef: string;
  amountCents: number;
  tenderRef?: string;
}): string {
  return JSON.stringify({
    id: input.eventId ?? `evt_${id()}`,
    type: 'checkout.completed',
    data: {
      sessionRef: input.providerSessionRef,
      amountCents: input.amountCents,
      tenderRef: input.tenderRef ?? `sim_txn_${id()}`,
    },
  });
}

function safeParse(rawBody: string): ParsedProviderEvent {
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    return {
      ...parsed,
      id: typeof parsed.id === 'string' && parsed.id !== '' ? parsed.id : `unparsed_${id()}`,
      type: typeof parsed.type === 'string' ? parsed.type : 'unknown',
    };
  } catch {
    return { id: `unparsed_${id()}`, type: 'unparseable' };
  }
}

export function simulatorCheckoutProvider(options: SimulatorProviderOptions): CheckoutProvider {
  const header = (options.signatureHeader ?? SIM_DEFAULT_HEADER).toLowerCase();
  const base = options.checkoutBaseUrl ?? SIM_DEFAULT_BASE;
  return {
    key: 'simulator',
    async createSession(order) {
      // Deterministic ref derived from the order id (no network).
      const providerSessionRef = `sim_sess_${order.orderId}`;
      const redirectUrl = `${base}/pay/${providerSessionRef}?amount=${order.amountCents}`;
      return { providerSessionRef, flow: 'redirect', redirectUrl };
    },
    verifyWebhook(headers, rawBody) {
      const event = safeParse(rawBody);
      const provided = headers[header];
      if (typeof provided !== 'string' || provided === '') {
        return { valid: false, event };
      }
      const expected = simulatorSign(options.secret, rawBody);
      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(provided, 'utf8');
      const valid = a.length === b.length && timingSafeEqual(a, b);
      return { valid, event };
    },
    parseCompletion(event) {
      const data = (event.data ?? {}) as {
        sessionRef?: unknown;
        amountCents?: unknown;
        tenderRef?: unknown;
      };
      if (typeof data.sessionRef !== 'string' || data.sessionRef === '') {
        throw new Error('simulator completion missing data.sessionRef');
      }
      if (!Number.isInteger(data.amountCents)) {
        throw new Error('simulator completion missing integer data.amountCents');
      }
      return {
        providerSessionRef: data.sessionRef,
        amountCents: data.amountCents as number,
        tenderRef: typeof data.tenderRef === 'string' ? data.tenderRef : event.id,
      };
    },
    parsePaymentUpdate(event) {
      if (event.type !== 'checkout.completed') return null;
      const completion = this.parseCompletion(event);
      return { ...completion, status: 'succeeded' };
    },
    async cancelSession() {
      // Simulator sessions have no external state to unwind.
    },
  };
}

/* ================================================================== *
 * Square-hosted provider — STRUCTURALLY complete, transport injected.
 *
 * Payload shapes / signature scheme follow Square's public docs:
 *  - Checkout: POST /v2/online-checkout/payment-links with
 *    { idempotency_key, quick_pay: { name, price_money:{amount,currency}, location_id } }
 *    -> response.payment_link.{ id, url }.
 *  - Webhook signature: HMAC-SHA256 over (notificationUrl + rawBody), base64,
 *    delivered in header "x-square-hmacsha256-signature".
 *  - Completion event: type "payment.updated",
 *    data.object.payment.{ id, status:"COMPLETED", amount_money.amount,
 *    order_id } — sessionRef reconciled via the payment link id we stored.
 * The module itself NEVER fetches: createSession calls the injected transport.
 * ================================================================== */

export interface SquareProviderOptions {
  accessToken: string;
  locationId: string;
  /** Square webhook signature key (from the dashboard). */
  signatureKey: string;
  /** The exact notification URL Square is configured to POST to. */
  notificationUrl: string;
  /** Injected HTTP transport (fake in tests, real fetch in production). */
  transport: HttpTransport;
  apiBase?: string;
  currency?: string;
  checkoutBaseUrl?: string;
}

const SQUARE_DEFAULT_API = 'https://connect.squareup.com';
const SQUARE_SIG_HEADER = 'x-square-hmacsha256-signature';

/** Square's HMAC-SHA256(base64) of notificationUrl + rawBody. Exposed for tests. */
export function squareSign(signatureKey: string, notificationUrl: string, rawBody: string): string {
  return createHmac('sha256', signatureKey)
    .update(notificationUrl + rawBody, 'utf8')
    .digest('base64');
}

export function squareHostedCheckoutProvider(options: SquareProviderOptions): CheckoutProvider {
  const apiBase = options.apiBase ?? SQUARE_DEFAULT_API;
  const currency = options.currency ?? 'USD';
  return {
    key: 'square_hosted',
    async createSession(order) {
      const body = JSON.stringify({
        idempotency_key: `${order.tenantId}:${order.orderId}`,
        quick_pay: {
          name: `Order ${order.orderId}`,
          price_money: { amount: order.amountCents, currency: order.currency ?? currency },
          location_id: options.locationId,
        },
        checkout_options: order.returnUrl ? { redirect_url: order.returnUrl } : undefined,
      });
      const res = await options.transport(`${apiBase}/v2/online-checkout/payment-links`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.accessToken}`,
          'Square-Version': '2024-01-18',
        },
        body,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`square createSession failed with status ${res.status}`);
      }
      const json = (await res.json()) as {
        payment_link?: { id?: string; url?: string };
      };
      const link = json.payment_link;
      if (!link?.id || !link?.url) {
        throw new Error('square createSession response missing payment_link.id/url');
      }
      return { providerSessionRef: link.id, flow: 'redirect', redirectUrl: link.url };
    },
    verifyWebhook(headers, rawBody) {
      const event = safeParse(rawBody);
      const provided = headers[SQUARE_SIG_HEADER];
      if (typeof provided !== 'string' || provided === '') {
        return { valid: false, event };
      }
      const expected = squareSign(options.signatureKey, options.notificationUrl, rawBody);
      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(provided, 'utf8');
      const valid = a.length === b.length && timingSafeEqual(a, b);
      return { valid, event };
    },
    parseCompletion(event) {
      const object = (event as { data?: { object?: { payment?: unknown } } }).data?.object;
      const payment = (object as { payment?: Record<string, unknown> } | undefined)?.payment;
      if (!payment) throw new Error('square completion missing data.object.payment');
      if (payment.status !== 'COMPLETED') throw new Error('square payment is not completed');
      const linkId = payment.payment_link_id ?? payment.order_id;
      const amount = (payment.amount_money as { amount?: unknown } | undefined)?.amount;
      if (typeof linkId !== 'string' || linkId === '') {
        throw new Error('square completion missing payment link/order reference');
      }
      if (!Number.isInteger(amount)) {
        throw new Error('square completion missing integer amount_money.amount');
      }
      return {
        providerSessionRef: linkId,
        amountCents: amount as number,
        tenderRef: typeof payment.id === 'string' ? payment.id : event.id,
      };
    },
    parsePaymentUpdate(event) {
      if (event.type !== 'payment.updated') return null;
      const payment = (event as { data?: { object?: { payment?: Record<string, unknown> } } }).data
        ?.object?.payment;
      if (!payment) return null;
      const providerSessionRef = payment.payment_link_id ?? payment.order_id;
      if (typeof providerSessionRef !== 'string' || providerSessionRef === '') return null;
      if (payment.status === 'COMPLETED') {
        const completion = this.parseCompletion(event);
        return { ...completion, status: 'succeeded' };
      }
      if (payment.status === 'CANCELED') {
        return { providerSessionRef, status: 'canceled' };
      }
      if (payment.status === 'FAILED') {
        return {
          providerSessionRef,
          status: 'failed',
          failureCode: typeof payment.card_details === 'object' ? 'card_declined' : 'payment_failed',
          failureMessage: 'Square reported the payment failed',
        };
      }
      return null;
    },
    async cancelSession(session) {
      const res = await options.transport(
        `${apiBase}/v2/online-checkout/payment-links/${encodeURIComponent(session.providerSessionRef)}`,
        {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.accessToken}`,
            'Square-Version': '2024-01-18',
          },
          body: '',
        },
      );
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`square cancelSession failed with status ${res.status}`);
      }
    },
  };
}

/* ================================================================== *
 * Stripe Terminal — server-driven PaymentIntent + reader action.
 *
 * The adapter is deliberately network-free: every HTTP exchange goes through
 * the injected transport. It creates a card_present PaymentIntent, instructs
 * the selected reader to process it, and waits for a signed
 * payment_intent.succeeded webhook before the service captures a tender.
 * ================================================================== */

export interface StripeTerminalProviderOptions {
  secretKey: string;
  webhookSecret: string;
  transport: HttpTransport;
  /** Used when the caller does not select a reader per attempt. */
  defaultReaderId?: string;
  apiBase?: string;
  currency?: string;
  /** Stripe recommends five minutes; callers may tighten it. */
  webhookToleranceSeconds?: number;
  /** Injectable Unix-seconds clock for deterministic verification tests. */
  nowSeconds?: () => number;
}

const STRIPE_DEFAULT_API = 'https://api.stripe.com';
const STRIPE_SIG_HEADER = 'stripe-signature';

/** Stripe v1 webhook digest: HMAC-SHA256 hex over `${timestamp}.${rawBody}`. */
export function stripeSign(webhookSecret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', webhookSecret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
}

/** Build a canonical Stripe-Signature header (also convenient for tests). */
export function stripeSignatureHeader(
  webhookSecret: string,
  timestamp: number,
  rawBody: string,
): string {
  return `t=${timestamp},v1=${stripeSign(webhookSecret, timestamp, rawBody)}`;
}

function safeStringEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function stripeObject(event: ParsedProviderEvent): Record<string, unknown> | undefined {
  const data = event.data as { object?: unknown } | undefined;
  return data?.object && typeof data.object === 'object'
    ? (data.object as Record<string, unknown>)
    : undefined;
}

function stripeMetadata(object: Record<string, unknown>): Record<string, unknown> {
  return object.metadata && typeof object.metadata === 'object'
    ? (object.metadata as Record<string, unknown>)
    : {};
}

function optionalStripeMetadata(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function stripeTerminalCheckoutProvider(
  options: StripeTerminalProviderOptions,
): CheckoutProvider {
  const apiBase = options.apiBase ?? STRIPE_DEFAULT_API;
  const currency = (options.currency ?? 'usd').toLowerCase();
  const tolerance = options.webhookToleranceSeconds ?? 300;
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  const prepareSession = async (
    order: CheckoutOrderSnapshot,
  ): Promise<PreparedSessionResult> => {
    if (!(order.readerId ?? options.defaultReaderId)) {
      throw new Error('stripe terminal checkout requires a readerId');
    }
    const requestKey = order.idempotencyKey ?? `${order.tenantId}:${order.orderId}`;
    const intentBody = new URLSearchParams();
    intentBody.set('amount', String(order.amountCents));
    intentBody.set('currency', order.currency?.toLowerCase() ?? currency);
    intentBody.append('payment_method_types[]', 'card_present');
    intentBody.set('capture_method', 'automatic');
    intentBody.set('metadata[tenant_id]', order.tenantId);
    intentBody.set('metadata[order_id]', order.orderId);
    if (order.paymentAttemptId) {
      intentBody.set('metadata[payment_attempt_id]', order.paymentAttemptId);
    }
    const intentResponse = await options.transport(`${apiBase}/v1/payment_intents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': requestKey,
      },
      body: intentBody.toString(),
    });
    if (intentResponse.status < 200 || intentResponse.status >= 300) {
      throw new Error(`stripe PaymentIntent creation failed with status ${intentResponse.status}`);
    }
    const intent = (await intentResponse.json()) as {
      id?: unknown;
      amount?: unknown;
      status?: unknown;
    };
    if (typeof intent.id !== 'string' || intent.id === '') {
      throw new Error('stripe PaymentIntent response missing id');
    }
    if (intent.amount !== undefined && intent.amount !== order.amountCents) {
      throw new Error('stripe PaymentIntent response amount does not match request');
    }
    return {
      providerSessionRef: intent.id,
      providerData: {
        paymentIntentStatus: typeof intent.status === 'string' ? intent.status : null,
      },
    };
  };

  const startPreparedSession = async (
    order: CheckoutOrderSnapshot,
    prepared: PreparedSessionResult,
  ): Promise<TerminalSessionResult> => {
    const readerId = order.readerId ?? options.defaultReaderId;
    if (!readerId) throw new Error('stripe terminal checkout requires a readerId');
    const requestKey = order.idempotencyKey ?? `${order.tenantId}:${order.orderId}`;
    const processBody = new URLSearchParams({ payment_intent: prepared.providerSessionRef });
    const readerResponse = await options.transport(
      `${apiBase}/v1/terminal/readers/${encodeURIComponent(readerId)}/process_payment_intent`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': `${requestKey}:reader`,
        },
        body: processBody.toString(),
      },
    );
    if (readerResponse.status < 200 || readerResponse.status >= 300) {
      throw new Error(`stripe reader process action failed with status ${readerResponse.status}`);
    }
    const reader = (await readerResponse.json()) as {
      id?: unknown;
      status?: unknown;
      action?: { status?: unknown; type?: unknown };
    };
    if (reader.id !== readerId) {
      throw new Error('stripe reader response id does not match selected reader');
    }
    return {
      providerSessionRef: prepared.providerSessionRef,
      flow: 'terminal',
      terminal: {
        readerId,
        ...(typeof reader.status === 'string' ? { readerStatus: reader.status } : {}),
        ...(typeof reader.action?.status === 'string' ? { actionStatus: reader.action.status } : {}),
      },
      providerData: {
        ...(prepared.providerData ?? {}),
        readerStatus: typeof reader.status === 'string' ? reader.status : null,
        readerActionType: typeof reader.action?.type === 'string' ? reader.action.type : null,
        readerActionStatus: typeof reader.action?.status === 'string' ? reader.action.status : null,
      },
    };
  };

  const createSession = async (order: CheckoutOrderSnapshot): Promise<TerminalSessionResult> => {
    const prepared = await prepareSession(order);
    return startPreparedSession(order, prepared);
  };

  return {
    key: 'stripe_terminal',
    createSession,
    prepareSession,
    startPreparedSession,
    verifyWebhook(headers, rawBody) {
      const event = safeParse(rawBody);
      const provided = headers[STRIPE_SIG_HEADER];
      if (typeof provided !== 'string' || provided === '') return { valid: false, event };

      let timestamp: number | undefined;
      const signatures: string[] = [];
      for (const component of provided.split(',')) {
        const separator = component.indexOf('=');
        if (separator < 1) continue;
        const key = component.slice(0, separator).trim();
        const value = component.slice(separator + 1).trim();
        if (key === 't' && /^\d+$/.test(value)) timestamp = Number(value);
        if (key === 'v1' && value !== '') signatures.push(value);
      }
      if (
        timestamp === undefined ||
        !Number.isSafeInteger(timestamp) ||
        Math.abs(nowSeconds() - timestamp) > tolerance
      ) {
        return { valid: false, event };
      }
      const expected = stripeSign(options.webhookSecret, timestamp, rawBody);
      return { valid: signatures.some((candidate) => safeStringEqual(expected, candidate)), event };
    },
    parseCompletion(event) {
      if (event.type !== 'payment_intent.succeeded') {
        throw new Error(`stripe event is not a successful PaymentIntent: ${event.type}`);
      }
      const intent = stripeObject(event);
      if (!intent || intent.status !== 'succeeded') {
        throw new Error('stripe completion missing succeeded data.object');
      }
      if (typeof intent.id !== 'string' || intent.id === '') {
        throw new Error('stripe completion missing PaymentIntent id');
      }
      const amount = Number.isInteger(intent.amount_received) ? intent.amount_received : intent.amount;
      if (!Number.isInteger(amount)) {
        throw new Error('stripe completion missing integer amount_received/amount');
      }
      return {
        providerSessionRef: intent.id,
        amountCents: amount as number,
        tenderRef: typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.id,
      };
    },
    parsePaymentUpdate(event) {
      const intent = stripeObject(event);
      if (!intent || typeof intent.id !== 'string' || intent.id === '') return null;
      const metadata = stripeMetadata(intent);
      const correlation = {
        ...(optionalStripeMetadata(metadata, 'tenant_id')
          ? { tenantId: optionalStripeMetadata(metadata, 'tenant_id') }
          : {}),
        ...(optionalStripeMetadata(metadata, 'order_id')
          ? { orderId: optionalStripeMetadata(metadata, 'order_id') }
          : {}),
        ...(optionalStripeMetadata(metadata, 'payment_attempt_id')
          ? { paymentAttemptId: optionalStripeMetadata(metadata, 'payment_attempt_id') }
          : {}),
      };
      if (event.type === 'payment_intent.succeeded') {
        const completion = this.parseCompletion(event);
        return { ...completion, status: 'succeeded', ...correlation };
      }
      if (event.type === 'payment_intent.canceled') {
        return { providerSessionRef: intent.id, status: 'canceled', ...correlation };
      }
      if (event.type === 'payment_intent.payment_failed') {
        const failure = intent.last_payment_error as
          | { code?: unknown; message?: unknown; decline_code?: unknown }
          | undefined;
        return {
          providerSessionRef: intent.id,
          status: 'failed',
          failureCode:
            typeof failure?.decline_code === 'string'
              ? failure.decline_code
              : typeof failure?.code === 'string'
                ? failure.code
                : 'payment_failed',
          failureMessage:
            typeof failure?.message === 'string' ? failure.message : 'Stripe reported the payment failed',
          ...correlation,
        };
      }
      return null;
    },
    parseRefundUpdate(event) {
      if (!['refund.created', 'refund.updated', 'refund.failed', 'charge.refund.updated'].includes(event.type)) {
        return null;
      }
      const refund = stripeObject(event);
      if (!refund || typeof refund.id !== 'string' || refund.id === '') return null;
      const status = String(refund.status);
      if (!['succeeded', 'pending', 'failed', 'canceled'].includes(status)) return null;
      if (!Number.isInteger(refund.amount)) return null;
      const paymentRef = typeof refund.payment_intent === 'string'
        ? refund.payment_intent
        : typeof refund.charge === 'string'
          ? refund.charge
          : undefined;
      if (!paymentRef) return null;
      const metadata = stripeMetadata(refund);
      return {
        providerRefundRef: refund.id,
        providerPaymentRef: paymentRef,
        status: status as ParsedRefundUpdate['status'],
        amountCents: refund.amount as number,
        ...(typeof refund.failure_reason === 'string'
          ? { failureCode: refund.failure_reason }
          : {}),
        ...(optionalStripeMetadata(metadata, 'tenant_id')
          ? { tenantId: optionalStripeMetadata(metadata, 'tenant_id') }
          : {}),
        ...(optionalStripeMetadata(metadata, 'order_id')
          ? { orderId: optionalStripeMetadata(metadata, 'order_id') }
          : {}),
        ...(optionalStripeMetadata(metadata, 'refund_id')
          ? { refundId: optionalStripeMetadata(metadata, 'refund_id') }
          : {}),
      };
    },
    async refund(input) {
      const refundBody = new URLSearchParams();
      if (input.providerSessionRef) {
        refundBody.set('payment_intent', input.providerSessionRef);
      } else {
        refundBody.set('charge', input.providerPaymentRef);
      }
      refundBody.set('amount', String(input.amountCents));
      refundBody.set('metadata[tenant_id]', input.tenantId);
      refundBody.set('metadata[order_id]', input.orderId);
      refundBody.set('metadata[refund_id]', input.refundId);
      const response = await options.transport(`${apiBase}/v1/refunds`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': input.idempotencyKey,
        },
        body: refundBody.toString(),
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`stripe refund request failed with status ${response.status}`);
      }
      const refund = (await response.json()) as {
        id?: unknown;
        status?: unknown;
        amount?: unknown;
        payment_intent?: unknown;
        charge?: unknown;
        failure_reason?: unknown;
      };
      if (typeof refund.id !== 'string' || refund.id === '') {
        throw new Error('stripe refund response missing id');
      }
      if (!['succeeded', 'pending', 'failed', 'canceled'].includes(String(refund.status))) {
        throw new Error('stripe refund response has invalid status');
      }
      if (refund.amount !== input.amountCents) {
        throw new Error('stripe refund response amount does not match request');
      }
      const expectedPaymentRef = input.providerSessionRef ?? input.providerPaymentRef;
      const returnedPaymentRef = input.providerSessionRef ? refund.payment_intent : refund.charge;
      if (returnedPaymentRef !== expectedPaymentRef) {
        throw new Error('stripe refund response payment reference does not match request');
      }
      if (
        input.providerSessionRef &&
        input.providerPaymentRef !== input.providerSessionRef &&
        refund.charge !== input.providerPaymentRef
      ) {
        throw new Error('stripe refund response charge does not match captured tender');
      }
      return {
        providerRefundRef: refund.id,
        providerPaymentRef: expectedPaymentRef,
        status: refund.status as ProviderRefundResult['status'],
        amountCents: refund.amount,
        ...(typeof refund.failure_reason === 'string' ? { failureCode: refund.failure_reason } : {}),
      };
    },
    async cancelSession(session) {
      const headers = {
        Authorization: `Bearer ${options.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      };
      if (session.readerId) {
        const readerCancel = await options.transport(
          `${apiBase}/v1/terminal/readers/${encodeURIComponent(session.readerId)}/cancel_action`,
          {
            method: 'POST',
            headers: { ...headers, 'Idempotency-Key': `${session.idempotencyKey}:reader-cancel` },
            body: '',
          },
        );
        if (readerCancel.status < 200 || readerCancel.status >= 300) {
          throw new Error(`stripe reader cancel action failed with status ${readerCancel.status}`);
        }
      }
      const intentCancel = await options.transport(
        `${apiBase}/v1/payment_intents/${encodeURIComponent(session.providerSessionRef)}/cancel`,
        {
          method: 'POST',
          headers: { ...headers, 'Idempotency-Key': `${session.idempotencyKey}:intent-cancel` },
          body: '',
        },
      );
      if (intentCancel.status < 200 || intentCancel.status >= 300) {
        throw new Error(`stripe PaymentIntent cancellation failed with status ${intentCancel.status}`);
      }
    },
  };
}
