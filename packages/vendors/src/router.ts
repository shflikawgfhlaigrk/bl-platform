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
import type { VendorsDatabase, VendorStatus } from './schema';
import {
  archiveVendor,
  catalogHistory,
  commitPriceListImport,
  createVendor,
  currentCost,
  getVendor,
  listCatalogEntries,
  listImportJobs,
  listVendors,
  previewPriceListImport,
  setCost,
  updateVendor,
} from './service';

const contactSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  role: z.string().optional(),
});
const addressSchema = z.object({
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  postal: z.string().optional(),
  country: z.string().optional(),
});

const createVendorSchema = z.object({
  name: z.string().trim().min(1).max(200),
  contacts: z.array(contactSchema).optional(),
  address: addressSchema.optional(),
  accountNumber: z.string().nullable().optional(),
  paymentTerms: z.string().nullable().optional(),
  leadTimeDays: z.number().int().min(0).optional(),
  minimumOrderCents: z.number().int().min(0).optional(),
  freeFreightThresholdCents: z.number().int().min(0).nullable().optional(),
});

const updateVendorSchema = createVendorSchema.partial().extend({
  status: z.enum(['active', 'archived']).optional(),
});

const setCostSchema = z.object({
  variationId: z.string().min(1),
  vendorSku: z.string().min(1),
  costCents: z.number().int().min(0),
  casePackQty: z.number().int().min(1),
  effectiveFrom: z.string().min(1).optional(),
});

const mappingSchema = z.object({
  columns: z.object({
    vendorSku: z.string().min(1),
    cost: z.string().min(1),
    casePack: z.string().min(1),
    variation: z.string().min(1).optional(),
  }),
  variationMatch: z.enum(['vendor_sku', 'row_variation']),
  costFormat: z.enum(['dollars', 'cents']).optional(),
});

const importSchema = z.object({
  csv: z.string(),
  config: mappingSchema,
  effectiveFrom: z.string().min(1).optional(),
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

export function vendorsRouter(deps: ModuleDeps<VendorsDatabase>): Hono<TenantEnv> {
  const { db } = deps;
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(db)));

  /* ---- vendors CRUD ---- */
  app.post('/vendors', async (c) => {
    const body = createVendorSchema.parse(await jsonBody(c));
    const v = await createVendor(db, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: v }, 201);
  });

  app.get('/vendors', async (c) => {
    const page = parsePagination(c.req.query());
    const status = c.req.query('status') as VendorStatus | undefined;
    const v = await listVendors(db, c.get('tenantId'), page, status);
    return c.json({ data: v, limit: page.limit, offset: page.offset });
  });

  app.get('/vendors/:id', async (c) => {
    const v = await getVendor(db, c.get('tenantId'), c.req.param('id'));
    if (!v) throw ApiError.notFound('vendor not found');
    return c.json({ data: v });
  });

  app.patch('/vendors/:id', async (c) => {
    const body = updateVendorSchema.parse(await jsonBody(c));
    const v = await updateVendor(db, c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: v });
  });

  app.post('/vendors/:id/archive', async (c) => {
    const v = await archiveVendor(db, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: v });
  });

  /* ---- catalog entries (cost history) ---- */
  app.post('/vendors/:id/catalog-entries', async (c) => {
    const body = setCostSchema.parse(await jsonBody(c));
    const entry = await setCost(db, c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: entry }, 201);
  });

  app.get('/vendors/:id/catalog-entries', async (c) => {
    const page = parsePagination(c.req.query());
    const entries = await listCatalogEntries(db, c.get('tenantId'), c.req.param('id'), page);
    return c.json({ data: entries, limit: page.limit, offset: page.offset });
  });

  app.get('/vendors/:id/catalog-entries/:variationId/history', async (c) => {
    const history = await catalogHistory(
      db,
      c.get('tenantId'),
      c.req.param('id'),
      c.req.param('variationId'),
    );
    return c.json({ data: history });
  });

  app.get('/vendors/:id/catalog-entries/:variationId/current-cost', async (c) => {
    const at = c.req.query('at');
    const entry = await currentCost(
      db,
      c.get('tenantId'),
      c.req.param('variationId'),
      c.req.param('id'),
      at,
    );
    if (!entry) throw ApiError.notFound('no cost effective at the requested instant');
    return c.json({ data: entry });
  });

  /* ---- price-list import (two-phase) ---- */
  app.post('/vendors/:id/import/preview', async (c) => {
    const body = importSchema.parse(await jsonBody(c));
    const preview = await previewPriceListImport(
      db,
      c.get('tenantId'),
      c.req.param('id'),
      body.csv,
      body.config,
    );
    return c.json({ data: preview });
  });

  app.post('/vendors/:id/import/commit', async (c) => {
    const body = importSchema.parse(await jsonBody(c));
    const result = await commitPriceListImport(
      db,
      c.get('tenantId'),
      actorOf(c),
      c.req.param('id'),
      body.csv,
      body.config,
      body.effectiveFrom,
    );
    return c.json({ data: result }, 201);
  });

  app.get('/vendors/:id/import/jobs', async (c) => {
    const page = parsePagination(c.req.query());
    const jobs = await listImportJobs(db, c.get('tenantId'), c.req.param('id'), page);
    return c.json({ data: jobs, limit: page.limit, offset: page.offset });
  });

  return app;
}
