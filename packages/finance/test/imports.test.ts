import { describe, expect, it } from 'vitest';
import { api, json, paymentRows, setup } from './helpers';

describe('finance ledger imports — idempotency', () => {
  it('importPayments is idempotent: twice → same counts, zero dupes', async () => {
    const ctx = await setup();
    const rows = paymentRows();

    const r1 = await json(await api(ctx.app, ctx.tenantA, 'POST', '/import/payments', { rows }));
    expect(r1.data).toEqual({ inserted: 3, updated: 0, skipped: 0 });

    const r2 = await json(await api(ctx.app, ctx.tenantA, 'POST', '/import/payments', { rows }));
    expect(r2.data).toEqual({ inserted: 0, updated: 0, skipped: 3 });

    const stored = await ctx.db
      .selectFrom('finance_payments')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantA.id)
      .execute();
    expect(stored).toHaveLength(3);
  });

  it('re-import with a changed field updates, not duplicates', async () => {
    const ctx = await setup();
    const rows = paymentRows();
    await api(ctx.app, ctx.tenantA, 'POST', '/import/payments', { rows });

    const changed = paymentRows();
    changed[0].status = 'REFUNDED';
    const r = await json(await api(ctx.app, ctx.tenantA, 'POST', '/import/payments', { rows: changed }));
    expect(r.data).toEqual({ inserted: 0, updated: 1, skipped: 2 });

    const stored = await ctx.db
      .selectFrom('finance_payments')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantA.id)
      .execute();
    expect(stored).toHaveLength(3);
    expect(stored.find((p) => p.source_payment_id === 'pay_1')!.status).toBe('REFUNDED');
  });

  it('dedupes within a single batch (same source id twice)', async () => {
    const ctx = await setup();
    const dup = [paymentRows()[0], paymentRows()[0]];
    const r = await json(await api(ctx.app, ctx.tenantA, 'POST', '/import/payments', { rows: dup }));
    expect(r.data).toEqual({ inserted: 1, updated: 0, skipped: 1 });
  });

  it('refunds / payouts / disputes / vendor-bills / tax-evidence imports are all idempotent', async () => {
    const ctx = await setup();

    const refunds = [{ sourceRefundId: 'ref_1', paymentRef: 'pay_1', amountCents: 4999, occurredAt: '2026-03-15T12:00:00.000Z' }];
    expect((await json(await api(ctx.app, ctx.tenantA, 'POST', '/import/refunds', { rows: refunds }))).data)
      .toEqual({ inserted: 1, updated: 0, skipped: 0 });
    expect((await json(await api(ctx.app, ctx.tenantA, 'POST', '/import/refunds', { rows: refunds }))).data)
      .toEqual({ inserted: 0, updated: 0, skipped: 1 });

    const payouts = [{ sourcePayoutId: 'po_1', amountCents: 14535, status: 'PAID', paidAt: '2026-03-10T00:00:00.000Z' }];
    expect((await json(await api(ctx.app, ctx.tenantA, 'POST', '/import/payouts', { rows: payouts }))).data)
      .toEqual({ inserted: 1, updated: 0, skipped: 0 });
    expect((await json(await api(ctx.app, ctx.tenantA, 'POST', '/import/payouts', { rows: payouts }))).data)
      .toEqual({ inserted: 0, updated: 0, skipped: 1 });

    const disputes = [{ sourceDisputeId: 'dp_1', paymentRef: 'pay_1', amountCents: 15408, status: 'LOST', occurredAt: '2026-04-01T00:00:00.000Z' }];
    expect((await json(await api(ctx.app, ctx.tenantA, 'POST', '/import/disputes', { rows: disputes }))).data)
      .toEqual({ inserted: 1, updated: 0, skipped: 0 });
    expect((await json(await api(ctx.app, ctx.tenantA, 'POST', '/import/disputes', { rows: disputes }))).data)
      .toEqual({ inserted: 0, updated: 0, skipped: 1 });

    const bills = [{ vendorBillRef: 'vb_1', vendorRef: 'v_1', amountCents: 50000, status: 'OPEN', occurredAt: null }];
    expect((await json(await api(ctx.app, ctx.tenantA, 'POST', '/import/vendor-bills', { rows: bills }))).data)
      .toEqual({ inserted: 1, updated: 0, skipped: 0 });
    expect((await json(await api(ctx.app, ctx.tenantA, 'POST', '/import/vendor-bills', { rows: bills }))).data)
      .toEqual({ inserted: 0, updated: 0, skipped: 1 });

    const evidence = [{ sourceEvidenceId: 'te_1', orderRef: 'ord_1', jurisdictionSource: 'pos_location', state: null, amountCents: 700, occurredAt: '2026-03-07T15:00:00.000Z' }];
    expect((await json(await api(ctx.app, ctx.tenantA, 'POST', '/import/tax-evidence', { rows: evidence }))).data)
      .toEqual({ inserted: 1, updated: 0, skipped: 0 });
    expect((await json(await api(ctx.app, ctx.tenantA, 'POST', '/import/tax-evidence', { rows: evidence }))).data)
      .toEqual({ inserted: 0, updated: 0, skipped: 1 });
  });

  it('rejects non-integer cents', async () => {
    const ctx = await setup();
    const rows = paymentRows();
    (rows[0] as any).amountCents = 100.5;
    const res = await api(ctx.app, ctx.tenantA, 'POST', '/import/payments', { rows });
    expect(res.status).toBe(400);
  });
});

describe('finance tenant isolation', () => {
  it('tenant B cannot see tenant A payments; A untouched', async () => {
    const ctx = await setup();
    await api(ctx.app, ctx.tenantA, 'POST', '/import/payments', { rows: paymentRows() });

    const aRows = await ctx.db.selectFrom('finance_payments').selectAll().where('tenant_id', '=', ctx.tenantA.id).execute();
    const bRows = await ctx.db.selectFrom('finance_payments').selectAll().where('tenant_id', '=', ctx.tenantB.id).execute();
    expect(aRows).toHaveLength(3);
    expect(bRows).toHaveLength(0);

    // B imports its own — A's stays at 3.
    await api(ctx.app, ctx.tenantB, 'POST', '/import/payments', { rows: [paymentRows()[0]] });
    const aAfter = await ctx.db.selectFrom('finance_payments').selectAll().where('tenant_id', '=', ctx.tenantA.id).execute();
    expect(aAfter).toHaveLength(3);
  });

  it('missing x-tenant-id → 400; unknown tenant → 404', async () => {
    const ctx = await setup();
    const noTenant = await ctx.app.request('/import/payments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rows: [] }),
    });
    expect(noTenant.status).toBe(400);

    const badTenant = await api(ctx.app, 'nonexistent-tenant', 'POST', '/import/payments', { rows: [] });
    expect(badTenant.status).toBe(404);
  });

  it('cash session of tenant A is 404 for tenant B', async () => {
    const ctx = await setup();
    const s = await json(await api(ctx.app, ctx.tenantA, 'POST', '/cash-sessions', { openedBy: 'u1', openingFloatCents: 10000 }));
    const bGet = await api(ctx.app, ctx.tenantB, 'GET', `/cash-sessions/${s.data.id}`);
    expect(bGet.status).toBe(404);
  });
});
