import { describe, expect, it } from 'vitest';
import { ServiceFoundationRegistry, type FoundationVerificationResult } from '../src/adapters';
import { WorkflowExecutionAdapter } from '../src/foundations';
import { executeRun } from '../src/runner';
import { ClientOpsService } from '../src/service';
import { createActiveInstallation, createRun, setup } from './helpers';

async function fixture(verify: () => Promise<FoundationVerificationResult>) {
  const { db, events, app, tenantA } = await setup();
  const service = new ClientOpsService(db, events);
  const installation = await createActiveInstallation(app, tenantA);
  const run = await createRun(app, tenantA, installation);
  const registry = new ServiceFoundationRegistry();
  const adapter = new WorkflowExecutionAdapter({ db, events });
  adapter.verify = verify;
  registry.register(adapter);
  return { service, registry, tenantId: tenantA.id, runId: run.id };
}

describe('completion requires verified action results', () => {
  it('fails a claimed completion when destination verification rejects it', async () => {
    const f = await fixture(async () => ({ verified: false, evidence: { reason: 'record absent' }, checkedAt: new Date().toISOString() }));
    const outcome = await executeRun(f, { ...f, approved: true });
    expect(outcome.status).toBe('failed');
    expect((await f.service.getRun(f.tenantId, f.runId)).error).toContain('did not pass result verification');
    expect(await f.service.listCompletionReceipts(f.tenantId, { limit: 10, offset: 0 })).toEqual([]);
  });

  it('fails without a completion receipt when verification is unreachable', async () => {
    const f = await fixture(async () => { throw new Error('destination unavailable'); });
    const outcome = await executeRun(f, { ...f, approved: true });
    expect(outcome.status).toBe('failed');
    expect((await f.service.getRun(f.tenantId, f.runId)).error).toContain('destination unavailable');
    expect(await f.service.listCompletionReceipts(f.tenantId, { limit: 10, offset: 0 })).toEqual([]);
  });

  it('does not accept an undated verification claim', async () => {
    const f = await fixture(async () => ({ verified: true, evidence: {}, checkedAt: 'invalid' }));
    expect((await executeRun(f, { ...f, approved: true })).status).toBe('failed');
  });

  it('persists a separate readback result for every successful action', async () => {
    let checks = 0;
    const f = await fixture(async () => ({ verified: true, evidence: { readback: ++checks }, checkedAt: new Date().toISOString() }));
    const outcome = await executeRun(f, { ...f, approved: true });
    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') throw new Error('expected success');
    expect(checks).toBe(outcome.results.length);
    const receipt = await f.service.getCompletionReceipt(f.tenantId, outcome.receiptId);
    expect((receipt.verification as { actions: unknown[] }).actions).toHaveLength(checks);
  });
});
