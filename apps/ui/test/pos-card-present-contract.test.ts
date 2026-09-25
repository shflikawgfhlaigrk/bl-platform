import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const register = readFileSync(path.resolve(here, '../public/js/views/register.js'), 'utf8');

function bodyBetween(start: string, end: string): string {
  const startAt = register.indexOf(start);
  const endAt = register.indexOf(end, startAt + start.length);
  expect(startAt).toBeGreaterThan(-1);
  expect(endAt).toBeGreaterThan(startAt);
  return register.slice(startAt, endAt);
}

describe('POS card-present register static contract', () => {
  it('offers card only when readiness says enabled and the physical reader is verified', () => {
    const readinessGate = bodyBetween('function cardPresentReady()', 'function updateActive');
    expect(readinessGate).toContain("card?.enabled === true && card?.physicalReaderVerified === true");
    expect(register).toContain("value: 'card_present', disabled: !cardReady");
    expect(register).toContain('Card — verified reader required');
    expect(register).toContain("if (!cardPresentReady()) throw new Error('The card reader is not currently online and verified')");
    expect(register).toContain("value: 'split'");
    expect(register).toContain('Split cash + external');
    expect(register).toContain('Split cash + card');
    expect(register).toContain('Split across cards');
  });

  it('persists stable order and attempt keys before the first network recovery', () => {
    const start = bodyBetween('function beginCardCheckout(amountCents)', 'async function recoverCardCheckout');
    expect(start).toContain("paymentKind: 'card_present'");
    expect(start).toContain('orderIdempotencyKey: newIdempotencyKey()');
    expect(start).toContain('attemptIdempotencyKey: newIdempotencyKey()');
    expect(start).toContain('attemptId: null');
    expect(start.indexOf('persist();')).toBeLessThan(start.indexOf('recoverPendingCheckout();'));
  });

  it('replays one order and one terminal attempt, then polls the durable attempt', () => {
    const recovery = bodyBetween('async function recoverCardCheckout', 'function bindCardAttempt');
    expect(recovery).toContain('idempotencyKey: current.orderIdempotencyKey');
    expect(recovery).toContain('attempt.idempotency_key === current.attemptIdempotencyKey');
    expect(recovery).toContain('`/api/pos/orders/${current.orderId}/card-payments`');
    expect(recovery).toContain('idempotencyKey: current.attemptIdempotencyKey');
    expect(recovery).toContain('`/api/pos/payment-attempts/${current.attemptId}`');
    expect(register).toContain('if (state.pendingCheckout) setTimeout(() => recoverPendingCheckout(), 0)');
  });

  it('does not complete until both the attempt succeeded and the order is paid', () => {
    const recovery = bodyBetween('async function recoverCardCheckout', 'function bindCardAttempt');
    const succeededAt = recovery.indexOf("attempt.status === 'succeeded'");
    const orderAt = recovery.indexOf('getData(`/api/orders/orders/${current.orderId}`)', succeededAt);
    const paidAt = recovery.indexOf('if (!isPaidStatus(order.status))', orderAt);
    const finishAt = recovery.indexOf('await finishSale(order)', paidAt);
    expect(succeededAt).toBeGreaterThan(-1);
    expect(orderAt).toBeGreaterThan(succeededAt);
    expect(paidAt).toBeGreaterThan(orderAt);
    expect(finishAt).toBeGreaterThan(paidAt);
    expect(register).toContain('No payment is recorded until the server reports both a succeeded attempt and a paid order.');
  });

  it('surfaces terminal failure/cancel and calls the explicit cancel facade', () => {
    expect(register).toContain("attempt.status === 'failed' || attempt.status === 'canceled'");
    expect(register).toContain('Card payment failed.');
    expect(register).toContain('Card payment canceled.');
    expect(register).toContain('`/api/pos/payment-attempts/${pending.attemptId}/cancel`');
    expect(register).toContain("activeCardAttempt?.status !== 'failed' && activeCardAttempt?.status !== 'canceled'");
    expect(register).toContain('state = clearPendingCheckout(state)');
  });
});
