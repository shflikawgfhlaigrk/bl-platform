import { describe, expect, it } from 'vitest';
import {
  addCountLine,
  applyMovement,
  approveCountLine,
  closeCountSession,
  createLocation,
  getStock,
  listCountLines,
  openCountSession,
  recordCount,
  recordRecount,
  setCountSessionStatus,
  verifyConservation,
} from '../src/service';
import { capture, setup } from './helpers';

async function seededSession(opts: { blind?: boolean; recountThreshold?: number } = {}) {
  const s = await setup();
  const loc = await createLocation(s.db, s.tenantA.id, 'system', { name: 'WH', kind: 'warehouse' });
  await applyMovement(s.db, s.events, s.tenantA.id, 'u1', {
    variationId: 'v1',
    locationId: loc.id,
    delta: 10,
    reason: 'received',
  });
  const session = await openCountSession(s.db, s.tenantA.id, 'u1', {
    locationId: loc.id,
    kind: 'full',
    blind: opts.blind,
    recountThreshold: opts.recountThreshold ?? 0,
  });
  return { ...s, loc, session };
}

describe('count sessions', () => {
  it('blind session hides expected_qty until review', async () => {
    const { db, tenantA, session } = await seededSession({ blind: true });
    const line = await addCountLine(db, tenantA.id, 'u1', session.id, 'v1');
    expect(line.expected_qty).toBe(10); // stored snapshot

    let lines = await listCountLines(db, tenantA.id, session.id);
    expect(lines[0].expected_qty).toBeNull(); // hidden while blind + open

    await setCountSessionStatus(db, tenantA.id, 'u1', session.id, 'review');
    lines = await listCountLines(db, tenantA.id, session.id);
    expect(lines[0].expected_qty).toBe(10); // revealed at review
  });

  it('recount_required when |variance| > threshold', async () => {
    const { db, tenantA, session } = await seededSession({ recountThreshold: 1 });
    const line = await addCountLine(db, tenantA.id, 'u1', session.id, 'v1');
    const counted = await recordCount(db, tenantA.id, 'u1', session.id, line.id, 7); // variance -3, > 1
    expect(counted.variance).toBe(-3);
    expect(counted.recount_required).toBe(1);
  });

  it('close requires sign-off', async () => {
    const { db, events, tenantA, session } = await seededSession();
    const line = await addCountLine(db, tenantA.id, 'u1', session.id, 'v1');
    await recordCount(db, tenantA.id, 'u1', session.id, line.id, 10);
    await expect(
      closeCountSession(db, events, tenantA.id, 'u1', session.id, ''),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('close requires variance lines approved or recounted', async () => {
    const { db, events, tenantA, session } = await seededSession({ recountThreshold: 0 });
    const line = await addCountLine(db, tenantA.id, 'u1', session.id, 'v1');
    await recordCount(db, tenantA.id, 'u1', session.id, line.id, 8); // variance -2, unapproved
    await expect(
      closeCountSession(db, events, tenantA.id, 'u1', session.id, 'manager'),
    ).rejects.toMatchObject({ status: 409 });
    await approveCountLine(db, tenantA.id, 'u1', session.id, line.id);
    const res = await closeCountSession(db, events, tenantA.id, 'u1', session.id, 'manager');
    expect(res.session.status).toBe('closed');
    expect(res.session.signed_by).toBe('manager');
  });

  it('closing writes counted movements atomically and emits inventory.count.completed', async () => {
    const { db, events, tenantA, loc, session } = await seededSession({ recountThreshold: 5 });
    const line = await addCountLine(db, tenantA.id, 'u1', session.id, 'v1');
    await recordCount(db, tenantA.id, 'u1', session.id, line.id, 8); // variance -2, within threshold
    const completed = capture(events, 'inventory.count.completed');
    const res = await closeCountSession(db, events, tenantA.id, 'u1', session.id, 'manager');
    expect(res.movementsWritten).toBe(1);

    const [stock] = await getStock(db, tenantA.id, { variationId: 'v1' });
    expect(stock.onHand).toBe(8); // reconciled to counted
    expect(stock.countedEver).toBe(true);

    expect(completed).toHaveLength(1);
    expect(completed[0].payload).toEqual({ v: 1, countSessionId: session.id, locationId: loc.id });

    const report = await verifyConservation(db, tenantA.id);
    expect(report.ok).toBe(true);
  });

  it('recount value drives the counted movement at close', async () => {
    const { db, events, tenantA, session } = await seededSession({ recountThreshold: 1 });
    const line = await addCountLine(db, tenantA.id, 'u1', session.id, 'v1');
    await recordCount(db, tenantA.id, 'u1', session.id, line.id, 3); // variance -7 → recount required
    await recordRecount(db, tenantA.id, 'u1', session.id, line.id, 9); // recounted to 9
    const res = await closeCountSession(db, events, tenantA.id, 'u1', session.id, 'manager');
    expect(res.session.status).toBe('closed');
    const [stock] = await getStock(db, tenantA.id, { variationId: 'v1' });
    expect(stock.onHand).toBe(9);
  });
});
