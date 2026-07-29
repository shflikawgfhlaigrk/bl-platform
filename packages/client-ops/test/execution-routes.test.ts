import { describe, expect, it } from 'vitest';
import { ServiceFoundationRegistry } from '../src/adapters';
import { registerReadyFoundations } from '../src/foundations';
import { clientOpsRouter } from '../src/router';
import { ClientOpsService } from '../src/service';
import { createActiveInstallation, createRun, headers, setup } from './helpers';

/**
 * HTTP execution surface: POST /runs/:id/execute + GET /foundations + the
 * review approval loop. Every asserted state is read back from the database —
 * a run only succeeds through the real runner writing real rows and receipts.
 */

async function setupWithRegistry() {
  const base = await setup();
  const registry = registerReadyFoundations(new ServiceFoundationRegistry());
  const app = clientOpsRouter({ db: base.db, events: base.events, contracts: {} }, { registry });
  return { ...base, app, registry };
}

describe('client-ops execution routes', () => {
  it('answers 501 honestly when no execution registry is configured', async () => {
    const { app, tenantA } = await setup();
    const installation = await createActiveInstallation(app, tenantA);
    const run = await createRun(app, tenantA, installation);
    const foundations = await app.request('/foundations', { headers: headers(tenantA) });
    expect(foundations.status).toBe(501);
    const execute = await app.request(`/runs/${run.id}/execute`, {
      method: 'POST', headers: headers(tenantA), body: '{}',
    });
    expect(execute.status).toBe(501);
  });

  it('lists all eight declared foundations with real connection state', async () => {
    const { app, tenantA } = await setupWithRegistry();
    const response = await app.request('/foundations', { headers: headers(tenantA) });
    expect(response.status).toBe(200);
    const list = ((await response.json()) as { data: any[] }).data;
    expect(list).toHaveLength(8);
    const wos = list.find((item) => item.serviceId === 'workflow-operating-system');
    expect(wos).toMatchObject({ connected: true, adapterReadiness: 'ready' });
    const frontDesk = list.find((item) => item.serviceId === 'ai-front-desk');
    expect(frontDesk).toMatchObject({ connected: false, adapterReadiness: 'declared' });
  });

  it('stops a mutating run at needs_approval with exactly one pending review and no receipt', async () => {
    const { app, db, events, tenantA } = await setupWithRegistry();
    const service = new ClientOpsService(db, events);
    const installation = await createActiveInstallation(app, tenantA);
    const run = await createRun(app, tenantA, installation);

    const first = await app.request(`/runs/${run.id}/execute`, {
      method: 'POST', headers: headers(tenantA), body: '{}',
    });
    expect(first.status).toBe(202);
    const firstBody = ((await first.json()) as { data: any }).data;
    expect(firstBody.status).toBe('needs_approval');
    expect(firstBody.mutatingActionIds.length).toBeGreaterThan(0);
    expect(typeof firstBody.reviewId).toBe('string');

    // Re-executing reuses the same pending review — no duplicates.
    const second = await app.request(`/runs/${run.id}/execute`, {
      method: 'POST', headers: headers(tenantA), body: '{}',
    });
    expect(second.status).toBe(202);
    expect(((await second.json()) as { data: any }).data.reviewId).toBe(firstBody.reviewId);
    expect(await service.listReviewsForRun(tenantA.id, run.id)).toHaveLength(1);

    // Nothing executed: run still requested, zero receipts.
    expect((await service.getRun(tenantA.id, run.id)).status).toBe('requested');
    await expect(service.listCompletionReceipts(tenantA.id, { limit: 10, offset: 0 })).resolves.toHaveLength(0);
  });

  it('approving the run review re-executes to succeeded with a persisted receipt', async () => {
    const { app, db, events, tenantA } = await setupWithRegistry();
    const service = new ClientOpsService(db, events);
    const installation = await createActiveInstallation(app, tenantA);
    const run = await createRun(app, tenantA, installation);
    const executed = await app.request(`/runs/${run.id}/execute`, {
      method: 'POST', headers: headers(tenantA), body: '{}',
    });
    const { reviewId } = ((await executed.json()) as { data: any }).data;

    const approve = await app.request(`/reviews/${reviewId}/approve`, {
      method: 'POST', headers: headers(tenantA), body: JSON.stringify({ note: 'approved for execution' }),
    });
    expect(approve.status).toBe(200);
    const approveBody = (await approve.json()) as { data: any; execution: any };
    expect(approveBody.data.status).toBe('approved');
    expect(approveBody.execution.status).toBe('succeeded');

    // Real persisted state, not a returned literal.
    expect((await service.getRun(tenantA.id, run.id)).status).toBe('succeeded');
    const receipt = await service.getCompletionReceipt(tenantA.id, approveBody.execution.receiptId);
    expect(receipt.runId).toBe(run.id);
    expect(receipt.summary).toContain('client_ops.workflow.execute');
  });

  it('a subsequent execute call also honors a recorded approval', async () => {
    const { app, db, events, tenantA } = await setupWithRegistry();
    const service = new ClientOpsService(db, events);
    const installation = await createActiveInstallation(app, tenantA);
    const run = await createRun(app, tenantA, installation);
    const executed = await app.request(`/runs/${run.id}/execute`, {
      method: 'POST', headers: headers(tenantA), body: '{}',
    });
    const { reviewId } = ((await executed.json()) as { data: any }).data;
    // Decide the review WITHOUT the router's re-execution (no registry on this app).
    const plain = clientOpsRouter({ db, events, contracts: {} });
    const approve = await plain.request(`/reviews/${reviewId}/approve`, {
      method: 'POST', headers: headers(tenantA), body: '{}',
    });
    expect(approve.status).toBe(200);
    expect((await service.getRun(tenantA.id, run.id)).status).toBe('requested');

    const rerun = await app.request(`/runs/${run.id}/execute`, {
      method: 'POST', headers: headers(tenantA), body: '{}',
    });
    expect(rerun.status).toBe(200);
    const rerunBody = ((await rerun.json()) as { data: any }).data;
    expect(rerunBody.status).toBe('succeeded');
    expect((await service.getRun(tenantA.id, run.id)).status).toBe('succeeded');
  });

  it('denying the run review cancels the requested run and blocks re-execution', async () => {
    const { app, db, events, tenantA } = await setupWithRegistry();
    const service = new ClientOpsService(db, events);
    const installation = await createActiveInstallation(app, tenantA);
    const run = await createRun(app, tenantA, installation);
    const executed = await app.request(`/runs/${run.id}/execute`, {
      method: 'POST', headers: headers(tenantA), body: '{}',
    });
    const { reviewId } = ((await executed.json()) as { data: any }).data;

    const deny = await app.request(`/reviews/${reviewId}/deny`, {
      method: 'POST', headers: headers(tenantA), body: JSON.stringify({ note: 'not this one' }),
    });
    expect(deny.status).toBe(200);
    const denyBody = (await deny.json()) as { data: any; run: any };
    expect(denyBody.data.status).toBe('denied');
    expect(denyBody.run.status).toBe('canceled');
    expect((await service.getRun(tenantA.id, run.id)).status).toBe('canceled');

    const again = await app.request(`/runs/${run.id}/execute`, {
      method: 'POST', headers: headers(tenantA), body: '{}',
    });
    expect(again.status).toBe(409);
  });

  it('reports the honest awaiting-client-connection state when readiness regresses', async () => {
    const { app, db, events, tenantA } = await setupWithRegistry();
    const service = new ClientOpsService(db, events);
    const installation = await createActiveInstallation(app, tenantA);
    const run = await createRun(app, tenantA, installation);
    // A required connector goes back to pending after activation.
    const required = installation.connectors.find((item: any) => item.required);
    const disconnect = await app.request(`/installations/${installation.id}/connectors/${required.id}`, {
      method: 'PATCH', headers: headers(tenantA), body: JSON.stringify({ status: 'pending' }),
    });
    expect(disconnect.status).toBe(200);

    const response = await app.request(`/runs/${run.id}/execute`, {
      method: 'POST', headers: headers(tenantA), body: '{}',
    });
    expect(response.status).toBe(200);
    const body = ((await response.json()) as { data: any }).data;
    expect(body.status).toBe('not_ready');
    expect(body.reason).toContain('pending connectors');
    // Untouched: run stays requested, no reviews, no receipts.
    expect((await service.getRun(tenantA.id, run.id)).status).toBe('requested');
    await expect(service.listReviewsForRun(tenantA.id, run.id)).resolves.toHaveLength(0);
  });

  it('rejects execution for a run that is not in the requested state', async () => {
    const { app, tenantA } = await setupWithRegistry();
    const installation = await createActiveInstallation(app, tenantA);
    const run = await createRun(app, tenantA, installation);
    const patch = await app.request(`/runs/${run.id}`, {
      method: 'PATCH', headers: headers(tenantA), body: JSON.stringify({ status: 'canceled' }),
    });
    expect(patch.status).toBe(200);
    const response = await app.request(`/runs/${run.id}/execute`, {
      method: 'POST', headers: headers(tenantA), body: '{}',
    });
    expect(response.status).toBe(409);
  });
});
