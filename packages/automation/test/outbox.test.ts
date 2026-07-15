import { describe, expect, it } from 'vitest';
import type { PlatformEvent } from '@blacklabel/core';
import { listAuditEntries } from '@blacklabel/core';
import { asCoreDb } from '@blacklabel/core';
import {
  OutboxLeaseLostError,
  OutboxService,
  type OutboxLease,
} from '../src/outbox';
import { backoffSeconds } from '../src/backoff';
import { setup } from './helpers';
import { DateTime } from 'luxon';

let leaseSequence = 0;

async function claimLease(outbox: OutboxService, tenantId: string): Promise<OutboxLease> {
  const [row] = await outbox.claimDue(
    tenantId,
    DateTime.utc().plus({ days: 1 }).toISO()!,
    1,
    { leaseOwner: `test-worker-${++leaseSequence}`, leaseSeconds: 60 },
  );
  expect(row).toBeTruthy();
  return {
    owner: row!.lease_owner!,
    token: row!.lease_token,
    expiresAt: row!.lease_expires_at!,
  };
}

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
    const f1 = await outbox.markFailed(
      tenantA.id,
      row.id,
      'boom-1',
      await claimLease(outbox, tenantA.id),
    );
    expect(f1.status).toBe('failed');
    expect(f1.attempts).toBe(1);
    expect(f1.last_error).toBe('boom-1');
    const delay1 = DateTime.fromISO(f1.next_attempt_at).diff(beforeFail1, 'seconds').seconds;
    expect(delay1).toBeGreaterThanOrEqual(backoffSeconds(1) - 2);
    expect(delay1).toBeLessThanOrEqual(backoffSeconds(1) + 2);

    // Attempt 2 fails → still 'failed', attempts 2.
    const f2 = await outbox.markFailed(
      tenantA.id,
      row.id,
      'boom-2',
      await claimLease(outbox, tenantA.id),
    );
    expect(f2.status).toBe('failed');
    expect(f2.attempts).toBe(2);

    // Attempt 3 fails → attempts reach max → 'dead'.
    const seenDead: string[] = [];
    events.on('automation.outbox.dead', (e) => {
      seenDead.push((e.payload as any).outboxId);
    });
    const f3 = await outbox.markFailed(
      tenantA.id,
      row.id,
      'boom-3',
      await claimLease(outbox, tenantA.id),
    );
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
    const dead = await outbox.markFailed(
      tenantA.id,
      row.id,
      'boom',
      await claimLease(outbox, tenantA.id),
    );
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
    expect((await outbox.cancel(tenantA.id, row.id)).status).toBe('canceled');
  });

  it('replay fails atomically when a failed row is claimed after it was read', async () => {
    const { db, events, tenantA } = await setup();
    const regular = new OutboxService(db, events);
    const { row } = await regular.enqueue(tenantA.id, {
      kind: 'k',
      payload: {},
      idempotencyKey: 'replay-race',
      maxAttempts: 3,
    });
    await regular.markFailed(
      tenantA.id,
      row.id,
      'retry me',
      await claimLease(regular, tenantA.id),
    );

    const racing = new OutboxService(db, events);
    const originalGet = racing.get.bind(racing);
    let injectClaim = true;
    racing.get = async (tenantId, outboxId) => {
      const observed = await originalGet(tenantId, outboxId);
      if (injectClaim) {
        injectClaim = false;
        await regular.claimDue(
          tenantA.id,
          DateTime.utc().plus({ days: 1 }).toISO()!,
          1,
          { leaseOwner: 'replay-race-winner', leaseSeconds: 60 },
        );
      }
      return observed;
    };

    await expect(racing.replay(tenantA.id, row.id)).rejects.toMatchObject({ status: 409 });
    expect(await regular.get(tenantA.id, row.id)).toMatchObject({
      status: 'delivering',
      lease_owner: 'replay-race-winner',
    });
  });

  it('cancel fails atomically when a pending row is claimed after it was read', async () => {
    const { db, events, tenantA } = await setup();
    const regular = new OutboxService(db, events);
    const { row } = await regular.enqueue(tenantA.id, {
      kind: 'k',
      payload: {},
      idempotencyKey: 'cancel-race',
    });

    const racing = new OutboxService(db, events);
    const originalGet = racing.get.bind(racing);
    let injectClaim = true;
    racing.get = async (tenantId, outboxId) => {
      const observed = await originalGet(tenantId, outboxId);
      if (injectClaim) {
        injectClaim = false;
        await regular.claimDue(
          tenantA.id,
          DateTime.utc().plus({ days: 1 }).toISO()!,
          1,
          { leaseOwner: 'cancel-race-winner', leaseSeconds: 60 },
        );
      }
      return observed;
    };

    await expect(racing.cancel(tenantA.id, row.id)).rejects.toMatchObject({ status: 409 });
    expect(await regular.get(tenantA.id, row.id)).toMatchObject({
      status: 'delivering',
      lease_owner: 'cancel-race-winner',
    });
  });

  it('claimDue only returns due pending/failed rows and marks them delivering', async () => {
    const { db, events, tenantA } = await setup();
    const outbox = new OutboxService(db, events);
    // A future-scheduled row: enqueue then fail so next_attempt_at moves out ~60s.
    const { row: future } = await outbox.enqueue(tenantA.id, {
      kind: 'k',
      payload: {},
      idempotencyKey: 'future-1',
    });
    await outbox.markFailed(
      tenantA.id,
      future.id,
      'later',
      await claimLease(outbox, tenantA.id),
    ); // next_attempt_at ≈ now + 60s
    await outbox.enqueue(tenantA.id, { kind: 'k', payload: {}, idempotencyKey: 'due-1' });

    // "now" = a moment after enqueue but before the +60s reschedule.
    const now = DateTime.utc().plus({ seconds: 5 }).toISO()!;
    const claimed = await outbox.claimDue(tenantA.id, now, 10);
    expect(claimed.map((c) => c.idempotency_key)).toEqual(['due-1']);
    expect(claimed[0]!.status).toBe('delivering');
  });
});

describe('outbox durable delivery leases', () => {
  const t0 = DateTime.fromISO('2030-01-01T00:00:00.000Z', { zone: 'utc' });

  it('reclaims a crash-stuck delivery after expiry and fences the dead worker', async () => {
    const { db, events, tenantA } = await setup();
    const outbox = new OutboxService(db, events);
    const { row } = await outbox.enqueue(tenantA.id, {
      kind: 'email.send',
      payload: { to: 'a@b.co' },
      idempotencyKey: 'lease-reclaim',
    });

    const first = await outbox.claimDue(tenantA.id, t0.toISO()!, 1, {
      leaseOwner: 'worker-a',
      leaseSeconds: 30,
    });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      status: 'delivering',
      lease_owner: 'worker-a',
      lease_token: 1,
    });

    const beforeExpiry = await outbox.claimDue(
      tenantA.id,
      t0.plus({ seconds: 29 }).toISO()!,
      1,
      { leaseOwner: 'worker-b', leaseSeconds: 30 },
    );
    expect(beforeExpiry).toEqual([]);

    const reclaimed = await outbox.claimDue(
      tenantA.id,
      t0.plus({ seconds: 31 }).toISO()!,
      1,
      { leaseOwner: 'worker-b', leaseSeconds: 30 },
    );
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({
      id: row.id,
      status: 'delivering',
      attempts: 1,
      lease_owner: 'worker-b',
      lease_token: 2,
    });
    expect(reclaimed[0]!.last_error).toContain('delivery lease expired');

    const staleLease: OutboxLease = {
      owner: first[0]!.lease_owner!,
      token: first[0]!.lease_token,
      expiresAt: first[0]!.lease_expires_at!,
    };
    await expect(outbox.markDelivered(tenantA.id, row.id, staleLease)).rejects.toBeInstanceOf(
      OutboxLeaseLostError,
    );
    await expect(
      outbox.markFailed(tenantA.id, row.id, 'stale failure', staleLease),
    ).rejects.toBeInstanceOf(OutboxLeaseLostError);

    const currentLease: OutboxLease = {
      owner: reclaimed[0]!.lease_owner!,
      token: reclaimed[0]!.lease_token,
      expiresAt: reclaimed[0]!.lease_expires_at!,
    };
    const delivered = await outbox.markDelivered(tenantA.id, row.id, currentLease);
    expect(delivered.status).toBe('delivered');
    expect(delivered.lease_owner).toBeNull();
  });

  it('fails closed when a leased delivery transition omits its lease', async () => {
    const { db, events, tenantA } = await setup();
    const outbox = new OutboxService(db, events);
    const { row } = await outbox.enqueue(tenantA.id, {
      kind: 'email.send',
      payload: {},
      idempotencyKey: 'lease-required',
    });
    const [claimed] = await outbox.claimDue(tenantA.id, t0.toISO()!, 1, {
      leaseOwner: 'worker-active',
      leaseSeconds: 30,
    });
    const missing = undefined as unknown as OutboxLease;

    await expect(outbox.markDelivered(tenantA.id, row.id, missing)).rejects.toMatchObject({
      status: 409,
    });
    await expect(outbox.markFailed(tenantA.id, row.id, 'unguarded', missing)).rejects.toMatchObject({
      status: 409,
    });
    expect(await outbox.get(tenantA.id, row.id)).toMatchObject({
      status: 'delivering',
      lease_owner: 'worker-active',
      lease_token: claimed!.lease_token,
      attempts: 0,
    });
  });

  it('rejects cancellation during delivery and after delivery completes', async () => {
    const { db, events, tenantA } = await setup();
    const outbox = new OutboxService(db, events);
    const { row } = await outbox.enqueue(tenantA.id, {
      kind: 'email.send',
      payload: {},
      idempotencyKey: 'cancel-delivery-state',
    });
    const [claimed] = await outbox.claimDue(tenantA.id, t0.toISO()!, 1, {
      leaseOwner: 'worker-cancel-guard',
      leaseSeconds: 30,
    });
    const lease: OutboxLease = {
      owner: claimed!.lease_owner!,
      token: claimed!.lease_token,
      expiresAt: claimed!.lease_expires_at!,
    };

    await expect(outbox.cancel(tenantA.id, row.id)).rejects.toMatchObject({ status: 409 });
    expect(await outbox.get(tenantA.id, row.id)).toMatchObject({
      status: 'delivering',
      lease_owner: 'worker-cancel-guard',
    });

    await outbox.markDelivered(tenantA.id, row.id, lease);
    await expect(outbox.cancel(tenantA.id, row.id)).rejects.toMatchObject({ status: 409 });
    expect((await outbox.get(tenantA.id, row.id))!.status).toBe('delivered');
  });

  it('renews a heartbeat and prevents reclaim until the extended deadline', async () => {
    const { db, events, tenantA } = await setup();
    const outbox = new OutboxService(db, events);
    await outbox.enqueue(tenantA.id, {
      kind: 'email.send',
      payload: {},
      idempotencyKey: 'lease-heartbeat',
    });
    const [claimed] = await outbox.claimDue(tenantA.id, t0.toISO()!, 1, {
      leaseOwner: 'worker-a',
      leaseSeconds: 30,
    });
    const lease: OutboxLease = {
      owner: claimed!.lease_owner!,
      token: claimed!.lease_token,
      expiresAt: claimed!.lease_expires_at!,
    };
    const renewed = await outbox.renewLease(
      tenantA.id,
      claimed!.id,
      lease,
      t0.plus({ seconds: 20 }).toISO()!,
      30,
    );
    expect(renewed.lease_heartbeat_at).toBe(t0.plus({ seconds: 20 }).toISO()!);
    expect(renewed.lease_expires_at).toBe(t0.plus({ seconds: 50 }).toISO()!);

    expect(
      await outbox.claimDue(tenantA.id, t0.plus({ seconds: 31 }).toISO()!, 1, {
        leaseOwner: 'worker-b',
        leaseSeconds: 30,
      }),
    ).toEqual([]);
    expect(
      await outbox.claimDue(tenantA.id, t0.plus({ seconds: 51 }).toISO()!, 1, {
        leaseOwner: 'worker-b',
        leaseSeconds: 30,
      }),
    ).toHaveLength(1);
  });

  it('dead-letters repeated worker death at the existing max-attempt boundary', async () => {
    const { db, events, tenantA } = await setup();
    const outbox = new OutboxService(db, events);
    const { row } = await outbox.enqueue(tenantA.id, {
      kind: 'email.send',
      payload: {},
      idempotencyKey: 'lease-dead',
      maxAttempts: 1,
    });
    await outbox.claimDue(tenantA.id, t0.toISO()!, 1, {
      leaseOwner: 'worker-a',
      leaseSeconds: 10,
    });

    const reclaimed = await outbox.claimDue(
      tenantA.id,
      t0.plus({ seconds: 11 }).toISO()!,
      1,
      { leaseOwner: 'worker-b', leaseSeconds: 10 },
    );
    expect(reclaimed).toEqual([]);
    const dead = await outbox.get(tenantA.id, row.id);
    expect(dead).toMatchObject({ status: 'dead', attempts: 1, lease_owner: null });
    expect(dead!.last_error).toContain('delivery lease expired');
  });
});
