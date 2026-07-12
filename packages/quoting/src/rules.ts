/**
 * Safe, data-driven pricing-rule interpreter. Rules are stored as JSON and
 * evaluated by walking plain data — there is NO eval, NO Function
 * constructor, NO dynamic code of any kind.
 *
 * A rule is: IF all `conditions` match the attribute bag THEN apply `action`.
 *
 * Scopes:
 * - 'line'  : attribute bag is one quote line; the action adjusts that
 *             line's effective unit price (before line discounts).
 *             Actions: percent_adjust (signed bps), fixed_adjust (signed
 *             cents), set_price (cents). Result clamped at 0.
 * - 'quote' : attribute bag is the whole quote; the action grants an extra
 *             quote-level discount (surcharges belong on lines).
 *             Actions: percent_discount (bps of the post-line-discount
 *             subtotal), fixed_discount (cents).
 */

export type RuleOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in';

export const RULE_OPS: readonly RuleOp[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in'];

export interface RuleCondition {
  field: string;
  op: RuleOp;
  value: unknown;
}

export type LineRuleActionType = 'percent_adjust' | 'fixed_adjust' | 'set_price';
export type QuoteRuleActionType = 'percent_discount' | 'fixed_discount';
export type RuleActionType = LineRuleActionType | QuoteRuleActionType;

export const LINE_RULE_ACTION_TYPES: readonly LineRuleActionType[] = [
  'percent_adjust',
  'fixed_adjust',
  'set_price',
];
export const QUOTE_RULE_ACTION_TYPES: readonly QuoteRuleActionType[] = [
  'percent_discount',
  'fixed_discount',
];

export interface RuleAction {
  type: RuleActionType;
  /** bps for percent_* types, cents for the rest. */
  amount: number;
}

/** Flat attribute bag the conditions are evaluated against. */
export type RuleAttributes = Record<string, string | number | boolean | null>;

/** Attributes exposed for 'line'-scope rules. */
export const LINE_RULE_FIELDS = [
  'description',
  'quantity',
  'unit_price_cents',
  'unit_cost_cents',
  'line_total_cents',
  'service_template_id',
] as const;

/** Attributes exposed for 'quote'-scope rules. */
export const QUOTE_RULE_FIELDS = [
  'subtotal_cents',
  'line_count',
  'total_quantity',
  'customer_id',
  'status',
] as const;

/**
 * Evaluate one condition. Unknown fields, unknown ops and type-mismatched
 * comparisons simply DON'T match (never throw) — a bad rule must not be able
 * to take a quote down. Field lookup is own-property only, so "__proto__"
 * and friends cannot reach anything.
 */
export function matchesCondition(attrs: RuleAttributes, cond: RuleCondition): boolean {
  if (!cond || typeof cond.field !== 'string') return false;
  if (!Object.prototype.hasOwnProperty.call(attrs, cond.field)) return false;
  const actual = attrs[cond.field];
  const expected = cond.value;

  switch (cond.op) {
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (typeof actual !== 'number' || typeof expected !== 'number') return false;
      if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
      if (cond.op === 'gt') return actual > expected;
      if (cond.op === 'gte') return actual >= expected;
      if (cond.op === 'lt') return actual < expected;
      return actual <= expected;
    }
    case 'contains': {
      if (typeof actual !== 'string' || typeof expected !== 'string') return false;
      return actual.toLowerCase().includes(expected.toLowerCase());
    }
    case 'in': {
      if (!Array.isArray(expected)) return false;
      return expected.some((v) => v === actual);
    }
    default:
      return false;
  }
}

/** All conditions must match (AND). An empty list matches everything. */
export function matchesAllConditions(
  attrs: RuleAttributes,
  conditions: readonly RuleCondition[],
): boolean {
  if (!Array.isArray(conditions)) return false;
  return conditions.every((c) => matchesCondition(attrs, c));
}

/**
 * Apply a line-scope action to an effective unit price (cents).
 * Unknown/malformed actions are a no-op. Result is a non-negative integer.
 */
export function applyLineAction(effectiveUnitPriceCents: number, action: RuleAction): number {
  if (!action || typeof action.amount !== 'number' || !Number.isFinite(action.amount)) {
    return effectiveUnitPriceCents;
  }
  const amount = Math.trunc(action.amount);
  let out = effectiveUnitPriceCents;
  switch (action.type) {
    case 'percent_adjust':
      out = out + Math.round((out * amount) / 10000);
      break;
    case 'fixed_adjust':
      out = out + amount;
      break;
    case 'set_price':
      out = amount;
      break;
    default:
      return effectiveUnitPriceCents;
  }
  return Math.max(Math.round(out), 0);
}

/**
 * Compute the extra discount (cents, >= 0) a quote-scope action grants
 * against the post-line-discount subtotal. Unknown/malformed actions grant 0.
 */
export function quoteActionDiscountCents(subtotalCents: number, action: RuleAction): number {
  if (!action || typeof action.amount !== 'number' || !Number.isFinite(action.amount)) {
    return 0;
  }
  const amount = Math.trunc(action.amount);
  if (amount <= 0) return 0;
  switch (action.type) {
    case 'percent_discount':
      return Math.round((subtotalCents * Math.min(amount, 10000)) / 10000);
    case 'fixed_discount':
      return amount;
    default:
      return 0;
  }
}

export interface ParsedPricingRule {
  id: string;
  name: string;
  scope: 'line' | 'quote';
  conditions: RuleCondition[];
  action: RuleAction;
  priority: number;
}

/**
 * Parse the JSON columns of a pricing-rule row into a ParsedPricingRule.
 * Returns undefined when the stored JSON is unusable (defensive: rules are
 * validated on write, but stored data must never crash pricing).
 */
export function parseStoredRule(row: {
  id: string;
  name: string;
  scope: string;
  conditions: string;
  action: string;
  priority: number;
}): ParsedPricingRule | undefined {
  if (row.scope !== 'line' && row.scope !== 'quote') return undefined;
  let conditions: unknown;
  let action: unknown;
  try {
    conditions = JSON.parse(row.conditions);
    action = JSON.parse(row.action);
  } catch {
    return undefined;
  }
  if (!Array.isArray(conditions)) return undefined;
  if (typeof action !== 'object' || action === null) return undefined;
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    conditions: conditions as RuleCondition[],
    action: action as RuleAction,
    priority: row.priority,
  };
}
