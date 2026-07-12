import { describe, it, expect } from 'vitest';
import * as Q from '../src/queue.mjs';

function mk(id: string, over: Partial<any> = {}) {
  return {
    id,
    url: `/api/inventory/movements`,
    method: 'POST',
    body: { delta: 1 },
    idempotencyKey: `idem-${id}`,
    queuedAt: '2026-07-12T00:00:00.000Z',
    ...over,
  };
}

describe('offline queue reducer', () => {
  it('enqueues in FIFO order and reports pending/synced status', () => {
    let s = Q.initialState();
    expect(Q.syncStatus(s)).toBe('synced');
    s = Q.enqueue(s, mk('a'));
    s = Q.enqueue(s, mk('b'));
    expect(Q.pendingCount(s)).toBe(2);
    expect(Q.syncStatus(s)).toBe('queued');
    expect(Q.nextQueued(s)!.id).toBe('a'); // FIFO
  });

  it('requires id and idempotencyKey', () => {
    const s = Q.initialState();
    expect(() => Q.enqueue(s, { ...mk('x'), idempotencyKey: '' })).toThrow(/idempotencyKey/);
    expect(() => Q.enqueue(s, { ...mk('x'), id: '' })).toThrow(/id/);
  });

  it('marks success by removing the item', () => {
    let s = Q.enqueue(Q.initialState(), mk('a'));
    s = Q.markInflight(s, 'a');
    expect(Q.find(s, 'a')!.state).toBe('inflight');
    expect(Q.find(s, 'a')!.attempts).toBe(1);
    s = Q.markSuccess(s, 'a');
    expect(Q.find(s, 'a')).toBeNull();
    expect(Q.syncStatus(s)).toBe('synced');
  });

  it('a 409 on replay becomes a conflict that is kept, never dropped', () => {
    let s = Q.enqueue(Q.initialState(), mk('a'));
    s = Q.markInflight(s, 'a');
    s = Q.markConflict(s, 'a', { error: { message: 'already applied', code: 'conflict' } });
    expect(Q.pendingCount(s)).toBe(1); // still present
    expect(Q.conflicts(s)).toHaveLength(1);
    expect((Q.conflicts(s)[0].conflict as any).error.code).toBe('conflict');
    expect(Q.syncStatus(s)).toBe('failed'); // surfaces red for review
  });

  it('a transient failure is retryable and re-queues on retry', () => {
    let s = Q.enqueue(Q.initialState(), mk('a'));
    s = Q.markInflight(s, 'a');
    s = Q.markFailure(s, 'a', 'network down');
    expect(Q.find(s, 'a')!.state).toBe('failed');
    expect(Q.syncStatus(s)).toBe('failed');
    s = Q.retry(s, 'a');
    expect(Q.find(s, 'a')!.state).toBe('queued');
    expect(Q.nextQueued(s)!.id).toBe('a');
  });

  it('retryAll re-queues every failed item but leaves conflicts alone', () => {
    let s = Q.initialState();
    s = Q.enqueue(s, mk('a'));
    s = Q.enqueue(s, mk('b'));
    s = Q.markFailure(Q.markInflight(s, 'a'), 'a', 'oops');
    s = Q.markConflict(Q.markInflight(s, 'b'), 'b', { error: { message: 'x' } });
    s = Q.retryAll(s);
    expect(Q.find(s, 'a')!.state).toBe('queued');
    expect(Q.find(s, 'b')!.state).toBe('conflict'); // conflicts need explicit review
  });

  it('counts reflect the mix of states', () => {
    let s = Q.initialState();
    s = Q.enqueue(s, mk('a'));
    s = Q.enqueue(s, mk('b'));
    s = Q.markFailure(Q.markInflight(s, 'b'), 'b', 'x');
    const c = Q.counts(s);
    expect(c.queued).toBe(1);
    expect(c.failed).toBe(1);
  });

  it('replays FIFO across a full success cycle', () => {
    let s = Q.initialState();
    for (const id of ['a', 'b', 'c']) s = Q.enqueue(s, mk(id));
    const order: string[] = [];
    let next;
    while ((next = Q.nextQueued(s))) {
      order.push(next.id);
      s = Q.markSuccess(Q.markInflight(s, next.id), next.id);
    }
    expect(order).toEqual(['a', 'b', 'c']);
    expect(Q.pendingCount(s)).toBe(0);
  });
});
