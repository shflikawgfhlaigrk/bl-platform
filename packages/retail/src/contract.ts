import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * The normalized import contract. Every adapter — export drop, API polling,
 * webhook ingestion, and the simulator — produces this exact shape, so the
 * downstream pipeline (validate → quarantine → idempotent upsert →
 * reconcile) is identical regardless of where the records came from.
 */

export const IMPORT_SOURCES = [
  'square_export',
  'square_api',
  'square_webhook',
  'simulator',
] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export const IMPORT_KINDS = [
  'payments',
  'orders',
  'customers',
  'catalog',
  'gift_cards',
  'payouts',
  'disputes',
  'invoices',
  'inventory_counts',
  'refunds',
] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export interface ImportSourceMeta {
  /** Export-drop file name, when the batch came from a dropped file. */
  fileName?: string;
  /** Polling cursor/watermark the batch was fetched at. */
  cursor?: string;
  /** Webhook event id, for replay-safe dedup. */
  webhookEventId?: string;
  /** ISO-8601 UTC when the batch was produced. */
  fetchedAt: string;
}

/** The one shape all three adapters + the simulator emit. */
export interface ImportBatch {
  source: ImportSource;
  kind: ImportKind;
  records: unknown[];
  sourceMeta: ImportSourceMeta;
}

export function isImportKind(v: string): v is ImportKind {
  return (IMPORT_KINDS as readonly string[]).includes(v);
}

/* ------------------------------------------------------------------ *
 * Canonical source hash — key-order independent, so the SAME input
 * (whatever the JSON key ordering) always yields the SAME sha256.
 * ------------------------------------------------------------------ */

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** sha256 (hex) of the canonicalized {kind, records}. Deterministic. */
export function sourceHash(kind: ImportKind, records: unknown[]): string {
  const canonical = JSON.stringify(canonicalize({ kind, records }));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/* ------------------------------------------------------------------ *
 * Per-kind zod schemas — validate the REAL Square export record shapes
 * (nested *_money objects, snake_case fields). Invalid records are
 * quarantined, never silently skipped.
 * ------------------------------------------------------------------ */

const money = z.object({ amount: z.number().int() }).passthrough();
const optionalMoney = money.optional();

const paymentSchema = z
  .object({
    id: z.string().min(1),
    created_at: z.string().min(1),
    status: z.string().min(1),
    amount_money: money,
    processing_fee: z.array(z.object({ amount_money: money }).passthrough()).optional(),
    customer_id: z.string().nullish(),
    order_id: z.string().nullish(),
  })
  .passthrough();

const orderLineSchema = z
  .object({
    name: z.string().nullish(),
    quantity: z.string().nullish(),
    catalog_object_id: z.string().nullish(),
    total_money: optionalMoney,
  })
  .passthrough();

const orderSchema = z
  .object({
    id: z.string().min(1),
    state: z.string().nullish(),
    created_at: z.string().nullish(),
    location_id: z.string().nullish(),
    total_money: optionalMoney,
    line_items: z.array(orderLineSchema).nullish(),
  })
  .passthrough();

const customerSchema = z
  .object({
    id: z.string().min(1),
    created_at: z.string().nullish(),
    given_name: z.string().nullish(),
    family_name: z.string().nullish(),
    email_address: z.string().nullish(),
    phone_number: z.string().nullish(),
    creation_source: z.string().nullish(),
  })
  .passthrough();

const catalogSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    is_deleted: z.boolean().nullish(),
    item_data: z.record(z.unknown()).nullish(),
    item_variation_data: z.record(z.unknown()).nullish(),
    category_data: z.record(z.unknown()).nullish(),
  })
  .passthrough();

const giftCardSchema = z
  .object({
    id: z.string().min(1),
    state: z.string().min(1),
    balance_money: money,
    gan: z.string().nullish(),
    created_at: z.string().nullish(),
  })
  .passthrough();

const payoutSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1),
    amount_money: money,
    destination: z.object({ type: z.string().nullish() }).passthrough().nullish(),
    created_at: z.string().nullish(),
    arrival_date: z.string().nullish(),
  })
  .passthrough();

const disputeSchema = z
  .object({
    id: z.string().min(1),
    state: z.string().min(1),
    reason: z.string().nullish(),
    amount_money: money,
    disputed_payment: z.object({ payment_id: z.string().nullish() }).passthrough().nullish(),
    created_at: z.string().nullish(),
  })
  .passthrough();

const invoiceSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1),
    order_id: z.string().nullish(),
    invoice_number: z.string().nullish(),
    created_at: z.string().nullish(),
    primary_recipient: z.object({ customer_id: z.string().nullish() }).passthrough().nullish(),
    payment_requests: z
      .array(z.object({ computed_amount_money: optionalMoney }).passthrough())
      .nullish(),
  })
  .passthrough();

const inventoryCountSchema = z
  .object({
    catalog_object_id: z.string().min(1),
    location_id: z.string().min(1),
    state: z.string().min(1),
    quantity: z.string().nullish(),
    calculated_at: z.string().nullish(),
  })
  .passthrough();

const refundSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1),
    amount_money: money,
    created_at: z.string().min(1),
    payment_id: z.string().nullish(),
    order_id: z.string().nullish(),
  })
  .passthrough();

export const KIND_SCHEMAS: Record<ImportKind, z.ZodTypeAny> = {
  payments: paymentSchema,
  orders: orderSchema,
  customers: customerSchema,
  catalog: catalogSchema,
  gift_cards: giftCardSchema,
  payouts: payoutSchema,
  disputes: disputeSchema,
  invoices: invoiceSchema,
  inventory_counts: inventoryCountSchema,
  refunds: refundSchema,
};

/** Validate one record against its kind schema. */
export function validateRecord(
  kind: ImportKind,
  record: unknown,
): { ok: true; value: unknown } | { ok: false; errors: unknown } {
  const parsed = KIND_SCHEMAS[kind].safeParse(record);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, errors: parsed.error.issues };
}
