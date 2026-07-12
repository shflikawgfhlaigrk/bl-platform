import { describe, expect, it } from 'vitest';
import { applyDailyCap, computeEarn } from '@blacklabel/loyalty';

describe('loyalty math: deterministic + traced', () => {
  it('points: earned = round(totalCents * earnPerDollarBps / 1e6), with trace', () => {
    // 10000 bps = 1 point per dollar. $50.00 -> 50 points.
    const t = computeEarn({ earnPerDollarBps: 10000 }, 5000);
    expect(t.model).toBe('points');
    expect(t.earned).toBe(50);
    expect(t.formula).toContain('5000');
    // 20000 bps = 2 points per dollar. $12.34 -> round(24.68) = 25.
    expect(computeEarn({ earnPerDollarBps: 20000 }, 1234).earned).toBe(25);
  });

  it('punch: 1 punch iff total >= threshold, with trace', () => {
    const rules = { punchThresholdCents: 2500, punchesForReward: 10 };
    expect(computeEarn(rules, 2500).earned).toBe(1);
    expect(computeEarn(rules, 2499).earned).toBe(0);
    expect(computeEarn(rules, 9999).earned).toBe(1);
  });

  it('is fully deterministic (same inputs -> identical trace)', () => {
    const a = computeEarn({ earnPerDollarBps: 15000 }, 3333);
    const b = computeEarn({ earnPerDollarBps: 15000 }, 3333);
    expect(a).toEqual(b);
  });

  it('daily cap clamps earn to the remaining allowance', () => {
    expect(applyDailyCap(30, 0, null)).toEqual({ granted: 30, capApplied: false, remaining: null });
    expect(applyDailyCap(30, 80, 100)).toEqual({ granted: 20, capApplied: true, remaining: 20 });
    expect(applyDailyCap(30, 100, 100)).toEqual({ granted: 0, capApplied: true, remaining: 0 });
  });
});
