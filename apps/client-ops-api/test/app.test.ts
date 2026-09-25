import { afterEach, describe, expect, it } from 'vitest';
import {
  clientOpsMigrations,
  registerReadyFoundations,
  ServiceFoundationRegistry,
  type ClientOpsDatabase,
} from '@blacklabel/client-ops';
import { asCoreDb, coreMigrations, createTenant, EventBus } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { workflowsMigrations, type WorkflowsDatabase } from '@blacklabel/workflows';
import { createClientOpsHttpApp, withBearerAuth, withTenantGuard } from '../src/app';
import { seedClientOpsProductStarter } from '../src/demo';

const databases: Array<ReturnType<typeof createTestDb<ClientOpsDatabase>>> = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

async function setup(options: { seedDemo?: boolean; registry?: ServiceFoundationRegistry } = { seedDemo: true }) {
  const db = createTestDb<ClientOpsDatabase & WorkflowsDatabase>();
  databases.push(db);
  await runMigrations(db, [...coreMigrations, ...clientOpsMigrations, ...workflowsMigrations]);
  const tenant = await createTenant(asCoreDb(db), { name: 'Demo Service Company' });
  const events = new EventBus();
  if (options.registry && !options.registry.get('client_ops.workflow.execute')) {
    registerReadyFoundations(options.registry, { workflow: { db, events } });
  }
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

  it('refuses a client-ops request that names no tenant instead of defaulting one', async () => {
    const { app, tenant } = await setup();
    const fetch = withTenantGuard((request) => app.fetch(request));

    const unlabelled = await fetch(new Request('http://localhost/api/client-ops/overview'));
    expect(unlabelled.status).toBe(400);
    expect(((await unlabelled.json()) as any).error.code).toBe('tenant_required');

    // A blank header is not a tenant either.
    const blank = await fetch(new Request('http://localhost/api/client-ops/overview', {
      headers: { 'x-tenant-id': '   ' },
    }));
    expect(blank.status).toBe(400);
    expect(((await blank.json()) as any).error.code).toBe('tenant_required');

    // An unknown tenant is rejected, never created or assumed.
    const unknown = await fetch(new Request('http://localhost/api/client-ops/overview', {
      headers: { 'x-tenant-id': 'tenant_that_does_not_exist' },
    }));
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as any).error.code).toBe('tenant_unknown');

    const named = await fetch(new Request('http://localhost/api/client-ops/overview', {
      headers: { 'x-tenant-id': tenant.id },
    }));
    expect(named.status).toBe(200);
  });

  it('injects a tenant only under the explicit loopback-development opt-in', async () => {
    const { app, tenant } = await setup();
    const fetch = withTenantGuard((request) => app.fetch(request), { devDefaultTenantId: tenant.id });
    const injected = await fetch(new Request('http://localhost/api/client-ops/overview'));
    expect(injected.status).toBe(200);
    // Even with the opt-in on, an explicit tenant is never overwritten.
    const explicit = await fetch(new Request('http://localhost/api/client-ops/overview', {
      headers: { 'x-tenant-id': 'tenant_that_does_not_exist' },
    }));
    expect(explicit.status).toBe(404);
  });

  it('rejects unauthenticated API calls before any tenant work while /api/health stays open', async () => {
    const { app, tenant } = await setup();
    const token = 'engine-shared-secret';
    const fetch = withBearerAuth(
      withTenantGuard((request) => app.fetch(request)),
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
    // Authenticated but unlabelled still fails closed on tenancy.
    const unlabelled = await fetch(new Request('http://localhost/api/client-ops/overview', {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(unlabelled.status).toBe(400);
    const authorized = await fetch(new Request('http://localhost/api/client-ops/overview', {
      headers: { authorization: `Bearer ${token}`, 'x-tenant-id': tenant.id },
    }));
    expect(authorized.status).toBe(200);
  });

  it('executes a run end-to-end through the mounted engine: request → approval → receipt', async () => {
    const registry = new ServiceFoundationRegistry();
    const { app, db, tenant } = await setup({ seedDemo: true, registry });
    const fetch = withTenantGuard((request) => app.fetch(request));
    const api = (path: string, init?: RequestInit) => fetch(new Request(`http://localhost/api/client-ops${path}`, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), 'x-tenant-id': tenant.id },
    }));
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
      workflowId: detail.workflows.find((w: any) => w.templateId.endsWith('.scheduled_operation')).id,
      idempotencyKey: 'app-test:end-to-end:1',
      input: { steps: [{ id: 'followup', type: 'create_task', config: { title: 'Follow up on estimate' } }] },
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
