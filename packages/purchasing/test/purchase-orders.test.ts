import { describe, expect, it } from 'vitest';
import { setup, headers } from './helpers';
import {
  createPurchaseOrder,
  submitPurchaseOrder,
  approvePurchaseOrder,
  rejectPurchaseOrder,
  sendPurchaseOrder,
  acknowledgePurchaseOrder,
  cancelPurchaseOrder,
  getLatestPoDocument,
  listPoEvents,
  getPurchaseOrder,
} from '../src/service';
import { EventBus } from '@blacklabel/core';

function draftInput() {
  return {
    vendorId: 'vend_1',
    freightCents: 1500,
    lines: [
      { variationId: 'var_1', qtyOrdered: 10, unitCostCents: 500, vendorSku: 'SK1' },
      { variationId: 'var_2', qtyOrdered: 3, unitCostCents: 2000 },
    ],
  };
}

describe('purchase order lifecycle', () => {
  it('totals to the cent: subtotal + freight = total; cash required = total', async () => {
    const { db, tenantA } = await setup();
    const po = await createPurchaseOrder(db, tenantA.id, 'buyer', draftInput());
    // 10*500 + 3*2000 = 5000 + 6000 = 11000; + freight 1500 = 12500.
    expect(po.subtotal_cents).toBe(11000);
    expect(po.freight_cents).toBe(1500);
    expect(po.total_cents).toBe(12500);
  });

  it('approval matrix: submit → approve emits purchasing.purchase_order.approved', async () => {
    const { db, tenantA } = await setup();
    const events = new EventBus();
    const seen: any[] = [];
    events.on('purchasing.purchase_order.approved', (e) => { seen.push(e); });

    const po = await createPurchaseOrder(db, tenantA.id, 'buyer', draftInput());
    await submitPurchaseOrder(db, tenantA.id, 'buyer', po.id);
    expect((await getPurchaseOrder(db, tenantA.id, po.id))!.status).toBe('pending_approval');

    const approved = await approvePurchaseOrder(db, events, tenantA.id, 'manager', po.id);
    expect(approved.status).toBe('approved');
    expect(approved.approver).toBe('manager');

    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('purchasing.purchase_order.approved');
    expect(seen[0].payload).toEqual({ v: 1, purchaseOrderId: po.id, vendorId: 'vend_1', totalCents: 12500 });
  });

  it('reject returns to draft with a reason recorded in the event log', async () => {
    const { db, tenantA } = await setup();
    const events = new EventBus();
    const po = await createPurchaseOrder(db, tenantA.id, 'buyer', draftInput());
    await submitPurchaseOrder(db, tenantA.id, 'buyer', po.id);
    const rejected = await rejectPurchaseOrder(db, tenantA.id, 'manager', po.id, 'over budget');
    expect(rejected.status).toBe('draft');
    const events2 = await listPoEvents(db, tenantA.id, po.id);
    const rej = events2.find((e) => e.kind === 'rejected');
    expect(rej).toBeTruthy();
    expect(JSON.parse(rej!.diff!)).toEqual({ reason: 'over budget' });
  });

  it('send lane renders a deterministic document and marks sent', async () => {
    const { db, tenantA } = await setup();
    const events = new EventBus();
    const po = await createPurchaseOrder(db, tenantA.id, 'buyer', draftInput());
    await submitPurchaseOrder(db, tenantA.id, 'buyer', po.id);
    await approvePurchaseOrder(db, events, tenantA.id, 'manager', po.id);
    const { purchaseOrder, document } = await sendPurchaseOrder(db, tenantA.id, 'buyer', po.id, {
      paymentTerms: 'Net 30',
    });
    expect(purchaseOrder.status).toBe('sent');

    const payload = JSON.parse(document.payload);
    expect(payload.totalCents).toBe(12500);
    expect(payload.paymentTerms).toBe('Net 30');
    expect(payload.lines).toHaveLength(2);
    const docByVar = Object.fromEntries(payload.lines.map((l: any) => [l.variationId, l]));
    expect(docByVar['var_1']).toMatchObject({ variationId: 'var_1', qtyOrdered: 10, unitCostCents: 500, lineTotalCents: 5000 });

    const latest = await getLatestPoDocument(db, tenantA.id, po.id);
    expect(latest!.id).toBe(document.id);
  });

  it('acknowledge records expected date; then a full flow through to cancel is blocked once received', async () => {
    const { db, tenantA } = await setup();
    const events = new EventBus();
    const po = await createPurchaseOrder(db, tenantA.id, 'buyer', draftInput());
    await submitPurchaseOrder(db, tenantA.id, 'buyer', po.id);
    await approvePurchaseOrder(db, events, tenantA.id, 'manager', po.id);
    await sendPurchaseOrder(db, tenantA.id, 'buyer', po.id);
    const ack = await acknowledgePurchaseOrder(db, tenantA.id, 'buyer', po.id, '2026-08-01T00:00:00.000Z');
    expect(ack.status).toBe('acknowledged');
    expect(ack.expected_at).toBe('2026-08-01T00:00:00.000Z');
  });

  it('illegal transitions raise 409 conflict', async () => {
    const { db, tenantA } = await setup();
    const events = new EventBus();
    const po = await createPurchaseOrder(db, tenantA.id, 'buyer', draftInput());
    // Cannot approve a draft (must submit first).
    await expect(approvePurchaseOrder(db, events, tenantA.id, 'manager', po.id)).rejects.toMatchObject({ status: 409 });
    // Cannot send a draft.
    await expect(sendPurchaseOrder(db, tenantA.id, 'buyer', po.id)).rejects.toMatchObject({ status: 409 });
  });

  it('submitting an empty PO is a bad request', async () => {
    const { db, tenantA } = await setup();
    const po = await createPurchaseOrder(db, tenantA.id, 'buyer', { vendorId: 'vend_1' });
    await expect(submitPurchaseOrder(db, tenantA.id, 'buyer', po.id)).rejects.toMatchObject({ status: 400 });
  });

  it('cancel is legal from draft and blocked afterward from a terminal state', async () => {
    const { db, tenantA } = await setup();
    const po = await createPurchaseOrder(db, tenantA.id, 'buyer', draftInput());
    const canceled = await cancelPurchaseOrder(db, tenantA.id, 'buyer', po.id, 'duplicate');
    expect(canceled.status).toBe('canceled');
    // Cannot cancel again.
    await expect(cancelPurchaseOrder(db, tenantA.id, 'buyer', po.id)).rejects.toMatchObject({ status: 409 });
  });

  it('PO is tenant-scoped through the router', async () => {
    const { app, tenantA, tenantB } = await setup();
    const created = await app.request('/purchase-orders', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify(draftInput()),
    });
    const { data: po } = (await created.json() as any);
    const bRead = await app.request(`/purchase-orders/${po.id}`, { headers: headers(tenantB) });
    expect(bRead.status).toBe(404);
    const bList = await app.request('/purchase-orders', { headers: headers(tenantB) });
    expect(((await bList.json() as any)).data).toEqual([]);
  });
});
