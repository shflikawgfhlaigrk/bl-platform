import type { Kysely, Transaction } from 'kysely';
import {
  ApiError,
  asCoreDb,
  audit,
  id,
  nowIso,
  type EventBus,
  type Pagination,
} from '@blacklabel/core';
import {
  IMPORT_KINDS,
  sourceHash,
  validateRecord,
  type ImportBatch,
  type ImportKind,
} from './contract';
import type {
  RetailDatabase,
  RetailImportManifestRow,
  RetailQuarantineRow,
  RetailImportCursorRow,
} from './schema';

type Db = Kysely<RetailDatabase>;
type Trx = Transaction<RetailDatabase>;

/* ------------------------------------------------------------------ *
 * Per-kind normalization: a validated Square record → target rows.
 * Each spec declares its table, natural key columns, and the business
 * columns that participate in change-detection. `orders` is handled
 * specially (header + line replacement) below.
 * ------------------------------------------------------------------ */

interface KindSpec {
  table: keyof RetailDatabase & string;
  keyCols: string[];
  compareCols: string[];
  toRows(rec: Record<string, unknown>): Record<string, unknown>[];
}

const num = (v: unknown): number | null =>
  typeof v === 'number' ? v : null;
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;
const moneyAmount = (m: unknown): number =>
  m && typeof m === 'object' && typeof (m as Record<string, unknown>).amount === 'number'
    ? ((m as Record<string, unknown>).amount as number)
    : 0;

const KIND_SPECS: Record<Exclude<ImportKind, 'orders'>, KindSpec> = {
  payments: {
    table: 'retail_payments',
    keyCols: ['source_id'],
    compareCols: ['paid_at', 'status', 'amount_cents', 'fee_cents', 'customer_source_id', 'order_source_id'],
    toRows: (r) => {
      const fees = Array.isArray(r.processing_fee) ? r.processing_fee : null;
      const feeCents = fees
        ? fees.reduce((s: number, f: unknown) => s + moneyAmount((f as Record<string, unknown>)?.amount_money), 0)
        : null;
      return [
        {
          source_id: r.id,
          paid_at: r.created_at,
          status: r.status,
          amount_cents: moneyAmount(r.amount_money),
          fee_cents: feeCents,
          customer_source_id: str(r.customer_id),
          order_source_id: str(r.order_id),
        },
      ];
    },
  },
  refunds: {
    table: 'retail_refunds',
    keyCols: ['source_id'],
    compareCols: ['refunded_at', 'status', 'amount_cents'],
    toRows: (r) => [
      {
        source_id: r.id,
        refunded_at: r.created_at,
        status: r.status,
        amount_cents: moneyAmount(r.amount_money),
      },
    ],
  },
  customers: {
    table: 'retail_customers',
    keyCols: ['source_id'],
    compareCols: ['given_name', 'family_name', 'email', 'phone', 'created_source', 'customer_created_at'],
    toRows: (r) => [
      {
        source_id: r.id,
        given_name: str(r.given_name),
        family_name: str(r.family_name),
        email: str(r.email_address),
        phone: str(r.phone_number),
        created_source: str(r.creation_source),
        customer_created_at: str(r.created_at),
      },
    ],
  },
  catalog: {
    table: 'retail_catalog_objects',
    keyCols: ['source_id'],
    compareCols: ['object_type', 'name', 'item_source_id', 'price_cents', 'sku', 'upc', 'category_name', 'is_deleted'],
    toRows: (r) => {
      const del = r.is_deleted ? 1 : 0;
      const rows: Record<string, unknown>[] = [];
      const type = r.type;
      if (type === 'ITEM') {
        const itemData = (r.item_data ?? {}) as Record<string, unknown>;
        rows.push({
          source_id: r.id,
          object_type: 'ITEM',
          name: str(itemData.name),
          item_source_id: null,
          price_cents: null,
          sku: null,
          upc: null,
          category_name: null,
          is_deleted: del,
        });
        const variations = Array.isArray(itemData.variations) ? itemData.variations : [];
        for (const v of variations) {
          const vv = (v ?? {}) as Record<string, unknown>;
          const vd = (vv.item_variation_data ?? {}) as Record<string, unknown>;
          rows.push({
            source_id: vv.id,
            object_type: 'ITEM_VARIATION',
            name: str(vd.name),
            item_source_id: str(vd.item_id) ?? (r.id as string),
            price_cents: num(moneyAmount(vd.price_money)) ?? null,
            sku: str(vd.sku),
            upc: str(vd.upc),
            category_name: null,
            is_deleted: vv.is_deleted || r.is_deleted ? 1 : 0,
          });
        }
      } else if (type === 'ITEM_VARIATION') {
        const vd = (r.item_variation_data ?? {}) as Record<string, unknown>;
        rows.push({
          source_id: r.id,
          object_type: 'ITEM_VARIATION',
          name: str(vd.name),
          item_source_id: str(vd.item_id),
          price_cents: num(moneyAmount(vd.price_money)) ?? null,
          sku: str(vd.sku),
          upc: str(vd.upc),
          category_name: null,
          is_deleted: del,
        });
      } else if (type === 'CATEGORY') {
        const cd = (r.category_data ?? {}) as Record<string, unknown>;
        rows.push({
          source_id: r.id,
          object_type: 'CATEGORY',
          name: str(cd.name),
          item_source_id: null,
          price_cents: null,
          sku: null,
          upc: null,
          category_name: str(cd.name),
          is_deleted: del,
        });
      }
      return rows;
    },
  },
  gift_cards: {
    table: 'retail_gift_cards',
    keyCols: ['source_id'],
    compareCols: ['gan', 'state', 'balance_cents', 'gift_card_created_at'],
    toRows: (r) => [
      {
        source_id: r.id,
        gan: str(r.gan),
        state: r.state,
        balance_cents: moneyAmount(r.balance_money),
        gift_card_created_at: str(r.created_at),
      },
    ],
  },
  payouts: {
    table: 'retail_payouts',
    keyCols: ['source_id'],
    compareCols: ['status', 'amount_cents', 'destination_type', 'payout_created_at', 'arrival_date'],
    toRows: (r) => [
      {
        source_id: r.id,
        status: r.status,
        amount_cents: moneyAmount(r.amount_money),
        destination_type: str((r.destination as Record<string, unknown>)?.type),
        payout_created_at: str(r.created_at),
        arrival_date: str(r.arrival_date),
      },
    ],
  },
  disputes: {
    table: 'retail_disputes',
    keyCols: ['source_id'],
    compareCols: ['state', 'reason', 'amount_cents', 'payment_source_id', 'dispute_created_at'],
    toRows: (r) => [
      {
        source_id: r.id,
        state: r.state,
        reason: str(r.reason),
        amount_cents: moneyAmount(r.amount_money),
        payment_source_id: str((r.disputed_payment as Record<string, unknown>)?.payment_id),
        dispute_created_at: str(r.created_at),
      },
    ],
  },
  invoices: {
    table: 'retail_invoices',
    keyCols: ['source_id'],
    compareCols: ['status', 'order_source_id', 'customer_source_id', 'computed_amount_cents', 'invoice_number', 'invoice_created_at'],
    toRows: (r) => {
      const reqs = Array.isArray(r.payment_requests) ? r.payment_requests : [];
      const first = (reqs[0] ?? {}) as Record<string, unknown>;
      return [
        {
          source_id: r.id,
          status: r.status,
          order_source_id: str(r.order_id),
          customer_source_id: str((r.primary_recipient as Record<string, unknown>)?.customer_id),
          computed_amount_cents: moneyAmount(first.computed_amount_money),
          invoice_number: str(r.invoice_number),
          invoice_created_at: str(r.created_at),
        },
      ];
    },
  },
  inventory_counts: {
    table: 'retail_inventory_counts',
    keyCols: ['catalog_source_id', 'location_source_id', 'state'],
    compareCols: ['quantity', 'calculated_at'],
    toRows: (r) => [
      {
        catalog_source_id: r.catalog_object_id,
        location_source_id: r.location_id,
        state: r.state,
        quantity: str(r.quantity),
        calculated_at: str(r.calculated_at),
      },
    ],
  },
};

interface UpsertCounts {
  accepted: number;
  updated: number;
  skipped: number;
}

async function insertChunked(
  trx: Trx,
  table: keyof RetailDatabase & string,
  rows: Record<string, unknown>[],
): Promise<void> {
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    if (chunk.length > 0) {
      await trx.insertInto(table).values(chunk as never).execute();
    }
  }
}

/** Generic idempotent check-then-insert/update over a spec (no ON CONFLICT). */
async function upsertBySpec(
  trx: Trx,
  tenantId: string,
  spec: KindSpec,
  validated: Record<string, unknown>[],
): Promise<UpsertCounts> {
  const t = trx as unknown as {
    selectFrom: (table: string) => any;
    updateTable: (table: string) => any;
  };
  const keyOf = (r: Record<string, unknown>) => JSON.stringify(spec.keyCols.map((c) => r[c]));

  // Build rows; dedupe within the batch (later wins — pagination-overlap safe).
  const built: Record<string, unknown>[] = [];
  for (const rec of validated) built.push(...spec.toRows(rec));
  const totalRows = built.length;
  const deduped = new Map<string, Record<string, unknown>>();
  for (const row of built) deduped.set(keyOf(row), row);

  const existingRows: Record<string, unknown>[] = await t
    .selectFrom(spec.table)
    .select([...spec.keyCols, ...spec.compareCols])
    .where('tenant_id', '=', tenantId)
    .execute();
  const existing = new Map<string, Record<string, unknown>>();
  for (const r of existingRows) existing.set(keyOf(r), r);

  const inserts: Record<string, unknown>[] = [];
  let accepted = 0;
  let updated = 0;
  const now = nowIso();

  for (const row of deduped.values()) {
    const k = keyOf(row);
    const prev = existing.get(k);
    if (!prev) {
      inserts.push({ id: id(), tenant_id: tenantId, ...row, created_at: now });
      accepted += 1;
    } else {
      const same = spec.compareCols.every((c) => (prev[c] ?? null) === (row[c] ?? null));
      if (same) continue;
      const set: Record<string, unknown> = {};
      for (const c of spec.compareCols) set[c] = row[c] ?? null;
      let q = t.updateTable(spec.table).set(set).where('tenant_id', '=', tenantId);
      for (const c of spec.keyCols) q = q.where(c, '=', row[c]);
      await q.execute();
      updated += 1;
    }
  }
  await insertChunked(trx, spec.table, inserts);
  return { accepted, updated, skipped: totalRows - accepted - updated };
}

/** orders: idempotent header upsert + whole-order line replacement. */
async function upsertOrders(
  trx: Trx,
  tenantId: string,
  validated: Record<string, unknown>[],
): Promise<UpsertCounts> {
  const compareCols = ['state', 'total_cents', 'ordered_at', 'location_source_id'];
  const deduped = new Map<string, Record<string, unknown>>();
  for (const rec of validated) deduped.set(String(rec.id), rec);
  const totalRows = validated.length;

  const existingRows = await trx
    .selectFrom('retail_orders')
    .select(['source_id', ...compareCols] as never)
    .where('tenant_id', '=', tenantId)
    .execute();
  const existing = new Map<string, Record<string, unknown>>();
  for (const r of existingRows as unknown as Record<string, unknown>[]) existing.set(String(r.source_id), r);

  let accepted = 0;
  let updated = 0;
  const now = nowIso();

  for (const rec of deduped.values()) {
    const sourceId = String(rec.id);
    const header = {
      state: str(rec.state) ?? '',
      total_cents: moneyAmount(rec.total_money),
      ordered_at: str(rec.created_at) ?? '',
      location_source_id: str(rec.location_id),
    };
    const prev = existing.get(sourceId);
    let changed = true;
    if (prev) {
      changed = !compareCols.every((c) => (prev[c] ?? null) === ((header as Record<string, unknown>)[c] ?? null));
    }

    if (!prev) {
      await trx
        .insertInto('retail_orders')
        .values({ id: id(), tenant_id: tenantId, source_id: sourceId, ...header, created_at: now } as never)
        .execute();
      accepted += 1;
    } else if (changed) {
      await trx
        .updateTable('retail_orders')
        .set(header as never)
        .where('tenant_id', '=', tenantId)
        .where('source_id', '=', sourceId)
        .execute();
      updated += 1;
    }

    // Replace this order's lines only when the order is new or changed —
    // keeps re-imports from ever duplicating lines.
    if (!prev || changed) {
      await trx
        .deleteFrom('retail_order_lines')
        .where('tenant_id', '=', tenantId)
        .where('source_order_id', '=', sourceId)
        .execute();
      const lineItems = Array.isArray(rec.line_items) ? rec.line_items : [];
      const lineRows = lineItems.map((li: unknown) => {
        const l = (li ?? {}) as Record<string, unknown>;
        return {
          id: id(),
          tenant_id: tenantId,
          source_order_id: sourceId,
          name: str(l.name) ?? '',
          quantity: Number(l.quantity ?? 1) || 0,
          total_cents: moneyAmount(l.total_money),
          catalog_source_id: str(l.catalog_object_id),
          category_name: null,
          created_at: now,
        };
      });
      await insertChunked(trx, 'retail_order_lines', lineRows);
    }
  }
  return { accepted, updated, skipped: totalRows - accepted - updated };
}

async function runImporter(
  trx: Trx,
  tenantId: string,
  kind: ImportKind,
  validated: Record<string, unknown>[],
): Promise<UpsertCounts> {
  if (kind === 'orders') return upsertOrders(trx, tenantId, validated);
  return upsertBySpec(trx, tenantId, KIND_SPECS[kind], validated);
}

/* ------------------------------------------------------------------ *
 * Reconciliation totals (payments / orders)
 * ------------------------------------------------------------------ */

async function liveTotals(
  db: Db,
  tenantId: string,
  kind: 'payments' | 'orders',
): Promise<{ grossCents: number; count: number }> {
  if (kind === 'payments') {
    const row = await db
      .selectFrom('retail_payments')
      .select((eb) => [eb.fn.countAll<number>().as('n'), eb.fn.sum<number>('amount_cents').as('gross')])
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'COMPLETED')
      .executeTakeFirst();
    return { grossCents: Number(row?.gross ?? 0), count: Number(row?.n ?? 0) };
  }
  const row = await db
    .selectFrom('retail_orders')
    .select((eb) => [eb.fn.countAll<number>().as('n'), eb.fn.sum<number>('total_cents').as('gross')])
    .where('tenant_id', '=', tenantId)
    .where('state', '=', 'COMPLETED')
    .executeTakeFirst();
  return { grossCents: Number(row?.gross ?? 0), count: Number(row?.n ?? 0) };
}

/* ------------------------------------------------------------------ *
 * The pipeline: validate → quarantine → idempotent upsert → reconcile.
 * ------------------------------------------------------------------ */

export interface RunBatchOptions {
  cursorBefore?: string | null;
  cursorAfter?: string | null;
}

export interface ManifestResult {
  manifestId: string;
  recordCount: number;
  accepted: number;
  updated: number;
  skippedDuplicates: number;
  quarantined: number;
  status: string;
  sourceHash: string;
  reconGrossCents: number | null;
  reconCount: number | null;
}

export async function runImportBatch(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  batch: ImportBatch,
  opts: RunBatchOptions = {},
): Promise<ManifestResult> {
  const manifestId = id();
  const hash = sourceHash(batch.kind, batch.records);
  const startedAt = nowIso();

  // Per-record validation FIRST — malformed rows are quarantined, never skipped.
  const valid: Record<string, unknown>[] = [];
  const quarantineInputs: { record: unknown; errors: unknown }[] = [];
  for (const rec of batch.records) {
    const res = validateRecord(batch.kind, rec);
    if (res.ok) valid.push(res.value as Record<string, unknown>);
    else quarantineInputs.push({ record: rec, errors: res.errors });
  }

  await db
    .insertInto('retail_import_manifests')
    .values({
      id: manifestId,
      tenant_id: tenantId,
      source: batch.source,
      kind: batch.kind,
      record_count: batch.records.length,
      accepted: 0,
      updated: 0,
      skipped_duplicates: 0,
      quarantined: 0,
      source_hash: hash,
      cursor_before: opts.cursorBefore ?? null,
      cursor_after: opts.cursorAfter ?? batch.sourceMeta.cursor ?? null,
      recon_gross_cents: null,
      recon_count: null,
      started_at: startedAt,
      finished_at: null,
      status: 'running',
      error: null,
      created_at: startedAt,
    })
    .execute();

  const quarantineIds: string[] = [];
  try {
    const counts = await db.transaction().execute(async (trx) => {
      const c = await runImporter(trx, tenantId, batch.kind, valid);

      const qNow = nowIso();
      const qRows = quarantineInputs.map((q) => {
        const qid = id();
        quarantineIds.push(qid);
        return {
          id: qid,
          tenant_id: tenantId,
          manifest_id: manifestId,
          kind: batch.kind,
          record: JSON.stringify(q.record),
          errors: JSON.stringify(q.errors),
          status: 'quarantined',
          created_at: qNow,
          updated_at: qNow,
        };
      });
      await insertChunked(trx, 'retail_quarantine', qRows);
      return c;
    });

    let reconGross: number | null = null;
    let reconCount: number | null = null;
    if (batch.kind === 'payments' || batch.kind === 'orders') {
      const totals = await liveTotals(db, tenantId, batch.kind);
      reconGross = totals.grossCents;
      reconCount = totals.count;
    }

    await db
      .updateTable('retail_import_manifests')
      .set({
        accepted: counts.accepted,
        updated: counts.updated,
        skipped_duplicates: counts.skipped,
        quarantined: quarantineInputs.length,
        recon_gross_cents: reconGross,
        recon_count: reconCount,
        finished_at: nowIso(),
        status: 'done',
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', manifestId)
      .execute();

    await audit(
      asCoreDb(db),
      tenantId,
      actor,
      'retail.import_manifest.imported',
      'retail.import_manifest',
      manifestId,
      { source: batch.source, kind: batch.kind, accepted: counts.accepted, updated: counts.updated, quarantined: quarantineInputs.length },
    );

    // Emit AFTER commit: one quarantined event per malformed record.
    for (const qid of quarantineIds) {
      await events.emit(tenantId, 'retail.import.quarantined', {
        v: 1,
        manifestId,
        quarantineId: qid,
        kind: batch.kind,
      });
    }

    return {
      manifestId,
      recordCount: batch.records.length,
      accepted: counts.accepted,
      updated: counts.updated,
      skippedDuplicates: counts.skipped,
      quarantined: quarantineInputs.length,
      status: 'done',
      sourceHash: hash,
      reconGrossCents: reconGross,
      reconCount,
    };
  } catch (err) {
    await db
      .updateTable('retail_import_manifests')
      .set({ status: 'failed', error: err instanceof Error ? err.message : String(err), finished_at: nowIso() })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', manifestId)
      .execute();
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * Cursors (polling adapter reads/writes; export-drop ignores)
 * ------------------------------------------------------------------ */

export async function getCursor(
  db: Db,
  tenantId: string,
  source: string,
  kind: string,
): Promise<RetailImportCursorRow | undefined> {
  return db
    .selectFrom('retail_import_cursors')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('source', '=', source)
    .where('kind', '=', kind)
    .executeTakeFirst();
}

export async function setCursor(
  db: Db,
  tenantId: string,
  source: string,
  kind: string,
  cursor: string,
): Promise<RetailImportCursorRow> {
  const existing = await getCursor(db, tenantId, source, kind);
  const now = nowIso();
  if (existing) {
    await db
      .updateTable('retail_import_cursors')
      .set({ cursor, updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', existing.id)
      .execute();
    return { ...existing, cursor, updated_at: now };
  }
  const row: RetailImportCursorRow = {
    id: id(),
    tenant_id: tenantId,
    source,
    kind,
    cursor,
    updated_at: now,
    created_at: now,
  };
  await db.insertInto('retail_import_cursors').values(row).execute();
  return row;
}

export async function listCursors(db: Db, tenantId: string): Promise<RetailImportCursorRow[]> {
  return db
    .selectFrom('retail_import_cursors')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('source')
    .orderBy('kind')
    .orderBy('id')
    .execute();
}

/* ------------------------------------------------------------------ *
 * Reconciliation
 * ------------------------------------------------------------------ */

export interface ReconciliationRow {
  kind: 'payments' | 'orders';
  manifestId: string;
  expectedGrossCents: number;
  actualGrossCents: number;
  expectedCount: number;
  actualCount: number;
  ok: boolean;
}

export async function reconciliation(
  db: Db,
  events: EventBus,
  tenantId: string,
): Promise<ReconciliationRow[]> {
  const out: ReconciliationRow[] = [];
  for (const kind of ['payments', 'orders'] as const) {
    const latest = await db
      .selectFrom('retail_import_manifests')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('kind', '=', kind)
      .where('status', '=', 'done')
      .where('recon_gross_cents', 'is not', null)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    if (!latest) continue;
    const live = await liveTotals(db, tenantId, kind);
    const expectedGross = latest.recon_gross_cents ?? 0;
    const expectedCount = latest.recon_count ?? 0;
    const ok = expectedGross === live.grossCents && expectedCount === live.count;
    if (!ok) {
      await events.emit(tenantId, 'retail.import.reconciliation_failed', {
        v: 1,
        manifestId: latest.id,
        kind,
        expectedGrossCents: expectedGross,
        actualGrossCents: live.grossCents,
        expectedCount,
        actualCount: live.count,
      });
    }
    out.push({
      kind,
      manifestId: latest.id,
      expectedGrossCents: expectedGross,
      actualGrossCents: live.grossCents,
      expectedCount,
      actualCount: live.count,
      ok,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Staleness / status
 * ------------------------------------------------------------------ */

export async function lastSuccessfulImportAt(
  db: Db,
  tenantId: string,
  kind: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('retail_import_manifests')
    .select((eb) => eb.fn.max<string | null>('finished_at').as('last'))
    .where('tenant_id', '=', tenantId)
    .where('kind', '=', kind)
    .where('status', '=', 'done')
    .executeTakeFirst();
  return row?.last ?? null;
}

export interface KindStatus {
  kind: ImportKind;
  lastSuccessAt: string | null;
  manifestCount: number;
  totalAccepted: number;
  totalQuarantined: number;
}

export async function importStatus(db: Db, tenantId: string): Promise<KindStatus[]> {
  const rows = await db
    .selectFrom('retail_import_manifests')
    .select((eb) => [
      'kind',
      eb.fn.countAll<number>().as('manifests'),
      eb.fn.sum<number>('accepted').as('accepted'),
      eb.fn.sum<number>('quarantined').as('quarantined'),
      eb.fn.max<string | null>('finished_at').as('last'),
    ])
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'done')
    .groupBy('kind')
    .execute();
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  return IMPORT_KINDS.map((kind) => {
    const r = byKind.get(kind);
    return {
      kind,
      lastSuccessAt: r?.last ?? null,
      manifestCount: Number(r?.manifests ?? 0),
      totalAccepted: Number(r?.accepted ?? 0),
      totalQuarantined: Number(r?.quarantined ?? 0),
    };
  });
}

/* ------------------------------------------------------------------ *
 * Manifest + quarantine queries
 * ------------------------------------------------------------------ */

export async function listManifests(
  db: Db,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
): Promise<RetailImportManifestRow[]> {
  return db
    .selectFrom('retail_import_manifests')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export interface ManifestDetail {
  manifest: RetailImportManifestRow;
  quarantineSummary: { quarantined: number; repaired: number; discarded: number };
}

export async function getManifestDetail(
  db: Db,
  tenantId: string,
  manifestId: string,
): Promise<ManifestDetail> {
  const manifest = await db
    .selectFrom('retail_import_manifests')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', manifestId)
    .executeTakeFirst();
  if (!manifest) throw ApiError.notFound('import manifest not found');
  const rows = await db
    .selectFrom('retail_quarantine')
    .select((eb) => ['status', eb.fn.countAll<number>().as('n')])
    .where('tenant_id', '=', tenantId)
    .where('manifest_id', '=', manifestId)
    .groupBy('status')
    .execute();
  const summary = { quarantined: 0, repaired: 0, discarded: 0 };
  for (const r of rows) {
    if (r.status in summary) (summary as Record<string, number>)[r.status] = Number(r.n);
  }
  return { manifest, quarantineSummary: summary };
}

export async function listQuarantine(
  db: Db,
  tenantId: string,
  filter: { status?: string } = {},
  page: Pagination = { limit: 50, offset: 0 },
): Promise<RetailQuarantineRow[]> {
  let q = db
    .selectFrom('retail_quarantine')
    .selectAll()
    .where('tenant_id', '=', tenantId);
  if (filter.status) q = q.where('status', '=', filter.status);
  return q.orderBy('created_at', 'desc').orderBy('id').limit(page.limit).offset(page.offset).execute();
}

export async function getQuarantine(
  db: Db,
  tenantId: string,
  quarantineId: string,
): Promise<RetailQuarantineRow> {
  const row = await db
    .selectFrom('retail_quarantine')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', quarantineId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound('quarantine record not found');
  return row;
}

/** Re-validate a corrected record, upsert it, and mark the row repaired. */
export async function repairQuarantine(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  quarantineId: string,
  correctedRecord: unknown,
): Promise<RetailQuarantineRow> {
  const row = await getQuarantine(db, tenantId, quarantineId);
  if (row.status !== 'quarantined') {
    throw ApiError.conflict(`quarantine record is already "${row.status}"`);
  }
  const kind = row.kind as ImportKind;
  const res = validateRecord(kind, correctedRecord);
  if (!res.ok) {
    throw ApiError.badRequest('corrected record still fails validation', res.errors);
  }
  const now = nowIso();
  await db.transaction().execute(async (trx) => {
    await runImporter(trx, tenantId, kind, [res.value as Record<string, unknown>]);
    await trx
      .updateTable('retail_quarantine')
      .set({ status: 'repaired', record: JSON.stringify(correctedRecord), updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', quarantineId)
      .execute();
  });
  await audit(asCoreDb(db), tenantId, actor, 'retail.quarantine.repaired', 'retail.quarantine', quarantineId, { kind });
  return { ...row, status: 'repaired', record: JSON.stringify(correctedRecord), updated_at: now };
}

/** Discard a quarantined record with a reason (append it to the errors blob). */
export async function discardQuarantine(
  db: Db,
  tenantId: string,
  actor: string,
  quarantineId: string,
  reason: string,
): Promise<RetailQuarantineRow> {
  const row = await getQuarantine(db, tenantId, quarantineId);
  if (row.status === 'discarded') return row;
  const now = nowIso();
  const errors = JSON.stringify({ discardReason: reason, original: safeParse(row.errors) });
  await db
    .updateTable('retail_quarantine')
    .set({ status: 'discarded', errors, updated_at: now })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', quarantineId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'retail.quarantine.discarded', 'retail.quarantine', quarantineId, { reason });
  return { ...row, status: 'discarded', errors, updated_at: now };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
