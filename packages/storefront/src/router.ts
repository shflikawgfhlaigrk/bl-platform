import { readFile } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, errorHandler } from '@blacklabel/core';
import type { Kysely } from 'kysely';
import type { StorefrontDatabase } from './schema';
import { renderSite, type RenderedSite, type SiteConfig, type ProjectionSite } from './render';
import { readProjection, getLiveRun } from './publish';

/**
 * PUBLIC storefront router. It is public-SHAPED: there is NO `x-tenant-id`
 * header and NO tenant middleware — the tenant is FIXED at construction. Every
 * read hits the `storefront_*` projection ONLY; no private table is ever
 * queried (a test constructs this with a projection-only DB to prove it).
 *
 * Mounted by the integrator at `/store`. External side effects (placing an
 * order, capturing consent, restock) are INJECTED functions — the router never
 * writes private data itself.
 */

export interface PlaceOrderInput {
  lines: Array<{ variationId: string; qty: number }>;
  customer?: { name?: string; email?: string; fulfillment?: string };
}

export interface StorefrontRouterDeps {
  /** A DB handle that need only expose the storefront_* projection tables. */
  db: Kysely<StorefrontDatabase>;
  /** Tenant fixed at construction — never read from a request. */
  tenantId: string;
  config?: Partial<SiteConfig>;
  /** Directory to serve local product images from (optional). */
  imageSourceDir?: string;
  /** Injected order placement (forwards to the Mags OS inventory API). */
  placeOrder?: (input: PlaceOrderInput) => Promise<unknown> | unknown;
  /** Injected double-opt-in consent capture. */
  submitConsent?: (input: { email: string }) => Promise<unknown> | unknown;
  /** Injected restock request. */
  submitRestock?: (input: { variationId: string; email?: string }) => Promise<unknown> | unknown;
  /** Injected order-status lookup by id + email hash. */
  orderStatusLookup?: (input: { orderId: string; email: string }) => Promise<unknown> | unknown;
}

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const rankSearch = (site: ProjectionSite, q: string) => {
  const query = q.trim().toLowerCase();
  if (!query) return [] as Array<{ slug: string; name: string; price: string }>;
  const pre: typeof site.items = [];
  const word: typeof site.items = [];
  const sub: typeof site.items = [];
  for (const it of site.items) {
    const n = it.name.toLowerCase();
    if (n.startsWith(query)) pre.push(it);
    else if (n.split(/[^a-z0-9]+/).includes(query)) word.push(it);
    else if (n.includes(query)) sub.push(it);
  }
  return [...pre, ...word, ...sub].slice(0, 100).map((it) => ({
    slug: it.slug,
    name: it.name,
    price: (() => {
      const prices = it.variations.map((v) => v.priceCents).filter((p): p is number => p != null);
      if (!prices.length) return 'Price not listed';
      const lo = Math.min(...prices);
      const hi = Math.max(...prices);
      const m = (c: number) => `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
      return lo === hi ? m(lo) : `${m(lo)} – ${m(hi)}`;
    })(),
  }));
};

export function storefrontPublicRouter(deps: StorefrontRouterDeps): Hono {
  const app = new Hono();
  app.onError(errorHandler);

  // Cache the rendered live site, keyed by the live run id (rebuild on swap).
  let cache: { runId: string; site: ProjectionSite; rendered: RenderedSite } | null = null;
  async function current(): Promise<{ site: ProjectionSite; rendered: RenderedSite } | null> {
    const live = await getLiveRun(deps.db, deps.tenantId);
    if (!live) return null;
    if (!cache || cache.runId !== live.id) {
      const site = await readProjection(deps.db, deps.tenantId, live.id);
      const rendered = renderSite(site, { ...deps.config, mode: 'live' });
      cache = { runId: live.id, site, rendered };
    }
    return { site: cache.site, rendered: cache.rendered };
  }

  const serve = (c: any, page: { body: string; contentType: string }, status = 200) =>
    c.newResponse(page.body, status, { 'content-type': page.contentType });

  /* -------------------------------- API -------------------------------- */

  app.get('/api/search', async (c) => {
    const cur = await current();
    if (!cur) return c.json({ data: [] });
    const q = c.req.query('q') ?? '';
    return c.json({ data: rankSearch(cur.site, q) });
  });

  app.post('/api/cart-validate', async (c) => {
    const cur = await current();
    if (!cur) throw ApiError.notFound('storefront not published');
    const schema = z.object({ lines: z.array(z.object({ variationId: z.string(), qty: z.number().int().positive() })) });
    const body = schema.parse(await c.req.json());
    const varMap = new Map(cur.site.items.flatMap((it) => it.variations.map((v) => [v.id, { it, v }] as const)));
    const lines = body.lines.map((l) => {
      const hit = varMap.get(l.variationId);
      if (!hit) return { variationId: l.variationId, valid: false, reason: 'unknown_variation' };
      return {
        variationId: l.variationId,
        valid: hit.v.state !== 'out',
        reason: hit.v.state === 'out' ? 'out_of_stock' : null,
        name: `${hit.it.name} ${hit.v.name}`.trim(),
        priceCents: hit.v.priceCents,
        state: hit.v.state,
        qty: l.qty,
      };
    });
    return c.json({ data: { lines, allValid: lines.every((l) => l.valid) } });
  });

  app.post('/api/orders', async (c) => {
    if (!deps.placeOrder) throw new ApiError(501, 'order placement is not available in this mode', 'not_implemented');
    const schema = z.object({
      lines: z.array(z.object({ variationId: z.string(), qty: z.number().int().positive() })).min(1),
      customer: z.object({ name: z.string().optional(), email: z.string().optional(), fulfillment: z.string().optional() }).optional(),
    });
    const body = schema.parse(await c.req.json());
    const result = await deps.placeOrder(body);
    return c.json({ data: result }, 201);
  });

  app.post('/api/consent', async (c) => {
    if (!deps.submitConsent) throw new ApiError(501, 'consent capture is not available in this mode', 'not_implemented');
    const body = z.object({ email: z.string().email() }).parse(await c.req.json());
    return c.json({ data: await deps.submitConsent(body) }, 202);
  });

  app.post('/api/restock-request', async (c) => {
    if (!deps.submitRestock) throw new ApiError(501, 'restock requests are not available in this mode', 'not_implemented');
    const body = z.object({ variationId: z.string(), email: z.string().email().optional() }).parse(await c.req.json());
    return c.json({ data: await deps.submitRestock(body) }, 202);
  });

  app.get('/api/order-status', async (c) => {
    if (!deps.orderStatusLookup) throw new ApiError(501, 'order status lookup is not available in this mode', 'not_implemented');
    const orderId = c.req.query('orderId');
    const email = c.req.query('email');
    if (!orderId || !email) throw ApiError.badRequest('orderId and email are required');
    return c.json({ data: await deps.orderStatusLookup({ orderId, email }) });
  });

  /* ------------------------------ images ------------------------------- */

  app.get('/assets/img/:name', async (c) => {
    if (!deps.imageSourceDir) throw ApiError.notFound('image');
    const name = basename(c.req.param('name')); // strip any path traversal
    const ext = extname(name).toLowerCase();
    try {
      const buf = await readFile(join(deps.imageSourceDir, name));
      return c.newResponse(buf, 200, { 'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream' });
    } catch {
      throw ApiError.notFound('image');
    }
  });

  /* --------------------------- static pages ---------------------------- */

  app.get('/', async (c) => {
    const cur = await current();
    if (!cur) throw ApiError.notFound('storefront not published');
    return serve(c, cur.rendered.byPath.get('index.html')!);
  });

  app.get('/:path{.+}', async (c) => {
    const cur = await current();
    if (!cur) throw ApiError.notFound('storefront not published');
    const path = c.req.param('path');
    const page = cur.rendered.byPath.get(path);
    if (page) return serve(c, page);
    const notFound = cur.rendered.byPath.get('404.html');
    if (notFound) return serve(c, notFound, 404);
    throw ApiError.notFound('page');
  });

  return app;
}
