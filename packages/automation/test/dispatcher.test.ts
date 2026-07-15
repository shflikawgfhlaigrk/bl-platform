import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { OutboxService } from '../src/outbox';
import { DispatcherRegistry, runOnce } from '../src/dispatcher';
import { setup } from './helpers';

const future = () => DateTime.utc().plus({ minutes: 1 }).toISO()!;

describe('dispatcher runOnce', () => {
  it('delivers a due row through its registered handler', async () => {
    const { db, events, tenantA } = await setup();
    const outbox = new OutboxService(db, events);
    const delivered: unknown[] = [];
    const registry = new DispatcherRegistry().register('email.send', (job) => {
      delivered.push(job.payload);
    });
    await outbox.enqueue(tenantA.id, {
      kind: 'email.send',
      payload: { to: 'a@b.co' },
      idempotencyKey: 'j1',
    });

    const result = await runOnce(db, registry, tenantA.id, future(), 50, events);
    expect(result.claimed).toBe(1);
    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(0);
    expect(delivered).toEqual([{ to: 'a@b.co' }]);

    const row = await outbox.get(tenantA.id, (await outbox.list(tenantA.id))[0]!.id);
    expect(row!.status).toBe('delivered');
    expect(row!.delivered_at).toBeTruthy();
  });

  it('isolates a throwing handler: that row fails, the drain continues', async () => {
    const { db, events, tenantA } = await setup();
    const outbox = new OutboxService(db, events);
    const okDelivered: string[] = [];
    const registry = new DispatcherRegistry()
      .register('bad.kind', () => {
        throw new Error('handler exploded');
      })
      .register('good.kind', (job) => {
        okDelivered.push(job.id);
      });

    await outbox.enqueue(tenantA.id, { kind: 'bad.kind', payload: {}, idempotencyKey: 'bad' });
    await outbox.enqueue(tenantA.id, { kind: 'good.kind', payload: {}, idempotencyKey: 'good' });

    const result = await runOnce(db, registry, tenantA.id, future(), 50, events);
    expect(result.claimed).toBe(2);
    expect(result.delivered).toBe(1); // the good one survived
    expect(result.failed).toBe(1); // the bad one failed, drain not broken
    expect(okDelivered).toHaveLength(1);

    const bad = (await outbox.list(tenantA.id, { status: 'failed' }))[0];
    expect(bad!.kind).toBe('bad.kind');
    expect(bad!.last_error).toContain('handler exploded');
  });

  it('marks a row with no registered handler as failed (noHandler counted)', async () => {
    const { db, events, tenantA } = await setup();
    const outbox = new OutboxService(db, events);
    const registry = new DispatcherRegistry();
    await outbox.enqueue(tenantA.id, { kind: 'unhandled.kind', payload: {}, idempotencyKey: 'n1' });
    const result = await runOnce(db, registry, tenantA.id, future(), 50, events);
    expect(result.noHandler).toBe(1);
    expect(result.failed).toBe(1);
    const row = (await outbox.list(tenantA.id))[0];
    expect(row!.last_error).toContain('no handler registered');
  });

  it('a delivered row is not re-claimed on the next run', async () => {
    const { db, events, tenantA } = await setup();
    const outbox = new OutboxService(db, events);
    const registry = new DispatcherRegistry().register('k', () => {});
    await outbox.enqueue(tenantA.id, { kind: 'k', payload: {}, idempotencyKey: 'once' });
    const first = await runOnce(db, registry, tenantA.id, future(), 50, events);
    expect(first.delivered).toBe(1);
    const second = await runOnce(db, registry, tenantA.id, future(), 50, events);
    expect(second.claimed).toBe(0);
  });

  it('allows only one concurrent worker to deliver the same idempotency key', async () => {
    const { db, events, tenantA } = await setup();
    const outbox = new OutboxService(db, events);
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const deliveries: string[] = [];
    const registry = new DispatcherRegistry().register('email.send', async (job) => {
      deliveries.push(job.idempotencyKey);
      started();
      await waiting;
    });
    await outbox.enqueue(tenantA.id, {
      kind: 'email.send',
      payload: {},
      idempotencyKey: 'provider-key-1',
    });

    const firstRun = runOnce(db, registry, tenantA.id, future(), 50, events, {
      workerId: 'worker-a',
      leaseSeconds: 60,
    });
    await didStart;
    const secondRun = await runOnce(db, registry, tenantA.id, future(), 50, events, {
      workerId: 'worker-b',
      leaseSeconds: 60,
    });
    expect(secondRun.claimed).toBe(0);
    release();
    const firstResult = await firstRun;
    expect(firstResult.delivered).toBe(1);
    expect(deliveries).toEqual(['provider-key-1']);
  });

  it('passes the fencing token and an explicit heartbeat to handlers', async () => {
    const { db, events, tenantA } = await setup();
    const outbox = new OutboxService(db, events);
    let observed: { owner: string; token: number } | undefined;
    const registry = new DispatcherRegistry().register('long.job', async (job) => {
      observed = { owner: job.leaseOwner, token: job.leaseToken };
      await job.heartbeat();
    });
    await outbox.enqueue(tenantA.id, {
      kind: 'long.job',
      payload: {},
      idempotencyKey: 'heartbeat-job',
    });

    const result = await runOnce(db, registry, tenantA.id, future(), 50, events, {
      workerId: 'worker-heartbeat',
      leaseSeconds: 60,
    });
    expect(result.delivered).toBe(1);
    expect(result.leaseLost).toBe(0);
    expect(observed).toEqual({ owner: 'worker-heartbeat', token: 1 });
  });

  it('surfaces a crash-recovered dead letter even when no row is claimed', async () => {
    const { db, events, tenantA } = await setup();
    const outbox = new OutboxService(db, events);
    const registry = new DispatcherRegistry();
    const t0 = DateTime.fromISO('2030-01-01T00:00:00.000Z', { zone: 'utc' });
    const { row } = await outbox.enqueue(tenantA.id, {
      kind: 'email.send',
      payload: {},
      idempotencyKey: 'dead-recovery-result',
      maxAttempts: 1,
    });
    await outbox.claimDue(tenantA.id, t0.toISO()!, 1, {
      leaseOwner: 'worker-that-died',
      leaseSeconds: 10,
    });

    const result = await runOnce(
      db,
      registry,
      tenantA.id,
      t0.plus({ seconds: 11 }).toISO()!,
      50,
      events,
      { workerId: 'recovery-worker', leaseSeconds: 10 },
    );
    expect(result).toMatchObject({ claimed: 0, delivered: 0, failed: 0, dead: 1 });
    expect(await outbox.get(tenantA.id, row.id)).toMatchObject({
      status: 'dead',
      attempts: 1,
    });
  });
});
