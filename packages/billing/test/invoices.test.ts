import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { parseCsv } from '@blacklabel/core';
import { markOverdueInvoices } from '../src/service';
import { api, json, makeInvoice, makeSentInvoice, setupBilling } from './helpers';

describe('invoice CRUD via router', () => {
  it('creates a draft invoice with line items and INV-{seq} numbering', async () => {
    const ctx = await setupBilling();
    const invoice = await makeInvoice(ctx, ctx.tenantA.id, {
      customerId: 'cust-42',
      lines: [
        { description: 'Labor', quantity: 2, unitPriceCents: 5_000 },
        { description: 'Parts', quantity: 1, unitPriceCents: 1_250 },
      ],
      memo: 'First invoice',
      portalVisible: true,
    });
    expect(invoice.number).toBe('INV-1');
    expect(invoice.status).toBe('draft');
    expect(invoice.customer_id).toBe('cust-42');
    expect(invoice.total_cents).toBe(11_250);
    expect(invoice.paid_cents).toBe(0);
    expect(invoice.portal_visible).toBe(true);
    expect(invoice.lines).toHaveLength(2);
    expect(invoice.lines[0]).toMatchObject({
      position: 0,
      description: 'Labor',
      line_total_cents: 10_000,
    });

    const res = await api(ctx.app, ctx.tenantA.id, 'GET', `/invoices/${invoice.id}`);
    expect(res.status).toBe(200);
    const fetched = (await json(res)).data;
    expect(fetched.number).toBe('INV-1');
    expect(fetched.lines).toHaveLength(2);
  });

  it('numbers invoices sequentially per tenant with independent counters', async () => {
    const ctx = await setupBilling();
    const a1 = await makeInvoice(ctx, ctx.tenantA.id);
    const a2 = await makeInvoice(ctx, ctx.tenantA.id);
    const b1 = await makeInvoice(ctx, ctx.tenantB.id);
    const a3 = await makeInvoice(ctx, ctx.tenantA.id);
    expect([a1.number, a2.number, a3.number]).toEqual(['INV-1', 'INV-2', 'INV-3']);
    expect(b1.number).toBe('INV-1');
  });

  it('updates a draft (replacing lines recomputes totals); rejects edits once sent', async () => {
    const ctx = await setupBilling();
    const invoice = await makeInvoice(ctx, ctx.tenantA.id);
    const updated = await api(ctx.app, ctx.tenantA.id, 'PUT', `/invoices/${invoice.id}`, {
      lines: [{ description: 'Bigger job', quantity: 4, unitPriceCents: 2_500 }],
      taxBps: 1000,
      memo: 'revised',
    });
    expect(updated.status).toBe(200);
    const body = (await json(updated)).data;
    expect(body.subtotal_cents).toBe(10_000);
    expect(body.tax_cents).toBe(1_000);
    expect(body.total_cents).toBe(11_000);
    expect(body.memo).toBe('revised');
    expect(body.lines).toHaveLength(1);

    const sent = await makeSentInvoice(ctx, ctx.tenantA.id);
    const denied = await api(ctx.app, ctx.tenantA.id, 'PUT', `/invoices/${sent.id}`, { memo: 'nope' });
    expect(denied.status).toBe(409);
  });

  it('deletes drafts only', async () => {
    const ctx = await setupBilling();
    const draft = await makeInvoice(ctx, ctx.tenantA.id);
    const del = await api(ctx.app, ctx.tenantA.id, 'DELETE', `/invoices/${draft.id}`);
    expect(del.status).toBe(200);
    expect((await api(ctx.app, ctx.tenantA.id, 'GET', `/invoices/${draft.id}`)).status).toBe(404);

    const sent = await makeSentInvoice(ctx, ctx.tenantA.id);
    expect((await api(ctx.app, ctx.tenantA.id, 'DELETE', `/invoices/${sent.id}`)).status).toBe(409);
  });

  it('lists with status/customer filters and pagination envelope', async () => {
    const ctx = await setupBilling();
    await makeInvoice(ctx, ctx.tenantA.id, { customerId: 'c1' });
    await makeSentInvoice(ctx, ctx.tenantA.id, { customerId: 'c2' });

    const all = await json(await api(ctx.app, ctx.tenantA.id, 'GET', '/invoices'));
    expect(all.data).toHaveLength(2);
    expect(all.limit).toBe(50);
    expect(all.offset).toBe(0);

    const drafts = await json(await api(ctx.app, ctx.tenantA.id, 'GET', '/invoices?status=draft'));
    expect(drafts.data).toHaveLength(1);
    expect(drafts.data[0].customer_id).toBe('c1');

    const byCustomer = await json(
      await api(ctx.app, ctx.tenantA.id, 'GET', '/invoices?customer_id=c2'),
    );
    expect(byCustomer.data).toHaveLength(1);
    expect(byCustomer.data[0].status).toBe('sent');

    const badSort = await api(ctx.app, ctx.tenantA.id, 'GET', '/invoices?sort=evil_column');
    expect(badSort.status).toBe(400);
  });

  it('rejects invalid bodies with 400 (zod)', async () => {
    const ctx = await setupBilling();
    const res = await api(ctx.app, ctx.tenantA.id, 'POST', '/invoices', {
      customerId: 'c1',
      lines: [{ description: 'x', quantity: 1, unitPriceCents: 12.5 }], // fractional cents
    });
    expect(res.status).toBe(400);
    const noLines = await api(ctx.app, ctx.tenantA.id, 'POST', '/invoices', {
      customerId: 'c1',
      lines: [],
    });
    expect(noLines.status).toBe(400);
  });
});

describe('payment lifecycle', () => {
  it('walks draft -> sent -> partial -> paid off recorded payments', async () => {
    const ctx = await setupBilling();
    const paidEvents: any[] = [];
    ctx.events.on('billing.invoice.paid', (e) => {
      paidEvents.push(e);
    });

    const sent = await makeSentInvoice(ctx, ctx.tenantA.id, {
      customerId: 'cust-9',
      lines: [{ description: 'Job', quantity: 1, unitPriceCents: 10_000 }],
    });
    expect(sent.status).toBe('sent');
    expect(sent.sent_at).toBeTruthy();

    const p1 = await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${sent.id}/payments`, {
      amountCents: 4_000,
      method: 'cash',
    });
    expect(p1.status).toBe(201);
    const afterP1 = (await json(p1)).data;
    expect(afterP1.invoice.status).toBe('partial');
    expect(afterP1.invoice.paid_cents).toBe(4_000);
    expect(paidEvents).toHaveLength(0);

    const p2 = await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${sent.id}/payments`, {
      amountCents: 6_000,
    });
    const afterP2 = (await json(p2)).data;
    expect(afterP2.invoice.status).toBe('paid');
    expect(afterP2.invoice.paid_cents).toBe(10_000);
    expect(afterP2.invoice.paid_at).toBeTruthy();

    // billing.invoice.paid emitted exactly once, with the catalog payload.
    expect(paidEvents).toHaveLength(1);
    expect(paidEvents[0].type).toBe('billing.invoice.paid');
    expect(paidEvents[0].tenantId).toBe(ctx.tenantA.id);
    expect(paidEvents[0].payload).toEqual({
      invoiceId: sent.id,
      customerId: 'cust-9',
      totalCents: 10_000,
    });

    const payments = await json(
      await api(ctx.app, ctx.tenantA.id, 'GET', `/invoices/${sent.id}/payments`),
    );
    expect(payments.data).toHaveLength(2);
    // Both may share the same received_at millisecond, so compare as a set.
    expect(
      payments.data.map((p: any) => p.amount_cents).sort((a: number, b: number) => a - b),
    ).toEqual([4_000, 6_000]);

    // No more payments once paid.
    const p3 = await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${sent.id}/payments`, {
      amountCents: 1,
    });
    expect(p3.status).toBe(409);
  });

  it('rejects payments on draft and void invoices, and non-positive amounts', async () => {
    const ctx = await setupBilling();
    const draft = await makeInvoice(ctx, ctx.tenantA.id);
    expect(
      (await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${draft.id}/payments`, { amountCents: 100 }))
        .status,
    ).toBe(409);

    const voided = await makeSentInvoice(ctx, ctx.tenantA.id);
    await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${voided.id}/void`);
    expect(
      (await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${voided.id}/payments`, { amountCents: 100 }))
        .status,
    ).toBe(409);

    const sent = await makeSentInvoice(ctx, ctx.tenantA.id);
    expect(
      (await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${sent.id}/payments`, { amountCents: 0 }))
        .status,
    ).toBe(400);
  });

  it('send/void transitions guard their preconditions', async () => {
    const ctx = await setupBilling();
    const invoice = await makeInvoice(ctx, ctx.tenantA.id);
    expect((await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${invoice.id}/send`)).status).toBe(200);
    // Can't send twice.
    expect((await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${invoice.id}/send`)).status).toBe(409);

    // Paid invoices can't be voided.
    await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${invoice.id}/payments`, {
      amountCents: 10_000,
    });
    expect((await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${invoice.id}/void`)).status).toBe(409);

    // Void is terminal for an unpaid invoice.
    const other = await makeSentInvoice(ctx, ctx.tenantA.id);
    const voidRes = await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${other.id}/void`);
    expect((await json(voidRes)).data.status).toBe('void');
    expect((await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${other.id}/void`)).status).toBe(409);
  });

  it('marks past-due invoices overdue (on send and via the refresh tick)', async () => {
    const ctx = await setupBilling();
    // Already past due at send time -> lands directly on overdue.
    const pastDue = await makeSentInvoice(ctx, ctx.tenantA.id, {
      dueAt: '2020-01-01T00:00:00.000Z',
    });
    expect(pastDue.status).toBe('overdue');

    // Due in the future -> sent; flips via the tick once "now" passes due_at.
    const futureDue = DateTime.utc().plus({ days: 7 }).toISO()!;
    const sent = await makeSentInvoice(ctx, ctx.tenantA.id, { dueAt: futureDue });
    expect(sent.status).toBe('sent');

    const refreshNow = await api(ctx.app, ctx.tenantA.id, 'POST', '/invoices/refresh-overdue');
    expect((await json(refreshNow)).data.markedOverdue).toBe(0);

    const later = DateTime.utc().plus({ days: 8 }).toISO()!;
    const flipped = await markOverdueInvoices({ db: ctx.db, events: ctx.events }, ctx.tenantA.id, later);
    expect(flipped).toBe(1);
    const fetched = await json(await api(ctx.app, ctx.tenantA.id, 'GET', `/invoices/${sent.id}`));
    expect(fetched.data.status).toBe('overdue');
  });
});

describe('quote -> invoice conversion', () => {
  it('maps the quote payload contract onto an invoice with provenance', async () => {
    const ctx = await setupBilling();
    const res = await api(ctx.app, ctx.tenantA.id, 'POST', '/invoices/from-quote', {
      quoteId: 'quote-777',
      customerId: 'cust-7',
      lines: [
        { description: 'Line A', quantity: 2, unitPriceCents: 3_000, discountBps: 500 },
        { description: 'Line B', quantity: 1, unitPriceCents: 1_500 },
      ],
      discountFixedCents: 200,
      taxBps: 700,
      memo: 'Converted from accepted quote',
    });
    expect(res.status).toBe(201);
    const invoice = (await json(res)).data;
    expect(invoice.source_entity_type).toBe('quoting.quote');
    expect(invoice.source_entity_id).toBe('quote-777');
    expect(invoice.customer_id).toBe('cust-7');
    expect(invoice.number).toBe('INV-1');
    expect(invoice.status).toBe('draft');
    expect(invoice.lines).toHaveLength(2);
    expect(invoice.lines[0]).toMatchObject({
      description: 'Line A',
      quantity: 2,
      unit_price_cents: 3_000,
      discount_bps: 500,
      line_total_cents: 5_700, // 6000 - 5%
    });
    // subtotal 5700+1500=7200; -200 fixed = 7000; tax 7% = 490; total 7490
    expect(invoice.subtotal_cents).toBe(7_200);
    expect(invoice.total_cents).toBe(7_490);
  });
});

describe('CSV export', () => {
  it('exports the tenant invoices as CSV', async () => {
    const ctx = await setupBilling();
    await makeInvoice(ctx, ctx.tenantA.id, { customerId: 'csv-cust' });
    const paid = await makeSentInvoice(ctx, ctx.tenantA.id, { customerId: 'csv-cust' });
    await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${paid.id}/payments`, {
      amountCents: 10_000,
    });
    // Another tenant's invoice must not leak into the export.
    await makeInvoice(ctx, ctx.tenantB.id, { customerId: 'other-tenant-cust' });

    const res = await api(ctx.app, ctx.tenantA.id, 'GET', '/invoices/export.csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const rows = parseCsv(await res.text());
    expect(rows).toHaveLength(2);
    // Rows created within the same millisecond may swap order — look up by number.
    const byNumber = Object.fromEntries(rows.map((r) => [r.number, r]));
    expect(Object.keys(byNumber).sort()).toEqual(['INV-1', 'INV-2']);
    expect(byNumber['INV-1'].status).toBe('draft');
    expect(byNumber['INV-2'].status).toBe('paid');
    expect(byNumber['INV-2'].paid_cents).toBe('10000');
    expect(rows.every((r) => r.customer_id === 'csv-cust')).toBe(true);
  });
});

describe('tenant isolation — invoices', () => {
  it("denies tenant B any access to tenant A's invoice and leaves A intact", async () => {
    const ctx = await setupBilling();
    const invoice = await makeSentInvoice(ctx, ctx.tenantA.id, { customerId: 'iso-cust' });

    expect((await api(ctx.app, ctx.tenantB.id, 'GET', `/invoices/${invoice.id}`)).status).toBe(404);
    expect(
      (await api(ctx.app, ctx.tenantB.id, 'PUT', `/invoices/${invoice.id}`, { memo: 'steal' })).status,
    ).toBe(404);
    expect((await api(ctx.app, ctx.tenantB.id, 'DELETE', `/invoices/${invoice.id}`)).status).toBe(404);
    expect((await api(ctx.app, ctx.tenantB.id, 'POST', `/invoices/${invoice.id}/send`)).status).toBe(404);
    expect((await api(ctx.app, ctx.tenantB.id, 'POST', `/invoices/${invoice.id}/void`)).status).toBe(404);
    expect(
      (
        await api(ctx.app, ctx.tenantB.id, 'POST', `/invoices/${invoice.id}/payments`, {
          amountCents: 100,
        })
      ).status,
    ).toBe(404);

    const bList = await json(await api(ctx.app, ctx.tenantB.id, 'GET', '/invoices'));
    expect(bList.data).toEqual([]);
    const bPayments = await json(await api(ctx.app, ctx.tenantB.id, 'GET', '/payments'));
    expect(bPayments.data).toEqual([]);

    const aFetched = await json(await api(ctx.app, ctx.tenantA.id, 'GET', `/invoices/${invoice.id}`));
    expect(aFetched.data.id).toBe(invoice.id);
    expect(aFetched.data.status).toBe('sent');
    expect(aFetched.data.memo).not.toBe('steal');
  });
});
