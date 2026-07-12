import type { Kysely } from 'kysely';
import {
  ApiError,
  asCoreDb,
  audit,
  id,
  nowIso,
  type EventBus,
  type Pagination,
} from '@blacklabel/core';
import type {
  RetailCustomerLinkRow,
  RetailDatabase,
  RetailImportRunRow,
  RetailOrderLineRow,
  RetailPaymentRow,
  RetailRefundRow,
} from './schema';

type Db = Kysely<RetailDatabase>;

/* ------------------------------------------------------------------ *
 * Import input shapes (POS-export rows, already parsed by the caller)
 * ------------------------------------------------------------------ */

export interface ImportPaymentInput {
  sourceId: string;
  paidAt: string;
  status: string;
  amountCents: number;
  feeCents?: number | null;
  customerSourceId?: string | null;
  orderSourceId?: string | null;
}

export interface ImportOrderLineInput {
  sourceOrderId: string;
  name: string;
  quantity: number;
  totalCents: number;
  catalogSourceId?: string | null;
  categoryName?: string | null;
}

export interface ImportRefundInput {
  sourceId: string;
  refundedAt: string;
  status: string;
  amountCents: number;
}

export interface ImportSalesInput {
  source: string;
  payments: ImportPaymentInput[];
  orderLines: ImportOrderLineInput[];
  refunds: ImportRefundInput[];
}

export interface ImportSalesResult {
  importRunId: string;
  paymentsInserted: number;
  paymentsSkipped: number;
  linesInserted: number;
  linesSkipped: number;
  refundsInserted: number;
  refundsSkipped: number;
  completedGrossCentsAfter: number;
}

/** Insert rows in chunks small enough for SQLite's bind-variable limit. */
async function insertChunked<T extends keyof RetailDatabase & string>(
  db: Db,
  table: T,
  rows: RetailDatabase[T][],
): Promise<void> {
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    if (chunk.length > 0) {
      await db.insertInto(table).values(chunk as never).execute();
    }
  }
}

async function completedGross(db: Db, tenantId: string): Promise<number> {
  const row = await db
    .selectFrom('retail_payments')
    .select((eb) => eb.fn.sum<number>('amount_cents').as('gross'))
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'COMPLETED')
    .executeTakeFirst();
  return Number(row?.gross ?? 0);
}

/**
 * Idempotent bulk import of POS sales facts. Rows whose `source_id` (or, for
 * order lines, whose entire `source_order_id`) already exists for the tenant
 * are skipped, so re-running the same export is a no-op. All inserts happen
 * in one transaction; the import-run ledger row and audit entry are written
 * with the same transaction, and the event fires after commit.
 */
export async function importSales(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  input: ImportSalesInput,
): Promise<ImportSalesResult> {
  if (!input.source.trim()) throw ApiError.badRequest('import source label is required');
  const startedAt = nowIso();

  const result = await db.transaction().execute(async (trx) => {
    const existingPayments = new Set(
      (
        await trx
          .selectFrom('retail_payments')
          .select('source_id')
          .where('tenant_id', '=', tenantId)
          .execute()
      ).map((r) => r.source_id),
    );
    const existingOrders = new Set(
      (
        await trx
          .selectFrom('retail_order_lines')
          .select('source_order_id')
          .where('tenant_id', '=', tenantId)
          .groupBy('source_order_id')
          .execute()
      ).map((r) => r.source_order_id),
    );
    const existingRefunds = new Set(
      (
        await trx
          .selectFrom('retail_refunds')
          .select('source_id')
          .where('tenant_id', '=', tenantId)
          .execute()
      ).map((r) => r.source_id),
    );

    const now = nowIso();

    const paymentRows: RetailPaymentRow[] = [];
    let paymentsSkipped = 0;
    const seenPayments = new Set<string>();
    for (const p of input.payments) {
      if (existingPayments.has(p.sourceId) || seenPayments.has(p.sourceId)) {
        paymentsSkipped += 1;
        continue;
      }
      seenPayments.add(p.sourceId);
      paymentRows.push({
        id: id(),
        tenant_id: tenantId,
        source_id: p.sourceId,
        paid_at: p.paidAt,
        status: p.status,
        amount_cents: p.amountCents,
        fee_cents: p.feeCents ?? null,
        customer_source_id: p.customerSourceId ?? null,
        order_source_id: p.orderSourceId ?? null,
        created_at: now,
      });
    }

    const lineRows: RetailOrderLineRow[] = [];
    let linesSkipped = 0;
    for (const l of input.orderLines) {
      if (existingOrders.has(l.sourceOrderId)) {
        linesSkipped += 1;
        continue;
      }
      lineRows.push({
        id: id(),
        tenant_id: tenantId,
        source_order_id: l.sourceOrderId,
        name: l.name,
        quantity: l.quantity,
        total_cents: l.totalCents,
        catalog_source_id: l.catalogSourceId ?? null,
        category_name: l.categoryName ?? null,
        created_at: now,
      });
    }

    const refundRows: RetailRefundRow[] = [];
    let refundsSkipped = 0;
    const seenRefunds = new Set<string>();
    for (const r of input.refunds) {
      if (existingRefunds.has(r.sourceId) || seenRefunds.has(r.sourceId)) {
        refundsSkipped += 1;
        continue;
      }
      seenRefunds.add(r.sourceId);
      refundRows.push({
        id: id(),
        tenant_id: tenantId,
        source_id: r.sourceId,
        refunded_at: r.refundedAt,
        status: r.status,
        amount_cents: r.amountCents,
        created_at: now,
      });
    }

    await insertChunked(trx as unknown as Db, 'retail_payments', paymentRows);
    await insertChunked(trx as unknown as Db, 'retail_order_lines', lineRows);
    await insertChunked(trx as unknown as Db, 'retail_refunds', refundRows);

    const grossAfter = await completedGross(trx as unknown as Db, tenantId);

    const run: RetailImportRunRow = {
      id: id(),
      tenant_id: tenantId,
      source: input.source.trim(),
      started_at: startedAt,
      finished_at: nowIso(),
      payments_inserted: paymentRows.length,
      payments_skipped: paymentsSkipped,
      lines_inserted: lineRows.length,
      lines_skipped: linesSkipped,
      refunds_inserted: refundRows.length,
      refunds_skipped: refundsSkipped,
      completed_gross_cents_after: grossAfter,
      created_at: nowIso(),
    };
    await trx.insertInto('retail_import_runs').values(run).execute();

    await audit(asCoreDb(trx), tenantId, actor, 'retail.import_run.imported', 'retail.import_run', run.id, {
      source: run.source,
      payments_inserted: run.payments_inserted,
      lines_inserted: run.lines_inserted,
      refunds_inserted: run.refunds_inserted,
    });

    return {
      importRunId: run.id,
      paymentsInserted: run.payments_inserted,
      paymentsSkipped: run.payments_skipped,
      linesInserted: run.lines_inserted,
      linesSkipped: run.lines_skipped,
      refundsInserted: run.refunds_inserted,
      refundsSkipped: run.refunds_skipped,
      completedGrossCentsAfter: grossAfter,
    };
  });

  await events.emit(tenantId, 'retail.import.completed', {
    importRunId: result.importRunId,
    payments: result.paymentsInserted,
    orderLines: result.linesInserted,
    refunds: result.refundsInserted,
  });

  return result;
}

/* ------------------------------------------------------------------ *
 * Customer links (POS customer id → crm customer id)
 * ------------------------------------------------------------------ */

export async function getCustomerLink(
  db: Db,
  tenantId: string,
  sourceId: string,
): Promise<RetailCustomerLinkRow | undefined> {
  return db
    .selectFrom('retail_customer_links')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('source_id', '=', sourceId)
    .executeTakeFirst();
}

export async function linkCustomer(
  db: Db,
  tenantId: string,
  sourceId: string,
  crmCustomerId: string,
): Promise<RetailCustomerLinkRow> {
  const existing = await getCustomerLink(db, tenantId, sourceId);
  if (existing) {
    if (existing.crm_customer_id !== crmCustomerId) {
      throw ApiError.conflict(
        `POS customer "${sourceId}" is already linked to crm customer "${existing.crm_customer_id}"`,
      );
    }
    return existing;
  }
  const row: RetailCustomerLinkRow = {
    id: id(),
    tenant_id: tenantId,
    source_id: sourceId,
    crm_customer_id: crmCustomerId,
    created_at: nowIso(),
  };
  await db.insertInto('retail_customer_links').values(row).execute();
  return row;
}

export async function listCustomerLinks(
  db: Db,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
): Promise<RetailCustomerLinkRow[]> {
  return db
    .selectFrom('retail_customer_links')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

/* ------------------------------------------------------------------ *
 * Read-side summaries
 * ------------------------------------------------------------------ */

export interface SalesSummary {
  paymentCount: number;
  grossCents: number;
  /** Whole cents; null when there are no completed payments. */
  averageTicketCents: number | null;
}

/** Completed-payments summary over an optional inclusive paid_at ISO range. */
export async function salesSummary(
  db: Db,
  tenantId: string,
  range: { from?: string; to?: string } = {},
): Promise<SalesSummary> {
  let q = db
    .selectFrom('retail_payments')
    .select((eb) => [
      eb.fn.countAll<number>().as('n'),
      eb.fn.sum<number>('amount_cents').as('gross'),
    ])
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'COMPLETED');
  if (range.from) q = q.where('paid_at', '>=', range.from);
  if (range.to) q = q.where('paid_at', '<=', range.to);
  const row = await q.executeTakeFirst();
  const n = Number(row?.n ?? 0);
  const gross = Number(row?.gross ?? 0);
  return {
    paymentCount: n,
    grossCents: gross,
    averageTicketCents: n > 0 ? Math.round(gross / n) : null,
  };
}

export async function listImportRuns(
  db: Db,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
): Promise<RetailImportRunRow[]> {
  return db
    .selectFrom('retail_import_runs')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export async function listPayments(
  db: Db,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
): Promise<RetailPaymentRow[]> {
  return db
    .selectFrom('retail_payments')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('paid_at', 'desc')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}
