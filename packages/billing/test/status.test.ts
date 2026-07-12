import { describe, expect, it } from 'vitest';
import { computeTotals } from '@blacklabel/core';
import { advanceInterval, computeInvoiceStatus } from '../src/service';
import { api, json, makeInvoice, setupBilling } from './helpers';

const NOW = '2026-07-10T12:00:00.000Z';

function statusOf(partial: {
  total_cents?: number;
  paid_cents?: number;
  sent_at?: string | null;
  due_at?: string | null;
  voided_at?: string | null;
}) {
  return computeInvoiceStatus(
    {
      total_cents: partial.total_cents ?? 10_000,
      paid_cents: partial.paid_cents ?? 0,
      sent_at: partial.sent_at ?? null,
      due_at: partial.due_at ?? null,
      voided_at: partial.voided_at ?? null,
    },
    NOW,
  );
}

describe('computeInvoiceStatus', () => {
  it('is draft before the invoice is sent', () => {
    expect(statusOf({})).toBe('draft');
  });

  it('is sent once sent with no payments and not past due', () => {
    expect(statusOf({ sent_at: NOW, due_at: '2026-08-01T00:00:00.000Z' })).toBe('sent');
    expect(statusOf({ sent_at: NOW })).toBe('sent');
  });

  it('is partial when 0 < paid < total', () => {
    expect(statusOf({ sent_at: NOW, paid_cents: 2_500 })).toBe('partial');
  });

  it('is paid when payments cover the total (incl. overpayment), even past due', () => {
    expect(statusOf({ sent_at: NOW, paid_cents: 10_000 })).toBe('paid');
    expect(statusOf({ sent_at: NOW, paid_cents: 12_000, due_at: '2020-01-01T00:00:00.000Z' })).toBe('paid');
  });

  it('is overdue when past due and unpaid or partially paid', () => {
    expect(statusOf({ sent_at: NOW, due_at: '2026-07-01T00:00:00.000Z' })).toBe('overdue');
    expect(statusOf({ sent_at: NOW, due_at: '2026-07-01T00:00:00.000Z', paid_cents: 5_000 })).toBe('overdue');
  });

  it('void wins over everything', () => {
    expect(statusOf({ voided_at: NOW, sent_at: NOW, paid_cents: 10_000 })).toBe('void');
  });

  it('a zero-total invoice does not count as paid', () => {
    expect(statusOf({ total_cents: 0, sent_at: NOW })).toBe('sent');
  });
});

describe('invoice money math (shared with quoting via core computeTotals)', () => {
  it('stores totals that agree with core computeTotals to the cent', async () => {
    const ctx = await setupBilling();
    const lines = [
      { description: 'Labor', quantity: 3, unitPriceCents: 1_999, discountBps: 1_000 },
      { description: 'Parts', quantity: 2.5, unitPriceCents: 1_000, discountFixedCents: 250 },
    ];
    const options = { discountBps: 500, discountFixedCents: 100, taxBps: 825 };
    const invoice = await makeInvoice(ctx, ctx.tenantA.id, { lines, ...options });

    const expected = computeTotals(
      lines.map((l) => ({
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        discount: {
          bps: (l as any).discountBps,
          fixedCents: (l as any).discountFixedCents,
        },
      })),
      {
        discount: { bps: options.discountBps, fixedCents: options.discountFixedCents },
        taxBps: options.taxBps,
      },
    );

    expect(invoice.subtotal_cents).toBe(expected.subtotalCents);
    expect(invoice.discount_cents).toBe(expected.discountCents);
    expect(invoice.tax_cents).toBe(expected.taxCents);
    expect(invoice.total_cents).toBe(expected.totalCents);
    expect(invoice.lines.map((l: any) => l.line_total_cents)).toEqual(expected.lineTotalsCents);

    // And pin the concrete cents so a computeTotals regression can't hide:
    // line1 3*1999=5997 -10% -> 5397; line2 round(2.5*1000)=2500 -250 -> 2250
    // subtotal 7647; -5% (382) - 100 -> 7165; tax 8.25% -> 591; total 7756.
    expect(invoice.subtotal_cents).toBe(7_647);
    expect(invoice.discount_cents).toBe(482);
    expect(invoice.tax_cents).toBe(591);
    expect(invoice.total_cents).toBe(7_756);
  });

  it('totals never go below zero with an oversized fixed discount', async () => {
    const ctx = await setupBilling();
    const invoice = await makeInvoice(ctx, ctx.tenantA.id, {
      lines: [{ description: 'Small job', quantity: 1, unitPriceCents: 500 }],
      discountFixedCents: 10_000,
      taxBps: 800,
    });
    expect(invoice.total_cents).toBe(0);
    expect(invoice.discount_cents).toBe(500);

    const res = await api(ctx.app, ctx.tenantA.id, 'GET', `/invoices/${invoice.id}`);
    expect((await json(res)).data.total_cents).toBe(0);
  });
});

describe('advanceInterval', () => {
  it('advances by the subscription interval in UTC', () => {
    expect(advanceInterval('2026-07-10T00:00:00.000Z', 'daily')).toBe('2026-07-11T00:00:00.000Z');
    expect(advanceInterval('2026-07-10T00:00:00.000Z', 'weekly')).toBe('2026-07-17T00:00:00.000Z');
    expect(advanceInterval('2026-07-10T00:00:00.000Z', 'monthly')).toBe('2026-08-10T00:00:00.000Z');
    expect(advanceInterval('2026-07-10T00:00:00.000Z', 'quarterly')).toBe('2026-10-10T00:00:00.000Z');
    expect(advanceInterval('2026-07-10T00:00:00.000Z', 'yearly')).toBe('2027-07-10T00:00:00.000Z');
  });

  it('clamps month-end dates like a calendar (Jan 31 + 1 month = Feb 28)', () => {
    expect(advanceInterval('2026-01-31T00:00:00.000Z', 'monthly')).toBe('2026-02-28T00:00:00.000Z');
  });
});
