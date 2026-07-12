import { describe, expect, it } from 'vitest';
import { body, create, setup } from './helpers';

describe('suppressions', () => {
  it('adds, checks (normalized), and removes suppressions; tenant-scoped', async () => {
    const ctx = await setup();
    await create(ctx, ctx.A, '/suppressions', { scope: 'email', value: 'Stop@X.com', reason: 'unsubscribed' });

    const check = (await body(await ctx.req(ctx.A, '/suppressions/check?scope=email&value=stop@x.com'))).data;
    expect(check.suppressed).toBe(true);
    // Different tenant is not suppressed.
    const checkB = (await body(await ctx.req(ctx.B, '/suppressions/check?scope=email&value=stop@x.com'))).data;
    expect(checkB.suppressed).toBe(false);

    // Idempotent add returns the same row (no duplicate).
    await create(ctx, ctx.A, '/suppressions', { scope: 'email', value: 'stop@x.com', reason: 'manual' });
    expect((await body(await ctx.req(ctx.A, '/suppressions'))).data).toHaveLength(1);

    // Remove.
    expect((await ctx.req(ctx.A, '/suppressions?scope=email&value=stop@x.com', { method: 'DELETE' })).status).toBe(204);
    const after = (await body(await ctx.req(ctx.A, '/suppressions/check?scope=email&value=stop@x.com'))).data;
    expect(after.suppressed).toBe(false);
  });
});

describe('restock requests', () => {
  it('creates a request and emits customers.restock.requested {v:1,...}', async () => {
    const ctx = await setup();
    const p = await create(ctx, ctx.A, '/profiles', { email: 'r@x.com' });
    const seen: any[] = [];
    ctx.events.on('customers.restock.requested', (e) => {
      seen.push(e);
    });

    await create(ctx, ctx.A, '/restock-requests', { variation_id: 'VAR-1', profile_id: p.id });
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toEqual({ v: 1, variationId: 'VAR-1', customerId: p.id });

    // Anonymous restock (no profile) omits customerId.
    seen.length = 0;
    await create(ctx, ctx.A, '/restock-requests', { variation_id: 'VAR-2' });
    expect(seen[0].payload).toEqual({ v: 1, variationId: 'VAR-2' });
  });

  it('transitions status open -> notified', async () => {
    const ctx = await setup();
    const rr = await create(ctx, ctx.A, '/restock-requests', { variation_id: 'VAR-9' });
    const updated = (await body(await ctx.json(ctx.A, 'POST', `/restock-requests/${rr.id}/status`, { status: 'notified' }))).data;
    expect(updated.status).toBe('notified');
  });
});

describe('service cases + notes', () => {
  it('creates a case, adds notes, updates status, and denies cross-tenant', async () => {
    const ctx = await setup();
    const p = await create(ctx, ctx.A, '/profiles', { email: 's@x.com' });
    const kase = await create(ctx, ctx.A, '/service-cases', { profile_id: p.id, kind: 'return', body: 'wrong size' });
    expect(kase.status).toBe('open');

    await create(ctx, ctx.A, `/service-cases/${kase.id}/notes`, { body: 'issued label' });
    const notes = (await body(await ctx.req(ctx.A, `/service-cases/${kase.id}/notes`))).data;
    expect(notes).toHaveLength(1);

    const resolved = (await body(await ctx.json(ctx.A, 'PATCH', `/service-cases/${kase.id}`, { status: 'resolved' }))).data;
    expect(resolved.status).toBe('resolved');

    // Cross-tenant denial.
    expect((await ctx.json(ctx.B, 'PATCH', `/service-cases/${kase.id}`, { status: 'open' })).status).toBe(404);
    expect((await body(await ctx.req(ctx.B, '/service-cases'))).data).toEqual([]);
  });
});
