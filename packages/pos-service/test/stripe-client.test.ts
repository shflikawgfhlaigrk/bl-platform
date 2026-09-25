import { describe, expect, it } from 'vitest';
import { createStripeClient, encodeParams, STRIPE_API_VERSION, StripeRequestError } from '../src/stripe-client';
import { fakeStripe } from './fake-stripe';

describe('encodeParams', () => {
  it('encodes nested objects, scalar arrays and object arrays the way Stripe expects', () => {
    const body = encodeParams({ a: { b: 'c', d: undefined }, types: ['card_present'], items: [{ sku: 'x', qty: 2 }], skip: null, flag: true });
    expect(decodeURIComponent(body)).toBe('a[b]=c&types[]=card_present&items[0][sku]=x&items[0][qty]=2&flag=true');
  });

  it('uses indexed arrays for v2 queries', () => {
    expect(decodeURIComponent(encodeParams({ include: ['configuration.merchant', 'requirements'] }, 'indexed')))
      .toBe('include[0]=configuration.merchant&include[1]=requirements');
  });
});

describe('createStripeClient', () => {
  it('sends v1 requests form-encoded with Stripe-Account, Stripe-Version and Idempotency-Key', async () => {
    const stripe = fakeStripe();
    const client = createStripeClient({ secretKey: 'sk_test_123', fetch: stripe.fetch });
    await client.v1({ method: 'POST', path: '/v1/terminal/locations', account: 'acct_1TestMerchant', idempotencyKey: 'k1', params: { display_name: 'Shop' } });
    const [call] = stripe.calls;
    expect(call.headers.Authorization).toBe('Bearer sk_test_123');
    expect(call.headers['Stripe-Version']).toBe(STRIPE_API_VERSION);
    expect(call.headers['Stripe-Account']).toBe('acct_1TestMerchant');
    expect(call.headers['Idempotency-Key']).toBe('k1');
    expect(call.form?.get('display_name')).toBe('Shop');
    expect(client.livemode).toBe(false);
  });

  it('sends v2 requests as JSON and v2 queries with indexed include', async () => {
    const stripe = fakeStripe();
    const client = createStripeClient({ secretKey: 'sk_test_123', fetch: stripe.fetch });
    await client.v2({ method: 'POST', path: '/v2/core/accounts', body: { dashboard: 'full' } });
    await client.v2({ method: 'GET', path: '/v2/core/accounts/acct_1TestMerchant', query: { include: ['configuration.merchant', 'requirements'] } });
    expect(stripe.calls[0].json).toEqual({ dashboard: 'full' });
    expect(stripe.calls[0].headers['Content-Type']).toBe('application/json');
    expect(stripe.calls[1].query.get('include[0]')).toBe('configuration.merchant');
    expect(stripe.calls[1].query.get('include[1]')).toBe('requirements');
  });

  it('maps Stripe errors to bounded fields without leaking the request', async () => {
    const stripe = fakeStripe({ failPath: '/v1/terminal/readers' });
    const client = createStripeClient({ secretKey: 'sk_test_123', fetch: stripe.fetch });
    const error = await client.v1({ method: 'POST', path: '/v1/terminal/readers', params: { registration_code: 'secret-code' } }).catch((e) => e);
    expect(error).toBeInstanceOf(StripeRequestError);
    expect(error).toMatchObject({ status: 400, code: 'resource_missing', requestId: 'req_fail', stripeMessage: 'No such thing' });
    expect(String(error.message)).not.toContain('secret-code');
  });

  it('refuses bad keys, non-https bases, malformed paths and malformed account ids', async () => {
    const { fetch } = fakeStripe();
    expect(() => createStripeClient({ secretKey: 'pk_test_1', fetch })).toThrow(/unrecognised format/);
    expect(() => createStripeClient({ secretKey: 'sk_test_1', fetch, apiBase: 'http://api.stripe.com' })).toThrow(/https/);
    const client = createStripeClient({ secretKey: 'sk_live_1', fetch });
    expect(client.livemode).toBe(true);
    await expect(client.v1({ method: 'GET', path: '/v1/../secret' })).rejects.toMatchObject({ code: 'invalid_path' });
    await expect(client.v1({ method: 'GET', path: '/v1/charges', account: 'acct_x y' })).rejects.toMatchObject({ code: 'invalid_account' });
  });

  it('times out instead of hanging', async () => {
    const client = createStripeClient({
      secretKey: 'sk_test_1',
      timeoutMs: 100,
      fetch: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    await expect(client.v1({ method: 'GET', path: '/v1/balance' })).rejects.toMatchObject({ code: 'request_timeout' });
  });
});
