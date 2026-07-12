import { describe, expect, it } from 'vitest';
import { backoffSeconds, MAX_BACKOFF_SECONDS } from '../src/backoff';
import { evaluateCondition, evaluateConditions, getPath } from '../src/conditions';
import { renderTemplate, stableStringify } from '../src/template';
import { isWithinSchedule } from '../src/schedule';
import { validateEvent, KNOWN_MAGS_EVENTS } from '../src/events-registry';
import type { RuleCondition } from '../src/schema';

describe('backoff schedule (deterministic 1m,5m,25m…)', () => {
  it('computes base*factor^(attempts-1) and caps at MAX', () => {
    expect(backoffSeconds(1)).toBe(60);
    expect(backoffSeconds(2)).toBe(300);
    expect(backoffSeconds(3)).toBe(1500);
    expect(backoffSeconds(4)).toBe(7500);
    // Large attempt counts clamp, never overflow / go random.
    expect(backoffSeconds(50)).toBe(MAX_BACKOFF_SECONDS);
    expect(backoffSeconds(1)).toBe(backoffSeconds(1)); // deterministic
  });
});

describe('condition operators', () => {
  const p = { onHand: 3, name: 'belt', tags: ['sale', 'new'], nested: { x: 10 } };

  it('eq / neq', () => {
    expect(evaluateCondition(p, { path: 'onHand', op: 'eq', value: 3 })).toBe(true);
    expect(evaluateCondition(p, { path: 'onHand', op: 'eq', value: 4 })).toBe(false);
    expect(evaluateCondition(p, { path: 'name', op: 'neq', value: 'saddle' })).toBe(true);
  });

  it('gt / gte / lt / lte (numeric, string-number coercion)', () => {
    expect(evaluateCondition(p, { path: 'onHand', op: 'gt', value: 2 })).toBe(true);
    expect(evaluateCondition(p, { path: 'onHand', op: 'gte', value: 3 })).toBe(true);
    expect(evaluateCondition(p, { path: 'onHand', op: 'lt', value: 3 })).toBe(false);
    expect(evaluateCondition(p, { path: 'onHand', op: 'lte', value: 3 })).toBe(true);
    expect(evaluateCondition({ onHand: '3' }, { path: 'onHand', op: 'lte', value: 5 })).toBe(true);
  });

  it('contains (array + string)', () => {
    expect(evaluateCondition(p, { path: 'tags', op: 'contains', value: 'sale' })).toBe(true);
    expect(evaluateCondition(p, { path: 'tags', op: 'contains', value: 'x' })).toBe(false);
    expect(evaluateCondition(p, { path: 'name', op: 'contains', value: 'el' })).toBe(true);
  });

  it('exists (present + must-be-absent)', () => {
    expect(evaluateCondition(p, { path: 'nested.x', op: 'exists' })).toBe(true);
    expect(evaluateCondition(p, { path: 'missing', op: 'exists' })).toBe(false);
    expect(evaluateCondition(p, { path: 'missing', op: 'exists', value: false })).toBe(true);
    expect(evaluateCondition(p, { path: 'onHand', op: 'exists', value: false })).toBe(false);
  });

  it('getPath traverses nested objects and array indexes', () => {
    expect(getPath(p, 'nested.x')).toBe(10);
    expect(getPath(p, 'tags.1')).toBe('new');
    expect(getPath(p, 'tags.9')).toBeUndefined();
  });

  it('AND semantics; empty list matches everything', () => {
    const conds: RuleCondition[] = [
      { path: 'onHand', op: 'lte', value: 5 },
      { path: 'name', op: 'eq', value: 'belt' },
    ];
    expect(evaluateConditions(p, conds)).toBe(true);
    expect(evaluateConditions(p, [{ path: 'onHand', op: 'gt', value: 5 }])).toBe(false);
    expect(evaluateConditions(p, [])).toBe(true);
  });
});

describe('template rendering', () => {
  it('preserves type for a full-token string and interpolates embedded tokens', () => {
    const out = renderTemplate(
      { id: '{{orderId}}', total: '{{totalCents}}', msg: 'order {{orderId}} = {{totalCents}}c' },
      { orderId: 'o1', totalCents: 12550 },
    ) as Record<string, unknown>;
    expect(out.id).toBe('o1');
    expect(out.total).toBe(12550); // number preserved, not "12550"
    expect(out.msg).toBe('order o1 = 12550c');
  });

  it('renders nested arrays/objects and missing paths become ""', () => {
    const out = renderTemplate(
      { items: ['{{a}}', 'x-{{b}}'], meta: { z: 'v-{{missing}}', raw: '{{missing}}' } },
      { a: 1, b: 'two' },
    ) as any;
    expect(out.items[0]).toBe(1);
    expect(out.items[1]).toBe('x-two');
    expect(out.meta.z).toBe('v-'); // embedded missing path → ""
    expect(out.meta.raw).toBeUndefined(); // full-token missing path → undefined (type-preserving)
  });

  it('stableStringify is key-order independent', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });
});

describe('schedule windows (luxon, America/New_York)', () => {
  const schedule = {
    timezone: 'America/New_York',
    windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }],
  };

  it('matches a weekday inside business hours and rejects outside', () => {
    // 2026-03-09 is a Monday. 14:00 UTC = 09:00 America/New_York (EDT, -5? -> actually EST/EDT).
    // Use an instant clearly inside: 2026-03-09T18:00Z = 13:00 or 14:00 local — within 9–17.
    expect(isWithinSchedule(schedule, '2026-03-09T18:00:00.000Z')).toBe(true);
    // 2026-03-09T06:00Z = ~01:00 local Monday — outside window.
    expect(isWithinSchedule(schedule, '2026-03-09T06:00:00.000Z')).toBe(false);
  });

  it('rejects a weekend day', () => {
    // 2026-03-08 is a Sunday.
    expect(isWithinSchedule(schedule, '2026-03-08T18:00:00.000Z')).toBe(false);
  });

  it('empty windows never match', () => {
    expect(isWithinSchedule({ timezone: 'America/New_York', windows: [] }, '2026-03-09T18:00:00.000Z')).toBe(false);
  });
});

describe('event schema registry', () => {
  it('registers every canonical CONTRACTS-MAGS §2 event (21)', () => {
    expect(KNOWN_MAGS_EVENTS.length).toBe(21);
  });

  it('validates 5+ catalog events and rejects bad payloads', () => {
    expect(validateEvent('inventory.stock.changed', {
      v: 1,
      variationId: 'v1',
      locationId: 'l1',
      delta: -2,
      onHand: 3,
      movementId: 'm1',
      reason: 'sale',
    }).ok).toBe(true);
    expect(validateEvent('orders.order.paid', { v: 1, orderId: 'o1', totalCents: 100 }).ok).toBe(true);
    expect(validateEvent('catalog.variation.changed', { v: 1, variationId: 'v1' }).ok).toBe(true);
    expect(validateEvent('shows.show.scheduled', { v: 1, showId: 's1', startsAt: '2026-03-09T00:00:00Z' }).ok).toBe(true);
    expect(validateEvent('customers.consent.changed', { v: 1, customerId: 'c1', channel: 'email', state: 'granted' }).ok).toBe(true);

    // Missing v:1
    const badV = validateEvent('orders.order.paid', { orderId: 'o1', totalCents: 100 });
    expect(badV.ok).toBe(false);
    expect(badV.errors.length).toBeGreaterThan(0);
    // Missing required field
    expect(validateEvent('inventory.stock.changed', { v: 1, variationId: 'v1' }).ok).toBe(false);
    // Wrong type for cents
    expect(validateEvent('orders.order.paid', { v: 1, orderId: 'o1', totalCents: 1.5 }).ok).toBe(false);
  });

  it('unknown event types validate OK (nothing to enforce)', () => {
    const r = validateEvent('some.internal.event', { anything: true });
    expect(r.ok).toBe(true);
    expect(r.unknown).toBe(true);
  });
});
