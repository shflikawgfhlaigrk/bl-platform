import { describe, expect, it } from 'vitest';
import { ServiceFoundationRegistry } from '../src/adapters';
import { registerReadyFoundations } from '../src/foundations';
import { clientOpsRouter } from '../src/router';
import { executeRun } from '../src/runner';
import { ClientOpsService } from '../src/service';
import { resolveTenantFoundations } from '../src/tenant-foundations';
import { createActiveInstallation, createRun, headers, setup } from './helpers';

/**
 * Per-tenant execution isolation. The live adapters bind to Black Label's OWN
 * sources, so "an adapter is loaded in this process" must never mean "this
 * client can execute". Every assertion below is read back through the real
 * router/runner against real rows — a tenant is ready only because it owns a
 * connector row for the foundation's owned source.
 */

async function setupWithRegistry() {
  const base = await setup();
  const registry = registerReadyFoundations(new ServiceFoundationRegistry());
  const app = clientOpsRouter({ db: base.db, events: base.events, contracts: {} }, { registry });
  return { ...base, app, registry };
}

const WORKFLOW_OWNED_SOURCE = 'BlackLabelPlatform.workflows';

describe('client-ops per-tenant foundation readiness', () => {
  it('reports awaiting_connection for a tenant that has connected no owned source', async () => {
    const { app, tenantA } = await setupWithRegistry();
    // Installed and otherwise fully connected, but nothing of its own is bound.
    await createActiveInstallation(app, tenantA, { declareOwnedSource: false });

    const response = await app.request('/foundations', { headers: headers(tenantA) });
    expect(response.status).toBe(200);
    const list = ((await response.json()) as { data: any[] }).data;
    const wos = list.find((item) => item.serviceId === 'workflow-operating-system');
    expect(wos).toMatchObject({
      ownedSourceIdentifier: WORKFLOW_OWNED_SOURCE,
      adapterConnected: true,
      connected: false,
      connectionStatus: 'awaiting_connection',
      ownedSourceConnection: null,
    });
  });

  it('reports ready only for the tenant that owns a connector row for the owned source', async () => {
    const { app, tenantA, tenantB } = await setupWithRegistry();
    await createActiveInstallation(app, tenantA);
    await createActiveInstallation(app, tenantB, { declareOwnedSource: false });

    const readyList = ((await (await app.request('/foundations', { headers: headers(tenantA) })).json()) as { data: any[] }).data;
    const ready = readyList.find((item) => item.serviceId === 'workflow-operating-system');
    expect(ready).toMatchObject({ connected: true, connectionStatus: 'ready' });
    expect(ready.ownedSourceConnection).toMatchObject({
      ownedSourceIdentifier: WORKFLOW_OWNED_SOURCE,
      credentialRef: `test:${tenantA.id}:operations-system`,
    });

    // Tenant A's declaration must not leak across the tenant boundary.
    const otherList = ((await (await app.request('/foundations', { headers: headers(tenantB) })).json()) as { data: any[] }).data;
    expect(otherList.find((item) => item.serviceId === 'workflow-operating-system'))
      .toMatchObject({ connected: false, connectionStatus: 'awaiting_connection' });
  });

  it('reports adapter_not_connected without ever claiming a tenant connection', async () => {
    const { app, tenantA } = await setupWithRegistry();
    await createActiveInstallation(app, tenantA);
    const list = ((await (await app.request('/foundations', { headers: headers(tenantA) })).json()) as { data: any[] }).data;
    expect(list.find((item) => item.serviceId === 'ai-front-desk'))
      .toMatchObject({ adapterConnected: false, connected: false, connectionStatus: 'adapter_not_connected' });
  });

  it('resolves the same answer through the registry-backed resolver as over HTTP', async () => {
    const { app, db, events, tenantA, registry } = await setupWithRegistry();
    await createActiveInstallation(app, tenantA);
    const service = new ClientOpsService(db, events);
    const resolved = await resolveTenantFoundations(service, tenantA.id, registry);
    const overHttp = ((await (await app.request('/foundations', { headers: headers(tenantA) })).json()) as { data: any[] }).data;
    expect(JSON.parse(JSON.stringify(resolved))).toEqual(overHttp);
  });
});

describe('client-ops runner tenant isolation', () => {
  it('refuses to execute for a tenant with no owned-source connector — no run state change, no receipt', async () => {
    const { app, db, events, tenantA, registry } = await setupWithRegistry();
    const service = new ClientOpsService(db, events);
    const installation = await createActiveInstallation(app, tenantA, { declareOwnedSource: false });
    const run = await createRun(app, tenantA, installation);

    const outcome = await executeRun(
      { service, registry },
      { tenantId: tenantA.id, runId: run.id, approved: true },
    );

    expect(outcome.status).toBe('not_ready');
    if (outcome.status === 'not_ready') {
      expect(outcome.reason).toContain(WORKFLOW_OWNED_SOURCE);
      expect(outcome.reason).toContain('awaiting client connection');
    }
    // Nothing ran and nothing was fabricated.
    expect((await service.getRun(tenantA.id, run.id)).status).toBe('requested');
    await expect(service.listCompletionReceipts(tenantA.id, { limit: 10, offset: 0 })).resolves.toHaveLength(0);
  });

  it('executes for the tenant that owns the source while the other tenant stays blocked', async () => {
    const { app, db, events, tenantA, tenantB, registry } = await setupWithRegistry();
    const service = new ClientOpsService(db, events);
    const ownInstallation = await createActiveInstallation(app, tenantA);
    const ownRun = await createRun(app, tenantA, ownInstallation, 'isolation:owner:1');
    const otherInstallation = await createActiveInstallation(app, tenantB, { declareOwnedSource: false });
    const otherRun = await createRun(app, tenantB, otherInstallation, 'isolation:other:1');

    const owner = await executeRun({ service, registry }, { tenantId: tenantA.id, runId: ownRun.id, approved: true });
    expect(owner.status).toBe('succeeded');
    expect((await service.getRun(tenantA.id, ownRun.id)).status).toBe('succeeded');

    const other = await executeRun({ service, registry }, { tenantId: tenantB.id, runId: otherRun.id, approved: true });
    expect(other.status).toBe('not_ready');
    expect((await service.getRun(tenantB.id, otherRun.id)).status).toBe('requested');
    await expect(service.listCompletionReceipts(tenantB.id, { limit: 10, offset: 0 })).resolves.toHaveLength(0);
  });

  it('hands the executing adapter the tenant\'s own connector ref, not a process default', async () => {
    const { app, db, events, tenantA, registry } = await setupWithRegistry();
    const service = new ClientOpsService(db, events);
    const installation = await createActiveInstallation(app, tenantA);
    const run = await createRun(app, tenantA, installation, 'isolation:ref:1');

    const adapter = registry.get('client_ops.workflow.execute');
    if (!adapter) throw new Error('workflow adapter missing from the test registry');
    const seen: Array<Record<string, unknown> | undefined> = [];
    const invoke = adapter.invoke.bind(adapter);
    adapter.invoke = async (request) => {
      seen.push(request.ownedSourceRef as Record<string, unknown> | undefined);
      return invoke(request);
    };

    const outcome = await executeRun({ service, registry }, { tenantId: tenantA.id, runId: run.id, approved: true });
    expect(outcome.status).toBe('succeeded');
    expect(seen.length).toBeGreaterThan(0);
    for (const ref of seen) {
      expect(ref).toMatchObject({
        ownedSourceIdentifier: WORKFLOW_OWNED_SOURCE,
        installationId: installation.id,
        credentialRef: `test:${tenantA.id}:operations-system`,
      });
    }
  });

  it('ignores a connector row that names an owned source without its own credential ref', async () => {
    const { app, tenantA } = await setupWithRegistry();
    const installation = await createActiveInstallation(app, tenantA);
    const binding = installation.connectors.find((item: any) => item.required);
    // Credential ref cleared: there is no client-owned access path any more, so
    // readiness must fall back to awaiting_connection rather than to our own.
    const cleared = await app.request(`/installations/${installation.id}/connectors/${binding.id}`, {
      method: 'PATCH', headers: headers(tenantA), body: JSON.stringify({ credentialRef: null }),
    });
    expect(cleared.status).toBe(200);

    const list = ((await (await app.request('/foundations', { headers: headers(tenantA) })).json()) as { data: any[] }).data;
    expect(list.find((item) => item.serviceId === 'workflow-operating-system'))
      .toMatchObject({ connected: false, connectionStatus: 'awaiting_connection' });
  });
});
