import { describe, expect, it } from 'vitest';
import { body, get, post, put, setup } from './helpers';

describe('workforce session policy', () => {
  it('GET creates a default policy on first read', async () => {
    const ctx = await setup();
    const res = await get(ctx, ctx.tenantA, '/session-policy');
    expect(res.status).toBe(200);
    const policy = (await body(res)).data;
    expect(policy.max_age_hours).toBeGreaterThan(0);
    expect(policy.sessions_invalidated_after).toBeNull();

    // Second read returns the SAME singleton row.
    const again = (await body(await get(ctx, ctx.tenantA, '/session-policy'))).data;
    expect(again.id).toBe(policy.id);
  });

  it('PUT updates max_age_hours and device_logout_all bumps the cut-line', async () => {
    const ctx = await setup();
    const updated = (await body(
      await put(ctx, ctx.tenantA, '/session-policy', { maxAgeHours: 12, deviceLogoutAll: true }),
    )).data;
    expect(updated.max_age_hours).toBe(12);
    expect(updated.sessions_invalidated_after).toBeTruthy();
  });

  it('invalidate-all sets a fresh cut-line without changing max age', async () => {
    const ctx = await setup();
    const before = (await body(await get(ctx, ctx.tenantA, '/session-policy'))).data;
    const res = await post(ctx, ctx.tenantA, '/session-policy/invalidate-all');
    expect(res.status).toBe(200);
    const after = (await body(res)).data;
    expect(after.max_age_hours).toBe(before.max_age_hours);
    expect(after.sessions_invalidated_after).toBeTruthy();
  });

  it('is tenant-scoped (separate singletons)', async () => {
    const ctx = await setup();
    const a = (await body(await get(ctx, ctx.tenantA, '/session-policy'))).data;
    const b = (await body(await get(ctx, ctx.tenantB, '/session-policy'))).data;
    expect(a.id).not.toBe(b.id);
    await put(ctx, ctx.tenantA, '/session-policy', { maxAgeHours: 5 });
    const bAfter = (await body(await get(ctx, ctx.tenantB, '/session-policy'))).data;
    expect(bAfter.max_age_hours).not.toBe(5);
  });

  it('rejects a non-positive max age (400)', async () => {
    const ctx = await setup();
    const res = await put(ctx, ctx.tenantA, '/session-policy', { maxAgeHours: 0 });
    expect(res.status).toBe(400);
  });
});
