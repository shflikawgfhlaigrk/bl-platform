import { describe, expect, it } from 'vitest';
import { computeTotals, listAuditEntries, asCoreDb } from '@blacklabel/core';
import { collect, fixtureOrderBody, headers, setup } from './helpers';

async function json(res: Response) {
  return (await res.json()) as any;
}

describe('orders CRUD + money', () => {
  it('creates an order and computes totals to the cent via core computeTotals', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request('/orders', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({
        channel: 'pos',
        lines: [
          { variationId: 'v1', description: 'A', qty: 2, unitPriceCents: 5000, discountBps: 1000 },
        ],
        discountFixedCents: 500,
        taxBps: 800,
      }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);

    // Independent oracle: line 10% off -> 9000; order -500 -> 8500; +8% tax 680 => 9180.
    const oracle = computeTotals(
      [{ quantity: 2, unitPriceCents: 5000, discount: { bps: 1000 } }],
      { discount: { fixedCents: 500 }, taxBps: 800 },
    );
    expect(oracle.subtotalCents).toBe(9000);
    expect(oracle.discountCents).toBe(500);
    expect(oracle.taxCents).toBe(680);
    expect(oracle.totalCents).toBe(9180);

    expect(body.data.subtotal_cents).toBe(oracle.subtotalCents);
    expect(body.data.discount_cents).toBe(oracle.discountCents);
    expect(body.data.tax_cents).toBe(oracle.taxCents);
    expect(body.data.total_cents).toBe(oracle.totalCents);
    expect(body.data.lines[0].line_total_cents).toBe(9000);
    expect(body.data.status).toBe('draft');
  });

  it('recomputes totals when a draft order is edited', async () => {
    const { app, tenantA } = await setup();
    const created = await json(
      await app.request('/orders', {
        method: 'POST',
        headers: headers(tenantA),
        body: JSON.stringify(fixtureOrderBody()),
      }),
    );
    const id = created.data.id;
    const updated = await json(
      await app.request(`/orders/${id}`, {
        method: 'PUT',
        headers: headers(tenantA),
        body: JSON.stringify({ taxBps: 1000, lines: [{ description: 'One', qty: 1, unitPriceCents: 2000 }] }),
      }),
    );
    expect(updated.data.subtotal_cents).toBe(2000);
    expect(updated.data.tax_cents).toBe(200);
    expect(updated.data.total_cents).toBe(2200);
    expect(updated.data.lines).toHaveLength(1);
  });

  it('audits order creation', async () => {
    const { app, db, tenantA } = await setup();
    const created = await json(
      await app.request('/orders', {
        method: 'POST',
        headers: headers(tenantA),
        body: JSON.stringify(fixtureOrderBody()),
      }),
    );
    const entries = await listAuditEntries(asCoreDb(db), tenantA.id, 'orders.order', created.data.id);
    expect(entries.some((e) => e.action === 'orders.order.created')).toBe(true);
  });

  it('rejects a duplicate source_order_id per tenant (external idempotency)', async () => {
    const { app, tenantA } = await setup();
    const mk = () =>
      app.request('/orders', {
        method: 'POST',
        headers: headers(tenantA),
        body: JSON.stringify({ channel: 'pos', source: 'square', sourceOrderId: 'ext-1', lines: [] }),
      });
    expect((await mk()).status).toBe(201);
    expect((await mk()).status).toBe(409);
  });
});

describe('orders tenant isolation', () => {
  it('denies cross-tenant read / update / delete and leaves data intact', async () => {
    const { app, tenantA, tenantB } = await setup();
    const created = await json(
      await app.request('/orders', {
        method: 'POST',
        headers: headers(tenantA),
        body: JSON.stringify(fixtureOrderBody()),
      }),
    );
    const id = created.data.id;

    expect((await app.request(`/orders/${id}`, { headers: headers(tenantB) })).status).toBe(404);
    expect(
      (
        await app.request(`/orders/${id}`, {
          method: 'PUT',
          headers: headers(tenantB),
          body: JSON.stringify({ note: 'hax' }),
        })
      ).status,
    ).toBe(404);
    expect(
      (await app.request(`/orders/${id}`, { method: 'DELETE', headers: headers(tenantB) })).status,
    ).toBe(404);

    // Tenant B lists nothing; A still sees its order untouched.
    const bList = await json(await app.request('/orders', { headers: headers(tenantB) }));
    expect(bList.data).toHaveLength(0);
    const aGet = await json(await app.request(`/orders/${id}`, { headers: headers(tenantA) }));
    expect(aGet.data.note).toBe(null);
  });
});

describe('tenders (idempotent) + pay requires sum == total', () => {
  it('same idempotency key twice yields ONE tender', async () => {
    const { app, tenantA } = await setup();
    const order = await json(
      await app.request('/orders', {
        method: 'POST',
        headers: headers(tenantA),
        body: JSON.stringify({ channel: 'pos', lines: [{ description: 'X', qty: 1, unitPriceCents: 5000 }] }),
      }),
    );
    const id = order.data.id;
    const t1 = await app.request(`/orders/${id}/tenders`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ kind: 'cash', amountCents: 5000, idempotencyKey: 'k1' }),
    });
    expect(t1.status).toBe(201);
    const t2 = await app.request(`/orders/${id}/tenders`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ kind: 'cash', amountCents: 5000, idempotencyKey: 'k1' }),
    });
    expect(t2.status).toBe(200);
    const b1 = await json(t1);
    const b2 = await json(t2);
    expect(b2.created).toBe(false);
    expect(b2.data.id).toBe(b1.data.id);

    const list = await json(await app.request(`/orders/${id}/tenders`, { headers: headers(tenantA) }));
    expect(list.data).toHaveLength(1);
  });

  it('pay fails until captured tenders equal the total, then succeeds and emits paid', async () => {
    const { app, events, tenantA } = await setup();
    const paidEvents = collect(events, 'orders.order.paid');
    const order = await json(
      await app.request('/orders', {
        method: 'POST',
        headers: headers(tenantA),
        body: JSON.stringify({ channel: 'pos', lines: [{ variationId: 'v1', description: 'X', qty: 1, unitPriceCents: 5000 }] }),
      }),
    );
    const id = order.data.id;

    // Under-tendered -> 409.
    await app.request(`/orders/${id}/tenders`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ kind: 'cash', amountCents: 3000, idempotencyKey: 'k1' }),
    });
    expect((await app.request(`/orders/${id}/pay`, { method: 'POST', headers: headers(tenantA), body: '{}' })).status).toBe(409);

    // Top up to exact total via pay's inline tenders, then paid.
    const payRes = await app.request(`/orders/${id}/pay`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ tenders: [{ kind: 'cash', amountCents: 2000, idempotencyKey: 'k2' }] }),
    });
    expect(payRes.status).toBe(200);
    expect((await json(payRes)).data.status).toBe('paid');
    expect(paidEvents).toHaveLength(1);
    expect(paidEvents[0].payload).toMatchObject({ v: 1, orderId: id, totalCents: 5000 });
    expect(paidEvents[0].payload).toMatchObject({ lines: [{ variationId: 'v1', qty: 1 }] });
  });
});

describe('order state machine', () => {
  async function draftOrder(app: any, tenant: any) {
    return json(
      await app.request('/orders', {
        method: 'POST',
        headers: headers(tenant),
        body: JSON.stringify({ channel: 'pos', lines: [{ description: 'X', qty: 1, unitPriceCents: 1000 }] }),
      }),
    );
  }

  it('legal path draft -> reserved -> paid and emits reserved', async () => {
    const { app, events, tenantA } = await setup();
    const reserved = collect(events, 'orders.order.reserved');
    const o = await draftOrder(app, tenantA);
    const r = await app.request(`/orders/${o.data.id}/reserve`, { method: 'POST', headers: headers(tenantA) });
    expect(r.status).toBe(200);
    expect((await json(r)).data.status).toBe('reserved');
    expect(reserved).toHaveLength(1);
    await app.request(`/orders/${o.data.id}/tenders`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ kind: 'external', amountCents: 1000, idempotencyKey: 'k' }),
    });
    const paid = await app.request(`/orders/${o.data.id}/pay`, { method: 'POST', headers: headers(tenantA), body: '{}' });
    expect((await json(paid)).data.status).toBe('paid');
  });

  it('rejects illegal transitions', async () => {
    const { app, tenantA } = await setup();
    const o = await draftOrder(app, tenantA);
    const id = o.data.id;
    // pay a draft with no tenders -> 409
    expect((await app.request(`/orders/${id}/pay`, { method: 'POST', headers: headers(tenantA), body: '{}' })).status).toBe(409);
    // fulfill an unpaid order -> 409
    expect(
      (
        await app.request(`/orders/${id}/fulfillments`, {
          method: 'POST',
          headers: headers(tenantA),
          body: JSON.stringify({ kind: 'ship', lines: [{ lineId: o.data.lines[0].id, qty: 1 }] }),
        })
      ).status,
    ).toBe(409);
    // refund an unpaid order -> 409
    expect(
      (
        await app.request(`/orders/${id}/refunds`, {
          method: 'POST',
          headers: headers(tenantA),
          body: JSON.stringify({ tenderId: 'x', amountCents: 100, lines: [{ lineId: o.data.lines[0].id, qty: 1, disposition: 'restock' }] }),
        })
      ).status,
    ).toBe(409);

    // Move to paid, then illegal reserve/cancel/delete.
    await app.request(`/orders/${id}/tenders`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ kind: 'cash', amountCents: 1000, idempotencyKey: 'k' }),
    });
    await app.request(`/orders/${id}/pay`, { method: 'POST', headers: headers(tenantA), body: '{}' });
    expect((await app.request(`/orders/${id}/reserve`, { method: 'POST', headers: headers(tenantA) })).status).toBe(409);
    expect((await app.request(`/orders/${id}/cancel`, { method: 'POST', headers: headers(tenantA) })).status).toBe(409);
    expect((await app.request(`/orders/${id}`, { method: 'DELETE', headers: headers(tenantA) })).status).toBe(409);
  });

  it('cancels a draft order (draft/reserved only)', async () => {
    const { app, tenantA } = await setup();
    const o = await draftOrder(app, tenantA);
    const res = await app.request(`/orders/${o.data.id}/cancel`, { method: 'POST', headers: headers(tenantA) });
    expect(res.status).toBe(200);
    expect((await json(res)).data.status).toBe('canceled');
  });

  it('marks a draft invoice-lane order as sent', async () => {
    const { app, tenantA } = await setup();
    const o = await json(
      await app.request('/orders', {
        method: 'POST',
        headers: headers(tenantA),
        body: JSON.stringify({ channel: 'invoice', lines: [{ description: 'Quote', qty: 1, unitPriceCents: 9900 }] }),
      }),
    );
    const res = await app.request(`/orders/${o.data.id}/send`, { method: 'POST', headers: headers(tenantA) });
    expect(res.status).toBe(200);
    expect((await json(res)).data.sent).toBe(true);
  });
});
