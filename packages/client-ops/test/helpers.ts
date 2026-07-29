import {
  EventBus,
  asCoreDb,
  coreMigrations,
  createTenant,
  type TenantRow,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { clientOpsMigrations } from '../src/migrations';
import { clientOpsRouter } from '../src/router';
import type { ClientOpsDatabase } from '../src/schema';

export async function setup() {
  const db = createTestDb<ClientOpsDatabase>();
  await runMigrations(db, [...coreMigrations, ...clientOpsMigrations]);
  const tenantA = await createTenant(asCoreDb(db), { name: 'Client Alpha' });
  const tenantB = await createTenant(asCoreDb(db), { name: 'Client Beta' });
  const events = new EventBus();
  const app = clientOpsRouter({ db, events, contracts: {} });
  return { db, tenantA, tenantB, events, app };
}

export function headers(tenant: TenantRow | { id: string }): Record<string, string> {
  return { 'x-tenant-id': tenant.id, 'x-user-id': 'test-operator', 'content-type': 'application/json' };
}

export async function createInstallation(
  app: ReturnType<typeof clientOpsRouter>,
  tenant: TenantRow | { id: string },
  body: Record<string, unknown> = {},
) {
  const response = await app.request('/installations', {
    method: 'POST', headers: headers(tenant),
    body: JSON.stringify({ catalogKind: 'service', catalogId: 'workflow-operating-system', ...body }),
  });
  if (response.status !== 201) throw new Error(`create installation failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { data: any }).data;
}

export async function createActiveInstallation(
  app: ReturnType<typeof clientOpsRouter>,
  tenant: TenantRow | { id: string },
) {
  const installation = await createInstallation(app, tenant);
  for (const binding of installation.connectors) {
    if (!binding.required) continue;
    const response = await app.request(`/installations/${installation.id}/connectors/${binding.id}`, {
      method: 'PATCH', headers: headers(tenant),
      body: JSON.stringify({ status: 'connected', credentialRef: `test:${binding.connectorId}`, metadata: { accountId: 'demo-account' }, health: { ok: true } }),
    });
    if (response.status !== 200) throw new Error(`connect binding failed: ${response.status} ${await response.text()}`);
  }
  for (const step of installation.onboarding) {
    if (!step.required) continue;
    const response = await app.request(`/installations/${installation.id}/onboarding/${step.id}`, {
      method: 'PATCH', headers: headers(tenant),
      body: JSON.stringify({ status: 'completed', evidence: { verified: true } }),
    });
    if (response.status !== 200) throw new Error(`complete onboarding failed: ${response.status} ${await response.text()}`);
  }
  const response = await app.request(`/installations/${installation.id}`, {
    method: 'PATCH', headers: headers(tenant), body: JSON.stringify({ status: 'active' }),
  });
  if (response.status !== 200) throw new Error(`activate installation failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { data: any }).data;
}

export async function createRun(
  app: ReturnType<typeof clientOpsRouter>,
  tenant: TenantRow | { id: string },
  installation: any,
  idempotencyKey = 'run-key-1',
) {
  const response = await app.request('/runs', {
    method: 'POST', headers: headers(tenant),
    body: JSON.stringify({ installationId: installation.id, workflowId: installation.workflows[0].id, idempotencyKey, input: { leadId: 'lead-1' } }),
  });
  if (response.status !== 201) throw new Error(`create run failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { data: any }).data;
}
