import { describe, expect, it } from 'vitest';
import type { PlatformEvent } from '@blacklabel/core';
import { body, get, makeEmployee, post, setup } from './helpers';

describe('clock in / clock out', () => {
  it('clock-in creates an open time entry and emits portal_employee.shift.clocked_in', async () => {
    const ctx = await setup();
    const { employeeId, token } = await makeEmployee(ctx, ctx.tenantA, {
      name: 'Riley',
      email: 'riley@example.com',
    });
    const seen: PlatformEvent<any>[] = [];
    ctx.events.on('portal_employee.shift.clocked_in', (e) => {
      seen.push(e);
    });

    const res = await post(ctx.app, ctx.tenantA, '/portal/clock-in', {}, token);
    expect(res.status).toBe(201);
    const entry = (await body(res)).data;
    expect(entry.employee_id).toBe(employeeId);
    expect(entry.clock_out_at).toBeNull();

    expect(seen).toHaveLength(1);
    expect(seen[0].tenantId).toBe(ctx.tenantA);
    expect(seen[0].payload).toMatchObject({
      shiftId: null,
      timeEntryId: entry.id,
      employeeId,
      userId: employeeId, // no linked core user -> employee id
    });
    expect(typeof seen[0].payload.at).toBe('string');
  });

  it('open-entry guard: cannot double clock-in (409)', async () => {
    const ctx = await setup();
    const { token } = await makeEmployee(ctx, ctx.tenantA, {
      name: 'Riley',
      email: 'riley@example.com',
    });
    expect((await post(ctx.app, ctx.tenantA, '/portal/clock-in', {}, token)).status).toBe(201);
    const second = await post(ctx.app, ctx.tenantA, '/portal/clock-in', {}, token);
    expect(second.status).toBe(409);
    expect((await body(second)).error.code).toBe('conflict');
  });

  it('clock-out closes the entry and emits portal_employee.shift.clocked_out', async () => {
    const ctx = await setup();
    const { employeeId, token } = await makeEmployee(ctx, ctx.tenantA, {
      name: 'Riley',
      email: 'riley@example.com',
    });
    const seen: PlatformEvent<any>[] = [];
    ctx.events.on('portal_employee.shift.clocked_out', (e) => {
      seen.push(e);
    });

    await post(ctx.app, ctx.tenantA, '/portal/clock-in', {}, token);
    const res = await post(ctx.app, ctx.tenantA, '/portal/clock-out', {}, token);
    expect(res.status).toBe(200);
    const entry = (await body(res)).data;
    expect(entry.clock_out_at).not.toBeNull();

    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toMatchObject({ timeEntryId: entry.id, employeeId });

    // and clocking in again is allowed after clock-out
    expect((await post(ctx.app, ctx.tenantA, '/portal/clock-in', {}, token)).status).toBe(201);
  });

  it('clock-out without an open entry is a 409', async () => {
    const ctx = await setup();
    const { token } = await makeEmployee(ctx, ctx.tenantA, {
      name: 'Riley',
      email: 'riley@example.com',
    });
    const res = await post(ctx.app, ctx.tenantA, '/portal/clock-out', {}, token);
    expect(res.status).toBe(409);
  });

  it('clock-in can link a shift; other employees\' shifts are rejected', async () => {
    const ctx = await setup();
    const riley = await makeEmployee(ctx, ctx.tenantA, { name: 'Riley', email: 'r@example.com' });
    const casey = await makeEmployee(ctx, ctx.tenantA, { name: 'Casey', email: 'c@example.com' });

    const shiftRes = await post(ctx.app, ctx.tenantA, '/shifts', {
      employeeId: riley.employeeId,
      startsAt: '2026-07-10T08:00:00.000Z',
      endsAt: '2026-07-10T16:00:00.000Z',
    });
    const shift = (await body(shiftRes)).data;

    // Casey cannot clock into Riley's shift
    const denied = await post(ctx.app, ctx.tenantA, '/portal/clock-in', { shiftId: shift.id }, casey.token);
    expect(denied.status).toBe(403);

    // Riley can
    const ok = await post(ctx.app, ctx.tenantA, '/portal/clock-in', { shiftId: shift.id }, riley.token);
    expect(ok.status).toBe(201);
    expect((await body(ok)).data.shift_id).toBe(shift.id);
  });

  it('managers may view another employee\'s time entries; workers may not', async () => {
    const ctx = await setup();
    const worker = await makeEmployee(ctx, ctx.tenantA, { name: 'W', email: 'w@example.com' });
    const other = await makeEmployee(ctx, ctx.tenantA, { name: 'O', email: 'o@example.com' });
    const manager = await makeEmployee(ctx, ctx.tenantA, {
      name: 'M',
      email: 'm@example.com',
      role: 'manager',
    });
    await post(ctx.app, ctx.tenantA, '/portal/clock-in', {}, worker.token);

    const managerView = await get(
      ctx.app,
      ctx.tenantA,
      `/portal/my/time-entries?employee_id=${worker.employeeId}`,
      manager.token,
    );
    expect(managerView.status).toBe(200);
    expect((await body(managerView)).data).toHaveLength(1);

    const denied = await get(
      ctx.app,
      ctx.tenantA,
      `/portal/my/time-entries?employee_id=${worker.employeeId}`,
      other.token,
    );
    expect(denied.status).toBe(403);

    // cross-tenant: a tenant-B manager cannot target a tenant-A employee id (404)
    const bManager = await makeEmployee(ctx, ctx.tenantB, {
      name: 'BM',
      email: 'bm@example.com',
      role: 'manager',
    });
    const crossTenant = await get(
      ctx.app,
      ctx.tenantB,
      `/portal/my/time-entries?employee_id=${worker.employeeId}`,
      bManager.token,
    );
    expect(crossTenant.status).toBe(404);
  });

  it('time entries are scoped per tenant and per employee', async () => {
    const ctx = await setup();
    const a = await makeEmployee(ctx, ctx.tenantA, { name: 'A', email: 'a@example.com' });
    const b = await makeEmployee(ctx, ctx.tenantB, { name: 'B', email: 'b@example.com' });
    await post(ctx.app, ctx.tenantA, '/portal/clock-in', {}, a.token);

    const mine = await get(ctx.app, ctx.tenantA, '/portal/my/time-entries', a.token);
    expect((await body(mine)).data).toHaveLength(1);

    // Tenant B's employee sees nothing (and B is not blocked by A's open entry)
    const theirs = await get(ctx.app, ctx.tenantB, '/portal/my/time-entries', b.token);
    expect((await body(theirs)).data).toHaveLength(0);
    expect((await post(ctx.app, ctx.tenantB, '/portal/clock-in', {}, b.token)).status).toBe(201);
  });
});
