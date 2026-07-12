import type { RuleCondition } from './schema';

/** Read a dot-path (e.g. "a.b.0.c") out of a JSON value; undefined if absent. */
export function getPath(value: unknown, path: string): unknown {
  if (path === '') return value;
  let cur: unknown = value;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** Evaluate one condition against an event payload. Deterministic, total. */
export function evaluateCondition(payload: unknown, cond: RuleCondition): boolean {
  const actual = getPath(payload, cond.path);
  const expected = cond.value;

  switch (cond.op) {
    case 'exists': {
      // value===false means "must be absent"; otherwise "must be present".
      const present = actual !== undefined;
      return expected === false ? !present : present;
    }
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'contains': {
      if (Array.isArray(actual)) return actual.includes(expected);
      if (typeof actual === 'string') return actual.includes(String(expected));
      return false;
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = asNumber(actual);
      const b = asNumber(expected);
      if (a !== undefined && b !== undefined) {
        if (cond.op === 'gt') return a > b;
        if (cond.op === 'gte') return a >= b;
        if (cond.op === 'lt') return a < b;
        return a <= b;
      }
      // Fall back to lexicographic string comparison when both are strings.
      if (typeof actual === 'string' && typeof expected === 'string') {
        if (cond.op === 'gt') return actual > expected;
        if (cond.op === 'gte') return actual >= expected;
        if (cond.op === 'lt') return actual < expected;
        return actual <= expected;
      }
      return false;
    }
    default:
      return false;
  }
}

/** All conditions must pass (AND). An empty list matches everything. */
export function evaluateConditions(payload: unknown, conditions: RuleCondition[]): boolean {
  return conditions.every((c) => evaluateCondition(payload, c));
}
