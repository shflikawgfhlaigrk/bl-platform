import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  ApiError,
  asCoreDb,
  errorHandler,
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

export function retailRouter(deps: ModuleDeps<RetailDatabase>): Hono<TenantEnv> {
  const { db, events } = deps;
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(db)));

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

  return app;
}
