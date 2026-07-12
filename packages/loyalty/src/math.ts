/**
 * Deterministic, dad-explainable loyalty math. PURE functions only — every
 * computation returns a human-readable trace. No clock, no randomness here.
 *
 * Two program models (mutually exclusive in `rules`):
 *   1. POINTS: { earnPerDollarBps }
 *      points per dollar = earnPerDollarBps / 10000 (10000 bps = 1 point/$1).
 *      earned = round(totalCents * earnPerDollarBps / 1_000_000)
 *      (totalCents/100 dollars * earnPerDollarBps/10000 points-per-dollar).
 *   2. PUNCH: { punchThresholdCents, punchesForReward }
 *      an order whose total >= punchThresholdCents earns exactly 1 punch;
 *      a reward becomes available once balance >= punchesForReward.
 *
 * Ledger amounts are program-native units: points for POINTS, punches for PUNCH.
 */

export interface PointsRules {
  earnPerDollarBps: number;
}
export interface PunchRules {
  punchThresholdCents: number;
  punchesForReward: number;
}
export type ProgramRules = PointsRules | PunchRules;

export function isPunchRules(r: ProgramRules): r is PunchRules {
  return (r as PunchRules).punchThresholdCents !== undefined;
}
export function isPointsRules(r: ProgramRules): r is PointsRules {
  return (r as PointsRules).earnPerDollarBps !== undefined;
}

export interface EarnTrace {
  model: 'points' | 'punch';
  totalCents: number;
  earned: number;
  formula: string;
  [k: string]: unknown;
}

/** Compute the units earned for an order total under a program's rules. */
export function computeEarn(rules: ProgramRules, totalCents: number): EarnTrace {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new Error(`totalCents must be a non-negative integer, got ${totalCents}`);
  }
  if (isPointsRules(rules)) {
    const bps = rules.earnPerDollarBps;
    if (!Number.isInteger(bps) || bps < 0) {
      throw new Error(`earnPerDollarBps must be a non-negative integer, got ${bps}`);
    }
    const earned = Math.round((totalCents * bps) / 1_000_000);
    return {
      model: 'points',
      totalCents,
      earnPerDollarBps: bps,
      earned,
      formula: `round(${totalCents} * ${bps} / 1000000) = ${earned}`,
    };
  }
  if (isPunchRules(rules)) {
    const earned = totalCents >= rules.punchThresholdCents ? 1 : 0;
    return {
      model: 'punch',
      totalCents,
      punchThresholdCents: rules.punchThresholdCents,
      punchesForReward: rules.punchesForReward,
      earned,
      formula: `${totalCents} >= ${rules.punchThresholdCents} ? 1 : 0 = ${earned}`,
    };
  }
  throw new Error('program rules must define earnPerDollarBps or punchThresholdCents');
}

/**
 * Apply a per-account daily earn cap. Returns the amount that may actually be
 * booked plus a trace of the cap decision.
 */
export function applyDailyCap(
  computed: number,
  alreadyEarnedToday: number,
  cap: number | null,
): { granted: number; capApplied: boolean; remaining: number | null } {
  if (cap == null) return { granted: computed, capApplied: false, remaining: null };
  const remaining = Math.max(cap - alreadyEarnedToday, 0);
  const granted = Math.min(computed, remaining);
  return { granted, capApplied: granted < computed, remaining };
}
