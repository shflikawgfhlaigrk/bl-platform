import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  ApiError,
  asCoreDb,
  errorHandler,
  parsePagination,
  serializeCsv,
  tenantMiddleware,
  type ModuleDeps,
  type TenantEnv,
} from '@blacklabel/core';
import type { FinanceDatabase } from './schema';
import {
  addCashAdjustment,
  addItemCost,
  closeCashSession,
  currentCost,
  exportCsvRows,
  exportTaxEvidence,
  getCashSession,
  importDisputes,
  importPayments,
  importPayouts,
  importRefunds,
  importTaxEvidence,
  importVendorBillRefs,
  listCashAdjustments,
  listCashSessions,
  listItemCosts,
  listLiabilitySnapshots,
  listPayoutMatches,
  listTaxConfigs,
  marginFor,
  matchPayout,
  openCashSession,
  payoutReconciliationSummary,
  periodSummary,
  postExpectedCents,
  recordLiabilitySnapshot,
  upsertTaxConfig,
  type CsvKind,
} from './service';

const iso = z.string().min(1);
const cents = z.number().int();

const sourceKind = z.enum(['card', 'cash', 'external', 'wallet', 'gift_card']);
const jurisdictionSource = z.enum(['show_venue', 'ship_to', 'pos_location', 'unknown']);
const costMethod = z.enum(['vendor_invoice', 'manual', 'weighted_average']);

const importPaymentsSchema = z.object({
  rows: z
    .array(
      z.object({
        sourcePaymentId: z.string().min(1),
        orderRef: z.string().nullable().optional(),
        amountCents: cents,
        feeCents: cents,
        netCents: cents,
        sourceKind,
        cardBrand: z.string().nullable().optional(),
        status: z.string().min(1),
        occurredAt: iso,
      }),
    )
    .default([]),
});

const importRefundsSchema = z.object({
  rows: z
    .array(
      z.object({
        sourceRefundId: z.string().min(1),
        paymentRef: z.string().min(1),
        amountCents: cents,
        occurredAt: iso,
      }),
    )
    .default([]),
});

const importPayoutsSchema = z.object({
  rows: z
    .array(
      z.object({
        sourcePayoutId: z.string().min(1),
        amountCents: cents,
        status: z.string().min(1),
        paidAt: iso,
        coverageStart: z.string().nullable().optional(),
        coverageEnd: z.string().nullable().optional(),
      }),
    )
    .default([]),
});

const importDisputesSchema = z.object({
  rows: z
    .array(
      z.object({
        sourceDisputeId: z.string().min(1),
        paymentRef: z.string().nullable().optional(),
        amountCents: cents,
        status: z.string().min(1),
        occurredAt: iso,
      }),
    )
    .default([]),
});

const importVendorBillsSchema = z.object({
  rows: z
    .array(
      z.object({
        vendorBillRef: z.string().min(1),
        vendorRef: z.string().nullable().optional(),
        amountCents: cents,
        status: z.string().min(1),
        occurredAt: z.string().nullable().optional(),
      }),
    )
    .default([]),
});

const importTaxEvidenceSchema = z.object({
  rows: z
    .array(
      z.object({
        sourceEvidenceId: z.string().min(1),
        orderRef: z.string().min(1),
        jurisdictionSource,
        state: z.string().nullable().optional(),
        amountCents: cents,
        occurredAt: iso,
      }),
    )
    .default([]),
});

const payoutMatchSchema = z.object({
  sourcePayoutId: z.string().min(1),
  candidateSourcePaymentIds: z.array(z.string().min(1)).default([]),
  notes: z.string().nullable().optional(),
});

const openCashSchema = z.object({
  locationRef: z.string().nullable().optional(),
  showRef: z.string().nullable().optional(),
  openedBy: z.string().min(1),
  openingFloatCents: cents,
  note: z.string().nullable().optional(),
});

const expectedSchema = z.object({ expectedCents: cents });

const closeCashSchema = z.object({
  closedBy: z.string().min(1),
  countedCents: cents,
  expectedCents: cents.optional(),
  note: z.string().nullable().optional(),
});

const adjustmentSchema = z.object({
  amountCents: cents,
  reason: z.string().min(1),
  createdBy: z.string().min(1),
});

const itemCostSchema = z.object({
  variationId: z.string().min(1),
  costCents: cents,
  method: costMethod,
  sourceRef: z.string().nullable().optional(),
  effectiveFrom: iso,
});

const marginSchema = z.object({
  at: iso.optional(),
  lines: z
    .array(
      z.object({
        variationId: z.string().min(1),
        unitPriceCents: cents,
        qty: z.number().int().nonnegative(),
      }),
    )
    .default([]),
});

const liabilitySchema = z.object({
  outstandingCents: cents,
  source: z.string().min(1),
  asOf: iso,
});

const taxConfigSchema = z.object({
  jurisdiction: z.string().min(1),
  registered: z.boolean(),
  rateBps: z.number().int().nonnegative().nullable().optional(),
  notes: z.string().nullable().optional(),
});

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw ApiError.badRequest('invalid JSON body');
  }
}

function actorOf(c: Context): string {
  const header = c.req.header('x-user-id');
  return header && header.trim() !== '' ? header.trim() : 'system';
}

const CSV_KINDS: readonly CsvKind[] = [
  'payments',
  'refunds',
  'payouts',
  'cash-sessions',
  'tax-evidence',
  'item-costs',
];

export function financeRouter(deps: ModuleDeps<FinanceDatabase>): Hono<TenantEnv> {
  const { db, events } = deps;
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(db)));

  /* -------- A. imports (idempotent → {inserted,updated,skipped}) -------- */
  app.post('/import/payments', async (c) => {
    const { rows } = importPaymentsSchema.parse(await jsonBody(c));
    const r = await importPayments(db, events, c.get('tenantId'), actorOf(c), rows);
    return c.json({ data: r }, 201);
  });
  app.post('/import/refunds', async (c) => {
    const { rows } = importRefundsSchema.parse(await jsonBody(c));
    const r = await importRefunds(db, events, c.get('tenantId'), actorOf(c), rows);
    return c.json({ data: r }, 201);
  });
  app.post('/import/payouts', async (c) => {
    const { rows } = importPayoutsSchema.parse(await jsonBody(c));
    const r = await importPayouts(db, events, c.get('tenantId'), actorOf(c), rows);
    return c.json({ data: r }, 201);
  });
  app.post('/import/disputes', async (c) => {
    const { rows } = importDisputesSchema.parse(await jsonBody(c));
    const r = await importDisputes(db, events, c.get('tenantId'), actorOf(c), rows);
    return c.json({ data: r }, 201);
  });
  app.post('/import/vendor-bills', async (c) => {
    const { rows } = importVendorBillsSchema.parse(await jsonBody(c));
    const r = await importVendorBillRefs(db, events, c.get('tenantId'), actorOf(c), rows);
    return c.json({ data: r }, 201);
  });
  app.post('/import/tax-evidence', async (c) => {
    const { rows } = importTaxEvidenceSchema.parse(await jsonBody(c));
    const r = await importTaxEvidence(db, events, c.get('tenantId'), actorOf(c), rows);
    return c.json({ data: r }, 201);
  });

  /* -------- B. payout reconciliation -------- */
  app.post('/payout-matches/run', async (c) => {
    const body = payoutMatchSchema.parse(await jsonBody(c));
    const r = await matchPayout(db, events, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: r.match }, 201);
  });
  app.get('/payout-matches', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await listPayoutMatches(db, c.get('tenantId'), page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });
  app.get('/payout-matches/summary', async (c) => {
    const s = await payoutReconciliationSummary(db, c.get('tenantId'));
    return c.json({ data: s });
  });

  /* -------- C. cash sessions -------- */
  app.post('/cash-sessions', async (c) => {
    const body = openCashSchema.parse(await jsonBody(c));
    const s = await openCashSession(db, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: s }, 201);
  });
  app.get('/cash-sessions', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await listCashSessions(db, c.get('tenantId'), page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });
  app.get('/cash-sessions/:id', async (c) => {
    const s = await getCashSession(db, c.get('tenantId'), c.req.param('id'));
    return c.json({ data: s });
  });
  app.put('/cash-sessions/:id/expected', async (c) => {
    const { expectedCents } = expectedSchema.parse(await jsonBody(c));
    const s = await postExpectedCents(db, c.get('tenantId'), actorOf(c), c.req.param('id'), expectedCents);
    return c.json({ data: s });
  });
  app.post('/cash-sessions/:id/close', async (c) => {
    const body = closeCashSchema.parse(await jsonBody(c));
    const s = await closeCashSession(db, events, c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: s });
  });
  app.post('/cash-sessions/:id/adjustments', async (c) => {
    const body = adjustmentSchema.parse(await jsonBody(c));
    const a = await addCashAdjustment(db, c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: a }, 201);
  });
  app.get('/cash-sessions/:id/adjustments', async (c) => {
    const rows = await listCashAdjustments(db, c.get('tenantId'), c.req.param('id'));
    return c.json({ data: rows });
  });

  /* -------- D. item costs + margin -------- */
  app.post('/item-costs', async (c) => {
    const body = itemCostSchema.parse(await jsonBody(c));
    const r = await addItemCost(db, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: r }, 201);
  });
  app.get('/item-costs', async (c) => {
    const variationId = c.req.query('variationId');
    if (!variationId) throw ApiError.badRequest('variationId query param is required');
    const rows = await listItemCosts(db, c.get('tenantId'), variationId);
    return c.json({ data: rows });
  });
  app.get('/item-costs/current', async (c) => {
    const variationId = c.req.query('variationId');
    if (!variationId) throw ApiError.badRequest('variationId query param is required');
    const at = c.req.query('at');
    const cost = await currentCost(db, c.get('tenantId'), variationId, at);
    return c.json({ data: cost ?? null });
  });
  app.post('/margin', async (c) => {
    const body = marginSchema.parse(await jsonBody(c));
    const r = await marginFor(db, c.get('tenantId'), body.lines, body.at);
    return c.json({ data: r });
  });

  /* -------- D2. liability snapshots -------- */
  app.post('/liability-snapshots', async (c) => {
    const body = liabilitySchema.parse(await jsonBody(c));
    const r = await recordLiabilitySnapshot(db, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: r }, 201);
  });
  app.get('/liability-snapshots', async (c) => {
    const page = parsePagination(c.req.query());
    const source = c.req.query('source');
    const rows = await listLiabilitySnapshots(db, c.get('tenantId'), source, page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });

  /* -------- E. tax config + evidence -------- */
  app.post('/tax-configs', async (c) => {
    const body = taxConfigSchema.parse(await jsonBody(c));
    const r = await upsertTaxConfig(db, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: r }, 201);
  });
  app.get('/tax-configs', async (c) => {
    const rows = await listTaxConfigs(db, c.get('tenantId'));
    return c.json({ data: rows });
  });
  app.get('/tax-evidence/export', async (c) => {
    const groups = await exportTaxEvidence(db, c.get('tenantId'));
    return c.json({ data: groups });
  });

  /* -------- F. period summaries -------- */
  app.get('/period-summary', async (c) => {
    const period = c.req.query('period');
    if (!period) throw ApiError.badRequest('period query param is required (YYYY or YYYY-MM)');
    const s = await periodSummary(db, c.get('tenantId'), period);
    return c.json({ data: s });
  });

  /* -------- G. CSV exports -------- */
  app.get('/exports/:kind', async (c) => {
    const raw = c.req.param('kind').replace(/\.csv$/, '');
    if (!CSV_KINDS.includes(raw as CsvKind)) {
      throw ApiError.badRequest(`unknown export kind "${raw}"`);
    }
    const rows = await exportCsvRows(db, c.get('tenantId'), raw as CsvKind);
    const csv = serializeCsv(rows);
    return c.body(csv, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="finance-${raw}.csv"`,
    });
  });

  return app;
}
