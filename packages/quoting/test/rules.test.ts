import { describe, expect, it } from 'vitest';
import {
  applyLineAction,
  matchesAllConditions,
  matchesCondition,
  parseStoredRule,
  quoteActionDiscountCents,
  type RuleAttributes,
} from '@blacklabel/quoting';

const attrs: RuleAttributes = {
  description: 'Exterior Window Pane',
  quantity: 20,
  unit_price_cents: 650,
  service_template_id: null,
};

describe('rule condition interpreter (safe, no eval)', () => {
  it('supports eq / neq', () => {
    expect(matchesCondition(attrs, { field: 'quantity', op: 'eq', value: 20 })).toBe(true);
    expect(matchesCondition(attrs, { field: 'quantity', op: 'eq', value: 21 })).toBe(false);
    expect(matchesCondition(attrs, { field: 'quantity', op: 'neq', value: 21 })).toBe(true);
    expect(matchesCondition(attrs, { field: 'service_template_id', op: 'eq', value: null })).toBe(true);
  });

  it('supports numeric comparisons gt/gte/lt/lte with type guards', () => {
    expect(matchesCondition(attrs, { field: 'quantity', op: 'gt', value: 19 })).toBe(true);
    expect(matchesCondition(attrs, { field: 'quantity', op: 'gt', value: 20 })).toBe(false);
    expect(matchesCondition(attrs, { field: 'quantity', op: 'gte', value: 20 })).toBe(true);
    expect(matchesCondition(attrs, { field: 'quantity', op: 'lt', value: 21 })).toBe(true);
    expect(matchesCondition(attrs, { field: 'quantity', op: 'lte', value: 19 })).toBe(false);
    // comparing a string attribute numerically never matches (no coercion)
    expect(matchesCondition(attrs, { field: 'description', op: 'gt', value: 5 })).toBe(false);
    // comparing a number against a string value never matches
    expect(matchesCondition(attrs, { field: 'quantity', op: 'gt', value: '5' })).toBe(false);
  });

  it('supports contains (case-insensitive) and in', () => {
    expect(matchesCondition(attrs, { field: 'description', op: 'contains', value: 'window' })).toBe(true);
    expect(matchesCondition(attrs, { field: 'description', op: 'contains', value: 'roof' })).toBe(false);
    expect(matchesCondition(attrs, { field: 'quantity', op: 'in', value: [10, 20, 30] })).toBe(true);
    expect(matchesCondition(attrs, { field: 'quantity', op: 'in', value: [1, 2] })).toBe(false);
    expect(matchesCondition(attrs, { field: 'quantity', op: 'in', value: 20 })).toBe(false); // not an array
  });

  it('never matches unknown fields, unknown ops, or prototype keys — and never throws', () => {
    expect(matchesCondition(attrs, { field: 'nope', op: 'eq', value: 1 })).toBe(false);
    expect(matchesCondition(attrs, { field: '__proto__', op: 'eq', value: {} as unknown })).toBe(false);
    expect(matchesCondition(attrs, { field: 'constructor', op: 'neq', value: 'x' })).toBe(false);
    expect(
      matchesCondition(attrs, { field: 'quantity', op: 'regex' as never, value: '.*' }),
    ).toBe(false);
    expect(matchesCondition(attrs, null as never)).toBe(false);
  });

  it('AND-combines conditions; empty list matches everything', () => {
    expect(
      matchesAllConditions(attrs, [
        { field: 'quantity', op: 'gte', value: 10 },
        { field: 'description', op: 'contains', value: 'exterior' },
      ]),
    ).toBe(true);
    expect(
      matchesAllConditions(attrs, [
        { field: 'quantity', op: 'gte', value: 10 },
        { field: 'description', op: 'contains', value: 'roof' },
      ]),
    ).toBe(false);
    expect(matchesAllConditions(attrs, [])).toBe(true);
  });
});

describe('rule actions', () => {
  it('line actions adjust price and clamp at zero', () => {
    expect(applyLineAction(1000, { type: 'percent_adjust', amount: -1000 })).toBe(900);
    expect(applyLineAction(1000, { type: 'percent_adjust', amount: 2500 })).toBe(1250); // surcharge
    expect(applyLineAction(1000, { type: 'fixed_adjust', amount: -50 })).toBe(950);
    expect(applyLineAction(1000, { type: 'fixed_adjust', amount: -5000 })).toBe(0); // clamp
    expect(applyLineAction(1000, { type: 'set_price', amount: 425 })).toBe(425);
    // malformed action is a no-op
    expect(applyLineAction(1000, { type: 'exec' as never, amount: 1 })).toBe(1000);
    expect(applyLineAction(1000, { type: 'set_price', amount: Number.NaN })).toBe(1000);
  });

  it('quote actions grant a discount (never a negative one)', () => {
    expect(quoteActionDiscountCents(50000, { type: 'percent_discount', amount: 500 })).toBe(2500);
    expect(quoteActionDiscountCents(50000, { type: 'fixed_discount', amount: 1234 })).toBe(1234);
    expect(quoteActionDiscountCents(50000, { type: 'percent_discount', amount: -500 })).toBe(0);
    expect(quoteActionDiscountCents(50000, { type: 'percent_discount', amount: 999999 })).toBe(50000); // capped at 100%
    expect(quoteActionDiscountCents(50000, { type: 'nope' as never, amount: 5 })).toBe(0);
  });
});

describe('parseStoredRule', () => {
  it('parses valid stored JSON and rejects garbage without throwing', () => {
    const good = parseStoredRule({
      id: 'r1',
      name: 'rule',
      scope: 'line',
      conditions: '[{"field":"quantity","op":"gte","value":10}]',
      action: '{"type":"percent_adjust","amount":-500}',
      priority: 5,
    });
    expect(good?.conditions).toHaveLength(1);
    expect(good?.action.type).toBe('percent_adjust');

    expect(
      parseStoredRule({ id: 'r2', name: 'x', scope: 'line', conditions: 'not json', action: '{}', priority: 0 }),
    ).toBeUndefined();
    expect(
      parseStoredRule({ id: 'r3', name: 'x', scope: 'bad', conditions: '[]', action: '{}', priority: 0 }),
    ).toBeUndefined();
    expect(
      parseStoredRule({ id: 'r4', name: 'x', scope: 'quote', conditions: '{}', action: '{}', priority: 0 }),
    ).toBeUndefined();
  });
});
