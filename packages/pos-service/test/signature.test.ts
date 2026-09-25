import { describe, expect, it } from 'vitest';
import { stripeSignatureHeader, verifyStripeSignature } from '../src/signature';

const secret = 'whsec_test_secret';
const payload = JSON.stringify({ id: 'evt_1', type: 'account.updated' });

describe('verifyStripeSignature', () => {
  it('accepts a valid signature inside the tolerance window', () => {
    const header = stripeSignatureHeader(secret, 1_000, payload);
    expect(verifyStripeSignature({ payload, header, secret, nowSeconds: 1_100 })).toEqual({ ok: true, timestamp: 1_000 });
  });

  it('accepts when any of several v1 signatures matches (secret rotation)', () => {
    const good = stripeSignatureHeader(secret, 1_000, payload).split(',')[1];
    const header = `t=1000,v1=${'0'.repeat(64)},${good}`;
    expect(verifyStripeSignature({ payload, header, secret, nowSeconds: 1_000 }).ok).toBe(true);
  });

  it('rejects a tampered body, a stale timestamp, a malformed header, and a missing secret', () => {
    const header = stripeSignatureHeader(secret, 1_000, payload);
    expect(verifyStripeSignature({ payload: payload.replace('evt_1', 'evt_2'), header, secret, nowSeconds: 1_000 })).toEqual({ ok: false, reason: 'no_matching_signature' });
    expect(verifyStripeSignature({ payload, header, secret, nowSeconds: 2_000 })).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
    expect(verifyStripeSignature({ payload, header: 'v1=abc', secret, nowSeconds: 1_000 })).toEqual({ ok: false, reason: 'malformed_header' });
    expect(verifyStripeSignature({ payload, header, secret: '', nowSeconds: 1_000 })).toEqual({ ok: false, reason: 'missing_secret' });
    expect(verifyStripeSignature({ payload, header: null, secret, nowSeconds: 1_000 })).toEqual({ ok: false, reason: 'missing_header' });
  });
});
