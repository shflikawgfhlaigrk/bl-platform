import { describe, expect, it } from 'vitest';
import { setup, headers, reorderRule, reorderEvent } from './helpers';

async function createRule(app: any, tenant: any, overrides: Record<string, unknown> = {}) {
  const res = await app.request('/rules', {
    method: 'POST',
    headers: headers(tenant),
    body: JSON.stringify({ ...reorderRule(), ...overrides }),
  });
  return res;
}

describe('rules router CRUD (x-tenant-id)', () => {
  it('POST/GET/PUT/versions/DELETE happy paths', async () => {
    const { app, tenantA } = await setup();

    const created = await createRule(app, tenantA);
    expect(created.status).toBe(201);
    const rule = (await created.json() as any).data;
    expect(rule.version).toBe(1);
    const ruleKey = rule.rule_key;

    const list = await app.request('/rules', { headers: headers(tenantA) });
    expect(((await list.json() as any).data)).toHaveLength(1);

    const one = await app.request(`/rules/${ruleKey}`, { headers: headers(tenantA) });
    expect((await one.json() as any).data.rule_key).toBe(ruleKey);

    const updated = await app.request(`/rules/${ruleKey}`, {
      method: 'PUT',
      headers: headers(tenantA),
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect((await updated.json() as any).data.version).toBe(2);

    const versions = await app.request(`/rules/${ruleKey}/versions`, { headers: headers(tenantA) });
    expect(((await versions.json() as any).data)).toHaveLength(2);

    const del = await app.request(`/rules/${ruleKey}`, { method: 'DELETE', headers: headers(tenantA) });
    const delBody = (await del.json() as any).data;
    expect(delBody.enabled).toBe(0);
    expect(delBody.policy).toBe('disabled');
  });

  it('validation error → 400; unknown rule → 404', async () => {
    const { app, tenantA } = await setup();
    const bad = await app.request('/rules', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ name: '', triggerEvent: 'x', actionKind: 'k', policy: 'nope' }),
    });
    expect(bad.status).toBe(400);
    const missing = await app.request('/rules/nope', { headers: headers(tenantA) });
    expect(missing.status).toBe(404);
  });

  it('requires the tenant header (400) and a real tenant (404)', async () => {
    const { app } = await setup();
    const noHeader = await app.request('/rules');
    expect(noHeader.status).toBe(400);
    const unknown = await app.request('/rules', { headers: { 'x-tenant-id': 'nope' } });
    expect(unknown.status).toBe(404);
  });
});

describe('evaluate + outbox + approvals + executions over HTTP', () => {
  it('evaluate (automatic) enqueues, listable via /outbox and /executions', async () => {
    const { app, tenantA } = await setup();
    await createRule(app, tenantA);

    const ev = await app.request('/evaluate', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ eventType: 'inventory.stock.below_reorder_point', payload: reorderEvent() }),
    });
    expect(ev.status).toBe(200);
    expect((await ev.json() as any).data[0].outcome).toBe('enqueued');

    const outbox = await app.request('/outbox?status=pending', { headers: headers(tenantA) });
    expect(((await outbox.json() as any).data)).toHaveLength(1);

    const bad = await app.request('/outbox?status=bogus', { headers: headers(tenantA) });
    expect(bad.status).toBe(400);

    const execs = await app.request('/executions?outcome=enqueued', { headers: headers(tenantA) });
    expect(((await execs.json() as any).data)).toHaveLength(1);
  });

  it('approval flow: evaluate → /approvals → approve', async () => {
    const { app, tenantA } = await setup();
    await createRule(app, tenantA, { policy: 'approval_required', idempotencyWindowSeconds: 0 });
    await app.request('/evaluate', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ eventType: 'inventory.stock.below_reorder_point', payload: reorderEvent() }),
    });

    const pending = await app.request('/approvals?status=pending', { headers: headers(tenantA) });
    const approval = (await pending.json() as any).data[0];
    expect(approval.status).toBe('pending');

    const approve = await app.request(`/approvals/${approval.id}/approve`, {
      method: 'POST',
      headers: headers(tenantA),
      body: '{}',
    });
    expect((await approve.json() as any).data.status).toBe('approved');

    // reject needs a reason (400 without it)
    const { app: app2, tenantA: t2 } = await setup();
    await createRule(app2, t2, { policy: 'approval_required', idempotencyWindowSeconds: 0 });
    await app2.request('/evaluate', {
      method: 'POST',
      headers: headers(t2),
      body: JSON.stringify({ eventType: 'inventory.stock.below_reorder_point', payload: reorderEvent() }),
    });
    const p2 = (await (await app2.request('/approvals?status=pending', { headers: headers(t2) })).json() as any).data[0];
    const noReason = await app2.request(`/approvals/${p2.id}/reject`, {
      method: 'POST',
      headers: headers(t2),
      body: '{}',
    });
    expect(noReason.status).toBe(400);
  });

  it('dead-letter list + replay + cancel over HTTP', async () => {
    const { app, tenantA, registry } = await setup();
    registry.register('purchasing.reorder', () => {
      throw new Error('always fails');
    });
    await createRule(app, tenantA, { idempotencyWindowSeconds: 0 });
    await app.request('/evaluate', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ eventType: 'inventory.stock.below_reorder_point', payload: reorderEvent() }),
    });
    const outboxId = (await (await app.request('/outbox', { headers: headers(tenantA) })).json() as any).data[0].id;

    // Cancel path.
    const cancel = await app.request(`/outbox/${outboxId}/cancel`, { method: 'POST', headers: headers(tenantA), body: '{}' });
    expect((await cancel.json() as any).data.status).toBe('canceled');

    // Replay a canceled row back to pending.
    const replay = await app.request(`/outbox/${outboxId}/replay`, { method: 'POST', headers: headers(tenantA), body: '{}' });
    expect((await replay.json() as any).data.status).toBe('pending');

    const dead = await app.request('/outbox/dead', { headers: headers(tenantA) });
    expect(dead.status).toBe(200);
  });

  it('POST /outbox/run-once drains via the injected registry', async () => {
    const { app, tenantA, registry } = await setup();
    const delivered: string[] = [];
    registry.register('purchasing.reorder', (job) => {
      delivered.push(job.id);
    });
    await createRule(app, tenantA, { idempotencyWindowSeconds: 0 });
    await app.request('/evaluate', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ eventType: 'inventory.stock.below_reorder_point', payload: reorderEvent() }),
    });

    const run = await app.request('/outbox/run-once', { method: 'POST', headers: headers(tenantA), body: '{}' });
    expect(run.status).toBe(200);
    const result = (await run.json() as any).data;
    expect(result.delivered).toBe(1);
    expect(delivered).toHaveLength(1);
  });

  it('run-once returns 501 when no registry is wired', async () => {
    const { db, events } = await setup();
    const { automationRouter } = await import('../src/router');
    const { createTenant, asCoreDb } = await import('@blacklabel/core');
    const t = await createTenant(asCoreDb(db), { name: 'NoRegistry' });
    const app = automationRouter({ db, events, contracts: {} }); // no registry
    const run = await app.request('/outbox/run-once', { method: 'POST', headers: headers(t), body: '{}' });
    expect(run.status).toBe(501);
  });
});

describe('tenant isolation — every entity', () => {
  it('tenant B cannot see or mutate tenant A rules/outbox/approvals/executions', async () => {
    const { app, tenantA, tenantB, registry } = await setup();
    registry.register('purchasing.reorder', () => {});
    // A creates a rule + approval + outbox + executions.
    const created = await createRule(app, tenantA, { policy: 'approval_required', idempotencyWindowSeconds: 0 });
    const ruleKey = (await created.json() as any).data.rule_key;
    await app.request('/evaluate', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ eventType: 'inventory.stock.below_reorder_point', payload: reorderEvent() }),
    });

    // B sees empty lists.
    for (const path of ['/rules', '/outbox', '/approvals', '/executions']) {
      const res = await app.request(path, { headers: headers(tenantB) });
      expect(res.status).toBe(200);
      expect((await res.json() as any).data).toEqual([]);
    }

    // B cannot read A's rule by key → 404.
    const readAcross = await app.request(`/rules/${ruleKey}`, { headers: headers(tenantB) });
    expect(readAcross.status).toBe(404);

    // B cannot update A's rule → 404.
    const updateAcross = await app.request(`/rules/${ruleKey}`, {
      method: 'PUT',
      headers: headers(tenantB),
      body: JSON.stringify({ name: 'hijack' }),
    });
    expect(updateAcross.status).toBe(404);

    // B cannot approve A's approval → 404.
    const aApproval = (await (await app.request('/approvals', { headers: headers(tenantA) })).json() as any).data[0];
    const approveAcross = await app.request(`/approvals/${aApproval.id}/approve`, {
      method: 'POST',
      headers: headers(tenantB),
      body: '{}',
    });
    expect(approveAcross.status).toBe(404);

    // A's data is untouched: still one pending approval.
    const aStill = (await (await app.request('/approvals?status=pending', { headers: headers(tenantA) })).json() as any).data;
    expect(aStill).toHaveLength(1);
  });

  it('a tenant B outbox row id cannot be replayed/canceled by tenant A', async () => {
    const { app, tenantA, tenantB } = await setup();
    await createRule(app, tenantB, { idempotencyWindowSeconds: 0 });
    await app.request('/evaluate', {
      method: 'POST',
      headers: headers(tenantB),
      body: JSON.stringify({ eventType: 'inventory.stock.below_reorder_point', payload: reorderEvent() }),
    });
    const bOutboxId = (await (await app.request('/outbox', { headers: headers(tenantB) })).json() as any).data[0].id;

    const cancelAcross = await app.request(`/outbox/${bOutboxId}/cancel`, {
      method: 'POST',
      headers: headers(tenantA),
      body: '{}',
    });
    expect(cancelAcross.status).toBe(404);
  });
});
