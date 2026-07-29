import { describe, expect, it } from 'vitest';
import { createActiveInstallation, createRun, headers, setup } from './helpers';

describe('client-ops artifacts, receipts, usage, and overview', () => {
  it('records completion evidence, immutable usage, and module-only summaries', async () => {
    const { app, db, tenantA } = await setup();
    const installation = await createActiveInstallation(app, tenantA);
    const run = await createRun(app, tenantA, installation);
    const succeed = await app.request(`/runs/${run.id}`, {
      method: 'PATCH', headers: headers(tenantA),
      body: JSON.stringify({ status: 'succeeded', output: { changed: true } }),
    });
    expect(succeed.status).toBe(200);

    const artifactResponse = await app.request('/artifacts', {
      method: 'POST', headers: headers(tenantA),
      body: JSON.stringify({
        installationId: installation.id, runId: run.id, kind: 'completion_receipt_source',
        name: 'External readback', uri: 'client-ops://runs/readback.json',
        mediaType: 'application/json', sha256: 'a'.repeat(64), metadata: { verified: true },
      }),
    });
    expect(artifactResponse.status).toBe(201);
    const artifact = ((await artifactResponse.json()) as any).data;

    const receiptResponse = await app.request('/receipts', {
      method: 'POST', headers: headers(tenantA),
      body: JSON.stringify({ installationId: installation.id, runId: run.id, summary: 'Run completed and external state matched.', verification: { readback: 'matched' }, artifactIds: [artifact.id] }),
    });
    expect(receiptResponse.status).toBe(201);
    const receipt = ((await receiptResponse.json()) as any).data;
    expect(receipt.artifactIds).toEqual([artifact.id]);
    expect((await app.request('/receipts', {
      method: 'POST', headers: headers(tenantA), body: JSON.stringify({ installationId: installation.id, runId: run.id, summary: 'duplicate', verification: {}, artifactIds: [] }),
    })).status).toBe(409);

    for (const body of [
      { provider: 'provider-a', model: 'model-x', metric: 'input_tokens', quantity: 120, unit: 'tokens', costCents: 7 },
      { provider: 'provider-a', model: 'model-x', metric: 'output_tokens', quantity: 40, unit: 'tokens', costCents: 5 },
      { provider: 'provider-b', model: null, metric: 'api_calls', quantity: 1, unit: 'calls', costCents: 0 },
    ]) {
      const response = await app.request('/usage-events', {
        method: 'POST', headers: headers(tenantA),
        body: JSON.stringify({ installationId: installation.id, runId: run.id, ...body }),
      });
      expect(response.status).toBe(201);
    }

    const usageListResponse = await app.request('/usage-events', { headers: headers(tenantA) });
    const usageList = ((await usageListResponse.json()) as any).data;
    expect(usageList).toHaveLength(3);
    expect((await app.request(`/usage-events/${usageList[0].id}`, {
      method: 'PATCH', headers: headers(tenantA), body: JSON.stringify({ costCents: 0 }),
    })).status).toBe(404);
    expect((await app.request(`/usage-events/${usageList[0].id}`, {
      method: 'DELETE', headers: headers(tenantA),
    })).status).toBe(404);

    const summary = ((await (await app.request(`/usage-summary?installation_id=${installation.id}`, { headers: headers(tenantA) })).json()) as any).data;
    expect(summary).toMatchObject({ eventCount: 3, totalCostCents: 12 });
    expect(summary.byProvider).toEqual([
      { provider: 'provider-a', model: 'model-x', eventCount: 2, quantity: 160, costCents: 12 },
      { provider: 'provider-b', model: null, eventCount: 1, quantity: 1, costCents: 0 },
    ]);
    expect(summary.byMetric.map((item: any) => item.metric)).toEqual(['api_calls', 'input_tokens', 'output_tokens']);

    const overview = ((await (await app.request('/overview', { headers: headers(tenantA) })).json()) as any).data;
    expect(overview).toMatchObject({
      installations: { total: 1, byStatus: { active: 1 } },
      runs: { total: 1, byStatus: { succeeded: 1 } },
      reviews: { total: 0, byStatus: {} },
      artifacts: 1,
      completionReceipts: 1,
      usage: { eventCount: 3, totalCostCents: 12 },
    });

    const persisted = await db.selectFrom('client_ops_usage_events').selectAll()
      .where('tenant_id', '=', tenantA.id).orderBy('occurred_at').orderBy('id').execute();
    expect(persisted).toHaveLength(3);
  });

  it('keeps evidence and usage invisible to tenant B', async () => {
    const { app, tenantA, tenantB } = await setup();
    const installation = await createActiveInstallation(app, tenantA);
    const run = await createRun(app, tenantA, installation);
    await app.request(`/runs/${run.id}`, { method: 'PATCH', headers: headers(tenantA), body: JSON.stringify({ status: 'succeeded' }) });
    const artifact = ((await (await app.request('/artifacts', {
      method: 'POST', headers: headers(tenantA),
      body: JSON.stringify({ installationId: installation.id, runId: run.id, kind: 'proof', name: 'Proof', uri: 'client-ops://proof', mediaType: 'application/json' }),
    })).json()) as any).data;
    const receipt = ((await (await app.request('/receipts', {
      method: 'POST', headers: headers(tenantA),
      body: JSON.stringify({ installationId: installation.id, runId: run.id, summary: 'done', verification: {}, artifactIds: [artifact.id] }),
    })).json()) as any).data;
    await app.request('/usage-events', {
      method: 'POST', headers: headers(tenantA),
      body: JSON.stringify({ installationId: installation.id, runId: run.id, provider: 'p', metric: 'calls', quantity: 1, unit: 'calls', costCents: 1 }),
    });

    expect((await app.request(`/artifacts/${artifact.id}`, { headers: headers(tenantB) })).status).toBe(404);
    expect((await app.request(`/receipts/${receipt.id}`, { headers: headers(tenantB) })).status).toBe(404);
    expect(((await (await app.request('/artifacts', { headers: headers(tenantB) })).json()) as any).data).toEqual([]);
    expect(((await (await app.request('/receipts', { headers: headers(tenantB) })).json()) as any).data).toEqual([]);
    expect(((await (await app.request('/usage-events', { headers: headers(tenantB) })).json()) as any).data).toEqual([]);
    expect(((await (await app.request('/usage-summary', { headers: headers(tenantB) })).json()) as any).data).toMatchObject({ eventCount: 0, totalCostCents: 0 });
  });
});
