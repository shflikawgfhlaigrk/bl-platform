import type { Hono } from 'hono';
import {
  EventBus,
  asCoreDb,
  coreMigrations,
  createTenant,
  createUser,
  type TenantEnv,
  type UserRole,
} from '@blacklabel/core';
import { createTestDb, runMigrations, type Kysely } from '@blacklabel/db';
import {
  seedBuiltinRoles,
  workforceMigrations,
  workforceRouter,
  type SeedBuiltinRolesResult,
  type WorkforceDatabase,
} from '@blacklabel/workforce';

export interface TestContext {
  db: Kysely<WorkforceDatabase>;
  events: EventBus;
  app: Hono<TenantEnv>;
  tenantA: string;
  tenantB: string;
}

export async function setup(): Promise<TestContext> {
  const db = createTestDb<WorkforceDatabase>();
  await runMigrations(db, [...coreMigrations, ...workforceMigrations]);
  const tenantA = (await createTenant(asCoreDb(db), { name: 'Tenant A' })).id;
  const tenantB = (await createTenant(asCoreDb(db), { name: 'Tenant B' })).id;
  const events = new EventBus();
  const app = workforceRouter({ db, events, contracts: {} });
  return { db, events, app, tenantA, tenantB };
}

export async function seed(ctx: TestContext, tenantId: string): Promise<SeedBuiltinRolesResult> {
  return seedBuiltinRoles(ctx.db, tenantId);
}

export async function makeUser(
  ctx: TestContext,
  tenantId: string,
  input: { name: string; email: string; role?: UserRole },
): Promise<string> {
  const user = await createUser(asCoreDb(ctx.db), tenantId, {
    name: input.name,
    email: input.email,
    role: input.role ?? 'member',
  });
  return user.id;
}

function headers(tenantId?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (tenantId !== undefined) h['x-tenant-id'] = tenantId;
  return h;
}

export async function get(
  ctx: TestContext,
  tenantId: string | undefined,
  path: string,
): Promise<Response> {
  return ctx.app.request(path, { headers: headers(tenantId) });
}

export async function post(
  ctx: TestContext,
  tenantId: string | undefined,
  path: string,
  body: unknown = {},
): Promise<Response> {
  return ctx.app.request(path, {
    method: 'POST',
    headers: headers(tenantId),
    body: JSON.stringify(body),
  });
}

export async function put(
  ctx: TestContext,
  tenantId: string | undefined,
  path: string,
  body: unknown = {},
): Promise<Response> {
  return ctx.app.request(path, {
    method: 'PUT',
    headers: headers(tenantId),
    body: JSON.stringify(body),
  });
}

export async function patch(
  ctx: TestContext,
  tenantId: string | undefined,
  path: string,
  body: unknown = {},
): Promise<Response> {
  return ctx.app.request(path, {
    method: 'PATCH',
    headers: headers(tenantId),
    body: JSON.stringify(body),
  });
}

export async function del(
  ctx: TestContext,
  tenantId: string | undefined,
  path: string,
): Promise<Response> {
  return ctx.app.request(path, { method: 'DELETE', headers: headers(tenantId) });
}

export async function body(res: Response): Promise<any> {
  return res.json();
}
