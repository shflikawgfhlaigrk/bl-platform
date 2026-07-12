import { describe, expect, it } from 'vitest';
import { headers, openBody, setup } from './helpers';

async function openViaRouter(app: any, tenant: any, body: Record<string, unknown>) {
  const res = await app.request('/', {
    method: 'POST',
    headers: headers(tenant),
    body: JSON.stringify(body),
  });
  return { res, json: (await res.json()) as any };
}

describe('actions router — CRUD & lifecycle', () => {
  it('opens (201), dedupes (200), lists, and reads one with comments+escalations', async () => {
    const { app, tenantA } = await setup();

    const first = await openViaRouter(app, tenantA, openBody());
    expect(first.res.status).toBe(201);
    expect(first.json.deduped).toBe(false);
    const actionId = first.json.data.id as string;

    const dup = await openViaRouter(app, tenantA, openBody({ evidence: { onHand: 0 } }));
    expect(dup.res.status).toBe(200);
    expect(dup.json.deduped).toBe(true);
    expect(dup.json.data.id).toBe(actionId);

    const list = await app.request('/', { headers: headers(tenantA) });
    const listJson = (await list.json()) as any;
    expect(listJson.data).toHaveLength(1);
    expect(listJson.limit).toBe(50);
    expect(listJson.offset).toBe(0);

    // comment + escalate, then read detail
    await app.request(`/${actionId}/comments`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ body: 'on it' }),
    });
    await app.request(`/${actionId}/escalate`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ toPriority: 'p1', reason: 'urgent' }),
    });
    const detail = await app.request(`/${actionId}`, { headers: headers(tenantA) });
    const detailJson = (await detail.json()) as any;
    expect(detailJson.data.action.priority).toBe('p1');
    expect(detailJson.data.action.status).toBe('escalated');
    expect(detailJson.data.comments).toHaveLength(1);
    expect(detailJson.data.escalations).toHaveLength(1);
  });

  it('resolve, snooze/unsnooze, assign, wake-due, counts, overdue via router', async () => {
    const { app, tenantA } = await setup();
    const opened = await openViaRouter(app, tenantA, openBody({ dueAt: '2026-07-01T00:00:00.000Z' }));
    const actionId = opened.json.data.id as string;

    // assign
    const assigned = await app.request(`/${actionId}/assign`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ ownerUserId: 'owner_1' }),
    });
    expect(((await assigned.json()) as any).data.owner_user_id).toBe('owner_1');

    // counts (active)
    const counts = await app.request('/counts', { headers: headers(tenantA) });
    expect(((await counts.json()) as any).data.total).toBe(1);

    // overdue
    const overdue = await app.request('/overdue?now=2026-07-12T00:00:00.000Z', {
      headers: headers(tenantA),
    });
    expect(((await overdue.json()) as any).data).toHaveLength(1);

    // snooze -> unsnooze
    const snoozed = await app.request(`/${actionId}/snooze`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ until: '2026-07-13T00:00:00.000Z', reason: 'later' }),
    });
    expect(((await snoozed.json()) as any).data.status).toBe('snoozed');

    // wake-due (not yet due -> 0)
    const wakeEarly = await app.request('/wake-due', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ now: '2026-07-12T12:00:00.000Z' }),
    });
    expect(((await wakeEarly.json()) as any).count).toBe(0);

    // wake-due (due -> 1)
    const wakeLate = await app.request('/wake-due', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ now: '2026-07-14T00:00:00.000Z' }),
    });
    expect(((await wakeLate.json()) as any).count).toBe(1);

    // resolve
    const resolved = await app.request(`/${actionId}/resolve`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ kind: 'manual', proof: { note: 'done' } }),
    });
    expect(((await resolved.json()) as any).data.status).toBe('resolved');
  });

  it('snooze without a reason is a 400', async () => {
    const { app, tenantA } = await setup();
    const opened = await openViaRouter(app, tenantA, openBody());
    const actionId = opened.json.data.id as string;
    const res = await app.request(`/${actionId}/snooze`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ until: '2026-07-13T00:00:00.000Z' }),
    });
    expect(res.status).toBe(400);
  });

  it('filters the queue by kind and priority', async () => {
    const { app, tenantA } = await setup();
    await openViaRouter(app, tenantA, openBody({ dedupeKey: 'k1', priority: 'p1' }));
    await openViaRouter(
      app,
      tenantA,
      openBody({ kind: 'po_awaiting_approval', dedupeKey: 'k2', priority: 'p3' }),
    );
    const byKind = await app.request('/?kind=po_awaiting_approval', { headers: headers(tenantA) });
    const byKindJson = (await byKind.json()) as any;
    expect(byKindJson.data).toHaveLength(1);
    expect(byKindJson.data[0].kind).toBe('po_awaiting_approval');

    const byPriority = await app.request('/?priority=p1', { headers: headers(tenantA) });
    expect(((await byPriority.json()) as any).data).toHaveLength(1);
  });

  it('unknown action id is 404', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request('/nope', { headers: headers(tenantA) });
    expect(res.status).toBe(404);
  });
});

describe('actions router — tenant middleware', () => {
  it('requires the tenant header (400) and a real tenant (404)', async () => {
    const { app } = await setup();
    const missing = await app.request('/');
    expect(missing.status).toBe(400);
    const unknown = await app.request('/', { headers: { 'x-tenant-id': 'nope' } });
    expect(unknown.status).toBe(404);
  });

  it('tenant B cannot read or mutate tenant A actions through the router', async () => {
    const { app, tenantA, tenantB } = await setup();
    const opened = await openViaRouter(app, tenantA, openBody());
    const actionId = opened.json.data.id as string;

    const list = await app.request('/', { headers: headers(tenantB) });
    expect(((await list.json()) as any).data).toEqual([]);

    const read = await app.request(`/${actionId}`, { headers: headers(tenantB) });
    expect(read.status).toBe(404);

    const resolve = await app.request(`/${actionId}/resolve`, {
      method: 'POST',
      headers: headers(tenantB),
      body: JSON.stringify({ kind: 'manual' }),
    });
    expect(resolve.status).toBe(404);

    // A untouched
    const stillA = await app.request(`/${actionId}`, { headers: headers(tenantA) });
    expect(((await stillA.json()) as any).data.action.status).toBe('open');
  });
});
