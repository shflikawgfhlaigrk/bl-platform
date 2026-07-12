import { describe, expect, it } from 'vitest';
import { suggestQty, type SuggestQtyInputs } from '../src/suggest';
import { weightedCost } from '../src/cost';

const base: SuggestQtyInputs = {
  onHand: 0,
  reserved: 0,
  inbound: 0,
  unitsPerWeekVelocity: 0,
  seasonalFactor: 1,
  leadTimeDays: 0,
  casePackQty: 1,
  minOrderQty: 0,
  safetyStock: 0,
  upcomingShowDemand: 0,
};

describe('suggestQty — every branch', () => {
  it('lead-time demand: velocity × seasonal × leadDays drives raw need', () => {
    // 14/wk = 2/day × seasonal 1 × 7 days = 14 demand; position 0 → need 14.
    const r = suggestQty({ ...base, unitsPerWeekVelocity: 14, leadTimeDays: 7 });
    expect(r.suggestedQty).toBe(14);
    expect(r.formulaTrace.some((s) => s.includes('demandDuringLeadTime'))).toBe(true);
  });

  it('seasonal factor scales demand', () => {
    // 2/day × seasonal 1.5 × 10 days = 30.
    const r = suggestQty({ ...base, unitsPerWeekVelocity: 14, seasonalFactor: 1.5, leadTimeDays: 10 });
    expect(r.suggestedQty).toBe(30);
  });

  it('safety stock adds to the target', () => {
    // demand 0, safety 5 → target 5, position 0 → need 5.
    const r = suggestQty({ ...base, safetyStock: 5 });
    expect(r.suggestedQty).toBe(5);
    expect(r.formulaTrace.some((s) => s.includes('safetyStock 5'))).toBe(true);
  });

  it('upcoming show demand adds to the target', () => {
    const r = suggestQty({ ...base, upcomingShowDemand: 8 });
    expect(r.suggestedQty).toBe(8);
    expect(r.formulaTrace.some((s) => s.includes('upcomingShowDemand 8'))).toBe(true);
  });

  it('position (onHand − reserved + inbound) reduces need', () => {
    // target 20 (safety), position = 10 - 3 + 1 = 8 → need 12.
    const r = suggestQty({ ...base, safetyStock: 20, onHand: 10, reserved: 3, inbound: 1 });
    expect(r.suggestedQty).toBe(12);
    expect(r.formulaTrace.some((s) => s.includes('position = onHand 10 − reserved 3 + inbound 1 = 8'))).toBe(true);
  });

  it('rounds UP to the case pack', () => {
    // need 13, case pack 6 → ceil(13/6)*6 = 18.
    const r = suggestQty({ ...base, safetyStock: 13, casePackQty: 6 });
    expect(r.suggestedQty).toBe(18);
    expect(r.formulaTrace.some((s) => s.includes('casePack rounding'))).toBe(true);
  });

  it('applies the minimum-order floor (re-rounded to case pack)', () => {
    // need 4, case pack 6 → 6; min order 12 → ceil(12/6)*6 = 12.
    const r = suggestQty({ ...base, safetyStock: 4, casePackQty: 6, minOrderQty: 12 });
    expect(r.suggestedQty).toBe(12);
    expect(r.formulaTrace.some((s) => s.includes('minOrder floor'))).toBe(true);
  });

  it('owner override WINS over the computed quantity', () => {
    const r = suggestQty({ ...base, safetyStock: 100, casePackQty: 6, ownerOverrideQty: 3 });
    expect(r.suggestedQty).toBe(3);
    expect(r.formulaTrace.some((s) => s.includes('ownerOverride present → final 3'))).toBe(true);
  });

  it('owner override of 0 still wins (suppresses an order)', () => {
    const r = suggestQty({ ...base, safetyStock: 100, ownerOverrideQty: 0 });
    expect(r.suggestedQty).toBe(0);
  });

  it('zero velocity and no other demand → 0, honest trace, never NaN/Infinity', () => {
    const r = suggestQty({ ...base, onHand: 5 });
    expect(r.suggestedQty).toBe(0);
    expect(Number.isNaN(r.suggestedQty)).toBe(false);
    expect(Number.isFinite(r.suggestedQty)).toBe(true);
    expect(r.formulaTrace.some((s) => s.includes('no order needed'))).toBe(true);
  });

  it('surplus position (need <= 0) yields 0', () => {
    const r = suggestQty({ ...base, safetyStock: 3, onHand: 100 });
    expect(r.suggestedQty).toBe(0);
  });
});

describe('weightedCost rounding', () => {
  it('computes a weighted average with Math.round', () => {
    // (10*100 + 5*130) / 15 = 1650/15 = 110.
    expect(weightedCost({ qty: 10, costCents: 100 }, { qty: 5, costCents: 130 })).toEqual({
      qty: 15,
      costCents: 110,
    });
  });

  it('rounds half up to the nearest cent', () => {
    // (1*100 + 2*101)/3 = 302/3 = 100.666… → 101.
    expect(weightedCost({ qty: 1, costCents: 100 }, { qty: 2, costCents: 101 })).toEqual({
      qty: 3,
      costCents: 101,
    });
  });

  it('zero total quantity → { qty: 0, costCents: 0 } (never NaN)', () => {
    expect(weightedCost({ qty: 0, costCents: 0 }, { qty: 0, costCents: 0 })).toEqual({
      qty: 0,
      costCents: 0,
    });
  });
});
