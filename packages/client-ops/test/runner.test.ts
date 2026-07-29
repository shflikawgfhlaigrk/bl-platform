import { describe, expect, it } from 'vitest';
import { ServiceFoundationRegistry } from '../src/adapters';
import { registerReadyFoundations } from '../src/foundations';
import { executeRun } from '../src/runner';
import { ClientOpsService } from '../src/service';
import { createActiveInstallation, createRun, setup } from './helpers';

describe('client-ops execution runner', () => {
  it('executes a requested run through a ready adapter and writes a real, persisted completion receipt', async () => {
    const { db, events, app, tenantA } = await setup();
    const service = new ClientOpsService(db, events);
    const installation = await createActiveInstallation(app, tenantA);
    const run = await createRun(app, tenantA, installation);
    expect(run.status).toBe('requested');

    const registry = registerReadyFoundations(new ServiceFoundationRegistry());
    const outcome = await executeRun(
      { service, registry },
      { tenantId: tenantA.id, runId: run.id, approved: true },
    );

    expect(outcome.status).toBe('succeeded');
    // The state change is real and persisted, not a returned literal.
    const persisted = await service.getRun(tenantA.id, run.id);
    expect(persisted.status).toBe('succeeded');
    if (outcome.status === 'succeeded') {
      const receipt = await service.getCompletionReceipt(tenantA.id, outcome.receiptId);
      expect(receipt.runId).toBe(run.id);
      expect(receipt.summary).toContain('client_ops.workflow.execute');
    }
  });

  it('fails honestly with no receipt when no adapter is connected — never fabricates success', async () => {
    const { db, events, app, tenantA } = await setup();
    const service = new ClientOpsService(db, events);
    const installation = await createActiveInstallation(app, tenantA);
    const run = await createRun(app, tenantA, installation);

    const outcome = await executeRun(
      { service, registry: new ServiceFoundationRegistry() },
      { tenantId: tenantA.id, runId: run.id, approved: true },
    );

    expect(outcome.status).toBe('failed');
    const persisted = await service.getRun(tenantA.id, run.id);
    expect(persisted.status).toBe('failed');
    // No completion receipt exists for a failed run.
    await expect(service.listCompletionReceipts(tenantA.id, { limit: 10, offset: 0 })).resolves.toHaveLength(0);
  });
});
