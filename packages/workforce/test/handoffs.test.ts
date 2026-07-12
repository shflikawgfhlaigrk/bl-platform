import { describe, expect, it } from 'vitest';
import type { PlatformEvent } from '@blacklabel/core';
import { asCoreDb, listAuditEntries } from '@blacklabel/core';
import { body, get, post, setup } from './helpers';

describe('workforce handoffs', () => {
  it('creates a handoff with open items JSON and lists it', async () => {
    const ctx = await setup();
    const res = await post(ctx, ctx.tenantA, '/handoffs', {
      fromUser: 'user_out',
      toUser: 'user_in',
      shiftRef: 'shift_123',
      body: 'Register short $2, restock table 4',
      openItems: [{ label: 'count drawer', done: false }, 'call vendor'],
    });
    expect(res.status).toBe(201);
    const handoff = (await body(res)).data;
    expect(handoff.acknowledged).toBe(false);
    expect(handoff.open_items).toEqual([{ label: 'count drawer', done: false }, 'call vendor']);

    const list = (await body(await get(ctx, ctx.tenantA, '/handoffs?toUser=user_in'))).data;
    expect(list.map((h: any) => h.id)).toContain(handoff.id);
  });

  it('acknowledge flips the flag, stamps who/when, emits event, is idempotent + audited', async () => {
    const ctx = await setup();
    const events: PlatformEvent<any>[] = [];
    ctx.events.on('workforce.handoff.acknowledged', (e) => {
      events.push(e);
    });

    const handoff = (await body(
      await post(ctx, ctx.tenantA, '/handoffs', { fromUser: 'a', body: 'notes' }),
    )).data;

    const ack = await post(ctx, ctx.tenantA, `/handoffs/${handoff.id}/acknowledge`);
    expect(ack.status).toBe(200);
    const acked = (await body(ack)).data;
    expect(acked.acknowledged).toBe(true);
    expect(acked.acknowledged_at).toBeTruthy();
    expect(acked.acknowledged_by).toBe('system');

    // Idempotent: second ack does not re-emit.
    await post(ctx, ctx.tenantA, `/handoffs/${handoff.id}/acknowledge`);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ v: 1, handoffId: handoff.id, acknowledgedBy: 'system' });

    const audits = await listAuditEntries(asCoreDb(ctx.db), ctx.tenantA, 'workforce.handoff', handoff.id);
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('workforce.handoff.created');
    expect(actions).toContain('workforce.handoff.acknowledged');
  });

  it('is tenant-scoped: tenant B cannot read or acknowledge tenant A handoff', async () => {
    const ctx = await setup();
    const handoff = (await body(
      await post(ctx, ctx.tenantA, '/handoffs', { fromUser: 'a', body: 'x' }),
    )).data;
    expect((await get(ctx, ctx.tenantB, `/handoffs/${handoff.id}`)).status).toBe(404);
    expect((await post(ctx, ctx.tenantB, `/handoffs/${handoff.id}/acknowledge`)).status).toBe(404);
    expect((await body(await get(ctx, ctx.tenantB, '/handoffs'))).data).toEqual([]);
  });

  it('rejects a handoff with no body (400)', async () => {
    const ctx = await setup();
    const res = await post(ctx, ctx.tenantA, '/handoffs', { fromUser: 'a', body: '' });
    expect(res.status).toBe(400);
  });
});

describe('workforce tenant header enforcement', () => {
  it('400 when x-tenant-id is missing; 404 for an unknown tenant', async () => {
    const ctx = await setup();
    const missing = await ctx.app.request('/roles', { headers: { 'content-type': 'application/json' } });
    expect(missing.status).toBe(400);
    const unknown = await ctx.app.request('/roles', { headers: { 'x-tenant-id': 'nope' } });
    expect(unknown.status).toBe(404);
  });
});
