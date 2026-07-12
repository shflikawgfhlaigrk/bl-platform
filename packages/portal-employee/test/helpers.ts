import type { Hono } from 'hono';
import {
  EventBus,
  asCoreDb,
  coreMigrations,
  createTenant,
  type TenantEnv,
} from '@blacklabel/core';
import { createTestDb, runMigrations, type Kysely } from '@blacklabel/db';
import {
  portalEmployeeMigrations,
  portalEmployeeRouter,
  type PortalEmployeeDatabase,
} from '@blacklabel/portal-employee';

export interface TestContext {
  db: Kysely<PortalEmployeeDatabase>;
  events: EventBus;
  app: Hono<TenantEnv>;
  tenantA: string;
  tenantB: string;
}

export async function setup(): Promise<TestContext> {
  const db = createTestDb<PortalEmployeeDatabase>();
  await runMigrations(db, [...coreMigrations, ...portalEmployeeMigrations]);
  const tenantA = (await createTenant(asCoreDb(db), { name: 'Tenant A' })).id;
  const tenantB = (await createTenant(asCoreDb(db), { name: 'Tenant B' })).id;
  const events = new EventBus();
  const app = portalEmployeeRouter({ db, events, contracts: {} });
  return { db, events, app, tenantA, tenantB };
}

function headers(tenantId: string, token?: string): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    'x-tenant-id': tenantId,
  };
  if (token !== undefined) h['x-employee-token'] = token;
  return h;
}

export async function get(
  app: Hono<TenantEnv>,
  tenantId: string,
  path: string,
  token?: string,
): Promise<Response> {
  return app.request(path, { headers: headers(tenantId, token) });
}

export async function post(
  app: Hono<TenantEnv>,
  tenantId: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: headers(tenantId, token),
    body: JSON.stringify(body),
  });
}

export async function patch(
  app: Hono<TenantEnv>,
  tenantId: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return app.request(path, {
    method: 'PATCH',
    headers: headers(tenantId),
    body: JSON.stringify(body),
  });
}

export async function del(app: Hono<TenantEnv>, tenantId: string, path: string): Promise<Response> {
  return app.request(path, { method: 'DELETE', headers: headers(tenantId) });
}

export async function body(res: Response): Promise<any> {
  return res.json();
}

/** Create an employee + portal token via the router; returns ids and the token string. */
export async function makeEmployee(
  ctx: TestContext,
  tenantId: string,
  input: { name: string; email: string; role?: 'worker' | 'manager' | 'admin' },
): Promise<{ employeeId: string; token: string }> {
  const created = await post(ctx.app, tenantId, '/employees', input);
  if (created.status !== 201) throw new Error(`makeEmployee failed: ${created.status}`);
  const employee = (await created.json() as any).data;
  const issued = await post(ctx.app, tenantId, `/employees/${employee.id}/tokens`, {});
  if (issued.status !== 201) throw new Error(`token issue failed: ${issued.status}`);
  const token = (await issued.json() as any).data;
  return { employeeId: employee.id, token: token.token };
}

/** Create an assignment via the router (back-office surface). */
export async function makeAssignment(
  ctx: TestContext,
  tenantId: string,
  input: Record<string, unknown>,
): Promise<any> {
  const res = await post(ctx.app, tenantId, '/assignments', input);
  if (res.status !== 201) throw new Error(`makeAssignment failed: ${res.status}`);
  return ((await res.json()) as any).data;
}
