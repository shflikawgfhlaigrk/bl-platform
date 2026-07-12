import { describe, expect, it } from 'vitest';
import type { PlatformEvent } from '@blacklabel/core';
import { listAuditEntries } from '@blacklabel/core';
import { asCoreDb } from '@blacklabel/core';
import { OutboxService } from '../src/outbox';
import { backoffSeconds } from '../src/backoff';
import { setup } from './helpers';
import { DateTime } from 'luxon';

describe('outbox idempotency', () => {
  it('enqueue with the same key twice returns one row (never a second)', async () => {
    const { db, events, tenantA } = await setup();
    const outbox = new OutboxService(db, events);

    const first = await outbox.enqueue(tenantA.id, {
      kind: 'outreach.send',
      payload: { to: 'a@b.co' },
      idempotencyKey: 'k1',
    });
    expect(first.created).toBe(true);

    const second = await outbox.enqueue(tenantA.id, {
      kind: 'outreach.send',
      payload: { to: 'DIFFERENT' },
      idempotencyKey: 'k1',
    });
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    // Original payload preserved — the duplicate did NOT overwrite.
    expect(JSON.parse(second.row.payload)).toEqual({ to: 'a@b.co' });

    const all = await db
      .selectFrom('automation_outbox')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .execute();
    expect(all).toHaveLength(1);
  });

  it('emits automation.outbox.enqueued once (not on the duplicate) with a 3-segment name', async () => {
    const { db, events, tenantA } = await setup();
    const outbox = new OutboxService(db, events);
    const seen: PlatformEvent[] = [];
    events.on('automation.outbox.enqueued', (e) => {
      seen.push(e);
    });
    await outbox.enqueue(tenantA.id, { kind: 'k', payload: {}, idempotencyKey: 'dup' });
    await outbox.enqueue(tenantA.id, { kind: 'k', payload: {}, idempotencyKey: 'dup' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.type.split('.')).toHaveLength(3);
    expect(seen[0]!.payload).toMatchObject({ v: 1, kind: 'k' });
  });

  it('writes an audit row on enqueue', async () => {
    const { db, events, tenantA } = await setup();
    const outbox = new OutboxService(db, events);
    const { row } = await outbox.enqueue(tenantA.id, { kind: 'k', payload: {}, idempotencyKey: 'a1' });
    const audits = await listAuditEntries(asCoreDb(db), tenantA.id, 'automation.outbox', row.id);
    expect(audits.map((a) => a.action)).toContain('automation.outbox.enqueued');
  });
});

describe('outbox backoff + dead-letter + replay', () => {
  it('reschedules with the documented backoff, then dead-letters at max_attempts', async () => {
    const { db, events, tenantA } = await setup();
    const outbox = new OutboxService(db, events);
    const { row } = await outbox.enqueue(tenantA.id, {
      kind: 'k',
      payload: {},
      idempotencyKey: 'm1',
      maxAttempts: 3,
    });

    // Attempt 1 fails → status 'failed', next_attempt_at ≈ now + 60s.
    const beforeFail1 = DateTime.utc();
    const f1 = await outbox.markFailed(tenantA.id, row.id, 'boom-1');
    expect(f1.status).toBe('failed');
    expect(f1.attempts).toBe(1);
    expect(f1.last_error).toBe('boom-1');
    const delay1 = DateTime.fromISO(f1.next_attempt_at).diff(beforeFail1, 'seconds').seconds;
    expect(delay1).toBeGreaterThanOrEqual(backoffSeconds(1) - 2);
    expect(delay1).toBeLessThanOrEqual(backoffSeconds(1) + 2);

    // Attempt 2 fails → still 'failed', attempts 2.
    const f2 = await outbox.markFailed(tenantA.id, row.id, 'boom-2');
    expect(f2.status).toBe('failed');
    expect(f2.attempts).toBe(2);

    // Attempt 3 fails → attempts reach max → 'dead'.
    const seenDead: string[] = [];
    events.on('automation.outbox.dead', (e) => {
      seenDead.push((e.payload as any).outboxId);
    });
    const f3 = await outbox.markFailed(tenantA.id, row.id, 'boom-3');
    expect(f3.status).toBe('dead');
    expect(f3.attempts).toBe(3);
    expect(seenDead).toContain(row.id);

    // Dead-letter list contains it.
    const dead = await outbox.listDead(tenantA.id);
    expect(dead.map((d) => d.id)).toContain(row.id);
  });

  it('replay resets a dead row to pending (attempts=0) and preserves the prior count in audit', async () => {
    const { db, events, tenantA } = await setup();
    const outbox = new OutboxService(db, events);
    const { row } = await outbox.enqueue(tenantA.id, {
      kind: 'k',
      payload: {},
      idempotencyKey: 'r1',
      maxAttempts: 1,
    });
    const dead = await outbox.markFailed(tenantA.id, row.id, 'boom');
    expect(dead.status).toBe('dead');

    const replayed = await outbox.replay(tenantA.id, row.id);
    expect(replayed.status).toBe('pending');
    expect(replayed.attempts).toBe(0);
    expect(replayed.last_error).toBeNull();

    const audits = await listAuditEntries(asCoreDb(db), tenantA.id, 'automation.outbox', row.id);
    const replayAudit = audits.find((a) => a.action === 'automation.outbox.replayed');
    expect(replayAudit).toBeTruthy();
    expect(JSON.parse(replayAudit!.diff as string).prior_attempts).toBe(1);
  });

  it('cancel stops delivery; a canceled row is not claimed', async () => {
    const { db, events, tenantA } = await setup();
    const outbox = new OutboxService(db, events);
    const { row } = await outbox.enqueue(tenantA.id, { kind: 'k', payload: {}, idempotencyKey: 'c1' });
    await outbox.cancel(tenantA.id, row.id);
    const claimed = await outbox.claimDue(tenantA.id, DateTime.utc().plus({ days: 1 }).toISO()!, 10);
    expect(claimed).toHaveLength(0);
  });

  it('claimDue only returns due pending/failed rows and marks them delivering', async () => {
    const { db, events, tenantA } = await setup();
    const outbox = new OutboxService(db, events);
    await outbox.enqueue(tenantA.id, { kind: 'k', payload: {}, idempotencyKey: 'due-1' });
    // A future-scheduled row: enqueue then fail so next_attempt_at moves out ~60s.
    const { row: future } = await outbox.enqueue(tenantA.id, {
      kind: 'k',
      payload: {},
      idempotencyKey: 'future-1',
    });
    await outbox.markFailed(tenantA.id, future.id, 'later'); // next_attempt_at ≈ now + 60s

    // "now" = a moment after enqueue but before the +60s reschedule.
    const now = DateTime.utc().plus({ seconds: 5 }).toISO()!;
    const claimed = await outbox.claimDue(tenantA.id, now, 10);
    expect(claimed.map((c) => c.idempotency_key)).toEqual(['due-1']);
    expect(claimed[0]!.status).toBe('delivering');
  });
});
