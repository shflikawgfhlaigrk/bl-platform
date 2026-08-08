import { id } from '@blacklabel/core';

/**
 * Payment provider abstraction — Stripe-SHAPED but not Stripe-hardcoded.
 *
 * The billing service talks only to this interface. Adapters translate to a
 * concrete processor. A real Stripe adapter would implement PaymentProvider
 * with key "stripe": createPaymentIntent -> stripe.paymentIntents.create,
 * recordWebhookEvent -> signature verification + event normalization. It gets
 * wired in apps/api via BillingRouterOptions.providers — no billing code
 * changes needed (see README "Payment providers").
 */

export interface CreatePaymentIntentInput {
  tenantId: string;
  invoiceId: string;
  /** Remaining balance to collect, integer cents. */
  amountCents: number;
  /** Free-form metadata the provider should echo back on webhooks. */
  metadata?: Record<string, string>;
}

export type PaymentIntentStatus =
  | 'requires_action'
  | 'requires_confirmation'
  | 'succeeded'
  | 'canceled';

export interface PaymentIntent {
  /** Provider-side intent id (e.g. "pi_..."). */
  intentId: string;
  provider: string;
  status: PaymentIntentStatus;
  amountCents: number;
  /** Client-side confirmation secret, when the provider uses one. */
  clientSecret?: string;
  /** Human instructions for offline/manual collection flows. */
  instructions?: string;
}

export interface ProviderWebhookEvent {
  tenantId: string;
  /** Exact request bytes decoded as UTF-8, before JSON parsing or reserialization. */
  rawBody: string;
  /** Lower-cased HTTP request headers, including provider signature metadata. */
  headers: Readonly<Record<string, string>>;
  /** Webhook payload after JSON parsing. */
  payload: unknown;
}

/** Normalized result of a webhook event. */
export type WebhookOutcome =
  | {
      kind: 'payment_succeeded';
      invoiceId: string;
      amountCents: number;
      /** Provider-side reference (intent/charge id). */
      externalRef?: string;
    }
  | { kind: 'ignored'; reason?: string };

export interface PaymentProvider {
  /** Registry key, e.g. "manual", "stub", "stripe". */
  readonly key: string;
  createPaymentIntent(input: CreatePaymentIntentInput): Promise<PaymentIntent>;
  /**
   * Verify/normalize a raw webhook payload. Return a WebhookOutcome; the
   * billing service persists the raw event and applies "payment_succeeded"
   * outcomes as recorded payments.
   */
  recordWebhookEvent(event: ProviderWebhookEvent): Promise<WebhookOutcome>;
}

/**
 * Manual/offline adapter: no processor involved. Intents are instructions to
 * collect payment out-of-band and record it via POST /invoices/:id/payments.
 * It has no webhooks, so every webhook event is ignored.
 */
export const manualPaymentProvider: PaymentProvider = {
  key: 'manual',
  async createPaymentIntent(input) {
    return {
      intentId: `manual_${id()}`,
      provider: 'manual',
      status: 'requires_action',
      amountCents: input.amountCents,
      instructions:
        'Collect payment offline (cash/check/transfer) and record it via POST /invoices/:id/payments.',
    };
  },
  async recordWebhookEvent() {
    return { kind: 'ignored', reason: 'manual provider has no webhooks' };
  },
};

/**
 * Stub adapter: an in-memory, Stripe-shaped test double. Intents look like
 * payment intents ("pi_..." + clientSecret); webhooks accept payloads shaped
 *   { type: "payment_intent.succeeded",
 *     data: { object: { id, amount_received, metadata: { invoiceId } } } }
 * exactly where a real processor adapter would parse its own event schema.
 */
export const stubPaymentProvider: PaymentProvider = {
  key: 'stub',
  async createPaymentIntent(input) {
    const intentId = `pi_${id()}`;
    return {
      intentId,
      provider: 'stub',
      status: 'requires_confirmation',
      amountCents: input.amountCents,
      clientSecret: `${intentId}_secret_${id()}`,
    };
  },
  async recordWebhookEvent(event) {
    const payload = event.payload as {
      type?: unknown;
      data?: { object?: { id?: unknown; amount_received?: unknown; metadata?: { invoiceId?: unknown } } };
    } | null;
    if (!payload || payload.type !== 'payment_intent.succeeded') {
      return { kind: 'ignored', reason: 'unhandled event type' };
    }
    const object = payload.data?.object;
    const externalRef = object?.id;
    const invoiceId = object?.metadata?.invoiceId;
    const amount = object?.amount_received;
    if (
      typeof externalRef !== 'string' ||
      externalRef === '' ||
      typeof invoiceId !== 'string' ||
      invoiceId === '' ||
      !Number.isInteger(amount) ||
      (amount as number) <= 0
    ) {
      return { kind: 'ignored', reason: 'missing id, invoiceId, or amount_received' };
    }
    return {
      kind: 'payment_succeeded',
      invoiceId,
      amountCents: amount as number,
      externalRef,
    };
  },
};

export const defaultPaymentProviders: PaymentProvider[] = [
  manualPaymentProvider,
];
