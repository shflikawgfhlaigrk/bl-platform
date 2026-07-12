import { describe, expect, it } from 'vitest';
import type { PlatformEvent } from '@blacklabel/core';
import { asCoreDb, listAuditEntries } from '@blacklabel/core';
import { body, del, get, makeUser, patch, post, setup } from './helpers';

const T = (h: number) => `2026-08-01T${String(h).padStart(2, '0')}:00:00.000Z`;

describe('workforce scheduling', () => {
  it('creates a draft schedule (no conflict check while unpublished)', async () => {
    const ctx = await setup();
    const u = await makeUser(ctx, ctx.tenantA, { name: 'U', email: 'u@a.com' });
    const a = await post(ctx, ctx.tenantA, '/schedules', {
      userId: u,
      startsAt: T(9),
      endsAt: T(17),
      kind: 'shop',
    });
    expect(a.status).toBe(201);
    // A second overlapping DRAFT is fine — drafts don't conflict.
    const b = await post(ctx, ctx.tenantA, '/schedules', {
      userId: u,
      startsAt: T(10),
      endsAt: T(12),
      kind: 'shop',
    });
    expect(b.status).toBe(201);
  });

  it('published overlap for the same user is a 409 with the conflicting ids', async () => {
    const ctx = await setup();
    const u = await makeUser(ctx, ctx.tenantA, { name: 'U', email: 'u@a.com' });
    const first = (await body(
      await post(ctx, ctx.tenantA, '/schedules', {
        userId: u,
        startsAt: T(9),
        endsAt: T(17),
        kind: 'shop',
        published: true,
      }),
    )).data;

    const res = await post(ctx, ctx.tenantA, '/schedules', {
      userId: u,
      startsAt: T(12),
      endsAt: T(20),
      kind: 'show',
      published: true,
    });
    expect(res.status).toBe(409);
    const env = await body(res);
    expect(env.error.code).toBe('conflict');
    expect(env.error.details.conflictingScheduleIds).toContain(first.id);
  });

  it('exact boundary (end == next start) is NOT a conflict', async () => {
    const ctx = await setup();
    const u = await makeUser(ctx, ctx.tenantA, { name: 'U', email: 'u@a.com' });
    await post(ctx, ctx.tenantA, '/schedules', {
      userId: u,
      startsAt: T(9),
      endsAt: T(13),
      kind: 'shop',
      published: true,
    });
    const adjacent = await post(ctx, ctx.tenantA, '/schedules', {
      userId: u,
      startsAt: T(13), // starts exactly when the previous ends
      endsAt: T(17),
      kind: 'shop',
      published: true,
    });
    expect(adjacent.status).toBe(201);
  });

  it('a DIFFERENT user overlapping is allowed', async () => {
    const ctx = await setup();
    const u1 = await makeUser(ctx, ctx.tenantA, { name: 'U1', email: 'u1@a.com' });
    const u2 = await makeUser(ctx, ctx.tenantA, { name: 'U2', email: 'u2@a.com' });
    await post(ctx, ctx.tenantA, '/schedules', {
      userId: u1,
      startsAt: T(9),
      endsAt: T(17),
      kind: 'shop',
      published: true,
    });
    const other = await post(ctx, ctx.tenantA, '/schedules', {
      userId: u2,
      startsAt: T(9),
      endsAt: T(17),
      kind: 'shop',
      published: true,
    });
    expect(other.status).toBe(201);
  });

  it('override flag allows a conflicting publish and RECORDS overridden=true + emits event', async () => {
    const ctx = await setup();
    const u = await makeUser(ctx, ctx.tenantA, { name: 'U', email: 'u@a.com' });
    const events: PlatformEvent<any>[] = [];
    ctx.events.on('workforce.schedule.published', (e) => {
      events.push(e);
    });

    await post(ctx, ctx.tenantA, '/schedules', {
      userId: u,
      startsAt: T(9),
      endsAt: T(17),
      kind: 'shop',
      published: true,
    });
    const overridden = (await body(
      await post(ctx, ctx.tenantA, '/schedules', {
        userId: u,
        startsAt: T(12),
        endsAt: T(20),
        kind: 'show',
        published: true,
        override: true,
      }),
    )).data;
    expect(overridden.overridden).toBe(true);
    expect(overridden.published).toBe(true);

    // Two published-emit events (v:1, one carries overridden true).
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.payload.v === 1)).toBe(true);
    expect(events.some((e) => e.payload.overridden === true)).toBe(true);
  });

  it('publish an existing draft runs the conflict check; override recorded', async () => {
    const ctx = await setup();
    const u = await makeUser(ctx, ctx.tenantA, { name: 'U', email: 'u@a.com' });
    await post(ctx, ctx.tenantA, '/schedules', {
      userId: u,
      startsAt: T(9),
      endsAt: T(17),
      kind: 'shop',
      published: true,
    });
    const draft = (await body(
      await post(ctx, ctx.tenantA, '/schedules', {
        userId: u,
        startsAt: T(10),
        endsAt: T(14),
        kind: 'shop',
      }),
    )).data;

    const blocked = await post(ctx, ctx.tenantA, `/schedules/${draft.id}/publish`, {});
    expect(blocked.status).toBe(409);

    const forced = await post(ctx, ctx.tenantA, `/schedules/${draft.id}/publish`, { override: true });
    expect(forced.status).toBe(200);
    expect((await body(forced)).data.overridden).toBe(true);
  });

  it('list filters by user + published; update + delete audited; tenant isolation', async () => {
    const ctx = await setup();
    const u = await makeUser(ctx, ctx.tenantA, { name: 'U', email: 'u@a.com' });
    const s = (await body(
      await post(ctx, ctx.tenantA, '/schedules', {
        userId: u,
        startsAt: T(9),
        endsAt: T(17),
        kind: 'shop',
      }),
    )).data;

    const listed = (await body(await get(ctx, ctx.tenantA, `/schedules?userId=${u}`))).data;
    expect(listed).toHaveLength(1);

    // Tenant B sees nothing and gets 404 on the row.
    expect((await body(await get(ctx, ctx.tenantB, `/schedules?userId=${u}`))).data).toEqual([]);
    expect((await get(ctx, ctx.tenantB, `/schedules/${s.id}`)).status).toBe(404);
    expect((await del(ctx, ctx.tenantB, `/schedules/${s.id}`)).status).toBe(404);

    const upd = await patch(ctx, ctx.tenantA, `/schedules/${s.id}`, { note: 'bring dollies' });
    expect((await body(upd)).data.note).toBe('bring dollies');

    const removed = await del(ctx, ctx.tenantA, `/schedules/${s.id}`);
    expect(removed.status).toBe(200);
    expect((await get(ctx, ctx.tenantA, `/schedules/${s.id}`)).status).toBe(404);

    const audits = await listAuditEntries(asCoreDb(ctx.db), ctx.tenantA, 'workforce.schedule', s.id);
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('workforce.schedule.created');
    expect(actions).toContain('workforce.schedule.updated');
    expect(actions).toContain('workforce.schedule.deleted');
  });

  it('rejects endsAt <= startsAt (400)', async () => {
    const ctx = await setup();
    const u = await makeUser(ctx, ctx.tenantA, { name: 'U', email: 'u@a.com' });
    const res = await post(ctx, ctx.tenantA, '/schedules', {
      userId: u,
      startsAt: T(17),
      endsAt: T(9),
      kind: 'shop',
    });
    expect(res.status).toBe(400);
  });
});
