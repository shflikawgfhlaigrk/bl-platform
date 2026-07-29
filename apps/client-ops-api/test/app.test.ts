import { afterEach, describe, expect, it } from 'vitest';
import {
  clientOpsMigrations,
  registerReadyFoundations,
  ServiceFoundationRegistry,
  type ClientOpsDatabase,
} from '@blacklabel/client-ops';
import { asCoreDb, coreMigrations, createTenant, EventBus } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { createClientOpsHttpApp, withBearerAuth, withDefaultTenant } from '../src/app';
import { seedClientOpsProductStarter } from '../src/demo';

const databases: Array<ReturnType<typeof createTestDb<ClientOpsDatabase>>> = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

async function setup(options: { seedDemo?: boolean; registry?: ServiceFoundationRegistry } = { seedDemo: true }) {
  const db = createTestDb<ClientOpsDatabase>();
  databases.push(db);
  await runMigrations(db, [...coreMigrations, ...clientOpsMigrations]);
  const tenant = await createTenant(asCoreDb(db), { name: 'Demo Service Company' });
  const events = new EventBus();
  if (options.seedDemo ?? true) await seedClientOpsProductStarter(db, events, tenant.id);
  const app = createClientOpsHttpApp({
    db, events, tenantId: tenant.id, tenantName: tenant.name, registry: options.registry,
  });
  return { app, db, tenant };
}

describe('client-ops standalone HTTP app', () => {
  it('starts production onboarding empty while the static 30-product portfolio remains visible', async () => {
    const { app, db, tenant } = await setup({ seedDemo: false });
    const bootstrap = await app.request('/api/bootstrap');
    expect(((await bootstrap.json()) as any).data).toMatchObject({
      tenantId: tenant.id, environment: 'Production onboarding',
    });
    const installations = await db.selectFrom('client_ops_installations').select('id')
      .where('tenant_id', '=', tenant.id).execute();
    expect(installations).toEqual([]);
    const portfolio = await app.request('/api/client-ops/portfolio', { headers: { 'x-tenant-id': tenant.id } });
    expect(((await portfolio.json()) as any).data.summary).toMatchObject({ total: 30, verifiedCount: 0 });
  });

  it('exposes health/bootstrap and installs all eight services without claiming external adapters live', async () => {
    const { app, db, tenant } = await setup();
    const health = await app.request('/api/health');
    expect(health.status).toBe(200);
    expect(((await health.json()) as any).data.ok).toBe(true);
    const bootstrap = await app.request('/api/bootstrap');
    expect(((await bootstrap.json()) as any).data).toMatchObject({ tenantId: tenant.id, tenantName: tenant.name });

    const installations = await db.selectFrom('client_ops_installations').select(['catalog_id', 'status'])
      .where('tenant_id', '=', tenant.id).orderBy('catalog_id').execute();
    expect(installations).toHaveLength(8);
    expect(installations.filter((item) => item.status === 'active').map((item) => item.catalog_id))
      .toEqual(['workflow-operating-system']);
    const externalConnected = await db.selectFrom('client_ops_connector_bindings')
      .select('client_ops_connector_bindings.id')
      .innerJoin('client_ops_installations', 'client_ops_installations.id', 'client_ops_connector_bindings.installation_id')
      .where('client_ops_connector_bindings.tenant_id', '=', tenant.id)
      .where('client_ops_installations.catalog_id', '!=', 'workflow-operating-system')
      .where('client_ops_connector_bindings.status', '=', 'connected').execute();
    expect(externalConnected).toHaveLength(0);
  });

  it('injects the local tenant for client-ops requests but preserves an explicit tenant', async () => {
    const { app, tenant } = await setup();
    const fetch = withDefaultTenant((request) => app.fetch(request), tenant.id);
    const response = await fetch(new Request('http://localhost/api/client-ops/overview'));
    expect(response.status).toBe(200);
    const explicit = await fetch(new Request('http://localhost/api/client-ops/overview', {
      headers: { 'x-tenant-id': 'tenant_that_does_not_exist' },
    }));
    expect(explicit.status).toBe(404);
  });

  it('rejects unauthenticated API calls before tenant injection while /api/health stays open', async () => {
    const { app, tenant } = await setup();
    const token = 'engine-shared-secret';
    const fetch = withBearerAuth(
      withDefaultTenant((request) => app.fetch(request), tenant.id),
      token,
    );
    const health = await fetch(new Request('http://localhost/api/health'));
    expect(health.status).toBe(200);
    const missing = await fetch(new Request('http://localhost/api/client-ops/overview'));
    expect(missing.status).toBe(401);
    const wrong = await fetch(new Request('http://localhost/api/client-ops/overview', {
      headers: { authorization: 'Bearer not-the-token' },
    }));
    expect(wrong.status).toBe(401);
    const bootstrap = await fetch(new Request('http://localhost/api/bootstrap'));
    expect(bootstrap.status).toBe(401);
    const authorized = await fetch(new Request('http://localhost/api/client-ops/overview', {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(authorized.status).toBe(200);
  });

  it('executes a run end-to-end through the mounted engine: request → approval → receipt', async () => {
    const registry = registerReadyFoundations(new ServiceFoundationRegistry());
    const { app, db, tenant } = await setup({ seedDemo: true, registry });
    const fetch = withDefaultTenant((request) => app.fetch(request), tenant.id);
    const api = (path: string, init?: RequestInit) => fetch(new Request(`http://localhost/api/client-ops${path}`, init));
    const post = (path: string, body: unknown) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'app-test' },
      body: JSON.stringify(body),
    });

    const foundations = await api('/foundations');
    expect(foundations.status).toBe(200);
    expect(((await foundations.json()) as any).data.filter((f: any) => f.connected).length).toBeGreaterThan(0);

    const installations = ((await (await api('/installations?limit=100')).json()) as any).data;
    const wos = installations.find((item: any) => item.catalogId === 'workflow-operating-system');
    const detail = ((await (await api(`/installations/${wos.id}`)).json()) as any).data;

    const requested = await post('/runs', {
      installationId: wos.id,
      workflowId: detail.workflows[0].id,
      idempotencyKey: 'app-test:end-to-end:1',
      input: { source: 'app-test' },
    });
    expect(requested.status).toBe(201);
    const run = ((await requested.json()) as any).data;

    const executed = await post(`/runs/${run.id}/execute`, {});
    expect(executed.status).toBe(202);
    const pending = ((await executed.json()) as any).data;
    expect(pending.status).toBe('needs_approval');

    const approved = await post(`/reviews/${pending.reviewId}/approve`, { note: 'ship it' });
    expect(approved.status).toBe(200);
    const approvedBody = (await approved.json()) as any;
    expect(approvedBody.execution.status).toBe('succeeded');

    // The receipt is a real database row reachable over the same API.
    const receipt = await api(`/receipts/${approvedBody.execution.receiptId}`);
    expect(receipt.status).toBe(200);
    expect(((await receipt.json()) as any).data.runId).toBe(run.id);
    const runRow = await db.selectFrom('client_ops_runs').select(['status'])
      .where('tenant_id', '=', tenant.id).where('id', '=', run.id).executeTakeFirstOrThrow();
    expect(runRow.status).toBe('succeeded');
  });

  it('applies security headers and cross-origin mutation protection', async () => {
    const { app, tenant } = await setup();
    const response = await app.request('/api/client-ops/reviews/not-real/approve', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://attacker.example',
        host: 'localhost',
        'x-tenant-id': tenant.id,
      },
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });
});
