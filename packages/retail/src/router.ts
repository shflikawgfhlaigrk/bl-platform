import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  ApiError,
  asCoreDb,
  errorHandler,
  id,
  nowIso,
  parsePagination,
  tenantMiddleware,
  type ModuleDeps,
  type TenantEnv,
} from '@blacklabel/core';
import type { RetailDatabase } from './schema';
import {
  importSales,
  listCustomerLinks,
  listImportRuns,
  listPayments,
  salesSummary,
} from './service';
import { isImportKind, type ImportKind } from './contract';
import { parseExportFile } from './export-adapter';
import { SquarePollingClient, type PollTransport } from './polling-adapter';
import {
  normalizeWebhookEvent,
  verifyWebhookSignature,
  type WebhookSignatureConfig,
} from './webhook-adapter';
import {
  discardQuarantine,
  getCursor,
  getManifestDetail,
  getQuarantine,
  importStatus,
  listCursors,
  listManifests,
  listQuarantine,
  reconciliation,
  repairQuarantine,
  runImportBatch,
  setCursor,
} from './import-service';

/**
 * Integrator-supplied wiring for the credentialed adapters. Both are absent
 * by default (the module ships COLD): webhook verification and API polling
 * only work once the integrator injects the founder-approved config.
 */
export interface RetailImportWiring {
  /** Square webhook signature key + notification URL (from the encrypted store). */
  webhook?: WebhookSignatureConfig;
  /** Injected read-only HTTP transport for API polling — never a live fetch here. */
  pollTransport?: PollTransport;
  /** Overlap window (seconds) applied to the saved watermark each poll run. */
  pollOverlapSeconds?: number;
  pollLimit?: number;
}

const exportDropSchema = z
  .object({
    kind: z.string().min(1),
    records: z.array(z.unknown()).optional(),
    json: z.string().optional(),
  })
  .refine((v) => v.records !== undefined || v.json !== undefined, {
    message: 'provide either "records" or raw "json"',
  });

const pollSchema = z.object({ kind: z.string().min(1) });
const repairSchema = z.object({ record: z.unknown() });
const discardSchema = z.object({ reason: z.string().min(1).max(500) });

const isoDate = z.string().min(1);

const importSchema = z.object({
  source: z.string().trim().min(1).max(200),
  payments: z
    .array(
      z.object({
        sourceId: z.string().min(1),
        paidAt: isoDate,
        status: z.string().min(1),
        amountCents: z.number().int(),
        feeCents: z.number().int().nullable().optional(),
        customerSourceId: z.string().nullable().optional(),
        orderSourceId: z.string().nullable().optional(),
      }),
    )
    .default([]),
  orderLines: z
    .array(
      z.object({
        sourceOrderId: z.string().min(1),
        name: z.string(),
        quantity: z.number(),
        totalCents: z.number().int(),
        catalogSourceId: z.string().nullable().optional(),
        categoryName: z.string().nullable().optional(),
      }),
    )
    .default([]),
  refunds: z
    .array(
      z.object({
        sourceId: z.string().min(1),
        refundedAt: isoDate,
        status: z.string().min(1),
        amountCents: z.number().int(),
      }),
    )
    .default([]),
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

export function retailRouter(
  deps: ModuleDeps<RetailDatabase>,
  wiring: RetailImportWiring = {},
): Hono<TenantEnv> {
  const { db, events } = deps;
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(db)));

  function requireKind(kind: string): ImportKind {
    if (!isImportKind(kind)) throw ApiError.badRequest(`unknown import kind "${kind}"`);
    return kind;
  }

  /** Bulk idempotent POS import (the import CLI calls the service directly). */
  app.post('/import', async (c) => {
    const body = importSchema.parse(await jsonBody(c));
    const result = await importSales(db, events, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: result }, 201);
  });

  app.get('/import-runs', async (c) => {
    const page = parsePagination(c.req.query());
    const runs = await listImportRuns(db, c.get('tenantId'), page);
    return c.json({ data: runs, limit: page.limit, offset: page.offset });
  });

  app.get('/payments', async (c) => {
    const page = parsePagination(c.req.query());
    const payments = await listPayments(db, c.get('tenantId'), page);
    return c.json({ data: payments, limit: page.limit, offset: page.offset });
  });

  app.get('/customer-links', async (c) => {
    const page = parsePagination(c.req.query());
    const links = await listCustomerLinks(db, c.get('tenantId'), page);
    return c.json({ data: links, limit: page.limit, offset: page.offset });
  });

  /** Completed-payments summary; accepts ?from=&to= inclusive ISO bounds. */
  app.get('/summary', async (c) => {
    const { from, to } = c.req.query();
    if (from !== undefined && to !== undefined && from > to) {
      throw ApiError.badRequest('"from" must be <= "to"', { from, to });
    }
    const summary = await salesSummary(db, c.get('tenantId'), { from, to });
    return c.json({ data: summary });
  });

  /* ============================================================ *
   * Incremental import system (provider-neutral)
   * ============================================================ */

  /** Adapter 1 — export drop: kind + records[] or raw json text. */
  app.post('/imports/export-drop', async (c) => {
    const body = exportDropSchema.parse(await jsonBody(c));
    const kind = requireKind(body.kind);
    const batch =
      body.json !== undefined
        ? parseExportFile(kind, body.json)
        : { source: 'square_export' as const, kind, records: body.records ?? [], sourceMeta: { fetchedAt: new Date().toISOString() } };
    const result = await runImportBatch(db, events, c.get('tenantId'), actorOf(c), batch);
    return c.json({ data: result }, 201);
  });

  /** Adapter 3 — webhook: raw body + signature header. 401 bad sig, replay no-op. */
  app.post('/imports/webhook', async (c) => {
    if (!wiring.webhook) {
      throw new ApiError(501, 'webhook ingestion is not wired (no signature key configured)', 'not_implemented');
    }
    const raw = await c.req.text();
    const ok = verifyWebhookSignature(
      { 'x-square-hmacsha256-signature': c.req.header('x-square-hmacsha256-signature') ?? '' },
      raw,
      wiring.webhook,
    );
    if (!ok) throw ApiError.unauthorized('invalid webhook signature');

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw ApiError.badRequest('webhook body is not valid JSON');
    }
    const { eventId, eventType, batch } = normalizeWebhookEvent(parsed);
    const tenantId = c.get('tenantId');

    const priorReceipt = await db
      .selectFrom('retail_webhook_receipts')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('event_id', '=', eventId)
      .executeTakeFirst();
    if (priorReceipt) {
      return c.json({ data: { replayed: true, eventId, manifestId: priorReceipt.manifest_id } });
    }

    const result = await runImportBatch(db, events, tenantId, actorOf(c), batch);
    const receiptNow = nowIso();
    await db
      .insertInto('retail_webhook_receipts')
      .values({
        id: id(),
        tenant_id: tenantId,
        event_id: eventId,
        event_type: eventType,
        manifest_id: result.manifestId,
        received_at: receiptNow,
        created_at: receiptNow,
      })
      .execute();
    return c.json({ data: { replayed: false, eventId, ...result } }, 201);
  });

  /** Adapter 2 — polling: runs the injected transport; 501 when none wired. */
  app.post('/imports/poll', async (c) => {
    const body = pollSchema.parse(await jsonBody(c));
    const kind = requireKind(body.kind);
    if (!wiring.pollTransport) {
      throw new ApiError(501, 'API polling is not wired (no read-only transport injected)', 'not_implemented');
    }
    const tenantId = c.get('tenantId');
    const client = new SquarePollingClient({
      transport: wiring.pollTransport,
      overlapSeconds: wiring.pollOverlapSeconds,
      limit: wiring.pollLimit,
    });
    const saved = await getCursor(db, tenantId, 'square_api', kind);
    const polled = await client.poll(kind, saved?.cursor ?? null);
    const result = await runImportBatch(db, events, tenantId, actorOf(c), polled.batch, {
      cursorBefore: saved?.cursor ?? null,
      cursorAfter: polled.newCursor,
    });
    if (polled.newCursor) await setCursor(db, tenantId, 'square_api', kind, polled.newCursor);
    return c.json({ data: { ...result, pagesFetched: polled.pagesFetched, rateLimitWaits: polled.rateLimitWaits } }, 201);
  });

  app.get('/imports/manifests', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await listManifests(db, c.get('tenantId'), page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });

  app.get('/imports/manifests/:id', async (c) => {
    const detail = await getManifestDetail(db, c.get('tenantId'), c.req.param('id'));
    return c.json({ data: detail });
  });

  app.get('/imports/cursors', async (c) => {
    const rows = await listCursors(db, c.get('tenantId'));
    return c.json({ data: rows });
  });

  app.get('/imports/reconciliation', async (c) => {
    const rows = await reconciliation(db, events, c.get('tenantId'));
    return c.json({ data: rows });
  });

  app.get('/imports/status', async (c) => {
    const rows = await importStatus(db, c.get('tenantId'));
    return c.json({ data: rows });
  });

  app.get('/quarantine', async (c) => {
    const page = parsePagination(c.req.query());
    const { status } = c.req.query();
    const rows = await listQuarantine(db, c.get('tenantId'), { status }, page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });

  app.get('/quarantine/:id', async (c) => {
    const row = await getQuarantine(db, c.get('tenantId'), c.req.param('id'));
    return c.json({ data: row });
  });

  app.post('/quarantine/:id/repair', async (c) => {
    const body = repairSchema.parse(await jsonBody(c));
    const row = await repairQuarantine(
      db,
      events,
      c.get('tenantId'),
      actorOf(c),
      c.req.param('id'),
      body.record,
    );
    return c.json({ data: row });
  });

  app.post('/quarantine/:id/discard', async (c) => {
    const body = discardSchema.parse(await jsonBody(c));
    const row = await discardQuarantine(db, c.get('tenantId'), actorOf(c), c.req.param('id'), body.reason);
    return c.json({ data: row });
  });

  return app;
}
