import { describe, expect, it } from 'vitest';
import { api, json, paymentRows, setup } from './helpers';

async function seedPaymentsAndPayout(ctx: Awaited<ReturnType<typeof setup>>, payoutCents: number) {
  await api(ctx.app, ctx.tenantA, 'POST', '/import/payments', { rows: paymentRows() });
  await api(ctx.app, ctx.tenantA, 'POST', '/import/payouts', {
    rows: [{ sourcePayoutId: 'po_1', amountCents: payoutCents, status: 'PAID', paidAt: '2026-03-10T00:00:00.000Z' }],
  });
}

describe('payout reconciliation (journey 17)', () => {
  it('exact match: delta 0, matched, coverage window present, NO failure event', async () => {
    const ctx = await setup();
    // pay_1 net 9710 + pay_2 net 4825 = 14535
    await seedPaymentsAndPayout(ctx, 14535);
    const failures: any[] = [];
    ctx.events.on('finance.payout.reconciliation_failed', (e) => { failures.push(e); });

    const r = await json(
      await api(ctx.app, ctx.tenantA, 'POST', '/payout-matches/run', {
        sourcePayoutId: 'po_1',
        candidateSourcePaymentIds: ['pay_1', 'pay_2'],
      }),
    );
    expect(r.data.matched).toBe(1);
    expect(r.data.expected_cents).toBe(14535);
    expect(r.data.actual_cents).toBe(14535);
    expect(r.data.delta_cents).toBe(0);
    expect(r.data.candidate_count).toBe(2);
    const cov = JSON.parse(r.data.coverage_window);
    expect(cov.start).toBe('2026-03-07T15:00:00.000Z');
    expect(cov.end).toBe('2026-03-08T16:30:00.000Z');
    expect(failures).toHaveLength(0);
  });

  it('mismatch: delta computed to the cent + failure event emitted', async () => {
    const ctx = await setup();
    await seedPaymentsAndPayout(ctx, 14000); // 535 short of 14535
    const failures: any[] = [];
    ctx.events.on('finance.payout.reconciliation_failed', (e) => { failures.push(e); });

    const r = await json(
      await api(ctx.app, ctx.tenantA, 'POST', '/payout-matches/run', {
        sourcePayoutId: 'po_1',
        candidateSourcePaymentIds: ['pay_1', 'pay_2'],
      }),
    );
    expect(r.data.matched).toBe(0);
    expect(r.data.delta_cents).toBe(535); // actual 14535 - expected 14000
    expect(failures).toHaveLength(1);
    expect(failures[0].payload).toEqual({ v: 1, payoutId: r.data.payout_id, deltaCents: 535 });
  });

  it('unknown payout → 404', async () => {
    const ctx = await setup();
    const res = await api(ctx.app, ctx.tenantA, 'POST', '/payout-matches/run', {
      sourcePayoutId: 'nope',
      candidateSourcePaymentIds: [],
    });
    expect(res.status).toBe(404);
  });

  it('summary reports matched/unmatched with the window and a partial-coverage flag', async () => {
    const ctx = await setup();
    // payments span 03-07 .. 03-09; payout coverage only 03-07 .. 03-08 → partial.
    await api(ctx.app, ctx.tenantA, 'POST', '/import/payments', { rows: paymentRows() });
    await api(ctx.app, ctx.tenantA, 'POST', '/import/payouts', {
      rows: [
        {
          sourcePayoutId: 'po_1',
          amountCents: 14535,
          status: 'PAID',
          paidAt: '2026-03-10T00:00:00.000Z',
          coverageStart: '2026-03-07T00:00:00.000Z',
          coverageEnd: '2026-03-08T23:59:59.000Z',
        },
      ],
    });
    await api(ctx.app, ctx.tenantA, 'POST', '/payout-matches/run', {
      sourcePayoutId: 'po_1',
      candidateSourcePaymentIds: ['pay_1', 'pay_2'],
    });

    const s = await json(await api(ctx.app, ctx.tenantA, 'GET', '/payout-matches/summary'));
    expect(s.data.payoutCount).toBe(1);
    expect(s.data.matchedCount).toBe(1);
    expect(s.data.unmatchedCount).toBe(0);
    expect(s.data.partialCoverage).toBe(true);
    expect(s.data.paymentsPeriod.start).toBe('2026-03-07T15:00:00.000Z');
    expect(s.data.paymentsPeriod.end).toBe('2026-03-09T12:00:00.000Z');
    expect(s.data.payoutCoverage.start).toBe('2026-03-07T00:00:00.000Z');
    expect(s.data.payoutCoverage.end).toBe('2026-03-08T23:59:59.000Z');
  });

  it('summary partialCoverage=false when payouts fully span payments', async () => {
    const ctx = await setup();
    await api(ctx.app, ctx.tenantA, 'POST', '/import/payments', { rows: paymentRows() });
    await api(ctx.app, ctx.tenantA, 'POST', '/import/payouts', {
      rows: [
        {
          sourcePayoutId: 'po_1',
          amountCents: 16535,
          status: 'PAID',
          paidAt: '2026-03-10T00:00:00.000Z',
          coverageStart: '2026-03-06T00:00:00.000Z',
          coverageEnd: '2026-03-10T00:00:00.000Z',
        },
      ],
    });
    await api(ctx.app, ctx.tenantA, 'POST', '/payout-matches/run', {
      sourcePayoutId: 'po_1',
      candidateSourcePaymentIds: ['pay_1', 'pay_2', 'pay_3'],
    });
    const s = await json(await api(ctx.app, ctx.tenantA, 'GET', '/payout-matches/summary'));
    expect(s.data.partialCoverage).toBe(false);
    expect(s.data.matchedCount).toBe(1);
    expect(s.data.totalDeltaCents).toBe(0);
  });
});
