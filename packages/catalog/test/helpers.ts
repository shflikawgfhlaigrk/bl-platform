import { asCoreDb, coreMigrations, createTenant, EventBus, type TenantEnv } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import type { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { catalogMigrations } from '../src/migrations';
import { catalogRouter } from '../src/router';
import type { CatalogDatabase } from '../src/schema';

export interface Ctx {
  db: Kysely<CatalogDatabase>;
  events: EventBus;
  app: Hono<TenantEnv>;
  A: string;
  B: string;
  req: (tenantId: string, path: string, init?: RequestInit) => Promise<Response>;
  json: (tenantId: string, method: string, path: string, body?: unknown) => Promise<Response>;
  csv: (tenantId: string, path: string, csv: string) => Promise<Response>;
}

export async function setup(): Promise<Ctx> {
  const db = createTestDb<CatalogDatabase>();
  await runMigrations(db, [...coreMigrations, ...catalogMigrations]);
  const A = (await createTenant(asCoreDb(db), { name: 'Alpha Tack' })).id;
  const B = (await createTenant(asCoreDb(db), { name: 'Beta Tack' })).id;
  const events = new EventBus();
  const app = catalogRouter({ db, events, contracts: {} });

  const req: Ctx['req'] = async (tenantId, path, init) =>
    app.request(path, {
      ...init,
      headers: { 'x-tenant-id': tenantId, ...(init?.headers as Record<string, string> | undefined) },
    });
  const json: Ctx['json'] = async (tenantId, method, path, body) =>
    app.request(path, {
      method,
      headers: { 'x-tenant-id': tenantId, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const csv: Ctx['csv'] = async (tenantId, path, body) =>
    app.request(path, {
      method: 'POST',
      headers: { 'x-tenant-id': tenantId, 'content-type': 'text/csv' },
      body,
    });

  return { db, events, app, A, B, req, json, csv };
}

export async function body<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export async function create<T = any>(ctx: Ctx, tenantId: string, path: string, payload: unknown): Promise<T> {
  const res = await ctx.json(tenantId, 'POST', path, payload);
  if (res.status !== 201) throw new Error(`create ${path} failed: ${res.status} ${await res.text()}`);
  return (await body(res)).data as T;
}

/** Seed one department + product + variation for a tenant; returns their ids. */
export async function seedProduct(
  ctx: Ctx,
  tenantId: string,
  opts: { deptSlug?: string; priceCents?: number | null; sku?: string | null } = {},
) {
  const dept = await create(ctx, tenantId, '/departments', { name: 'Tack', slug: opts.deptSlug ?? 'tack' });
  const product = await create(ctx, tenantId, '/products', {
    sourceItemId: `item_${Math.random().toString(36).slice(2)}`,
    name: 'LeMieux Saddle Pad',
    departmentId: dept.id,
    sourceCategoryName: 'Saddle Pads',
  });
  const variation = await create(ctx, tenantId, '/variations', {
    productId: product.id,
    sourceVariationId: `var_${Math.random().toString(36).slice(2)}`,
    name: 'Medium',
    sku: opts.sku === undefined ? 'SKU-MED-1' : opts.sku,
    priceCents: opts.priceCents === undefined ? 4999 : opts.priceCents,
  });
  return { dept, product, variation };
}
