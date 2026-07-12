import { createHmac, timingSafeEqual } from 'node:crypto';
import { id } from '@blacklabel/core';

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
  amountCents: number;
  currency?: string;
  returnUrl?: string;
  /** Line descriptions for the hosted page, when the provider wants them. */
  lineItems?: { description: string; qty: number; unitPriceCents: number }[];
}

export interface CreateSessionResult {
  providerSessionRef: string;
  redirectUrl: string;
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

export interface CheckoutProvider {
  readonly key: 'simulator' | 'square_hosted';
  /** Open a hosted checkout for the order; returns a redirect URL. */
  createSession(order: CheckoutOrderSnapshot): Promise<CreateSessionResult>;
  /** Verify the raw callback body against its signature header(s). */
  verifyWebhook(
    headers: Record<string, string | undefined>,
    rawBody: string,
  ): VerifyWebhookResult | Promise<VerifyWebhookResult>;
  /** Extract the completion facts the service reconciles against the order. */
  parseCompletion(event: ParsedProviderEvent): ParsedCompletion;
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
      id: typeof parsed.id === 'string' && parsed.id !== '' ? parsed.id : `unparsed_${id()}`,
      type: typeof parsed.type === 'string' ? parsed.type : 'unknown',
      ...parsed,
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
      return { providerSessionRef, redirectUrl };
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
      return { providerSessionRef: link.id, redirectUrl: link.url };
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
  };
}
