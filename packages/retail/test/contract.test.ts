import { describe, expect, it } from 'vitest';
import { IMPORT_KINDS, sourceHash, validateRecord } from '../src/contract';
import { squareOrder, squarePayment } from './helpers';

describe('source hash determinism', () => {
  it('is stable and key-order independent for the same input', () => {
    const a = { id: 'p1', amount_money: { amount: 100, currency: 'USD' }, status: 'COMPLETED' };
    // Same data, keys written in a different order.
    const b = { status: 'COMPLETED', amount_money: { currency: 'USD', amount: 100 }, id: 'p1' };
    expect(sourceHash('payments', [a])).toBe(sourceHash('payments', [b]));
  });

  it('changes when the data changes', () => {
    const a = sourceHash('payments', [{ id: 'p1', amount_money: { amount: 100 } }]);
    const b = sourceHash('payments', [{ id: 'p1', amount_money: { amount: 101 } }]);
    expect(a).not.toBe(b);
  });

  it('is a 64-char hex sha256', () => {
    expect(sourceHash('payments', [{ id: 'p1' }])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('distinguishes kinds', () => {
    expect(sourceHash('payments', [])).not.toBe(sourceHash('orders', []));
  });
});

describe('per-kind zod validation on real-shaped records', () => {
  it('accepts a real Square payment and rejects a malformed one', () => {
    expect(validateRecord('payments', squarePayment('p1', 1307)).ok).toBe(true);
    // missing amount_money.amount
    expect(validateRecord('payments', { id: 'p1', created_at: 'x', status: 'COMPLETED' }).ok).toBe(false);
    // missing id
    expect(validateRecord('payments', { created_at: 'x', status: 'C', amount_money: { amount: 1 } }).ok).toBe(false);
  });

  it('accepts a real Square order with nested line items', () => {
    expect(validateRecord('orders', squareOrder('o1', 1307)).ok).toBe(true);
  });

  it('accepts a real Square customer (email_address optional)', () => {
    const rec = { id: 'C1', created_at: '2022-05-21T13:32:08.198Z', given_name: 'A', family_name: 'Burgess' };
    expect(validateRecord('customers', rec).ok).toBe(true);
  });

  it('accepts a real Square catalog ITEM and a gift card / payout / dispute / invoice', () => {
    expect(validateRecord('catalog', { type: 'ITEM', id: 'I1', item_data: { name: 'X' } }).ok).toBe(true);
    expect(validateRecord('gift_cards', { id: 'g1', state: 'ACTIVE', balance_money: { amount: 2500 } }).ok).toBe(true);
    expect(validateRecord('payouts', { id: 'po1', status: 'PAID', amount_money: { amount: 366, currency_code: 'USD' } }).ok).toBe(true);
    expect(validateRecord('disputes', { id: 'd1', state: 'LOST', amount_money: { amount: 15408 } }).ok).toBe(true);
    expect(validateRecord('invoices', { id: 'inv1', status: 'PAID', payment_requests: [{ computed_amount_money: { amount: 11891 } }] }).ok).toBe(true);
  });

  it('quarantines an inventory count missing its composite key fields', () => {
    expect(validateRecord('inventory_counts', { catalog_object_id: 'V1', location_id: 'L1', state: 'IN_STOCK', quantity: '3' }).ok).toBe(true);
    expect(validateRecord('inventory_counts', { catalog_object_id: 'V1', quantity: '3' }).ok).toBe(false);
  });

  it('accepts a real Square refund', () => {
    expect(validateRecord('refunds', { id: 'r1', status: 'COMPLETED', amount_money: { amount: 1307 }, created_at: 'x' }).ok).toBe(true);
  });

  it('covers every declared kind', () => {
    expect(IMPORT_KINDS.length).toBe(10);
  });
});
