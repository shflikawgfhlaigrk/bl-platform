import { describe, expect, it } from 'vitest';
import {
  applyMovement,
  closeTransfer,
  createLocation,
  createTransfer,
  getStock,
  receiveTransfer,
  shipTransfer,
  verifyConservation,
} from '../src/service';
import { capture, setup } from './helpers';

async function seedTwoLocations() {
  const s = await setup();
  const from = await createLocation(s.db, s.tenantA.id, 'system', { name: 'WH', kind: 'warehouse' });
  const to = await createLocation(s.db, s.tenantA.id, 'system', { name: 'Trailer', kind: 'trailer' });
  await applyMovement(s.db, s.events, s.tenantA.id, 'u1', {
    variationId: 'v1',
    locationId: from.id,
    delta: 10,
    reason: 'received',
  });
  return { ...s, from, to };
}

describe('transfers', () => {
  it('ship then receive moves stock between locations (journey 5)', async () => {
    const { db, events, tenantA, from, to } = await seedTwoLocations();
    const { transfer, lines } = await createTransfer(db, tenantA.id, 'u1', from.id, to.id, [
      { variationId: 'v1', qtySent: 3 },
    ]);
    await shipTransfer(db, events, tenantA.id, 'u1', transfer.id);
    let stock = await getStock(db, tenantA.id, { variationId: 'v1', locationId: from.id });
    expect(stock[0].onHand).toBe(7);

    await receiveTransfer(db, events, tenantA.id, 'u1', transfer.id, [{ lineId: lines[0].id, qtyReceived: 3 }]);
    stock = await getStock(db, tenantA.id, { variationId: 'v1', locationId: to.id });
    expect(stock[0].onHand).toBe(3);

    const closed = await closeTransfer(db, events, tenantA.id, 'u1', transfer.id);
    expect(closed.transfer.status).toBe('closed');
    expect(closed.discrepancyCount).toBe(0);
    const report = await verifyConservation(db, tenantA.id);
    expect(report.ok).toBe(true);
  });

  it('discrepancy flow: short receipt closes to discrepancy and emits discrepancyCount', async () => {
    const { db, events, tenantA, from, to } = await seedTwoLocations();
    const { transfer, lines } = await createTransfer(db, tenantA.id, 'u1', from.id, to.id, [
      { variationId: 'v1', qtySent: 5 },
    ]);
    await shipTransfer(db, events, tenantA.id, 'u1', transfer.id);
    await receiveTransfer(db, events, tenantA.id, 'u1', transfer.id, [{ lineId: lines[0].id, qtyReceived: 4 }]);

    const seen = capture(events, 'inventory.transfer.closed');
    const closed = await closeTransfer(db, events, tenantA.id, 'u1', transfer.id, 'one lost in transit');
    expect(closed.transfer.status).toBe('discrepancy');
    expect(closed.discrepancyCount).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toEqual({
      v: 1,
      transferId: transfer.id,
      fromLocationId: from.id,
      toLocationId: to.id,
      discrepancyCount: 1,
    });
    // 1 unit is neither at from nor received at to (lost) — conservation still holds by ledger.
    const report = await verifyConservation(db, tenantA.id);
    expect(report.ok).toBe(true);
  });
});
