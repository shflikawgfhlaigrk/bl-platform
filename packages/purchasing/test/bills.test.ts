import { describe, expect, it } from 'vitest';
import { EventBus } from '@blacklabel/core';
import { setup, headers } from './helpers';
import {
  createPurchaseOrder,
  submitPurchaseOrder,
  approvePurchaseOrder,
  sendPurchaseOrder,
  createReceipt,
  listPoLines,
  createVendorBill,
  matchVendorBill,
  listBillExceptions,
  getVendorBill,
} from '../src/service';

async function receivedPo(db: any, events: EventBus, tenantId: string) {
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
  const lines = await listPoLines(db, tenantId, po.id);
  const byVar = Object.fromEntries(lines.map((l) => [l.variation_id, l]));
  const receipt = await createReceipt(db, events, tenantId, 'receiver', po.id, {
    lines: [
      { poLineId: byVar['var_1'].id, qtyReceived: 10, condition: 'ok' },
      { poLineId: byVar['var_2'].id, qtyReceived: 4, condition: 'ok' },
    ],
  });
  return { po, receiptId: receipt.receipt.id };
}

describe('vendor bills + three-way match', () => {
  it('enforces (tenant, vendor, bill_number) uniqueness (no ON CONFLICT)', async () => {
    const { db, tenantA } = await setup();
    await createVendorBill(db, tenantA.id, 'acct', {
      vendorId: 'vend_1',
      billNumber: 'INV-1',
      amountCents: 100,
      lines: [],
    });
    await expect(
      createVendorBill(db, tenantA.id, 'acct', { vendorId: 'vend_1', billNumber: 'INV-1', amountCents: 200, lines: [] }),
    ).rejects.toMatchObject({ status: 409 });
    // Same bill number under a DIFFERENT vendor is fine.
    const ok = await createVendorBill(db, tenantA.id, 'acct', { vendorId: 'vend_2', billNumber: 'INV-1', amountCents: 200, lines: [] });
    expect(ok.status).toBe('unmatched');
  });

  it('clean bill matches → status matched, zero exceptions', async () => {
    const { db, tenantA } = await setup();
    const events = new EventBus();
    const { po, receiptId } = await receivedPo(db, events, tenantA.id);
    const bill = await createVendorBill(db, tenantA.id, 'acct', {
      vendorId: 'vend_1',
      billNumber: 'INV-CLEAN',
      amountCents: 13000,
      lines: [
        { variationId: 'var_1', qty: 10, unitCostCents: 500 },
        { variationId: 'var_2', qty: 4, unitCostCents: 2000 },
      ],
    });
    const result = await matchVendorBill(db, tenantA.id, 'acct', bill.id, po.id, receiptId);
    expect(result.status).toBe('matched');
    expect(result.exceptions).toHaveLength(0);
    expect((await getVendorBill(db, tenantA.id, bill.id))!.status).toBe('matched');
  });

  it('price + qty variances produce cent-exact / unit-exact exceptions', async () => {
    const { db, tenantA } = await setup();
    const events = new EventBus();
    const { po, receiptId } = await receivedPo(db, events, tenantA.id);
    const bill = await createVendorBill(db, tenantA.id, 'acct', {
      vendorId: 'vend_1',
      billNumber: 'INV-VAR',
      amountCents: 99999,
      lines: [
        { variationId: 'var_1', qty: 10, unitCostCents: 540 }, // price variance +40/unit
        { variationId: 'var_2', qty: 6, unitCostCents: 2000 }, // qty variance: billed 6, received 4 → +2
      ],
    });
    const result = await matchVendorBill(db, tenantA.id, 'acct', bill.id, po.id, receiptId);
    expect(result.status).toBe('exception');

    const price = result.exceptions.find((e) => e.kind === 'price_variance')!;
    expect(price.variation_id).toBe('var_1');
    expect(price.expected).toBe(500);
    expect(price.actual).toBe(540);
    expect(price.delta).toBe(40);

    const qty = result.exceptions.find((e) => e.kind === 'qty_variance')!;
    expect(qty.variation_id).toBe('var_2');
    expect(qty.expected).toBe(4); // received
    expect(qty.actual).toBe(6); // billed
    expect(qty.delta).toBe(2);

    // Exceptions persisted + drill-through references captured.
    const persisted = await listBillExceptions(db, tenantA.id, bill.id);
    expect(persisted).toHaveLength(2);
    expect(persisted.every((e) => e.purchase_order_id === po.id && e.receipt_id === receiptId)).toBe(true);
  });

  it('re-matching is idempotent (replaces the prior exception set)', async () => {
    const { db, tenantA } = await setup();
    const events = new EventBus();
    const { po, receiptId } = await receivedPo(db, events, tenantA.id);
    const bill = await createVendorBill(db, tenantA.id, 'acct', {
      vendorId: 'vend_1',
      billNumber: 'INV-RE',
      amountCents: 1,
      lines: [{ variationId: 'var_1', qty: 10, unitCostCents: 540 }],
    });
    await matchVendorBill(db, tenantA.id, 'acct', bill.id, po.id, receiptId);
    await matchVendorBill(db, tenantA.id, 'acct', bill.id, po.id, receiptId);
    expect(await listBillExceptions(db, tenantA.id, bill.id)).toHaveLength(1);
  });

  it('bills + match work through the router', async () => {
    const { db, app, tenantA } = await setup();
    const events = new EventBus();
    const { po, receiptId } = await receivedPo(db, events, tenantA.id);
    const create = await app.request('/vendor-bills', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({
        vendorId: 'vend_1',
        billNumber: 'INV-API',
        amountCents: 13000,
        lines: [
          { variationId: 'var_1', qty: 10, unitCostCents: 500 },
          { variationId: 'var_2', qty: 4, unitCostCents: 2000 },
        ],
      }),
    });
    expect(create.status).toBe(201);
    const { data: bill } = (await create.json() as any);
    const match = await app.request(`/vendor-bills/${bill.id}/match`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ purchaseOrderId: po.id, receiptId }),
    });
    expect(((await match.json() as any)).data.status).toBe('matched');
  });
});
