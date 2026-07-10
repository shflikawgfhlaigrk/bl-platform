import { describe, expect, it } from 'vitest';
import { applyDiscount, computeTotals } from '@blacklabel/core';

describe('applyDiscount', () => {
  it('applies bps then fixed cents, clamped at zero', () => {
    expect(applyDiscount(1000)).toBe(1000);
    expect(applyDiscount(1000, { bps: 500 })).toBe(950); // 5%
    expect(applyDiscount(1000, { fixedCents: 200 })).toBe(800);
    expect(applyDiscount(1000, { bps: 1000, fixedCents: 100 })).toBe(800); // 1000-100-100
    expect(applyDiscount(100, { fixedCents: 500 })).toBe(0); // clamp
  });

  it('rounds half away from zero at the bps step', () => {
    // 333 * 5% = 16.65 -> 17
    expect(applyDiscount(333, { bps: 500 })).toBe(316);
  });

  it('rejects non-integer cents and out-of-range bps', () => {
    expect(() => applyDiscount(10.5)).toThrow(/integer cents/);
    expect(() => applyDiscount(100, { bps: 10001 })).toThrow(/bps/);
    expect(() => applyDiscount(100, { bps: -1 })).toThrow(/bps/);
    expect(() => applyDiscount(100, { fixedCents: -5 })).toThrow(/fixedCents/);
  });
});

describe('computeTotals', () => {
  it('applies line discounts, then order discount, then tax — in that order', () => {
    const totals = computeTotals(
      [
        { quantity: 3, unitPriceCents: 1000, discount: { bps: 500 } }, // 3000 - 150 = 2850
        { quantity: 2, unitPriceCents: 2499, discount: { fixedCents: 500 } }, // 4998 - 500 = 4498
      ],
      { discount: { bps: 1000 }, taxBps: 825 },
    );
    expect(totals.lineTotalsCents).toEqual([2850, 4498]);
    expect(totals.subtotalCents).toBe(7348);
    // order discount: round(7348 * 10%) = 735
    expect(totals.discountCents).toBe(735);
    // tax on 6613: round(6613 * 8.25%) = round(545.5725) = 546
    expect(totals.taxCents).toBe(546);
    expect(totals.totalCents).toBe(7159);
  });

  it('supports fractional quantities (hours) with per-line rounding', () => {
    const totals = computeTotals([{ quantity: 2.5, unitPriceCents: 999 }]);
    expect(totals.lineTotalsCents).toEqual([2498]); // round(2497.5)
    expect(totals.subtotalCents).toBe(2498);
    expect(totals.totalCents).toBe(2498);
  });

  it('handles empty lines and no options', () => {
    const totals = computeTotals([]);
    expect(totals).toEqual({
      lineTotalsCents: [],
      subtotalCents: 0,
      discountCents: 0,
      taxCents: 0,
      totalCents: 0,
    });
  });

  it('validates inputs', () => {
    expect(() => computeTotals([{ quantity: -1, unitPriceCents: 100 }])).toThrow(/quantity/);
    expect(() => computeTotals([{ quantity: 1, unitPriceCents: 10.5 }])).toThrow(/integer cents/);
    expect(() => computeTotals([], { taxBps: -1 })).toThrow(/taxBps/);
  });
});
