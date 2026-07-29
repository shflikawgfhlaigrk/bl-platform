import { describe, expect, it } from 'vitest';
import { createActiveInstallation, createRun, headers, setup } from './helpers';

describe('client-ops runs', () => {
  it('deduplicates requests and retries while preserving retry lineage and history', async () => {
    const { app, tenantA } = await setup();
    const installation = await createActiveInstallation(app, tenantA);
    const run = await createRun(app, tenantA, installation, 'initial-key');
    expect(run).toMatchObject({ attempt: 1, status: 'requested', rootRunId: run.id, retryOfRunId: null });

    const duplicate = await app.request('/runs', {
      method: 'POST', headers: headers(tenantA),
      body: JSON.stringify({ installationId: installation.id, workflowId: installation.workflows[0].id, idempotencyKey: 'initial-key', input: { leadId: 'lead-1' } }),
    });
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()) as any).toMatchObject({ created: false, data: { id: run.id } });

    const keyConflict = await app.request('/runs', {
      method: 'POST', headers: headers(tenantA),
      body: JSON.stringify({ installationId: installation.id, workflowId: installation.workflows[0].id, idempotencyKey: 'initial-key', input: { leadId: 'other' } }),
    });
    expect(keyConflict.status).toBe(409);

    const fail = await app.request(`/runs/${run.id}`, {
      method: 'PATCH', headers: headers(tenantA), body: JSON.stringify({ status: 'failed', error: 'connector timeout' }),
    });
    expect(((await fail.json()) as any).data.status).toBe('failed');

    const retryResponse = await app.request(`/runs/${run.id}/retry`, {
      method: 'POST', headers: headers(tenantA), body: JSON.stringify({ idempotencyKey: 'retry-key' }),
    });
    expect(retryResponse.status).toBe(201);
    const retry = ((await retryResponse.json()) as any).data;
    expect(retry).toMatchObject({ retryOfRunId: run.id, rootRunId: run.id, attempt: 2, status: 'requested' });

    const duplicateRetry = await app.request(`/runs/${run.id}/retry`, {
      method: 'POST', headers: headers(tenantA), body: JSON.stringify({ idempotencyKey: 'retry-key' }),
    });
    expect((await duplicateRetry.json()) as any).toMatchObject({ created: false, data: { id: retry.id } });

    const history = await app.request(`/runs?installation_id=${installation.id}`, { headers: headers(tenantA) });
    const historyBody = (await history.json()) as any;
    expect(historyBody.data.map((item: any) => item.id).sort()).toEqual([run.id, retry.id].sort());
  });

  it('denies tenant B run reads, writes, and retry attempts', async () => {
    const { app, tenantA, tenantB } = await setup();
    const installation = await createActiveInstallation(app, tenantA);
    const run = await createRun(app, tenantA, installation);
    expect((await app.request(`/runs/${run.id}`, { headers: headers(tenantB) })).status).toBe(404);
    expect((await app.request(`/runs/${run.id}`, {
      method: 'PATCH', headers: headers(tenantB), body: JSON.stringify({ status: 'failed', error: 'x' }),
    })).status).toBe(404);
    expect((await app.request(`/runs/${run.id}/retry`, {
      method: 'POST', headers: headers(tenantB), body: JSON.stringify({ idempotencyKey: 'cross-tenant' }),
    })).status).toBe(404);
    const listB = await app.request('/runs', { headers: headers(tenantB) });
    expect(((await listB.json()) as any).data).toEqual([]);
  });
});
