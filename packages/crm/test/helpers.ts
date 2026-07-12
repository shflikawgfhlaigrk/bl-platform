import {
  asCoreDb,
  coreMigrations,
  createTenant,
  EventBus,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { crmMigrations, crmRouter, type CrmDatabase } from '@blacklabel/crm';
import type { Hono } from 'hono';
import type { TenantEnv } from '@blacklabel/core';
import type { Kysely } from 'kysely';

export interface TestContext {
  db: Kysely<CrmDatabase>;
  events: EventBus;
  app: Hono<TenantEnv>;
  /** Tenant A id. */
  A: string;
  /** Tenant B id. */
  B: string;
  req: (tenantId: string, path: string, init?: RequestInit) => Promise<Response>;
  json: (tenantId: string, method: string, path: string, body?: unknown) => Promise<Response>;
}

export async function setup(): Promise<TestContext> {
  const db = createTestDb<CrmDatabase>();
  await runMigrations(db, [...coreMigrations, ...crmMigrations]);
  const tenantA = await createTenant(asCoreDb(db), { name: 'Tenant A' });
  const tenantB = await createTenant(asCoreDb(db), { name: 'Tenant B' });
  const events = new EventBus();
  const app = crmRouter({ db, events, contracts: {} });

  const req: TestContext['req'] = async (tenantId, path, init) =>
    app.request(path, {
      ...init,
      headers: {
        'x-tenant-id': tenantId,
        ...(init?.headers as Record<string, string> | undefined),
      },
    });

  const json: TestContext['json'] = async (tenantId, method, path, body) =>
    app.request(path, {
      method,
      headers: { 'x-tenant-id': tenantId, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  return { db, events, app, A: tenantA.id, B: tenantB.id, req, json };
}

export async function body<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** POST helper that asserts a 201 and returns the created entity. */
export async function create<T = any>(
  ctx: TestContext,
  tenantId: string,
  path: string,
  payload: unknown,
): Promise<T> {
  const res = await ctx.json(tenantId, 'POST', path, payload);
  if (res.status !== 201) {
    throw new Error(`create ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await body(res)).data as T;
}
