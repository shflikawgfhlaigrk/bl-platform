import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  coreMigrations,
  createTenant,
  errorHandler,
  tenantMiddleware,
  type CoreDatabase,
  type TenantEnv,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';

async function setup() {
  const db = createTestDb<CoreDatabase>();
  await runMigrations(db, coreMigrations);
  const tenant = await createTenant(db, { name: 'Acme Plumbing' });

  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(db));
  app.get('/whoami', (c) => c.json({ tenantId: c.get('tenantId') }));
  return { db, tenant, app };
}

describe('tenantMiddleware', () => {
  it('returns 400 when x-tenant-id header is missing', async () => {
    const { app } = await setup();
    const res = await app.request('/whoami');
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('tenant_header_missing');
  });

  it('returns 400 when x-tenant-id header is blank', async () => {
    const { app } = await setup();
    const res = await app.request('/whoami', { headers: { 'x-tenant-id': '   ' } });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown tenant', async () => {
    const { app } = await setup();
    const res = await app.request('/whoami', { headers: { 'x-tenant-id': 'nope-not-real' } });
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('tenant_unknown');
  });

  it('sets tenantId on the context for a valid tenant', async () => {
    const { app, tenant } = await setup();
    const res = await app.request('/whoami', { headers: { 'x-tenant-id': tenant.id } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantId: tenant.id });
  });
});
