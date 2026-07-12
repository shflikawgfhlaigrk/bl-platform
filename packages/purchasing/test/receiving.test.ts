import { describe, expect, it } from 'vitest';
import { EventBus } from '@blacklabel/core';
import { setup } from './helpers';
import {
  createPurchaseOrder,
  submitPurchaseOrder,
  approvePurchaseOrder,
  sendPurchaseOrder,
  createReceipt,
  listDiscrepancies,
  listPoLines,
  getPurchaseOrder,
} from '../src/service';

async function sentPo(db: any, events: EventBus, tenantId: string) {
  const po = await createPurchaseOrder(db, tenantId, 'buyer', {
    vendorId: 'vend_1',
    lines: [
      { variationId: 'var_1', qtyOrdered: 10, unitCostCents: 500 },
      { variationId: 'var_2', qtyOrdered: 4, unitCostCents: 2000 },
    ],
  });
  await submitPurchaseOrder(db, tenantId, 'buyer', po.id);
  await approvePurchaseOrder(db, events, tenantId, 'manager', po.id);
  await sendPurchaseOrder(db, tenantId, 'buyer', po.id);
  return po;
}

/** Map variation_id → line row (positional order of listPoLines is only id-stable). */
async function lineByVariation(db: any, tenantId: string, poId: string) {
  const lines = await listPoLines(db, tenantId, poId);
  const map: Record<string, (typeof lines)[number]> = {};
  for (const l of lines) map[l.variation_id] = l;
  return map;
}

describe('receiving', () => {
  it('a clean full receipt marks lines + PO received and emits the received event with condition lines', async () => {
    const { db, tenantA } = await setup();
    const events = new EventBus();
    const received: any[] = [];
    events.on('purchasing.purchase_order.received', (e) => { received.push(e); });

    const po = await sentPo(db, events, tenantA.id);
    const byVar = await lineByVariation(db, tenantA.id, po.id);

    const result = await createReceipt(db, events, tenantA.id, 'receiver', po.id, {
      lines: [
        { poLineId: byVar['var_1'].id, qtyReceived: 10, condition: 'ok' },
        { poLineId: byVar['var_2'].id, qtyReceived: 4, condition: 'ok' },
      ],
    });
    expect(result.purchaseOrder.status).toBe('received');
    expect(result.discrepancies).toHaveLength(0);

    expect(received).toHaveLength(1);
    expect(received[0].payload.v).toBe(1);
    expect(received[0].payload.purchaseOrderId).toBe(po.id);
    expect(received[0].payload.receiptId).toBe(result.receipt.id);
    const evByVar = Object.fromEntries(received[0].payload.lines.map((l: any) => [l.variationId, l]));
    expect(evByVar['var_1']).toEqual({ variationId: 'var_1', qty: 10, condition: 'ok', unitCostCents: 500 });
    expect(evByVar['var_2']).toEqual({ variationId: 'var_2', qty: 4, condition: 'ok', unitCostCents: 2000 });

    const after = await getPurchaseOrder(db, tenantA.id, po.id);
    expect(after!.status).toBe('received');
  });

  it('OVER receipt → over discrepancy + discrepant event', async () => {
    const { db, tenantA } = await setup();
    const events = new EventBus();
    const discrepant: any[] = [];
    events.on('purchasing.receipt.discrepant', (e) => { discrepant.push(e); });

    const po = await sentPo(db, events, tenantA.id);
    const byVar = await lineByVariation(db, tenantA.id, po.id);
    const result = await createReceipt(db, events, tenantA.id, 'receiver', po.id, {
      lines: [{ poLineId: byVar['var_1'].id, qtyReceived: 13, condition: 'ok' }],
    });
    const over = result.discrepancies.find((d) => d.kind === 'over');
    expect(over).toBeTruthy();
    expect(over!.expected_qty).toBe(10);
    expect(over!.received_qty).toBe(13);
    expect(over!.delta_qty).toBe(3);
    expect(discrepant).toHaveLength(1);
    expect(discrepant[0].payload.discrepancyCount).toBeGreaterThan(0);
  });

  it('SHORT (final) receipt → short discrepancy + backordered line + partially_received PO', async () => {
    const { db, tenantA } = await setup();
    const events = new EventBus();
    const po = await sentPo(db, events, tenantA.id);
    const byVar = await lineByVariation(db, tenantA.id, po.id);
    // Receive only var_1 (7 of 10, final). var_2 untouched.
    const result = await createReceipt(db, events, tenantA.id, 'receiver', po.id, {
      lines: [{ poLineId: byVar['var_1'].id, qtyReceived: 7, condition: 'ok', final: true }],
    });
    const short = result.discrepancies.find((d) => d.kind === 'short');
    expect(short).toBeTruthy();
    expect(short!.delta_qty).toBe(-3);
    expect(result.purchaseOrder.status).toBe('partially_received');

    const after = await lineByVariation(db, tenantA.id, po.id);
    const l1 = after['var_1'];
    expect(l1.qty_received).toBe(7);
    expect(l1.qty_backordered).toBe(3);
    expect(l1.line_state).toBe('backordered');
  });

  it('DAMAGED and WRONG_ITEM → discrepancies, and NOT booked into good qty_received', async () => {
    const { db, tenantA } = await setup();
    const events = new EventBus();
    const po = await sentPo(db, events, tenantA.id);
    const byVar = await lineByVariation(db, tenantA.id, po.id);
    const result = await createReceipt(db, events, tenantA.id, 'receiver', po.id, {
      lines: [
        { poLineId: byVar['var_1'].id, qtyReceived: 2, condition: 'damaged' },
        { poLineId: byVar['var_2'].id, qtyReceived: 1, condition: 'wrong_item' },
      ],
    });
    expect(result.discrepancies.map((d) => d.kind).sort()).toEqual(['damaged', 'wrong_item']);
    const after = await lineByVariation(db, tenantA.id, po.id);
    // Damaged/wrong not booked as good stock.
    expect(after['var_1'].qty_received).toBe(0);
    expect(after['var_2'].qty_received).toBe(0);
    // Event carries per-line conditions for the integrator.
    const evByVar = Object.fromEntries(result.eventLines.map((l) => [l.variationId, l]));
    expect(evByVar['var_1']).toEqual({ variationId: 'var_1', qty: 2, condition: 'damaged', unitCostCents: 500 });
    expect(evByVar['var_2']).toEqual({ variationId: 'var_2', qty: 1, condition: 'wrong_item', unitCostCents: 2000 });
  });

  it('cannot receive against a draft PO', async () => {
    const { db, tenantA } = await setup();
    const events = new EventBus();
    const po = await createPurchaseOrder(db, tenantA.id, 'buyer', {
      vendorId: 'vend_1',
      lines: [{ variationId: 'var_1', qtyOrdered: 5, unitCostCents: 100 }],
    });
    const lines = await listPoLines(db, tenantA.id, po.id);
    await expect(
      createReceipt(db, events, tenantA.id, 'r', po.id, {
        lines: [{ poLineId: lines[0].id, qtyReceived: 1 }],
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('discrepancies are listable and tenant-scoped', async () => {
    const { db, tenantA, tenantB } = await setup();
    const events = new EventBus();
    const po = await sentPo(db, events, tenantA.id);
    const lines = await listPoLines(db, tenantA.id, po.id);
    await createReceipt(db, events, tenantA.id, 'receiver', po.id, {
      lines: [{ poLineId: lines[0].id, qtyReceived: 13, condition: 'ok' }],
    });
    expect((await listDiscrepancies(db, tenantA.id)).length).toBeGreaterThan(0);
    expect(await listDiscrepancies(db, tenantB.id)).toEqual([]);
  });
});
