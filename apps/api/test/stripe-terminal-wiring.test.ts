import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createConfiguredStripeTerminalProvider,
  readStripeTerminalEnvConfig,
  StripeTerminalTransportError,
  verifyConfiguredStripeTerminalReader,
  type StripeTerminalFetch,
  type StripeTerminalFetchResponse,
} from '../src/stripe-terminal';

const SECRET_KEY = 'sk_test_server_only_123';
const WEBHOOK_SECRET = 'whsec_server_only_456';

interface FetchCall {
  url: string;
  init: Parameters<StripeTerminalFetch>[1];
}

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): StripeTerminalFetchResponse {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => raw,
  };
}

function configured(fetch: StripeTerminalFetch, overrides: Record<string, unknown> = {}) {
  return createConfiguredStripeTerminalProvider(
    {
      secretKey: SECRET_KEY,
      webhookSecret: WEBHOOK_SECRET,
      defaultReaderId: 'tmr_server_default',
      ...overrides,
    },
    { fetch },
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Stripe Terminal server wiring', () => {
  it('reads only the explicit Stripe Terminal environment contract', () => {
    const config = readStripeTerminalEnvConfig({
      STRIPE_SECRET_KEY: SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_TERMINAL_READER_ID: 'tmr_server_default',
      STRIPE_API_VERSION: '2024-06-20',
      STRIPE_API_BASE_URL: 'https://stripe.example.test/',
      STRIPE_REQUEST_TIMEOUT_MS: '2500',
      STRIPE_WEBHOOK_TOLERANCE_SECONDS: '120',
      STRIPE_CURRENCY: 'CAD',
      UNRELATED_SECRET: 'must-not-be-read',
    });
    expect(config).toEqual({
      secretKey: SECRET_KEY,
      webhookSecret: WEBHOOK_SECRET,
      defaultReaderId: 'tmr_server_default',
      apiVersion: '2024-06-20',
      apiBase: 'https://stripe.example.test/',
      requestTimeoutMs: 2500,
      webhookToleranceSeconds: 120,
      currency: 'CAD',
    });
    expect(readStripeTerminalEnvConfig({
      STRIPE_REQUEST_TIMEOUT_MS: 'not-a-number',
      STRIPE_WEBHOOK_TOLERANCE_SECONDS: '1.5',
    })).toMatchObject({
      requestTimeoutMs: undefined,
      webhookToleranceSeconds: undefined,
    });
  });

  it('sends the exact form-encoded PaymentIntent and reader requests through injected fetch', async () => {
    const calls: FetchCall[] = [];
    const fetch: StripeTerminalFetch = async (url, init) => {
      calls.push({ url, init });
      if (url === 'https://api.stripe.com/v1/payment_intents') {
        return response(200, {
          id: 'pi_server_1',
          amount: 12_345,
          status: 'requires_payment_method',
        });
      }
      if (
        url
        === 'https://api.stripe.com/v1/terminal/readers/tmr_server_default/process_payment_intent'
      ) {
        return response(200, {
          id: 'tmr_server_default',
          status: 'online',
          action: { type: 'process_payment_intent', status: 'in_progress' },
        });
      }
      throw new Error(`unexpected test URL ${url}`);
    };
    const provider = configured(fetch, { apiVersion: '2024-06-20' });
    expect(provider).not.toBeNull();

    const result = await provider!.createSession({
      tenantId: 'tenant-pos',
      orderId: 'order-pos',
      paymentAttemptId: 'attempt-pos',
      idempotencyKey: 'tenant-pos:attempt-pos',
      amountCents: 12_345,
      currency: 'USD',
    });

    expect(result).toMatchObject({
      providerSessionRef: 'pi_server_1',
      flow: 'terminal',
      terminal: {
        readerId: 'tmr_server_default',
        readerStatus: 'online',
        actionStatus: 'in_progress',
      },
    });
    expect(calls).toHaveLength(2);

    const intent = calls[0]!;
    expect(intent.url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(intent.init.method).toBe('POST');
    expect(intent.init.headers).toMatchObject({
      Authorization: `Bearer ${SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': 'tenant-pos:attempt-pos',
      'Stripe-Version': '2024-06-20',
    });
    expect(Object.fromEntries(new URLSearchParams(intent.init.body))).toMatchObject({
      amount: '12345',
      currency: 'usd',
      capture_method: 'automatic',
      'metadata[tenant_id]': 'tenant-pos',
      'metadata[order_id]': 'order-pos',
      'metadata[payment_attempt_id]': 'attempt-pos',
    });
    expect(new URLSearchParams(intent.init.body).getAll('payment_method_types[]')).toEqual([
      'card_present',
    ]);

    const reader = calls[1]!;
    expect(reader.url).toBe(
      'https://api.stripe.com/v1/terminal/readers/tmr_server_default/process_payment_intent',
    );
    expect(reader.init.headers['Idempotency-Key']).toBe('tenant-pos:attempt-pos:reader');
    expect(new URLSearchParams(reader.init.body).get('payment_intent')).toBe('pi_server_1');
    expect(reader.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('omits Stripe-Version unless a nonblank version is explicitly supplied', async () => {
    const headers: Array<Record<string, string>> = [];
    const fetch: StripeTerminalFetch = async (url, init) => {
      headers.push(init.headers);
      if (url.endsWith('/v1/payment_intents')) {
        return response(200, { id: 'pi_no_version', amount: 100 });
      }
      return response(200, { id: 'tmr_server_default', status: 'online' });
    };
    const provider = configured(fetch, { apiVersion: '   ' });
    await provider!.createSession({ tenantId: 'tenant', orderId: 'order', amountCents: 100 });
    expect(headers).toHaveLength(2);
    expect(headers.every((header) => header['Stripe-Version'] === undefined)).toBe(true);
  });

  it('stays fail-closed for every incomplete or blank required config', () => {
    const fetch = vi.fn<StripeTerminalFetch>();
    const configs = [
      {},
      { secretKey: SECRET_KEY },
      { secretKey: SECRET_KEY, webhookSecret: WEBHOOK_SECRET },
      {
        secretKey: '   ',
        webhookSecret: WEBHOOK_SECRET,
        defaultReaderId: 'tmr_default',
      },
      {
        secretKey: SECRET_KEY,
        webhookSecret: '\n',
        defaultReaderId: 'tmr_default',
      },
      {
        secretKey: SECRET_KEY,
        webhookSecret: WEBHOOK_SECRET,
        defaultReaderId: ' ',
      },
      {
        secretKey: SECRET_KEY,
        webhookSecret: WEBHOOK_SECRET,
        defaultReaderId: 'tmr_default',
        currency: 'cad',
      },
    ];
    for (const config of configs) {
      expect(createConfiguredStripeTerminalProvider(config, { fetch })).toBeNull();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed before reader I/O when configured currency is not USD', async () => {
    const fetch = vi.fn<StripeTerminalFetch>();
    const config = {
      secretKey: SECRET_KEY,
      webhookSecret: WEBHOOK_SECRET,
      defaultReaderId: 'tmr_server_default',
      currency: 'CAD',
    };
    expect(createConfiguredStripeTerminalProvider(config, { fetch })).toBeNull();
    await expect(verifyConfiguredStripeTerminalReader(config, { fetch })).resolves.toEqual({
      configured: false,
      verified: false,
      reason: 'unsupported_currency',
      expectedReaderId: 'tmr_server_default',
      observedReaderId: null,
      status: null,
      error: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retains safe Stripe status/code/message while redacting credentials', async () => {
    const fetch: StripeTerminalFetch = async () => response(
      402,
      {
        error: {
          code: 'card_declined',
          decline_code: 'insufficient_funds',
          message: `Declined; never expose ${SECRET_KEY} or ${WEBHOOK_SECRET}`,
        },
      },
      { 'request-id': 'req_safe_123' },
    );
    const provider = configured(fetch)!;

    const caught = await provider
      .createSession({ tenantId: 'tenant', orderId: 'order', amountCents: 100 })
      .then(() => undefined, (error: unknown) => error);
    expect(caught).toBeInstanceOf(StripeTerminalTransportError);
    if (!(caught instanceof StripeTerminalTransportError)) {
      throw new Error('expected StripeTerminalTransportError');
    }
    expect(caught).toMatchObject({
      status: 402,
      code: 'insufficient_funds',
      requestId: 'req_safe_123',
    });
    expect(caught.stripeMessage).toContain('Declined');
    expect(caught.stripeMessage).toContain('[redacted]');
    expect(String(caught)).not.toContain(SECRET_KEY);
    expect(String(caught)).not.toContain(WEBHOOK_SECRET);
  });

  it('fails safely on invalid JSON and fetch errors without echoing credentials', async () => {
    const invalid = configured(async () => response(200, '{not json'))!;
    await expect(
      invalid.createSession({ tenantId: 'tenant', orderId: 'order', amountCents: 100 }),
    ).rejects.toMatchObject({ code: 'invalid_json', status: 200 });

    const network = configured(async () => {
      throw new Error(`socket failed with Authorization: Bearer ${SECRET_KEY}`);
    })!;
    const caught = await network
      .createSession({ tenantId: 'tenant', orderId: 'order', amountCents: 100 })
      .then(() => undefined, (error: unknown) => error);
    expect(caught).toMatchObject({ code: 'network_error' });
    expect(String(caught)).not.toContain(SECRET_KEY);
  });

  it('aborts hung fetches at the bounded configured timeout', async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const fetch: StripeTerminalFetch = (_url, init) => {
      observedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    };
    const provider = configured(fetch, { requestTimeoutMs: 1 })!;
    const pending = provider.createSession({
      tenantId: 'tenant',
      orderId: 'order',
      amountCents: 100,
    });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'request_timeout' });
    await vi.advanceTimersByTimeAsync(99);
    expect(observedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(observedSignal?.aborted).toBe(true);
  });

  it('keeps the reader probe cold until provider configuration is complete', async () => {
    const fetch = vi.fn<StripeTerminalFetch>();
    for (const config of [
      {},
      { secretKey: SECRET_KEY },
      { secretKey: SECRET_KEY, webhookSecret: WEBHOOK_SECRET },
      { secretKey: SECRET_KEY, webhookSecret: WEBHOOK_SECRET, defaultReaderId: '   ' },
    ]) {
      await expect(verifyConfiguredStripeTerminalReader(config, { fetch })).resolves.toEqual({
        configured: false,
        verified: false,
        reason: 'not_configured',
        expectedReaderId: null,
        observedReaderId: null,
        status: null,
        error: null,
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('verifies only the exact configured reader when Stripe reports it online', async () => {
    const calls: FetchCall[] = [];
    const fetch: StripeTerminalFetch = async (url, init) => {
      calls.push({ url, init });
      return response(200, { id: 'tmr_server_default', status: 'online' });
    };
    const result = await verifyConfiguredStripeTerminalReader(
      {
        secretKey: SECRET_KEY,
        webhookSecret: WEBHOOK_SECRET,
        defaultReaderId: 'tmr_server_default',
        apiBase: 'https://stripe.example.test/',
        apiVersion: '2024-06-20',
      },
      { fetch },
    );
    expect(result).toEqual({
      configured: true,
      verified: true,
      reason: 'online',
      expectedReaderId: 'tmr_server_default',
      observedReaderId: 'tmr_server_default',
      status: 'online',
      error: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://stripe.example.test/v1/terminal/readers/tmr_server_default',
    );
    expect(calls[0]!.init).toMatchObject({
      method: 'GET',
      headers: {
        Authorization: `Bearer ${SECRET_KEY}`,
        'Stripe-Version': '2024-06-20',
      },
    });
    expect(calls[0]!.init.headers['Content-Type']).toBeUndefined();
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it('fails closed for offline, unknown-status, and mismatched readers', async () => {
    const verify = (payload: unknown) => verifyConfiguredStripeTerminalReader(
      {
        secretKey: SECRET_KEY,
        webhookSecret: WEBHOOK_SECRET,
        defaultReaderId: 'tmr_server_default',
      },
      { fetch: async () => response(200, payload) },
    );

    await expect(verify({ id: 'tmr_server_default', status: 'offline' })).resolves.toMatchObject({
      configured: true,
      verified: false,
      reason: 'offline',
      status: 'offline',
    });
    await expect(verify({ id: 'tmr_server_default', status: 'busy' })).resolves.toMatchObject({
      configured: true,
      verified: false,
      reason: 'not_online',
      status: 'busy',
    });
    await expect(verify({ id: 'tmr_different', status: 'online' })).resolves.toMatchObject({
      configured: true,
      verified: false,
      reason: 'reader_mismatch',
      expectedReaderId: 'tmr_server_default',
      observedReaderId: 'tmr_different',
      status: 'online',
    });
  });

  it('returns sanitized structured reader failures for network and Stripe errors', async () => {
    const config = {
      secretKey: SECRET_KEY,
      webhookSecret: WEBHOOK_SECRET,
      defaultReaderId: 'tmr_server_default',
    };
    const network = await verifyConfiguredStripeTerminalReader(config, {
      fetch: async () => {
        throw new Error(`socket leaked Bearer ${SECRET_KEY} and ${WEBHOOK_SECRET}`);
      },
    });
    expect(network).toMatchObject({
      configured: true,
      verified: false,
      reason: 'request_failed',
      error: { code: 'network_error', status: null, requestId: null },
    });
    expect(JSON.stringify(network)).not.toContain(SECRET_KEY);
    expect(JSON.stringify(network)).not.toContain(WEBHOOK_SECRET);

    const stripeFailure = await verifyConfiguredStripeTerminalReader(config, {
      fetch: async () => response(
        401,
        { error: { code: 'invalid_api_key', message: `bad ${SECRET_KEY} ${WEBHOOK_SECRET}` } },
        { 'request-id': 'req_reader_safe' },
      ),
    });
    expect(stripeFailure).toMatchObject({
      configured: true,
      verified: false,
      reason: 'request_failed',
      error: { code: 'invalid_api_key', status: 401, requestId: 'req_reader_safe' },
    });
    expect(JSON.stringify(stripeFailure)).not.toContain(SECRET_KEY);
    expect(JSON.stringify(stripeFailure)).not.toContain(WEBHOOK_SECRET);
  });
});

it('keeps a phone reader unavailable for the server-driven iPad checkout', async () => {
  const result = await verifyConfiguredStripeTerminalReader({ secretKey: SECRET_KEY,
    webhookSecret: WEBHOOK_SECRET, defaultReaderId: 'tmr_phone' }, {
    fetch: async () => response(200, { id: 'tmr_phone', status: 'online', device_type: 'mobile_phone_reader' }),
  });
  expect(result).toMatchObject({ configured: true, verified: false, reason: 'unsupported_reader' });
});
