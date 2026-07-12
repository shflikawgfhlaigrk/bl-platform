import { describe, expect, it } from 'vitest';
import type { PlatformEvent } from '@blacklabel/core';
import { createSourceTables, headers, seedSources, setup } from './fixtures';

describe('alert rules CRUD', () => {
  it('creates, lists, updates and deletes rules through the router, emitting events', async () => {
    const { app, tenantA, events } = await setup();
    const emitted: PlatformEvent[] = [];
    events.on('*', (e) => {
      if (e.type.startsWith('dashboard.alert.')) emitted.push(e);
    });

    // create
    const created = await app.request('/alerts', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ name: 'Low conversion', metric: 'quote_conversion_bps', threshold: 2500, direction: 'below' }),
    });
    expect(created.status).toBe(201);
    const rule = (await created.json() as any).data;
    expect(rule).toMatchObject({
      name: 'Low conversion',
      metric: 'quote_conversion_bps',
      threshold: 2500,
      direction: 'below',
      enabled: true,
    });

    // list
    const listed = await app.request('/alerts', { headers: headers(tenantA) });
    const listBody = await listed.json() as any;
    expect(listBody.data).toHaveLength(1);
    expect(listBody.limit).toBe(50);
    expect(listBody.offset).toBe(0);

    // update
    const patched = await app.request(`/alerts/${rule.id}`, {
      method: 'PATCH',
      headers: headers(tenantA),
      body: JSON.stringify({ threshold: 3000, enabled: false }),
    });
    expect(patched.status).toBe(200);
    expect((await patched.json() as any).data).toMatchObject({ threshold: 3000, enabled: false });

    // delete
    const deleted = await app.request(`/alerts/${rule.id}`, { method: 'DELETE', headers: headers(tenantA) });
    expect(deleted.status).toBe(200);
    expect((await (await app.request('/alerts', { headers: headers(tenantA) })).json() as any).data).toEqual([]);

    expect(emitted.map((e) => e.type)).toEqual([
      'dashboard.alert.created',
      'dashboard.alert.updated',
      'dashboard.alert.deleted',
    ]);
    expect(emitted[0].payload).toEqual({ alertId: rule.id, metric: 'quote_conversion_bps' });
  });

  it('rejects unknown metrics and bad directions', async () => {
    const { app, tenantA } = await setup();
    const badMetric = await app.request('/alerts', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ name: 'x', metric: 'made_up', threshold: 1, direction: 'above' }),
    });
    expect(badMetric.status).toBe(400);

    const badDirection = await app.request('/alerts', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ name: 'x', metric: 'open_tasks', threshold: 1, direction: 'sideways' }),
    });
    expect(badDirection.status).toBe(400);
  });

  it('denies cross-tenant access: B gets empty list, 404 on update/delete, and A\'s rule is untouched', async () => {
    const { app, tenantA, tenantB } = await setup();
    const created = await app.request('/alerts', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ name: 'Mine', metric: 'open_tasks', threshold: 5, direction: 'above' }),
    });
    const rule = (await created.json() as any).data;

    const bList = await app.request('/alerts', { headers: headers(tenantB) });
    expect((await bList.json() as any).data).toEqual([]);

    const bPatch = await app.request(`/alerts/${rule.id}`, {
      method: 'PATCH',
      headers: headers(tenantB),
      body: JSON.stringify({ threshold: 999999 }),
    });
    expect(bPatch.status).toBe(404);

    const bDelete = await app.request(`/alerts/${rule.id}`, { method: 'DELETE', headers: headers(tenantB) });
    expect(bDelete.status).toBe(404);

    // A's rule untouched
    const aList = await app.request('/alerts', { headers: headers(tenantA) });
    const aRules = (await aList.json() as any).data;
    expect(aRules).toHaveLength(1);
    expect(aRules[0]).toMatchObject({ id: rule.id, threshold: 5 });
  });
});

describe('alert evaluation (on demand)', () => {
  it('evaluates enabled rules against live aggregations and emits dashboard.alert.triggered', async () => {
    const { app, db, tenantA, events } = await setup();
    await createSourceTables(db);
    await seedSources(db, tenantA.id, 'a'); // open_tasks = 3, conversion = 4000 bps

    const triggeredEvents: PlatformEvent[] = [];
    events.on('dashboard.alert.triggered', (e) => {
      triggeredEvents.push(e);
    });

    const mk = (body: Record<string, unknown>) =>
      app.request('/alerts', { method: 'POST', headers: headers(tenantA), body: JSON.stringify(body) });
    const hit = (await (await mk({ name: 'Too many open tasks', metric: 'open_tasks', threshold: 2, direction: 'above' })).json() as any).data;
    await mk({ name: 'Conversion too low', metric: 'quote_conversion_bps', threshold: 2000, direction: 'below' }); // 4000 not < 2000
    await mk({ name: 'Disabled rule', metric: 'open_tasks', threshold: 0, direction: 'above', enabled: false });

    const res = await app.request('/alerts/evaluate', { headers: headers(tenantA) });
    expect(res.status).toBe(200);
    const { evaluations } = (await res.json() as any).data;
    expect(evaluations).toHaveLength(2); // disabled rule excluded
    const byName = Object.fromEntries(evaluations.map((e: { name: string }) => [e.name, e]));
    expect(byName['Too many open tasks']).toMatchObject({ value: 3, triggered: true, available: true });
    expect(byName['Conversion too low']).toMatchObject({ value: 4000, triggered: false });

    expect(triggeredEvents).toHaveLength(1);
    expect(triggeredEvents[0].payload).toEqual({
      alertId: hit.id,
      metric: 'open_tasks',
      value: 3,
      threshold: 2,
      direction: 'above',
    });
  });

  it('respects the date-range filter and never triggers on unavailable sources', async () => {
    const { app, db, tenantA } = await setup();
    // No source tables at all → metric unavailable.
    await app.request('/alerts', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ name: 'Zero revenue', metric: 'revenue_cents', threshold: 1, direction: 'below' }),
    });
    const unavailable = await app.request('/alerts/evaluate', { headers: headers(tenantA) });
    const evalsUnavailable = (await unavailable.json() as any).data.evaluations;
    expect(evalsUnavailable[0]).toMatchObject({ available: false, triggered: false });

    // Now create+seed sources: all-time open_tasks=3; Feb-only open_tasks=2.
    await createSourceTables(db);
    await seedSources(db, tenantA.id, 'a');
    await app.request('/alerts', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ name: 'Open above 2', metric: 'open_tasks', threshold: 2, direction: 'above' }),
    });
    const feb = await app.request('/alerts/evaluate?from=2026-02-01&to=2026-02-28', { headers: headers(tenantA) });
    const febEvals = (await feb.json() as any).data.evaluations;
    const rule = febEvals.find((e: { name: string }) => e.name === 'Open above 2');
    expect(rule).toMatchObject({ value: 2, triggered: false }); // 2 is not > 2 (strict)
  });
});
