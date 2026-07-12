import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '@blacklabel/core';
import type { ImportBatch, ImportKind } from './contract';

/**
 * Adapter 3 — WEBHOOK INGESTION.
 *
 * Square signs each webhook with HMAC-SHA256 over (notificationUrl + rawBody)
 * keyed by the endpoint's signature key, base64-encoded, delivered in the
 * `x-square-hmacsha256-signature` header. We verify with REAL crypto
 * (node:crypto, timing-safe), then normalize the event into an ImportBatch.
 *
 * ┌─ INTEGRATOR WIRING ───────────────────────────────────────────────────┐
 * │ The signature key + notification URL are injected at wiring time (from  │
 * │ the tenant's admin-configured, AES-GCM-encrypted credential store) —    │
 * │ never hard-coded here. Replay safety comes from retail_webhook_receipts │
 * │ (event_id UNIQUE per tenant): a duplicate event is a no-op.             │
 * └────────────────────────────────────────────────────────────────────────┘
 */

export interface WebhookSignatureConfig {
  signatureKey: string;
  notificationUrl: string;
}

const SIGNATURE_HEADER = 'x-square-hmacsha256-signature';

function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

/** Compute the expected Square signature for a raw body. */
export function computeWebhookSignature(
  rawBody: string,
  config: WebhookSignatureConfig,
): string {
  return createHmac('sha256', config.signatureKey)
    .update(config.notificationUrl + rawBody, 'utf8')
    .digest('base64');
}

/** Verify the `x-square-hmacsha256-signature` header (timing-safe). */
export function verifyWebhookSignature(
  headers: Record<string, string>,
  rawBody: string,
  config: WebhookSignatureConfig,
): boolean {
  const provided = lowerHeaders(headers)[SIGNATURE_HEADER];
  if (!provided) return false;
  const expected = computeWebhookSignature(rawBody, config);
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Square `data.type` → our ImportKind. */
const EVENT_TYPE_TO_KIND: Record<string, ImportKind> = {
  payment: 'payments',
  refund: 'refunds',
  order: 'orders',
  customer: 'customers',
  catalog: 'catalog',
  catalog_version: 'catalog',
  gift_card: 'gift_cards',
  payout: 'payouts',
  dispute: 'disputes',
  invoice: 'invoices',
  inventory_count: 'inventory_counts',
  inventory_counts: 'inventory_counts',
};

export interface NormalizedWebhookEvent {
  eventId: string;
  eventType: string;
  batch: ImportBatch;
}

/**
 * Normalize a parsed Square webhook envelope into an ImportBatch. The
 * envelope is `{ event_id, type, data: { type, id, object: { <type>: {...} } } }`.
 */
export function normalizeWebhookEvent(body: unknown): NormalizedWebhookEvent {
  if (!body || typeof body !== 'object') {
    throw ApiError.badRequest('webhook body must be a JSON object');
  }
  const env = body as Record<string, unknown>;
  const eventId = typeof env.event_id === 'string' ? env.event_id : '';
  const eventType = typeof env.type === 'string' ? env.type : '';
  if (!eventId) throw ApiError.badRequest('webhook envelope missing event_id');

  const data = (env.data ?? {}) as Record<string, unknown>;
  const dataType = typeof data.type === 'string' ? data.type : '';
  const kind = EVENT_TYPE_TO_KIND[dataType];
  if (!kind) {
    throw ApiError.badRequest(`unsupported webhook data.type "${dataType}"`);
  }

  const object = (data.object ?? {}) as Record<string, unknown>;
  // The object is wrapped under its own type key; inventory arrives as an array.
  let records: unknown[] = [];
  const wrapped = object[dataType];
  if (Array.isArray(wrapped)) records = wrapped;
  else if (wrapped && typeof wrapped === 'object') records = [wrapped];
  else if (Array.isArray(object.inventory_counts)) records = object.inventory_counts;
  else if (Object.keys(object).length > 0) records = [object];

  return {
    eventId,
    eventType,
    batch: {
      source: 'square_webhook',
      kind,
      records,
      sourceMeta: { webhookEventId: eventId, fetchedAt: new Date().toISOString() },
    },
  };
}
