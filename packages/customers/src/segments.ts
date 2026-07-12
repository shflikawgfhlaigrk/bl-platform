/**
 * Deterministic segment definitions AS DATA + a PURE evaluator.
 *
 * A segment rule set is `{ all: [{ field, op, value }] }` (AND of predicates)
 * evaluated over a STATS INPUT MAP fed by the integrator. Evaluation is a pure
 * function: same rules + same stats -> same members + same inputs_hash.
 */
import { hashInputs } from './normalize';

export type SegmentOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'within_days'
  | 'older_than_days'
  | 'is_null'
  | 'not_null';

export const SEGMENT_OPS: readonly SegmentOp[] = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'within_days',
  'older_than_days',
  'is_null',
  'not_null',
];

export interface SegmentPredicate {
  field: string;
  op: SegmentOp;
  value?: unknown;
}

export interface SegmentRules {
  all: SegmentPredicate[];
}

/**
 * Per-profile stats fed in by the integrator (orders/finance modules own the
 * numbers; this module never reads them). All money is integer cents; dates
 * are ISO-8601 UTC strings.
 */
export interface ProfileStats {
  lifetimeCents?: number;
  orderCount?: number;
  lastOrderAt?: string | null;
  firstOrderAt?: string | null;
  categoryTop?: string | null;
  region?: string | null;
  /** Current email consent state, injected from the consent ledger. */
  emailConsentState?: string | null;
  /** Current sms consent state, injected from the consent ledger. */
  smsConsentState?: string | null;
  /** Anything else the integrator wants to key rules on. */
  [key: string]: unknown;
}

export type StatsInputMap = Record<string, ProfileStats>;

export interface SegmentEvaluation {
  /** Member profile ids, sorted ascending for determinism. */
  members: string[];
  /** Fingerprint of (rules + exact evaluated inputs) — proves reproducibility. */
  inputsHash: string;
}

const DAY_MS = 86_400_000;

function daysBetween(fromIso: string, nowIso: string): number {
  return (Date.parse(nowIso) - Date.parse(fromIso)) / DAY_MS;
}

/** Evaluate one predicate against one profile's stats + evaluation clock. */
export function evaluatePredicate(
  stats: ProfileStats,
  pred: SegmentPredicate,
  nowIso: string,
): boolean {
  const raw = stats[pred.field];
  switch (pred.op) {
    case 'is_null':
      return raw == null;
    case 'not_null':
      return raw != null;
    case 'eq':
      return raw === pred.value;
    case 'ne':
      return raw !== pred.value;
    case 'gt':
      return typeof raw === 'number' && raw > Number(pred.value);
    case 'gte':
      return typeof raw === 'number' && raw >= Number(pred.value);
    case 'lt':
      return typeof raw === 'number' && raw < Number(pred.value);
    case 'lte':
      return typeof raw === 'number' && raw <= Number(pred.value);
    case 'in':
      return Array.isArray(pred.value) && pred.value.includes(raw as never);
    case 'within_days': {
      if (typeof raw !== 'string') return false;
      const d = daysBetween(raw, nowIso);
      return d >= 0 && d <= Number(pred.value);
    }
    case 'older_than_days': {
      if (typeof raw !== 'string') return false;
      return daysBetween(raw, nowIso) >= Number(pred.value);
    }
    default:
      return false;
  }
}

/** True iff every predicate in `all` holds. Empty rule set matches nobody. */
export function matchesRules(stats: ProfileStats, rules: SegmentRules, nowIso: string): boolean {
  if (!rules.all || rules.all.length === 0) return false;
  return rules.all.every((p) => evaluatePredicate(stats, p, nowIso));
}

/**
 * PURE segment evaluation. Deterministic: members sorted, inputs_hash derived
 * from the rules plus the exact per-profile stats that were actually consulted
 * (so re-running with identical inputs yields an identical hash).
 */
export function evaluateSegment(
  rules: SegmentRules,
  stats: StatsInputMap,
  nowIso: string,
): SegmentEvaluation {
  const members: string[] = [];
  for (const profileId of Object.keys(stats)) {
    const s = stats[profileId];
    if (s && matchesRules(s, rules, nowIso)) members.push(profileId);
  }
  members.sort();
  // Hash the rules + the stats of the MEMBERS (the inputs that produced the
  // result) + the clock. Non-member noise cannot change the fingerprint.
  const memberInputs: Record<string, ProfileStats> = {};
  for (const id of members) memberInputs[id] = stats[id]!;
  const inputsHash = hashInputs({ rules, nowIso, members: memberInputs });
  return { members, inputsHash };
}

export interface BuiltinSegmentDef {
  name: string;
  rules: SegmentRules;
}

/**
 * Built-in seeded segment definitions. `vipThresholdCents` and
 * `lapsedLifetimeCents` are configurable at seed time.
 */
export function builtinSegments(config: {
  vipThresholdCents?: number;
  lapsedLifetimeCents?: number;
} = {}): BuiltinSegmentDef[] {
  const vip = config.vipThresholdCents ?? 100_000; // $1,000 lifetime default
  const lapsedFloor = config.lapsedLifetimeCents ?? 50_000; // $500 default
  return [
    { name: 'new', rules: { all: [{ field: 'firstOrderAt', op: 'within_days', value: 60 }] } },
    { name: 'repeat', rules: { all: [{ field: 'orderCount', op: 'gte', value: 2 }] } },
    { name: 'vip', rules: { all: [{ field: 'lifetimeCents', op: 'gte', value: vip }] } },
    {
      name: 'lapsed',
      rules: {
        all: [
          { field: 'lastOrderAt', op: 'older_than_days', value: 365 },
          { field: 'lifetimeCents', op: 'gte', value: lapsedFloor },
        ],
      },
    },
    {
      name: 'consented_email',
      rules: { all: [{ field: 'emailConsentState', op: 'eq', value: 'granted' }] },
    },
  ];
}
