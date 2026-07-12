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
import type { CatalogDatabase, PublicationState } from './schema';
import * as svc from './service';

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

const departmentSchema = z.object({
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1).optional(),
  parentId: z.string().nullable().optional(),
  sort: z.number().int().optional(),
});

const departmentPatchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  slug: z.string().trim().min(1).optional(),
  parentId: z.string().nullable().optional(),
  sort: z.number().int().optional(),
  archived: z.boolean().optional(),
});

const productSchema = z.object({
  sourceItemId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  departmentId: z.string().nullable().optional(),
  brandId: z.string().nullable().optional(),
  sourceCategoryName: z.string().nullable().optional(),
});

const productPatchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().nullable().optional(),
  departmentId: z.string().nullable().optional(),
  brandId: z.string().nullable().optional(),
  sourceCategoryName: z.string().nullable().optional(),
  archived: z.boolean().optional(),
});

const variationSchema = z.object({
  productId: z.string().trim().min(1),
  sourceVariationId: z.string().trim().min(1),
  name: z.string().optional(),
  sku: z.string().nullable().optional(),
  priceCents: z.number().int().nullable().optional(),
  priceBookId: z.string().nullable().optional(),
  trackInventory: z.boolean().optional(),
});

const variationPatchSchema = z.object({
  name: z.string().optional(),
  sku: z.string().nullable().optional(),
  priceCents: z.number().int().nullable().optional(),
  priceBookId: z.string().nullable().optional(),
  trackInventory: z.boolean().optional(),
  archived: z.boolean().optional(),
});

const barcodeSchema = z.object({ code: z.string().min(1), isPrimary: z.boolean().optional() });

const priceBookSchema = z.object({
  name: z.string().trim().min(1),
  currency: z.string().optional(),
  effectiveFrom: z.string().nullable().optional(),
  effectiveTo: z.string().nullable().optional(),
  status: z.string().optional(),
});

const priceEntrySchema = z.object({
  priceBookId: z.string().min(1),
  variationId: z.string().min(1),
  priceCents: z.number().int().nonnegative(),
  effectiveFrom: z.string().nullable().optional(),
  effectiveTo: z.string().nullable().optional(),
});

const promotionSchema = z.object({
  name: z.string().trim().min(1),
  type: z.enum(['percent_bps', 'fixed_cents']),
  value: z.number().int().nonnegative(),
  scope: z
    .object({
      departmentIds: z.array(z.string()).optional(),
      brandIds: z.array(z.string()).optional(),
      productIds: z.array(z.string()).optional(),
    })
    .optional(),
  startsAt: z.string().nullable().optional(),
  endsAt: z.string().nullable().optional(),
  status: z.string().optional(),
});

const publicationSchema = z.object({
  state: z.enum(['draft', 'published', 'excluded']),
  allowUnpriced: z.boolean().optional(),
});

const kitSchema = z.object({ productId: z.string().min(1), name: z.string().optional() });
const kitComponentSchema = z.object({ variationId: z.string().min(1), quantity: z.number().int().positive() });
const labelSchema = z.object({ variationIds: z.array(z.string()).min(1), at: z.string().optional() });
const assignSchema = z.object({ departmentId: z.string().min(1) });

export function catalogRouter(deps: ModuleDeps<CatalogDatabase>): Hono<TenantEnv> {
  const { db, events } = deps;
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(db)));

  const tid = (c: Context) => c.get('tenantId');

  /* ---- Departments ---- */
  app.get('/departments', async (c) => c.json({ data: await svc.listDepartments(db, tid(c)) }));
  app.get('/departments/tree', async (c) => c.json({ data: await svc.departmentTree(db, tid(c)) }));
  app.post('/departments', async (c) => {
    const body = departmentSchema.parse(await jsonBody(c));
    return c.json({ data: await svc.createDepartment(db, tid(c), actorOf(c), body) }, 201);
  });
  app.patch('/departments/:id', async (c) => {
    const body = departmentPatchSchema.parse(await jsonBody(c));
    return c.json({ data: await svc.updateDepartment(db, tid(c), actorOf(c), c.req.param('id'), body) });
  });

  /* ---- Category mappings (review queue) ---- */
  app.get('/category-mappings', async (c) => {
    const page = parsePagination(c.req.query());
    const status = c.req.query('status');
    const filter: { status?: 'mapped' | 'needs_review' } =
      status === 'needs_review' || status === 'mapped' ? { status } : {};
    return c.json({
      data: await svc.listCategoryMappings(db, tid(c), filter, page),
      limit: page.limit,
      offset: page.offset,
    });
  });
  app.post('/category-mappings/:id/assign', async (c) => {
    const body = assignSchema.parse(await jsonBody(c));
    return c.json({
      data: await svc.assignCategoryMapping(db, tid(c), actorOf(c), c.req.param('id'), body.departmentId),
    });
  });

  /* ---- Brands ---- */
  app.get('/brands', async (c) => c.json({ data: await svc.listBrands(db, tid(c)) }));

  /* ---- Barcode lookup + conflicts (static before /products/:id-ish) ---- */
  app.get('/lookup', async (c) => {
    const code = c.req.query('code');
    if (!code) throw ApiError.badRequest('code query param is required');
    return c.json({ data: await svc.lookupByCode(db, tid(c), code) });
  });
  app.get('/conflicts', async (c) => c.json({ data: await svc.listBarcodeConflicts(db, tid(c)) }));

  /* ---- Products ---- */
  app.get('/products/search', async (c) => {
    const page = parsePagination(c.req.query());
    const q = c.req.query('q') ?? '';
    return c.json({
      data: await svc.searchProducts(db, tid(c), q, page),
      limit: page.limit,
      offset: page.offset,
    });
  });
  app.get('/products', async (c) => {
    const page = parsePagination(c.req.query());
    const q = c.req.query();
    const filter: Parameters<typeof svc.listProducts>[2] = {};
    if (q.publicationState) filter.publicationState = q.publicationState as PublicationState;
    if (q.departmentId) filter.departmentId = q.departmentId;
    if (q.brandId) filter.brandId = q.brandId;
    return c.json({
      data: await svc.listProducts(db, tid(c), filter, page),
      limit: page.limit,
      offset: page.offset,
    });
  });
  app.post('/products', async (c) => {
    const body = productSchema.parse(await jsonBody(c));
    return c.json({ data: await svc.createProduct(db, tid(c), actorOf(c), body) }, 201);
  });
  app.get('/products/:id', async (c) => {
    const p = await svc.getProduct(db, tid(c), c.req.param('id'));
    if (!p) throw ApiError.notFound('product not found');
    return c.json({ data: p });
  });
  app.patch('/products/:id', async (c) => {
    const body = productPatchSchema.parse(await jsonBody(c));
    return c.json({ data: await svc.updateProduct(db, tid(c), actorOf(c), c.req.param('id'), body) });
  });
  app.post('/products/:id/publication', async (c) => {
    const body = publicationSchema.parse(await jsonBody(c));
    return c.json({
      data: await svc.setPublicationState(db, tid(c), actorOf(c), events, c.req.param('id'), body.state, {
        allowUnpriced: body.allowUnpriced,
      }),
    });
  });

  /* ---- Variations ---- */
  app.get('/variations', async (c) => {
    const page = parsePagination(c.req.query());
    const productId = c.req.query('productId');
    return c.json({
      data: await svc.listVariations(db, tid(c), productId ? { productId } : {}, page),
      limit: page.limit,
      offset: page.offset,
    });
  });
  app.post('/variations', async (c) => {
    const body = variationSchema.parse(await jsonBody(c));
    return c.json({ data: await svc.createVariation(db, tid(c), actorOf(c), events, body) }, 201);
  });
  app.get('/variations/:id', async (c) => {
    const v = await svc.getVariation(db, tid(c), c.req.param('id'));
    if (!v) throw ApiError.notFound('variation not found');
    return c.json({ data: v });
  });
  app.patch('/variations/:id', async (c) => {
    const body = variationPatchSchema.parse(await jsonBody(c));
    return c.json({
      data: await svc.updateVariation(db, tid(c), actorOf(c), events, c.req.param('id'), body),
    });
  });

  /* ---- Barcodes ---- */
  app.get('/variations/:id/barcodes', async (c) => c.json({ data: await svc.listBarcodes(db, tid(c), c.req.param('id')) }));
  app.post('/variations/:id/barcodes', async (c) => {
    const body = barcodeSchema.parse(await jsonBody(c));
    return c.json({
      data: await svc.addBarcode(db, tid(c), actorOf(c), c.req.param('id'), body.code, { isPrimary: body.isPrimary }),
    }, 201);
  });

  /* ---- Price books / entries / resolve ---- */
  app.get('/price-books', async (c) => c.json({ data: await svc.listPriceBooks(db, tid(c)) }));
  app.post('/price-books', async (c) => {
    const body = priceBookSchema.parse(await jsonBody(c));
    return c.json({ data: await svc.createPriceBook(db, tid(c), actorOf(c), body) }, 201);
  });
  app.post('/price-entries', async (c) => {
    const body = priceEntrySchema.parse(await jsonBody(c));
    return c.json({ data: await svc.addPriceEntry(db, tid(c), actorOf(c), body) }, 201);
  });
  app.get('/variations/:id/price', async (c) => {
    const at = c.req.query('at');
    return c.json({ data: await svc.resolvePrice(db, tid(c), c.req.param('id'), at) });
  });
  app.get('/variations/:id/promoted-price', async (c) => {
    const at = c.req.query('at');
    return c.json({ data: await svc.resolvePromotedPrice(db, tid(c), c.req.param('id'), at) });
  });

  /* ---- Promotions ---- */
  app.get('/promotions', async (c) => c.json({ data: await svc.listPromotions(db, tid(c)) }));
  app.post('/promotions', async (c) => {
    const body = promotionSchema.parse(await jsonBody(c));
    return c.json({ data: await svc.createPromotion(db, tid(c), actorOf(c), body) }, 201);
  });

  /* ---- Kits ---- */
  app.get('/kits', async (c) => c.json({ data: await svc.listKits(db, tid(c)) }));
  app.post('/kits', async (c) => {
    const body = kitSchema.parse(await jsonBody(c));
    return c.json({ data: await svc.createKit(db, tid(c), actorOf(c), body) }, 201);
  });
  app.get('/kits/:id', async (c) => {
    const at = c.req.query('at');
    return c.json({ data: await svc.getKitComposition(db, tid(c), c.req.param('id'), at) });
  });
  app.post('/kits/:id/components', async (c) => {
    const body = kitComponentSchema.parse(await jsonBody(c));
    return c.json({
      data: await svc.addKitComponent(db, tid(c), actorOf(c), c.req.param('id'), body.variationId, body.quantity),
    }, 201);
  });

  /* ---- Labels ---- */
  app.post('/labels', async (c) => {
    const body = labelSchema.parse(await jsonBody(c));
    return c.json({ data: await svc.labelData(db, tid(c), body.variationIds, body.at) });
  });

  /* ---- Bulk CSV ---- */
  app.get('/export.csv', async (c) => {
    const csv = await svc.exportVariationsCsv(db, tid(c));
    return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8' } });
  });
  app.post('/import/preview', async (c) => {
    const csv = await c.req.text();
    return c.json({ data: svc.previewVariationImport(csv) });
  });
  app.post('/import/commit', async (c) => {
    const csv = await c.req.text();
    return c.json({ data: await svc.commitVariationImport(db, tid(c), actorOf(c), events, csv) }, 201);
  });
  app.get('/bulk-jobs', async (c) => c.json({ data: await svc.listBulkJobs(db, tid(c)) }));

  return app;
}
