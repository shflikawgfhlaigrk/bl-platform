import { describe, expect, it } from 'vitest';
import { asCoreDb, listAuditEntries } from '@blacklabel/core';
import { collect, headers, setup } from './helpers';

async function json(res: Response) {
  return (await res.json()) as any;
}

/** Create a PAID order with two variation lines (qty 3 of v1, qty 1 of v2). */
async function paidOrder(app: any, tenant: any) {
  const order = await json(
    await app.request('/orders', {
      method: 'POST',
      headers: headers(tenant),
      body: JSON.stringify({
        channel: 'storefront',
        lines: [
          { variationId: 'v1', locationId: 'loc1', description: 'Belt', qty: 3, unitPriceCents: 1000 },
          { variationId: 'v2', locationId: 'loc1', description: 'Pad', qty: 1, unitPriceCents: 2000 },
        ],
      }),
    }),
  );
  const id = order.data.id;
  await app.request(`/orders/${id}/tenders`, {
    method: 'POST',
    headers: headers(tenant),
    body: JSON.stringify({ kind: 'cash', amountCents: 5000, idempotencyKey: 'pay' }),
  });
  await app.request(`/orders/${id}/pay`, { method: 'POST', headers: headers(tenant), body: '{}' });
  return { id, lines: order.data.lines };
}

describe('fulfillment (partial supported)', () => {
  it('partial then full fulfillment moves order partially_fulfilled -> fulfilled and emits fulfilled once', async () => {
    const { app, events, tenantA } = await setup();
    const fulfilled = collect(events, 'orders.order.fulfilled');
    const { id, lines } = await paidOrder(app, tenantA);
    const v1 = lines.find((l: any) => l.variation_id === 'v1');
    const v2 = lines.find((l: any) => l.variation_id === 'v2');

    // Fulfill 2 of 3 of v1 -> partially_fulfilled.
    const f1 = await json(
      await app.request(`/orders/${id}/fulfillments`, {
        method: 'POST',
        headers: headers(tenantA),
        body: JSON.stringify({ kind: 'ship', lines: [{ lineId: v1.id, qty: 2 }] }),
      }),
    );
    await app.request(`/fulfillments/${f1.data.fulfillment.id}/advance`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ status: 'shipped', tracking: '1Z-TEST' }),
    });
    let order = await json(await app.request(`/orders/${id}`, { headers: headers(tenantA) }));
    expect(order.data.status).toBe('partially_fulfilled');
    expect(fulfilled).toHaveLength(0);

    // Fulfill remaining 1 of v1 + the v2 -> fulfilled.
    const f2 = await json(
      await app.request(`/orders/${id}/fulfillments`, {
        method: 'POST',
        headers: headers(tenantA),
        body: JSON.stringify({ kind: 'ship', lines: [{ lineId: v1.id, qty: 1 }, { lineId: v2.id, qty: 1 }] }),
      }),
    );
    await app.request(`/fulfillments/${f2.data.fulfillment.id}/advance`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ status: 'shipped' }),
    });
    // Drive it further to delivered (shipped -> delivered is legal) — order stays fulfilled.
    await app.request(`/fulfillments/${f2.data.fulfillment.id}/advance`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ status: 'delivered' }),
    });
    order = await json(await app.request(`/orders/${id}`, { headers: headers(tenantA) }));
    expect(order.data.status).toBe('fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0].payload).toMatchObject({ v: 1, orderId: id });
  });

  it('rejects fulfilling more than the outstanding qty', async () => {
    const { app, tenantA } = await setup();
    const { id, lines } = await paidOrder(app, tenantA);
    const v2 = lines.find((l: any) => l.variation_id === 'v2');
    const res = await app.request(`/orders/${id}/fulfillments`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ kind: 'ship', lines: [{ lineId: v2.id, qty: 5 }] }),
    });
    expect(res.status).toBe(409);
  });

  it('rejects an illegal fulfillment status transition', async () => {
    const { app, tenantA } = await setup();
    const { id, lines } = await paidOrder(app, tenantA);
    const v2 = lines.find((l: any) => l.variation_id === 'v2');
    const f = await json(
      await app.request(`/orders/${id}/fulfillments`, {
        method: 'POST',
        headers: headers(tenantA),
        body: JSON.stringify({ kind: 'ship', lines: [{ lineId: v2.id, qty: 1 }] }),
      }),
    );
    // Legal: pending -> shipped -> delivered.
    await app.request(`/fulfillments/${f.data.fulfillment.id}/advance`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ status: 'shipped' }),
    });
    await app.request(`/fulfillments/${f.data.fulfillment.id}/advance`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ status: 'delivered' }),
    });
    // delivered is terminal -> shipping again is illegal.
    const res = await app.request(`/fulfillments/${f.data.fulfillment.id}/advance`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ status: 'shipped' }),
    });
    expect(res.status).toBe(409);
  });
});

describe('pick list + packing slip projections', () => {
  it('pick list lists outstanding lines; packing slip reflects a fulfillment', async () => {
    const { app, tenantA } = await setup();
    const { id, lines } = await paidOrder(app, tenantA);
    const v1 = lines.find((l: any) => l.variation_id === 'v1');

    const pick = await json(await app.request(`/orders/${id}/pick-list`, { headers: headers(tenantA) }));
    expect(pick.data.orderId).toBe(id);
    expect(pick.data.items).toHaveLength(2);
    expect(pick.data.items[0]).toMatchObject({ variationId: 'v1', qty: 3, locationId: 'loc1' });

    const f = await json(
      await app.request(`/orders/${id}/fulfillments`, {
        method: 'POST',
        headers: headers(tenantA),
        body: JSON.stringify({ kind: 'ship', address: { city: 'Ocala' }, lines: [{ lineId: v1.id, qty: 3 }] }),
      }),
    );
    const slip = await json(
      await app.request(`/fulfillments/${f.data.fulfillment.id}/packing-slip`, { headers: headers(tenantA) }),
    );
    expect(slip.data.orderId).toBe(id);
    expect(slip.data.kind).toBe('ship');
    expect(slip.data.address).toMatchObject({ city: 'Ocala' });
    expect(slip.data.items).toHaveLength(1);
    expect(slip.data.items[0]).toMatchObject({ variationId: 'v1', qty: 3 });

    // Complete it -> v1 leaves the pick list.
    await app.request(`/fulfillments/${f.data.fulfillment.id}/advance`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ status: 'shipped' }),
    });
    const pick2 = await json(await app.request(`/orders/${id}/pick-list`, { headers: headers(tenantA) }));
    expect(pick2.data.items.map((i: any) => i.variationId)).toEqual(['v2']);
  });
});

describe('refunds with per-line restock dispositions', () => {
  it('records dispositions per line, updates tender, transitions order, and emits returned', async () => {
    const { app, events, tenantA } = await setup();
    const returned = collect(events, 'orders.order.returned');
    const { id, lines } = await paidOrder(app, tenantA);
    const v1 = lines.find((l: any) => l.variation_id === 'v1');
    const v2 = lines.find((l: any) => l.variation_id === 'v2');
    const tenders = await json(await app.request(`/orders/${id}/tenders`, { headers: headers(tenantA) }));
    const tenderId = tenders.data[0].id;

    // Partial return: 1 of v1 restock -> partially_returned.
    const r1 = await app.request(`/orders/${id}/refunds`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ tenderId, amountCents: 1000, reason: 'changed mind', lines: [{ lineId: v1.id, qty: 1, disposition: 'restock' }] }),
    });
    expect(r1.status).toBe(201);
    let order = await json(await app.request(`/orders/${id}`, { headers: headers(tenantA) }));
    expect(order.data.status).toBe('partially_returned');
    expect(returned).toHaveLength(1);
    expect(returned[0].payload).toMatchObject({ v: 1, orderId: id });
    expect((returned[0].payload as any).lines[0]).toMatchObject({ variationId: 'v1', qty: 1, disposition: 'restock', locationId: 'loc1' });

    // Tender now partially_refunded.
    const t2 = await json(await app.request(`/orders/${id}/tenders`, { headers: headers(tenantA) }));
    expect(t2.data[0].status).toBe('partially_refunded');
    expect(t2.data[0].refunded_cents).toBe(1000);

    // Return the rest (2 more v1 quarantine, 1 v2 damaged) -> fully returned.
    const r2 = await app.request(`/orders/${id}/refunds`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({
        tenderId,
        amountCents: 4000,
        lines: [
          { lineId: v1.id, qty: 2, disposition: 'quarantine' },
          { lineId: v2.id, qty: 1, disposition: 'damaged' },
        ],
      }),
    });
    expect(r2.status).toBe(201);
    order = await json(await app.request(`/orders/${id}`, { headers: headers(tenantA) }));
    expect(order.data.status).toBe('returned');
    const t3 = await json(await app.request(`/orders/${id}/tenders`, { headers: headers(tenantA) }));
    expect(t3.data[0].status).toBe('refunded');
    expect(t3.data[0].refunded_cents).toBe(5000);
  });

  it('rejects returning more than the returnable qty', async () => {
    const { app, tenantA } = await setup();
    const { id, lines } = await paidOrder(app, tenantA);
    const v2 = lines.find((l: any) => l.variation_id === 'v2');
    const tenders = await json(await app.request(`/orders/${id}/tenders`, { headers: headers(tenantA) }));
    const res = await app.request(`/orders/${id}/refunds`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ tenderId: tenders.data[0].id, amountCents: 2000, lines: [{ lineId: v2.id, qty: 9, disposition: 'restock' }] }),
    });
    expect(res.status).toBe(409);
  });

  it('audits refund creation', async () => {
    const { app, db, tenantA } = await setup();
    const { id, lines } = await paidOrder(app, tenantA);
    const v2 = lines.find((l: any) => l.variation_id === 'v2');
    const tenders = await json(await app.request(`/orders/${id}/tenders`, { headers: headers(tenantA) }));
    const refund = await json(
      await app.request(`/orders/${id}/refunds`, {
        method: 'POST',
        headers: headers(tenantA),
        body: JSON.stringify({ tenderId: tenders.data[0].id, amountCents: 2000, lines: [{ lineId: v2.id, qty: 1, disposition: 'restock' }] }),
      }),
    );
    const entries = await listAuditEntries(asCoreDb(db), tenantA.id, 'orders.refund', refund.data.refund.id);
    expect(entries.some((e) => e.action === 'orders.refund.created')).toBe(true);
  });
});
