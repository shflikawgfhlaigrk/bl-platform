import type { Hono } from 'hono';
import {
  asCoreDb,
  coreMigrations,
  createTenant,
  EventBus,
  type TenantEnv,
} from '@blacklabel/core';
import { createTestDb, runMigrations, type Kysely } from '@blacklabel/db';
import { billingMigrations } from '../src/migrations';
import { billingRouter, type BillingRouterOptions } from '../src/router';
import type { BillingDatabase } from '../src/schema';

export interface TestContext {
  db: Kysely<BillingDatabase>;
  events: EventBus;
  app: Hono<TenantEnv>;
  tenantA: { id: string };
  tenantB: { id: string };
}

export async function setupBilling(options: BillingRouterOptions = {}): Promise<TestContext> {
  const db = createTestDb<BillingDatabase>();
  await runMigrations(db, [...coreMigrations, ...billingMigrations]);
  const tenantA = await createTenant(asCoreDb(db), { name: 'Tenant A' });
  const tenantB = await createTenant(asCoreDb(db), { name: 'Tenant B' });
  const events = new EventBus();
  const app = billingRouter({ db, events, contracts: {} }, options);
  return { db, events, app, tenantA, tenantB };
}

/** Fire a router request with the tenant header (and JSON body when given). */
export async function api(
  app: Hono<TenantEnv>,
  tenantId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      'x-tenant-id': tenantId,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

export async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Create a draft invoice through the router; returns the invoice payload. */
export async function makeInvoice(
  ctx: TestContext,
  tenantId: string,
  overrides: Record<string, unknown> = {},
): Promise<any> {
  const res = await api(ctx.app, tenantId, 'POST', '/invoices', {
    customerId: 'cust-1',
    lines: [{ description: 'Work', quantity: 1, unitPriceCents: 10_000 }],
    ...overrides,
  });
  if (res.status !== 201) {
    throw new Error(`makeInvoice failed: ${res.status} ${await res.text()}`);
  }
  return (await json(res)).data;
}

/** Create + send an invoice; returns the sent invoice payload. */
export async function makeSentInvoice(
  ctx: TestContext,
  tenantId: string,
  overrides: Record<string, unknown> = {},
): Promise<any> {
  const invoice = await makeInvoice(ctx, tenantId, overrides);
  const res = await api(ctx.app, tenantId, 'POST', `/invoices/${invoice.id}/send`);
  if (res.status !== 200) {
    throw new Error(`send failed: ${res.status} ${await res.text()}`);
  }
  return (await json(res)).data;
}
