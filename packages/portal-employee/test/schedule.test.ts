import { describe, expect, it } from 'vitest';
import { body, get, makeAssignment, makeEmployee, post, setup } from './helpers';

const DAY = '2026-07-10';

async function seedDay(ctx: Awaited<ReturnType<typeof setup>>) {
  const worker = await makeEmployee(ctx, ctx.tenantA, { name: 'Riley', email: 'r@example.com' });
  const manager = await makeEmployee(ctx, ctx.tenantA, {
    name: 'Morgan',
    email: 'm@example.com',
    role: 'manager',
  });

  await post(ctx.app, ctx.tenantA, '/shifts', {
    employeeId: worker.employeeId,
    startsAt: `${DAY}T08:00:00.000Z`,
    endsAt: `${DAY}T16:00:00.000Z`,
  });
  // A shift on ANOTHER day must not appear
  await post(ctx.app, ctx.tenantA, '/shifts', {
    employeeId: worker.employeeId,
    startsAt: '2026-07-12T08:00:00.000Z',
    endsAt: '2026-07-12T16:00:00.000Z',
  });
  const todayJob = await makeAssignment(ctx, ctx.tenantA, {
    employeeId: worker.employeeId,
    kind: 'service_visit',
    title: 'Morning visit',
    scheduledAt: `${DAY}T09:30:00.000Z`,
  });
  await makeAssignment(ctx, ctx.tenantA, {
    employeeId: worker.employeeId,
    kind: 'service_visit',
    title: 'Different day',
    scheduledAt: '2026-07-11T09:30:00.000Z',
  });
  return { worker, manager, todayJob };
}

describe('daily schedule endpoint', () => {
  it('returns shifts + assignments for the requested date only', async () => {
    const ctx = await setup();
    const { worker, todayJob } = await seedDay(ctx);

    const res = await get(ctx.app, ctx.tenantA, `/portal/my/schedule?date=${DAY}`, worker.token);
    expect(res.status).toBe(200);
    const schedule = (await body(res)).data;
    expect(schedule.date).toBe(DAY);
    expect(schedule.employeeId).toBe(worker.employeeId);
    expect(schedule.shifts).toHaveLength(1);
    expect(schedule.shifts[0].starts_at).toBe(`${DAY}T08:00:00.000Z`);
    expect(schedule.assignments.map((a: any) => a.id)).toEqual([todayJob.id]);
    expect(schedule.openTimeEntry).toBeNull();
  });

  it('reflects an open time entry after clock-in', async () => {
    const ctx = await setup();
    const { worker } = await seedDay(ctx);
    await post(ctx.app, ctx.tenantA, '/portal/clock-in', {}, worker.token);
    const schedule = (await body(
      await get(ctx.app, ctx.tenantA, `/portal/my/schedule?date=${DAY}`, worker.token),
    )).data;
    expect(schedule.openTimeEntry).not.toBeNull();
    expect(schedule.openTimeEntry.employee_id).toBe(worker.employeeId);
  });

  it('rejects malformed dates with 400', async () => {
    const ctx = await setup();
    const { worker } = await seedDay(ctx);
    const res = await get(ctx.app, ctx.tenantA, '/portal/my/schedule?date=07/10/2026', worker.token);
    expect(res.status).toBe(400);
  });

  it('managers may view another employee\'s schedule; workers may not', async () => {
    const ctx = await setup();
    const { worker, manager } = await seedDay(ctx);

    const managerView = await get(
      ctx.app,
      ctx.tenantA,
      `/portal/my/schedule?date=${DAY}&employee_id=${worker.employeeId}`,
      manager.token,
    );
    expect(managerView.status).toBe(200);
    expect((await body(managerView)).data.shifts).toHaveLength(1);

    const workerView = await get(
      ctx.app,
      ctx.tenantA,
      `/portal/my/schedule?date=${DAY}&employee_id=${manager.employeeId}`,
      worker.token,
    );
    expect(workerView.status).toBe(403);
  });
});

describe('mobile HTML pages', () => {
  it('GET /portal/day renders a mobile-first daily view with clock control', async () => {
    const ctx = await setup();
    const { worker } = await seedDay(ctx);
    const res = await get(ctx.app, ctx.tenantA, `/portal/day?date=${DAY}`, worker.token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('viewport'); // mobile-first meta
    expect(html).toContain('My Day');
    expect(html).toContain('Morning visit');
    expect(html).toContain('service_visit');
    expect(html).toContain('Clock In'); // not clocked in yet
  });

  it('GET /portal/clock shows clock-out once clocked in and escapes user content', async () => {
    const ctx = await setup();
    const worker = await makeEmployee(ctx, ctx.tenantA, {
      name: 'Riley <script>alert(1)</script>',
      email: 'x@example.com',
    });
    await post(ctx.app, ctx.tenantA, '/portal/clock-in', {}, worker.token);
    const res = await get(ctx.app, ctx.tenantA, '/portal/clock', worker.token);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Clock Out');
    expect(html).not.toContain('<script>alert(1)</script>'); // escaped
    expect(html).toContain('&lt;script&gt;');
  });

  it('HTML pages require a valid token too', async () => {
    const ctx = await setup();
    const res = await get(ctx.app, ctx.tenantA, '/portal/day');
    expect(res.status).toBe(401);
  });
});
