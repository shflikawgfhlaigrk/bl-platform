import type { Hono } from 'hono';
import {
  asCoreDb,
  coreMigrations,
  createTenant,
  EventBus,
  type Contracts,
  type TenantEnv,
  type TenantRow,
} from '@blacklabel/core';
import { createTestDb, runMigrations, type Kysely } from '@blacklabel/db';
import { quotingMigrations, quotingRouter, type QuotingDatabase } from '@blacklabel/quoting';
import type { QuotingCtx } from '../src/service';

export interface TestWorld {
  db: Kysely<QuotingDatabase>;
  events: EventBus;
  contracts: Contracts;
  app: Hono<TenantEnv>;
  tenantA: TenantRow;
  tenantB: TenantRow;
}

export async function setup(contracts: Contracts = {}): Promise<TestWorld> {
  const db = createTestDb<QuotingDatabase>();
  await runMigrations(db, [...coreMigrations, ...quotingMigrations]);
  const tenantA = await createTenant(asCoreDb(db), { name: 'Tenant A' });
  const tenantB = await createTenant(asCoreDb(db), { name: 'Tenant B' });
  const events = new EventBus();
  const app = quotingRouter({ db, events, contracts });
  return { db, events, contracts, app, tenantA, tenantB };
}

export function ctxFor(world: TestWorld, tenantId: string, actor = 'system'): QuotingCtx {
  return {
    db: world.db,
    events: world.events,
    contracts: world.contracts,
    tenantId,
    actor,
  };
}

/** JSON request against the router with the tenant header set. */
export async function req(
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
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
