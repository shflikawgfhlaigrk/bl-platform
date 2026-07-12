import { describe, expect, it } from 'vitest';
import type { PlatformEvent } from '@blacklabel/core';
import { body, get, makeAssignment, makeEmployee, post, setup, type TestContext } from './helpers';

async function twoWorkersAndAManager(ctx: TestContext) {
  const worker = await makeEmployee(ctx, ctx.tenantA, { name: 'Worker', email: 'w@example.com' });
  const other = await makeEmployee(ctx, ctx.tenantA, { name: 'Other', email: 'o@example.com' });
  const manager = await makeEmployee(ctx, ctx.tenantA, {
    name: 'Manager',
    email: 'm@example.com',
    role: 'manager',
  });
  return { worker, other, manager };
}

describe('assignments + permissions + work logs', () => {
  it('creates an assignment (free-form kind) and emits portal_employee.assignment.created', async () => {
    const ctx = await setup();
    const { worker } = await twoWorkersAndAManager(ctx);
    const seen: PlatformEvent<any>[] = [];
    ctx.events.on('portal_employee.assignment.created', (e) => {
      seen.push(e);
    });

    const assignment = await makeAssignment(ctx, ctx.tenantA, {
      employeeId: worker.employeeId,
      kind: 'video_shoot', // media staff — kind is per-tenant free-form, not an industry enum
      title: 'Shoot customer testimonial',
      relatedEntityType: 'scheduling.appointment',
      relatedEntityId: 'appt-123',
    });
    expect(assignment.status).toBe('assigned');
    expect(assignment.kind).toBe('video_shoot');
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toEqual({
      assignmentId: assignment.id,
      employeeId: worker.employeeId,
      kind: 'video_shoot',
    });
  });

  it('worker sees their own assignments; cannot read another worker\'s (403); manager can', async () => {
    const ctx = await setup();
    const { worker, other, manager } = await twoWorkersAndAManager(ctx);
    const assignment = await makeAssignment(ctx, ctx.tenantA, {
      employeeId: worker.employeeId,
      kind: 'install',
      title: 'Install unit',
    });

    const mine = await get(ctx.app, ctx.tenantA, '/portal/my/assignments', worker.token);
    expect((await body(mine)).data.map((a: any) => a.id)).toEqual([assignment.id]);

    const denied = await get(ctx.app, ctx.tenantA, `/portal/assignments/${assignment.id}`, other.token);
    expect(denied.status).toBe(403);

    const allowed = await get(ctx.app, ctx.tenantA, `/portal/assignments/${assignment.id}`, manager.token);
    expect(allowed.status).toBe(200);
  });

  it('middleware-enforced: only managers/admins can list ALL assignments', async () => {
    const ctx = await setup();
    const { worker, manager } = await twoWorkersAndAManager(ctx);
    await makeAssignment(ctx, ctx.tenantA, {
      employeeId: worker.employeeId,
      kind: 'job',
      title: 'A job',
    });

    const denied = await get(ctx.app, ctx.tenantA, '/portal/assignments', worker.token);
    expect(denied.status).toBe(403);
    expect((await body(denied)).error.code).toBe('forbidden');

    const allowed = await get(ctx.app, ctx.tenantA, '/portal/assignments', manager.token);
    expect(allowed.status).toBe(200);
    expect((await body(allowed)).data).toHaveLength(1);
  });

  it('status update writes a status_update work log and completing emits portal_employee.task.completed', async () => {
    const ctx = await setup();
    const { worker } = await twoWorkersAndAManager(ctx);
    const assignment = await makeAssignment(ctx, ctx.tenantA, {
      employeeId: worker.employeeId,
      kind: 'job',
      title: 'Finish the job',
    });
    const seen: PlatformEvent<any>[] = [];
    ctx.events.on('portal_employee.task.completed', (e) => {
      seen.push(e);
    });

    const progress = await post(
      ctx.app,
      ctx.tenantA,
      `/portal/assignments/${assignment.id}/status`,
      { status: 'in_progress' },
      worker.token,
    );
    expect(progress.status).toBe(200);
    expect(seen).toHaveLength(0); // not completed yet

    const done = await post(
      ctx.app,
      ctx.tenantA,
      `/portal/assignments/${assignment.id}/status`,
      { status: 'completed', note: 'all wrapped up' },
      worker.token,
    );
    expect(done.status).toBe(200);
    expect((await body(done)).data.status).toBe('completed');
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toEqual({
      assignmentId: assignment.id,
      employeeId: worker.employeeId,
      kind: 'job',
    });

    const logs = (await body(
      await get(ctx.app, ctx.tenantA, `/portal/assignments/${assignment.id}/logs`, worker.token),
    )).data;
    expect(logs).toHaveLength(2);
    expect(logs.map((l: any) => l.kind)).toEqual(['status_update', 'status_update']);
    expect(logs[1].body).toBe('all wrapped up');
    expect(logs[1].status).toBe('completed');
  });

  it('work logs keep insertion order even when written within the same millisecond', async () => {
    // Regression: created_at has ms resolution, so rapid writes collide and the
    // random nanoid id tiebreaker used to reorder them. seq keeps them stable.
    const ctx = await setup();
    const { worker } = await twoWorkersAndAManager(ctx);
    const assignment = await makeAssignment(ctx, ctx.tenantA, {
      employeeId: worker.employeeId,
      kind: 'job',
      title: 'Rapid-fire logging',
    });

    const bodies = ['one', 'two', 'three', 'four', 'five', 'six'];
    for (const text of bodies) {
      const res = await post(
        ctx.app,
        ctx.tenantA,
        `/portal/assignments/${assignment.id}/logs`,
        { body: text },
        worker.token,
      );
      expect(res.status).toBe(201);
    }

    const logs = (await body(
      await get(ctx.app, ctx.tenantA, `/portal/assignments/${assignment.id}/logs`, worker.token),
    )).data;
    expect(logs.map((l: any) => l.body)).toEqual(bodies);
    expect(logs.map((l: any) => l.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('workers cannot update another worker\'s assignment status', async () => {
    const ctx = await setup();
    const { worker, other } = await twoWorkersAndAManager(ctx);
    const assignment = await makeAssignment(ctx, ctx.tenantA, {
      employeeId: worker.employeeId,
      kind: 'job',
      title: 'Not yours',
    });
    const res = await post(
      ctx.app,
      ctx.tenantA,
      `/portal/assignments/${assignment.id}/status`,
      { status: 'completed' },
      other.token,
    );
    expect(res.status).toBe(403);
  });

  it('notes: worker on own assignment OK, on another\'s 403; manager comments are manager-only', async () => {
    const ctx = await setup();
    const { worker, other, manager } = await twoWorkersAndAManager(ctx);
    const assignment = await makeAssignment(ctx, ctx.tenantA, {
      employeeId: worker.employeeId,
      kind: 'job',
      title: 'Job with notes',
    });

    // worker note on own assignment
    const note = await post(
      ctx.app,
      ctx.tenantA,
      `/portal/assignments/${assignment.id}/logs`,
      { body: 'gate code is 4321' },
      worker.token,
    );
    expect(note.status).toBe(201);
    expect((await body(note)).data.kind).toBe('note');

    // another worker cannot note on it
    const deniedNote = await post(
      ctx.app,
      ctx.tenantA,
      `/portal/assignments/${assignment.id}/logs`,
      { body: 'sneaky' },
      other.token,
    );
    expect(deniedNote.status).toBe(403);

    // worker cannot post a manager comment (middleware-enforced)
    const deniedComment = await post(
      ctx.app,
      ctx.tenantA,
      `/portal/assignments/${assignment.id}/comments`,
      { body: 'I am not a manager' },
      worker.token,
    );
    expect(deniedComment.status).toBe(403);

    // manager can comment on anyone's assignment
    const comment = await post(
      ctx.app,
      ctx.tenantA,
      `/portal/assignments/${assignment.id}/comments`,
      { body: 'nice work out there' },
      manager.token,
    );
    expect(comment.status).toBe(201);
    expect((await body(comment)).data.kind).toBe('manager_comment');

    const logs = (await body(
      await get(ctx.app, ctx.tenantA, `/portal/assignments/${assignment.id}/logs`, manager.token),
    )).data;
    expect(logs.map((l: any) => l.kind)).toEqual(['note', 'manager_comment']);
  });

  it('photo references: worker attaches file ids to own assignment; others are denied', async () => {
    const ctx = await setup();
    const { worker, other } = await twoWorkersAndAManager(ctx);
    const assignment = await makeAssignment(ctx, ctx.tenantA, {
      employeeId: worker.employeeId,
      kind: 'job',
      title: 'Job with photos',
    });

    const added = await post(
      ctx.app,
      ctx.tenantA,
      `/portal/assignments/${assignment.id}/photos`,
      { fileId: 'file-abc-123', caption: 'after' },
      worker.token,
    );
    expect(added.status).toBe(201);
    expect((await body(added)).data.file_id).toBe('file-abc-123');

    const denied = await post(
      ctx.app,
      ctx.tenantA,
      `/portal/assignments/${assignment.id}/photos`,
      { fileId: 'file-evil' },
      other.token,
    );
    expect(denied.status).toBe(403);

    const listed = await get(
      ctx.app,
      ctx.tenantA,
      `/portal/assignments/${assignment.id}/photos`,
      worker.token,
    );
    const photos = (await body(listed)).data;
    expect(photos).toHaveLength(1);
    expect(photos[0].caption).toBe('after');
  });

  it('tenant isolation: tenant B cannot see or touch tenant A assignments', async () => {
    const ctx = await setup();
    const { worker } = await twoWorkersAndAManager(ctx);
    const assignment = await makeAssignment(ctx, ctx.tenantA, {
      employeeId: worker.employeeId,
      kind: 'job',
      title: 'A-only job',
    });
    const bManager = await makeEmployee(ctx, ctx.tenantB, {
      name: 'B Manager',
      email: 'bm@example.com',
      role: 'manager',
    });

    // back-office surface
    expect((await get(ctx.app, ctx.tenantB, `/assignments/${assignment.id}`)).status).toBe(404);
    expect((await body(await get(ctx.app, ctx.tenantB, '/assignments'))).data).toEqual([]);

    // portal surface — even a manager in tenant B gets 404
    expect(
      (await get(ctx.app, ctx.tenantB, `/portal/assignments/${assignment.id}`, bManager.token)).status,
    ).toBe(404);
    expect(
      (await post(
        ctx.app,
        ctx.tenantB,
        `/portal/assignments/${assignment.id}/status`,
        { status: 'canceled' },
        bManager.token,
      )).status,
    ).toBe(404);

    // A's data untouched
    const still = (await body(await get(ctx.app, ctx.tenantA, `/assignments/${assignment.id}`))).data;
    expect(still.status).toBe('assigned');
  });
});
