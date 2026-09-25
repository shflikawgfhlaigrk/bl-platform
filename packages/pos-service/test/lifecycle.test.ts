import { describe, expect, it } from 'vitest';
import { hardwareOutcome, readCardPaymentsStatus, readHardwareOrder, readUserRequirements } from '../src/lifecycle';

describe('reading Stripe objects', () => {
  it('reads card_payments status from a v2 account and treats the unexpected as not active', () => {
    const account = (status: unknown) => ({ configuration: { merchant: { capabilities: { card_payments: { status } } } } });
    expect(readCardPaymentsStatus(account('active'))).toBe('active');
    expect(readCardPaymentsStatus(account('restricted'))).toBe('restricted');
    expect(readCardPaymentsStatus(account('something_new'))).toBe('unknown');
    expect(readCardPaymentsStatus({ configuration: { merchant: { capabilities: {} } } })).toBe('unrequested');
    expect(readCardPaymentsStatus({})).toBe('unknown');
  });

  it('keeps only requirements the merchant must act on now', () => {
    const due = readUserRequirements({
      requirements: {
        entries: [
          { awaiting_action_from: 'user', description: 'identity.business_details.id_numbers', minimum_deadline: { status: 'currently_due' }, errors: [{ code: 'invalid_tax_id' }] },
          { awaiting_action_from: 'stripe', description: 'review', minimum_deadline: { status: 'currently_due' } },
          { awaiting_action_from: 'user', description: 'later', minimum_deadline: { status: 'eventually_due' } },
        ],
      },
    });
    expect(due).toEqual([{ description: 'identity.business_details.id_numbers', deadline: 'currently_due', errors: ['invalid_tax_id'] }]);
  });

  it('validates hardware orders and maps every status', () => {
    expect(readHardwareOrder({ id: 'nope', status: 'shipped' })).toBeNull();
    expect(readHardwareOrder({ id: 'thor_1', status: 'teleported' })).toBeNull();
    expect(readHardwareOrder({ id: 'thor_1', status: 'shipped', shipment_tracking: [{ carrier: 'ups', tracking_number: '1Z' }] }))
      .toEqual({ id: 'thor_1', status: 'shipped', tracking: [{ carrier: 'ups', trackingNumber: '1Z' }] });
    expect(hardwareOutcome('pending')).toEqual({ stage: 'reader_ordered' });
    expect(hardwareOutcome('ready_to_ship')).toEqual({ stage: 'reader_ordered' });
    expect(hardwareOutcome('shipped')).toEqual({ stage: 'reader_shipped' });
    expect(hardwareOutcome('delivered')).toEqual({ stage: 'reader_delivered' });
    expect(hardwareOutcome('undeliverable')).toMatchObject({ blocked: { code: 'hardware_undeliverable' } });
    expect(hardwareOutcome('canceled')).toMatchObject({ blocked: { code: 'hardware_order_canceled' } });
  });
});
