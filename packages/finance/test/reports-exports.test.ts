import { describe, expect, it } from 'vitest';
import { listAuditEntries, asCoreDb } from '@blacklabel/core';
import { api, json, paymentRows, setup } from './helpers';

async function seedForPeriod(ctx: Awaited<ReturnType<typeof setup>>) {
  await api(ctx.app, ctx.tenantA, 'POST', '/import/payments', { rows: paymentRows() });
  await api(ctx.app, ctx.tenantA, 'POST', '/import/refunds', {
    rows: [{ sourceRefundId: 'ref_1', paymentRef: 'pay_1', amountCents: 4999, occurredAt: '2026-03-15T12:00:00.000Z' }],
  });
}

describe('period rollups', () => {
  it('computes gross/refunds/net/fees/fee-rate to the cent for a month', async () => {
    const ctx = await setup();
    await seedForPeriod(ctx);
    const s = await json(await api(ctx.app, ctx.tenantA, 'GET', '/period-summary?period=2026-03'));
    expect(s.data.grain).toBe('month');
    expect(s.data.grossCents).toBe(17000); // 10000 + 5000 + 2000
    expect(s.data.feesCents).toBe(465); // 290 + 175 + 0
    expect(s.data.refundsCents).toBe(4999);
    expect(s.data.netCents).toBe(12001);
    expect(s.data.effectiveFeeRateBps).toBe(274); // round(465/17000*10000)
    expect(s.data.paymentCount).toBe(3);
    expect(s.data.refundCount).toBe(1);
    expect(s.data.paymentSourceIdsSample).toContain('pay_1');

    const bySource = Object.fromEntries(s.data.bySourceKind.map((l: any) => [l.sourceKind, l]));
    expect(bySource.card.grossCents).toBe(15000);
    expect(bySource.card.count).toBe(2);
    expect(bySource.cash.grossCents).toBe(2000);
  });

  it('year grain aggregates and excludes non-completed payments', async () => {
    const ctx = await setup();
    const rows = paymentRows();
    rows.push({
      sourcePaymentId: 'pay_failed',
      orderRef: null,
      amountCents: 9999,
      feeCents: 0,
      netCents: 9999,
      sourceKind: 'card',
      cardBrand: 'VISA',
      status: 'FAILED',
      occurredAt: '2026-05-01T00:00:00.000Z',
    });
    await api(ctx.app, ctx.tenantA, 'POST', '/import/payments', { rows });
    const s = await json(await api(ctx.app, ctx.tenantA, 'GET', '/period-summary?period=2026'));
    expect(s.data.grossCents).toBe(17000); // FAILED excluded
    expect(s.data.paymentCount).toBe(3);
  });

  it('rejects a malformed period', async () => {
    const ctx = await setup();
    const res = await api(ctx.app, ctx.tenantA, 'GET', '/period-summary?period=March');
    expect(res.status).toBe(400);
  });
});

describe('tax config + evidence', () => {
  it('tax config is configuration only (registered flag, optional rate, no conclusions)', async () => {
    const ctx = await setup();
    const created = await json(
      await api(ctx.app, ctx.tenantA, 'POST', '/tax-configs', {
        jurisdiction: 'GA',
        registered: true,
        rateBps: 700,
        notes: 'home state',
      }),
    );
    expect(created.data.registered).toBe(1);
    expect(created.data.rate_bps).toBe(700);

    // upsert same jurisdiction updates in place (no dup)
    await api(ctx.app, ctx.tenantA, 'POST', '/tax-configs', { jurisdiction: 'GA', registered: false });
    const list = await json(await api(ctx.app, ctx.tenantA, 'GET', '/tax-configs'));
    expect(list.data).toHaveLength(1);
    expect(list.data[0].registered).toBe(0);
  });

  it('evidence export groups by state+month with an explicit UNKNOWN bucket', async () => {
    const ctx = await setup();
    await api(ctx.app, ctx.tenantA, 'POST', '/import/tax-evidence', {
      rows: [
        { sourceEvidenceId: 'te_1', orderRef: 'o1', jurisdictionSource: 'ship_to', state: 'GA', amountCents: 700, occurredAt: '2026-03-07T15:00:00.000Z' },
        { sourceEvidenceId: 'te_2', orderRef: 'o2', jurisdictionSource: 'ship_to', state: 'GA', amountCents: 300, occurredAt: '2026-03-20T15:00:00.000Z' },
        { sourceEvidenceId: 'te_3', orderRef: 'o3', jurisdictionSource: 'pos_location', state: null, amountCents: 500, occurredAt: '2026-03-09T15:00:00.000Z' },
      ],
    });
    const groups = (await json(await api(ctx.app, ctx.tenantA, 'GET', '/tax-evidence/export'))).data;
    const ga = groups.find((g: any) => g.state === 'GA' && g.month === '2026-03');
    const unknown = groups.find((g: any) => g.state === 'UNKNOWN' && g.month === '2026-03');
    expect(ga.amountCents).toBe(1000);
    expect(ga.count).toBe(2);
    expect(unknown.amountCents).toBe(500);
    expect(unknown.sourceIdsSample).toContain('te_3');
  });
});

describe('liability snapshots', () => {
  it('records outstanding liability with provenance and returns history newest-first', async () => {
    const ctx = await setup();
    await api(ctx.app, ctx.tenantA, 'POST', '/liability-snapshots', {
      outstandingCents: 44660,
      source: 'gift_cards',
      asOf: '2026-06-01T00:00:00.000Z',
    });
    await api(ctx.app, ctx.tenantA, 'POST', '/liability-snapshots', {
      outstandingCents: 40000,
      source: 'gift_cards',
      asOf: '2026-07-01T00:00:00.000Z',
    });
    const list = await json(await api(ctx.app, ctx.tenantA, 'GET', '/liability-snapshots?source=gift_cards'));
    expect(list.data).toHaveLength(2);
    expect(list.data[0].as_of).toBe('2026-07-01T00:00:00.000Z');
    expect(list.data[0].outstanding_cents).toBe(40000);
  });
});

describe('CSV exports', () => {
  it('payments CSV carries source ids and integer-cent amounts', async () => {
    const ctx = await setup();
    await api(ctx.app, ctx.tenantA, 'POST', '/import/payments', { rows: paymentRows() });
    const res = await api(ctx.app, ctx.tenantA, 'GET', '/exports/payments.csv');
    expect(res.headers.get('content-type')).toContain('text/csv');
    const text = await res.text();
    const lines = text.trim().split('\n');
    expect(lines[0]).toBe('source_payment_id,order_ref,amount_cents,fee_cents,net_cents,source_kind,card_brand,status,occurred_at');
    expect(text).toContain('pay_1');
    expect(text).toContain('10000');
    // amounts are round integers, never a decimal point
    for (const l of lines.slice(1)) {
      const amount = l.split(',')[2];
      expect(amount).toMatch(/^\d+$/);
    }
  });

  it('payouts CSV includes match columns for drill-through', async () => {
    const ctx = await setup();
    await api(ctx.app, ctx.tenantA, 'POST', '/import/payments', { rows: paymentRows() });
    await api(ctx.app, ctx.tenantA, 'POST', '/import/payouts', {
      rows: [{ sourcePayoutId: 'po_1', amountCents: 14535, status: 'PAID', paidAt: '2026-03-10T00:00:00.000Z' }],
    });
    await api(ctx.app, ctx.tenantA, 'POST', '/payout-matches/run', {
      sourcePayoutId: 'po_1',
      candidateSourcePaymentIds: ['pay_1', 'pay_2'],
    });
    const text = await (await api(ctx.app, ctx.tenantA, 'GET', '/exports/payouts.csv')).text();
    expect(text).toContain('source_payout_id');
    expect(text).toContain('delta_cents');
    expect(text).toContain('po_1');
  });

  it('rejects an unknown export kind', async () => {
    const ctx = await setup();
    const res = await api(ctx.app, ctx.tenantA, 'GET', '/exports/bogus.csv');
    expect(res.status).toBe(400);
  });
});

describe('audit trail', () => {
  it('every mutation writes an audit entry', async () => {
    const ctx = await setup();
    await api(ctx.app, ctx.tenantA, 'POST', '/import/payments', { rows: paymentRows() });
    const opened = await json(
      await api(ctx.app, ctx.tenantA, 'POST', '/cash-sessions', { openedBy: 'c', openingFloatCents: 5000 }),
    );

    const importAudits = await listAuditEntries(asCoreDb(ctx.db), ctx.tenantA.id, 'finance.payment', 'batch');
    expect(importAudits.length).toBeGreaterThanOrEqual(1);

    const cashAudits = await listAuditEntries(asCoreDb(ctx.db), ctx.tenantA.id, 'finance.cash_session', opened.data.id);
    expect(cashAudits.some((a) => a.action === 'finance.cash_session.opened')).toBe(true);
  });
});
