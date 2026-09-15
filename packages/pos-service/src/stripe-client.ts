/**
 * Minimal Stripe transport for the POS service.
 *
 * Two request shapes, both verified against Stripe's API reference (2026-09-15):
 * - v1 (Terminal, PaymentIntents, Refunds): form-encoded bodies, `Stripe-Account` header for
 *   direct charges on a connected account.
 * - v2 (Accounts, Account Links): JSON bodies, indexed array query parameters (`include[0]=…`).
 *
 * The client never reads environment variables and never logs. Errors carry only bounded Stripe
 * fields (status, code, message, request id) — never request bodies, headers, or credentials.
 */

export const STRIPE_API_VERSION = '2026-08-26.dahlia';

const DEFAULT_API_BASE = 'https://api.stripe.com';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_048_576;

export interface StripeFetchResponse {
  readonly status: number;
  readonly headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

export type StripeFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<StripeFetchResponse>;

export interface StripeClientOptions {
  secretKey: string;
  fetch: StripeFetch;
  apiVersion?: string;
  apiBase?: string;
  timeoutMs?: number;
}

export interface StripeV1Request {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  params?: Record<string, unknown>;
  /** Connected account id for direct charges (sent as Stripe-Account). */
  account?: string;
  idempotencyKey?: string;
}

export interface StripeV2Request {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface StripeClient {
  readonly livemode: boolean;
  v1<T = Record<string, unknown>>(request: StripeV1Request): Promise<T>;
  v2<T = Record<string, unknown>>(request: StripeV2Request): Promise<T>;
}

export class StripeRequestError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly stripeMessage: string | null;
  readonly requestId: string | null;

  constructor(message: string, fields: { status: number | null; code: string; stripeMessage?: string | null; requestId?: string | null }) {
    super(message);
    this.name = 'StripeRequestError';
    this.status = fields.status;
    this.code = fields.code;
    this.stripeMessage = fields.stripeMessage ?? null;
    this.requestId = fields.requestId ?? null;
  }
}

type ArrayStyle = 'brackets' | 'indexed';

/**
 * Encode nested params the way Stripe expects.
 * - objects: `a[b]=c`
 * - arrays of scalars: `a[]=x` (v1 bodies) or `a[0]=x` (v2 queries)
 * - arrays of objects: `a[0][b]=c`
 * `undefined` and `null` are omitted rather than sent as empty strings.
 */
export function encodeParams(params: Record<string, unknown>, arrayStyle: ArrayStyle = 'brackets'): string {
  const pairs: string[] = [];
  const add = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const scalar = item === null || typeof item !== 'object';
        add(scalar && arrayStyle === 'brackets' ? `${key}[]` : `${key}[${index}]`, item);
      });
      return;
    }
    if (typeof value === 'object') {
      for (const [child, childValue] of Object.entries(value as Record<string, unknown>)) add(`${key}[${child}]`, childValue);
      return;
    }
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  };
  for (const [key, value] of Object.entries(params)) add(key, value);
  return pairs.join('&');
}

function readLivemode(secretKey: string): boolean {
  if (/^(sk|rk)_live_/.test(secretKey)) return true;
  if (/^(sk|rk)_test_/.test(secretKey)) return false;
  throw new StripeRequestError('Stripe secret key has an unrecognised format.', { status: null, code: 'invalid_secret_key' });
}

function assertPath(path: string, prefix: '/v1/' | '/v2/'): void {
  if (!path.startsWith(prefix) || path.includes('..') || /[\s?#]/.test(path)) {
    throw new StripeRequestError(`Refusing malformed Stripe path: ${path.slice(0, 80)}`, { status: null, code: 'invalid_path' });
  }
}

export function createStripeClient(options: StripeClientOptions): StripeClient {
  const secretKey = options.secretKey?.trim();
  if (!secretKey) throw new StripeRequestError('Stripe secret key is required.', { status: null, code: 'invalid_secret_key' });
  const livemode = readLivemode(secretKey);
  const apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  const base = new URL(apiBase);
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) {
    throw new StripeRequestError('Stripe API base must use https.', { status: null, code: 'invalid_api_base' });
  }
  const apiVersion = options.apiVersion?.trim() || STRIPE_API_VERSION;
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 100), 60_000);

  async function send<T>(method: string, url: string, headers: Record<string, string>, body: string | undefined): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: StripeFetchResponse;
    try {
      response = await options.fetch(url, { method, headers, ...(body === undefined ? {} : { body }), signal: controller.signal });
    } catch (error) {
      const aborted = controller.signal.aborted;
      throw new StripeRequestError(aborted ? 'Stripe request timed out.' : 'Stripe request failed before a response.', {
        status: null, code: aborted ? 'request_timeout' : 'request_failed',
      });
    } finally {
      clearTimeout(timer);
    }
    const requestId = response.headers?.get('request-id') ?? null;
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new StripeRequestError('Stripe response exceeded the size limit.', { status: response.status, code: 'response_too_large', requestId });
    }
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new StripeRequestError('Stripe returned a non-JSON response.', { status: response.status, code: 'invalid_response', requestId });
    }
    if (response.status < 200 || response.status >= 300) {
      const error = (parsed as { error?: { code?: unknown; type?: unknown; message?: unknown } }).error ?? {};
      const code = typeof error.code === 'string' ? error.code : typeof error.type === 'string' ? error.type : `http_${response.status}`;
      const stripeMessage = typeof error.message === 'string' ? error.message.slice(0, 500) : null;
      throw new StripeRequestError(`Stripe request failed (${response.status} ${code}).`, { status: response.status, code, stripeMessage, requestId });
    }
    return parsed as T;
  }

  return {
    livemode,
    async v1<T>(request: StripeV1Request): Promise<T> {
      assertPath(request.path, '/v1/');
      const headers: Record<string, string> = { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': apiVersion };
      if (request.account) {
        if (!/^acct_[A-Za-z0-9]+$/.test(request.account)) throw new StripeRequestError('Invalid connected account id.', { status: null, code: 'invalid_account' });
        headers['Stripe-Account'] = request.account;
      }
      if (request.idempotencyKey) headers['Idempotency-Key'] = request.idempotencyKey;
      const encoded = encodeParams(request.params ?? {}, 'brackets');
      if (request.method === 'GET' || request.method === 'DELETE') {
        return send<T>(request.method, `${apiBase}${request.path}${encoded ? `?${encoded}` : ''}`, headers, undefined);
      }
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      return send<T>(request.method, `${apiBase}${request.path}`, headers, encoded);
    },
    async v2<T>(request: StripeV2Request): Promise<T> {
      assertPath(request.path, '/v2/');
      const headers: Record<string, string> = { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': apiVersion };
      if (request.idempotencyKey) headers['Idempotency-Key'] = request.idempotencyKey;
      const query = request.query ? encodeParams(request.query, 'indexed') : '';
      const url = `${apiBase}${request.path}${query ? `?${query}` : ''}`;
      if (request.method === 'GET') return send<T>('GET', url, headers, undefined);
      headers['Content-Type'] = 'application/json';
      return send<T>('POST', url, headers, JSON.stringify(request.body ?? {}));
    },
  };
}
