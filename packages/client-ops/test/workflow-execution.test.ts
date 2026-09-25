import { afterEach, describe, expect, it } from 'vitest';
import { ServiceFoundationRegistry } from '../src/adapters';
import { WorkflowExecutionAdapter } from '../src/foundations';
import { executeRun } from '../src/runner';
import { ClientOpsService } from '../src/service';
import { createActiveInstallation, createRun, setup } from './helpers';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

async function fixture() {
  const f = await setup();
  cleanups.push(() => f.db.destroy());
  const service = new ClientOpsService(f.db, f.events);
  const installation = await createActiveInstallation(f.app, f.tenantA);
  const run = await createRun(f.app, f.tenantA, installation);
  const adapter = new WorkflowExecutionAdapter(f);
  const registry = new ServiceFoundationRegistry();
  registry.register(adapter);
  const execute = (runId = run.id) => executeRun({ service, registry }, { tenantId: f.tenantA.id, runId, approved: true });
  return { ...f, service, installation, run, adapter, registry, execute };
}

describe('persisted workflow execution', () => {
  it('requires an actual database dependency', () => {
    expect(new WorkflowExecutionAdapter().readiness()).toBe('declared');
  });

  it('creates the requested business object and verifies its persisted fields', async () => {
    const f = await fixture();
    const outcome = await f.execute();
    expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded');
    const task = await f.db.selectFrom('workflows_tasks').selectAll().executeTakeFirstOrThrow();
    expect(task).toMatchObject({ tenant_id: f.tenantA.id, title: 'Follow up on estimate', status: 'open' });
    expect(await f.db.selectFrom('client_ops_execution_journal').selectAll().execute()).toHaveLength(4);
    if (outcome.status !== 'succeeded') throw new Error('expected success');
    const receipt = await f.service.getCompletionReceipt(f.tenantA.id, outcome.receiptId);
    expect(JSON.stringify(receipt.verification)).toContain(task.id);
    expect(JSON.stringify(receipt.verification)).toContain('"matches":true');
  });

  it('fails with no success receipt if the destination record disappears', async () => {
    const f = await fixture();
    const verify = f.adapter.verify.bind(f.adapter);
    f.adapter.verify = async (request) => {
      if ((request.expected as any)?.completed) await f.db.deleteFrom('workflows_tasks').execute();
      return verify(request);
    };
    const outcome = await f.execute();
    expect(outcome.status).toBe('failed');
    expect(await f.service.listCompletionReceipts(f.tenantA.id, { limit: 10, offset: 0 })).toHaveLength(0);
  });

  it('restarts the adapter and retries after verification failure without duplicating work', async () => {
    const f = await fixture();
    const verify = f.adapter.verify.bind(f.adapter);
    f.adapter.verify = async (request) => {
      if ((request.expected as any)?.completed) throw new Error('temporary verifier failure');
      return verify(request);
    };
    expect((await f.execute()).status).toBe('failed');
    expect(await f.db.selectFrom('workflows_tasks').selectAll().execute()).toHaveLength(1);
    const retry = await f.service.retryRun(f.tenantA.id, f.run.id, { idempotencyKey: 'retry-after-readback' });
    const registry = new ServiceFoundationRegistry();
    registry.register(new WorkflowExecutionAdapter(f));
    const outcome = await executeRun({ service: f.service, registry }, { tenantId: f.tenantA.id, runId: retry.run.id, approved: true });
    expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded');
    expect(await f.db.selectFrom('workflows_tasks').selectAll().execute()).toHaveLength(1);
  });

  it('rejects a changed plan on a retry once work has been checkpointed', async () => {
    const f = await fixture();
    f.adapter.verify = async () => ({ verified: false, evidence: {}, checkedAt: new Date().toISOString() });
    await f.execute();
    const retry = await f.service.retryRun(f.tenantA.id, f.run.id, { idempotencyKey: 'changed-plan',
      input: { steps: [{ id: 'followup', type: 'create_task', config: { title: 'Changed work' } }] },
    });
    const registry = new ServiceFoundationRegistry();
    registry.register(new WorkflowExecutionAdapter(f));
    const outcome = await executeRun({ service: f.service, registry }, { tenantId: f.tenantA.id, runId: retry.run.id, approved: true });
    expect(outcome.status).toBe('failed');
    expect((await f.service.getRun(f.tenantA.id, retry.run.id)).error).toContain('already checkpointed');
  });

  it('cannot verify another tenant\'s checkpoint or an altered result', async () => {
    const f = await fixture();
    const result = await f.execute();
    if (result.status !== 'succeeded') throw new Error(JSON.stringify(result));
    const invocation = result.results[0];
    const request = { tenantId: f.tenantA.id, installationId: f.installation.id, runId: f.run.id,
      invocationId: invocation.invocationId, expected: { fabricated: true } };
    expect((await f.adapter.verify(request)).verified).toBe(false);
    await expect(f.adapter.verify({ ...request, tenantId: f.tenantB.id })).rejects.toThrow('run not found');
  });

  it('records a real recovery run and review while preserving the queued execution state', async () => {
    const f = await fixture();
    await f.service.updateRun(f.tenantA.id, f.run.id, { status: 'failed', error: 'temporary destination unavailable' });
    const recovery = await f.service.requestRun(f.tenantA.id, {
      installationId: f.installation.id,
      workflowId: f.installation.workflows.find((w: any) => w.templateId.endsWith('.exception_recovery')).id,
      idempotencyKey: 'recover-failed-run', input: { failedRunId: f.run.id },
    });
    const outcome = await f.execute(recovery.run.id);
    expect(outcome.status, JSON.stringify(outcome)).toBe('succeeded');
    const retries = (await f.service.listRuns(f.tenantA.id, { limit: 10, offset: 0 })).filter((r) => r.retryOfRunId === f.run.id);
    expect(retries).toHaveLength(1);
    expect(retries[0].status).toBe('requested');
    const reviews = await f.service.listReviewsForRun(f.tenantA.id, f.run.id);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].status).toBe('pending');
  });
});
