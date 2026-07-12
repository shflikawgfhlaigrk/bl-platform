import { describe, expect, it } from 'vitest';
import { asCoreDb, listAuditEntries, type PlatformEvent } from '@blacklabel/core';
import { collect, setup } from './helpers';
import {
  addComment,
  assign,
  autoResolveByDedupeKey,
  countsSummary,
  escalate,
  getAction,
  listOverdue,
  listQueue,
  open,
  resolve,
  snooze,
  unsnooze,
  wakeDueSnoozes,
} from '../src/service';

const base = {
  kind: 'stock_below_reorder_point',
  title: 'Stock below reorder point',
  priority: 'p2',
  dedupeKey: 'sbrp:var_1:loc_1',
  evidence: { onHand: 1, reorderPoint: 5 },
} as const;

describe('actions service — open & dedupe', () => {
  it('opens a new action and emits actions.action.created', async () => {
    const { db, events, tenantA } = await setup();
    const created = collect(events, 'actions.action.created');
    const { action, deduped } = await open(db, events, tenantA.id, 'u1', base);
    expect(deduped).toBe(false);
    expect(action.status).toBe('open');
    expect(action.evidence).toEqual({ onHand: 1, reorderPoint: 5 });
    expect(created).toHaveLength(1);
    expect(created[0].payload).toEqual({ v: 1, actionId: action.id, kind: base.kind });
  });

  it('opening the same dedupe_key twice yields ONE action with refreshed evidence', async () => {
    const { db, events, tenantA } = await setup();
    const created = collect(events, 'actions.action.created');
    const first = await open(db, events, tenantA.id, 'u1', base);
    const second = await open(db, events, tenantA.id, 'u1', {
      ...base,
      evidence: { onHand: 0, reorderPoint: 5 },
    });
    expect(second.deduped).toBe(true);
    expect(second.action.id).toBe(first.action.id);
    expect(second.action.evidence).toEqual({ onHand: 0, reorderPoint: 5 });
    // Only the genuine creation emitted a created event.
    expect(created).toHaveLength(1);

    const queue = await listQueue(db, tenantA.id);
    expect(queue).toHaveLength(1);
  });

  it('a RESOLVED action does not block a new action with the same dedupe_key', async () => {
    const { db, events, tenantA } = await setup();
    const first = await open(db, events, tenantA.id, 'u1', base);
    await resolve(db, events, tenantA.id, 'u1', first.action.id, { kind: 'manual' });

    const second = await open(db, events, tenantA.id, 'u1', base);
    expect(second.deduped).toBe(false);
    expect(second.action.id).not.toBe(first.action.id);
    expect(second.action.status).toBe('open');
  });

  it('audits every mutation', async () => {
    const { db, events, tenantA } = await setup();
    const { action } = await open(db, events, tenantA.id, 'u1', base);
    await assign(db, tenantA.id, 'u1', action.id, 'owner_9');
    await escalate(db, tenantA.id, 'u1', action.id, 'p1', 'urgent');
    const entries = await listAuditEntries(asCoreDb(db), tenantA.id, 'actions.action', action.id);
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('actions.action.created');
    expect(actions).toContain('actions.action.assigned');
    expect(actions).toContain('actions.action.escalated');
  });
});

describe('actions service — resolve & auto-resolve', () => {
  it('resolve writes proof + emits actions.action.resolved', async () => {
    const { db, events, tenantA } = await setup();
    const resolved: PlatformEvent[] = collect(events, 'actions.action.resolved');
    const { action } = await open(db, events, tenantA.id, 'u1', base);
    const done = await resolve(db, events, tenantA.id, 'u1', action.id, {
      kind: 'manual',
      proof: { note: 'restocked' },
    });
    expect(done.status).toBe('resolved');
    expect(done.resolution_kind).toBe('manual');
    expect(done.resolution_proof).toEqual({ note: 'restocked' });
    expect(done.resolved_at).not.toBeNull();
    expect(resolved).toHaveLength(1);
    expect(resolved[0].payload).toEqual({ v: 1, actionId: action.id });
  });

  it('autoResolveByDedupeKey resolves the active action and no-ops when none', async () => {
    const { db, events, tenantA } = await setup();
    const { action } = await open(db, events, tenantA.id, 'u1', base);
    const done = await autoResolveByDedupeKey(db, events, tenantA.id, 'system', base.dedupeKey, {
      via: 'test',
    });
    expect(done?.id).toBe(action.id);
    expect(done?.resolution_kind).toBe('auto');

    // Second call: nothing active → undefined (replay-safe).
    const again = await autoResolveByDedupeKey(db, events, tenantA.id, 'system', base.dedupeKey);
    expect(again).toBeUndefined();
  });
});

describe('actions service — snooze / wake / escalate', () => {
  it('snooze requires a reason', async () => {
    const { db, events, tenantA } = await setup();
    const { action } = await open(db, events, tenantA.id, 'u1', base);
    await expect(
      snooze(db, tenantA.id, 'u1', action.id, '2026-07-13T00:00:00.000Z', '   '),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('snooze then wake-due transitions back to open only when due', async () => {
    const { db, events, tenantA } = await setup();
    const { action } = await open(db, events, tenantA.id, 'u1', base);
    const snoozed = await snooze(
      db,
      tenantA.id,
      'u1',
      action.id,
      '2026-07-13T00:00:00.000Z',
      'waiting on delivery',
    );
    expect(snoozed.status).toBe('snoozed');

    // Not yet due → no wake.
    const early = await wakeDueSnoozes(db, tenantA.id, 'system', '2026-07-12T00:00:00.000Z');
    expect(early).toHaveLength(0);

    // Due → woken back to open, snooze cleared.
    const woke = await wakeDueSnoozes(db, tenantA.id, 'system', '2026-07-14T00:00:00.000Z');
    expect(woke).toHaveLength(1);
    expect(woke[0].id).toBe(action.id);
    expect(woke[0].status).toBe('open');
    expect(woke[0].snoozed_until).toBeNull();
  });

  it('unsnooze restores an open action', async () => {
    const { db, events, tenantA } = await setup();
    const { action } = await open(db, events, tenantA.id, 'u1', base);
    await snooze(db, tenantA.id, 'u1', action.id, '2026-07-13T00:00:00.000Z', 'later');
    const back = await unsnooze(db, tenantA.id, 'u1', action.id);
    expect(back.status).toBe('open');
  });

  it('escalation bumps priority, sets escalated status, and records history', async () => {
    const { db, events, tenantA } = await setup();
    const { action } = await open(db, events, tenantA.id, 'u1', base);
    const esc = await escalate(db, tenantA.id, 'u1', action.id, 'p1', 'floor is out of stock');
    expect(esc.priority).toBe('p1');
    expect(esc.status).toBe('escalated');

    const detail = await getAction(db, tenantA.id, action.id);
    expect(detail.escalations).toHaveLength(1);
    expect(detail.escalations[0]).toMatchObject({
      from_priority: 'p2',
      to_priority: 'p1',
      reason: 'floor is out of stock',
    });
  });
});

describe('actions service — comments, queue ordering, counts', () => {
  it('comment attaches to the action and shows in detail', async () => {
    const { db, events, tenantA } = await setup();
    const { action } = await open(db, events, tenantA.id, 'u1', base);
    await addComment(db, tenantA.id, 'u1', action.id, 'u1', 'looking into it');
    const detail = await getAction(db, tenantA.id, action.id);
    expect(detail.comments).toHaveLength(1);
    expect(detail.comments[0].body).toBe('looking into it');
  });

  it('queue is ordered by (priority, due_at, created_at, id)', async () => {
    const { db, events, tenantA } = await setup();
    await open(db, events, tenantA.id, 'u1', {
      kind: 'payout_mismatch',
      title: 'p3 later-due',
      priority: 'p3',
      dedupeKey: 'k_a',
      dueAt: '2026-07-20T00:00:00.000Z',
    });
    await open(db, events, tenantA.id, 'u1', {
      kind: 'payout_mismatch',
      title: 'p1 urgent',
      priority: 'p1',
      dedupeKey: 'k_b',
      dueAt: '2026-07-19T00:00:00.000Z',
    });
    await open(db, events, tenantA.id, 'u1', {
      kind: 'payout_mismatch',
      title: 'p3 earlier-due',
      priority: 'p3',
      dedupeKey: 'k_c',
      dueAt: '2026-07-15T00:00:00.000Z',
    });
    const queue = await listQueue(db, tenantA.id);
    expect(queue.map((a) => a.title)).toEqual(['p1 urgent', 'p3 earlier-due', 'p3 later-due']);
  });

  it('overdue lists only active actions past due_at', async () => {
    const { db, events, tenantA } = await setup();
    await open(db, events, tenantA.id, 'u1', {
      ...base,
      dedupeKey: 'k_overdue',
      dueAt: '2026-07-01T00:00:00.000Z',
    });
    await open(db, events, tenantA.id, 'u1', {
      ...base,
      dedupeKey: 'k_future',
      dueAt: '2026-08-01T00:00:00.000Z',
    });
    const overdue = await listOverdue(db, tenantA.id, '2026-07-12T00:00:00.000Z');
    expect(overdue).toHaveLength(1);
    expect(overdue[0].dedupe_key).toBe('k_overdue');
  });

  it('counts summary groups active actions by kind and priority', async () => {
    const { db, events, tenantA } = await setup();
    await open(db, events, tenantA.id, 'u1', { ...base, dedupeKey: 'k1', priority: 'p1' });
    await open(db, events, tenantA.id, 'u1', {
      kind: 'po_awaiting_approval',
      title: 'PO',
      priority: 'p2',
      dedupeKey: 'k2',
    });
    const { action } = await open(db, events, tenantA.id, 'u1', {
      kind: 'po_awaiting_approval',
      title: 'PO2',
      priority: 'p2',
      dedupeKey: 'k3',
    });
    await resolve(db, events, tenantA.id, 'u1', action.id, { kind: 'manual' });

    const counts = await countsSummary(db, tenantA.id);
    expect(counts.total).toBe(2); // resolved one excluded
    expect(counts.byKind).toEqual({ stock_below_reorder_point: 1, po_awaiting_approval: 1 });
    expect(counts.byPriority).toEqual({ p1: 1, p2: 1 });
  });
});

describe('actions service — tenant isolation', () => {
  it('tenant B cannot see, resolve, or snooze tenant A actions', async () => {
    const { db, events, tenantA, tenantB } = await setup();
    const { action } = await open(db, events, tenantA.id, 'u1', base);

    expect(await listQueue(db, tenantB.id)).toEqual([]);
    await expect(getAction(db, tenantB.id, action.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      resolve(db, events, tenantB.id, 'x', action.id, { kind: 'manual' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      snooze(db, tenantB.id, 'x', action.id, '2026-07-13T00:00:00.000Z', 'r'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(assign(db, tenantB.id, 'x', action.id, 'o')).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      escalate(db, tenantB.id, 'x', action.id, 'p1', 'r'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      addComment(db, tenantB.id, 'x', action.id, 'x', 'hi'),
    ).rejects.toMatchObject({ status: 404 });

    // A's action untouched.
    const stillA = await getAction(db, tenantA.id, action.id);
    expect(stillA.action.status).toBe('open');
  });

  it('the same dedupe_key lives independently in two tenants', async () => {
    const { db, events, tenantA, tenantB } = await setup();
    const a = await open(db, events, tenantA.id, 'u1', base);
    const b = await open(db, events, tenantB.id, 'u1', base);
    expect(b.deduped).toBe(false);
    expect(b.action.id).not.toBe(a.action.id);
  });
});
