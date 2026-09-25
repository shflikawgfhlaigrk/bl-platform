import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ExecutiveOperationsHqAdapter } from '../src/foundations/executive-operations-hq';
import { registerProductionFoundations } from '../src/foundations';
import { ClientOpsService } from '../src/service';
import { executeRun } from '../src/runner';
import { createActiveInstallation, createRun, setup } from './helpers';
import type { FoundationInvocationRequest } from '../src/adapters';

const roots: string[] = [];
const close: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(close.splice(0).map(f => f())); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });

function source(seat: string) {
  const root = mkdtempSync(join(tmpdir(), 'hq-isolation-')); roots.push(root);
  writeFileSync(join(root, 'packet.json'), JSON.stringify({ seat, percent: 25, task: `${seat} private task` }));
  return root;
}

async function fixture() {
  const { db, events, app, tenantA, tenantB } = await setup(); close.push(() => db.destroy());
  const service = new ClientOpsService(db, events);
  const host = source('HOST-SECRET'); vi.stubEnv('BL_HQ_HANDOFFS_DIR', host);
  const tenants = [tenantA, tenantB]; const items = [];
  for (const [index, tenant] of tenants.entries()) {
    const installation = await createActiveInstallation(app, tenant, { catalogId: 'executive-operations-hq' });
    const run = await createRun(app, tenant, installation);
    const ref = (await service.listConnectedOwnedSources(tenant.id))[0];
    const handoffsDir = source(index === 0 ? 'TENANT-A' : 'TENANT-B');
    const request: FoundationInvocationRequest = { tenantId: tenant.id, installationId: installation.id, runId: run.id,
      workflowTemplateId: installation.workflows[0].templateId, actionType: 'publish_brief', input: run.input, ownedSourceRef: ref };
    items.push({ tenant, installation, run, ref, handoffsDir, request });
  }
  const sources = items.map(x => ({ tenantId: x.tenant.id, connection: x.ref, handoffsDir: x.handoffsDir }));
  const adapter = new ExecutiveOperationsHqAdapter({ service, sources });
  return { db, service, host, items, sources, adapter };
}

it('fails closed for legacy/global directories even when an arbitrary ref claims connection', async () => {
  const { host, items } = await fixture();
  const legacy = new ExecutiveOperationsHqAdapter({ handoffsDir: host });
  expect(legacy.readiness()).toBe('declared');
  const result = await legacy.invoke(items[0].request); expect(result.status).toBe('failed');
  expect(JSON.stringify(result)).not.toContain('HOST-SECRET'); expect(JSON.stringify(result)).not.toContain(host);
  expect((await legacy.verify({ ...items[0].request, invocationId: 'forged', expected: {} })).verified).toBe(false);
});

it('resolves two valid tenants to distinct sources and scoped references', async () => {
  const { service, adapter, items, host } = await fixture(); const refs: string[][] = [];
  for (const [index, item] of items.entries()) {
    await service.updateRun(item.tenant.id, item.run.id, { status: 'running' }, 'fixture');
    const result = await adapter.invoke(item.request); expect(result.status).toBe('completed');
    const text = JSON.stringify(result);
    expect(text).toContain(index === 0 ? 'TENANT-A' : 'TENANT-B');
    expect(text).not.toContain(index === 0 ? 'TENANT-B' : 'TENANT-A');
    for (const value of ['HOST-SECRET', host, item.handoffsDir, item.ref.credentialRef]) expect(text).not.toContain(value);
    expect((await adapter.verify({ ...item.request, invocationId: result.invocationId, expected: result.output })).verified).toBe(true);
    refs.push(result.externalReferences);
  }
  expect(refs[0].some(ref => refs[1].includes(ref))).toBe(false);
});

it('rejects missing, forged, cross-tenant, wrong-installation and changed source identifiers', async () => {
  const { service, adapter, items } = await fixture(); const a = items[0]; const b = items[1];
  await service.updateRun(a.tenant.id, a.run.id, { status: 'running' }, 'fixture');
  for (const ownedSourceRef of [undefined, b.ref, { ...a.ref, credentialRef: 'forged' }, { ...a.ref, bindingId: b.ref.bindingId }, { ...a.ref, installationId: b.installation.id }, { ...a.ref, connectorId: 'forged' }, { ...a.ref, ownedSourceIdentifier: 'wrong' }]) {
    const request = { ...a.request, ownedSourceRef };
    expect((await adapter.invoke(request)).status).toBe('failed');
    expect((await adapter.verify({ ...request, invocationId: 'forged', expected: {} })).verified).toBe(false);
  }
  expect((await adapter.invoke({ ...a.request, runId: b.run.id })).status).toBe('failed');
});

it('revalidates connection revocation and credential rotation for invoke and verification', async () => {
  const { service, adapter, items } = await fixture(); const a = items[0];
  await service.updateRun(a.tenant.id, a.run.id, { status: 'running' }, 'fixture');
  const result = await adapter.invoke(a.request); expect(result.status).toBe('completed');
  for (const patch of [{ credentialRef: 'rotated' }, { status: 'disabled' as const }]) {
    await service.updateConnector(a.tenant.id, a.installation.id, a.ref.bindingId, { credentialRef: a.ref.credentialRef, status: 'connected' });
    await service.updateConnector(a.tenant.id, a.installation.id, a.ref.bindingId, patch);
    expect((await adapter.invoke(a.request)).status).toBe('failed');
    expect((await adapter.verify({ ...a.request, invocationId: result.invocationId, expected: result.output })).verified).toBe(false);
  }
});

it('does not read symlinked packets from a different configured source', async () => {
  const { service, adapter, items } = await fixture(); const a = items[0];
  symlinkSync(join(items[1].handoffsDir, 'packet.json'), join(a.handoffsDir, 'foreign.json'));
  await service.updateRun(a.tenant.id, a.run.id, { status: 'running' }, 'fixture');
  const result = await adapter.invoke(a.request); expect(result.status).toBe('completed');
  expect(JSON.stringify(result)).toContain('TENANT-A'); expect(JSON.stringify(result)).not.toContain('TENANT-B');
});

it('detects changed source packets during verification', async () => {
  const { service, adapter, items } = await fixture(); const a = items[0];
  await service.updateRun(a.tenant.id, a.run.id, { status: 'running' }, 'fixture');
  const result = await adapter.invoke(a.request);
  expect((await adapter.verify({ ...a.request, invocationId: result.invocationId, expected: { ...(result.output as object), section: 'forged' } })).verified).toBe(false);
  expect((await adapter.verify({ ...a.request, ownedSourceRef: undefined, invocationId: result.invocationId, expected: result.output })).verified).toBe(false);
  writeFileSync(join(a.handoffsDir, 'packet.json'), JSON.stringify({ seat: 'CHANGED', percent: 100 }));
  expect((await adapter.verify({ ...a.request, invocationId: result.invocationId, expected: result.output })).verified).toBe(false);
});

it('selects the current installation connection when one tenant owns two HQ installations', async () => {
  const { service, sources, items } = await fixture(); const a = items[0];
  const other = await service.createInstallation(a.tenant.id, { catalogKind: 'service', catalogId: 'executive-operations-hq', name: 'Additional HQ' });
  const binding = other.connectors.find(c => c.required)!;
  await service.updateConnector(a.tenant.id, other.id, binding.id, { status: 'connected', credentialRef: 'different-credential', metadata: { ownedSource: 'BlackLabelHQ' } });
  const registry = registerProductionFoundations(undefined, { hq: { service, sources } });
  const outcome = await executeRun({ service, registry }, { tenantId: a.tenant.id, runId: a.run.id, approved: true });
  expect(outcome.status).toBe('succeeded');
  expect(JSON.stringify(outcome)).toContain('TENANT-A');
});

it('production registration requires explicit server-owned mappings and persists tenant-only receipts', async () => {
  const { service, sources, items } = await fixture();
  const unbound = registerProductionFoundations();
  expect(unbound.get('client_ops.hq.publish_brief')!.readiness()).toBe('declared');
  const registry = registerProductionFoundations(undefined, { hq: { service, sources } });
  for (const [index, a] of items.entries()) {
    const outcome = await executeRun({ service, registry }, { tenantId: a.tenant.id, runId: a.run.id, approved: true });
    expect(outcome.status).toBe('succeeded');
    const persisted = await service.getRun(a.tenant.id, a.run.id); const text = JSON.stringify(persisted.output);
    expect(text).toContain(index === 0 ? 'TENANT-A' : 'TENANT-B');
    expect(text).not.toContain(index === 0 ? 'TENANT-B' : 'TENANT-A'); expect(text).not.toContain('HOST-SECRET');
  }
});
