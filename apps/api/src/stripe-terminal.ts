import {
  stripeTerminalCheckoutProvider,
  type CheckoutProvider,
  type HttpTransport,
} from '@blacklabel/orders';

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_048_576;

/**
 * Server-owned Stripe Terminal configuration. The composition root is
 * responsible for reading environment variables or another secret store and
 * passing the resulting values here; this module never reads process.env.
 */
export interface StripeTerminalConfig {
  secretKey?: string | null;
  webhookSecret?: string | null;
  defaultReaderId?: string | null;
  apiBase?: string | null;
  /** Sent as Stripe-Version only when explicitly configured and nonblank. */
  apiVersion?: string | null;
  currency?: string | null;
  requestTimeoutMs?: number | null;
  webhookToleranceSeconds?: number | null;
}

/** Minimal environment shape accepted by the server configuration reader. */
export type StripeTerminalEnvironment = Readonly<Record<string, string | undefined>>;

function optionalEnvInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '' || !/^-?\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Explicit process environment contract used by server.ts. Unknown, blank, or
 * malformed optional values stay absent and therefore use safe adapter defaults.
 */
export function readStripeTerminalEnvConfig(env: StripeTerminalEnvironment): StripeTerminalConfig {
  return {
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    defaultReaderId: env.STRIPE_TERMINAL_READER_ID,
    apiVersion: env.STRIPE_API_VERSION,
    apiBase: env.STRIPE_API_BASE_URL,
    currency: env.STRIPE_CURRENCY,
    requestTimeoutMs: optionalEnvInteger(env.STRIPE_REQUEST_TIMEOUT_MS),
    webhookToleranceSeconds: optionalEnvInteger(env.STRIPE_WEBHOOK_TOLERANCE_SECONDS),
  };
}

export interface StripeTerminalFetchResponse {
  readonly status: number;
  readonly headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Fetch-compatible dependency kept deliberately small for deterministic tests. */
export type StripeTerminalFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<StripeTerminalFetchResponse>;

export interface StripeTerminalTransportOptions {
  secretKey: string;
  fetch: StripeTerminalFetch;
  apiVersion?: string | null;
  requestTimeoutMs?: number | null;
}

export interface StripeTerminalProviderDependencies {
  fetch: StripeTerminalFetch;
}

export type StripeTerminalReaderVerificationReason =
  | 'not_configured'
  | 'unsupported_currency'
  | 'unsupported_reader'
  | 'online'
  | 'offline'
  | 'not_online'
  | 'reader_mismatch'
  | 'invalid_response'
  | 'request_failed';

export interface StripeTerminalReaderVerificationError {
  code: string;
  status: number | null;
  requestId: string | null;
}

/** Fail-closed server verification result. No credential-bearing fields exist. */
export interface StripeTerminalReaderVerification {
  configured: boolean;
  verified: boolean;
  reason: StripeTerminalReaderVerificationReason;
  expectedReaderId: string | null;
  observedReaderId: string | null;
  status: string | null;
  error: StripeTerminalReaderVerificationError | null;
}

export interface StripeTerminalTransportErrorOptions {
  status?: number;
  code: string;
  stripeMessage?: string;
  requestId?: string;
}

/**
 * Error safe to surface to server logs or an API error mapper. It retains only
 * bounded Stripe error fields and never includes request bodies, headers,
 * credentials, response bodies, or the underlying fetch error.
 */
export class StripeTerminalTransportError extends Error {
  readonly status: number | undefined;
  readonly code: string;
  readonly stripeMessage: string | undefined;
  readonly requestId: string | undefined;

  constructor(message: string, options: StripeTerminalTransportErrorOptions) {
    super(message);
    this.name = 'StripeTerminalTransportError';
    this.status = options.status;
    this.code = options.code;
    this.stripeMessage = options.stripeMessage;
    this.requestId = options.requestId;
  }
}

function nonblank(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function timeoutMs(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.trunc(value)));
}

function redactSecrets(value: string, secretKey: string): string {
  let safe = value;
  if (secretKey !== '') safe = safe.split(secretKey).join('[redacted]');
  return safe
    .replace(/\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9_-]+\b/gi, '[redacted]')
    .replace(/\bwhsec_[A-Za-z0-9_-]+\b/gi, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeMessage(value: unknown, secretKey: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const safe = redactSecrets(value, secretKey);
  if (safe === '') return undefined;
  return safe.slice(0, 500);
}

function safeCode(value: unknown, secretKey: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const safe = safeMessage(value, secretKey);
  if (!safe || safe !== value || !/^[A-Za-z0-9_.:-]{1,128}$/.test(safe)) return undefined;
  return safe;
}

function safeRequestId(value: string | null | undefined, secretKey: string): string | undefined {
  if (!value) return undefined;
  const safe = safeMessage(value, secretKey);
  if (!safe || safe !== value || !/^[A-Za-z0-9_.:-]{1,255}$/.test(safe)) return undefined;
  return safe;
}

function copyForwardHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'authorization' || lower === 'content-type' || lower === 'stripe-version') {
      continue;
    }
    forwarded[name] = value;
  }
  return forwarded;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function httpFailure(
  status: number,
  payload: unknown,
  requestId: string | undefined,
  secretKey: string,
): StripeTerminalTransportError {
  const envelope = payload && typeof payload === 'object'
    ? (payload as { error?: unknown })
    : undefined;
  const stripeError = envelope?.error && typeof envelope.error === 'object'
    ? (envelope.error as { code?: unknown; decline_code?: unknown; message?: unknown })
    : undefined;
  const code = safeCode(stripeError?.decline_code, secretKey)
    ?? safeCode(stripeError?.code, secretKey)
    ?? 'stripe_http_error';
  const stripeMessage = safeMessage(stripeError?.message, secretKey);
  const summary = [
    `Stripe Terminal request failed with status ${status}`,
    `code ${code}`,
    stripeMessage,
  ].filter((part): part is string => Boolean(part)).join(': ');
  return new StripeTerminalTransportError(summary, {
    status,
    code,
    ...(stripeMessage ? { stripeMessage } : {}),
    ...(requestId ? { requestId } : {}),
  });
}

async function parseResponse(
  response: StripeTerminalFetchResponse,
  secretKey: string,
): Promise<unknown> {
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    throw new StripeTerminalTransportError('Stripe Terminal response could not be read', {
      status: response.status,
      code: 'response_read_failed',
    });
  }
  if (raw === '') return {};
  if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new StripeTerminalTransportError('Stripe Terminal response exceeded the size limit', {
      status: response.status,
      code: 'response_too_large',
    });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    if (!isSuccess(response.status)) return undefined;
    throw new StripeTerminalTransportError('Stripe Terminal returned invalid JSON', {
      status: response.status,
      code: 'invalid_json',
      stripeMessage: safeMessage('Invalid JSON response', secretKey),
    });
  }
}

/**
 * Adapt an injected fetch implementation to the orders package's transport.
 * All requests are application/x-www-form-urlencoded and authenticated with
 * the configured server secret. Stripe-Version is opt-in rather than guessed.
 */
export function createStripeTerminalHttpTransport(
  options: StripeTerminalTransportOptions,
): HttpTransport {
  const secretKey = options.secretKey.trim();
  if (secretKey === '') {
    throw new StripeTerminalTransportError('Stripe Terminal secret key is not configured', {
      code: 'configuration_error',
    });
  }
  const apiVersion = nonblank(options.apiVersion);
  const requestTimeoutMs = timeoutMs(options.requestTimeoutMs);

  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const method = init.method.toUpperCase();
      const sendsBody = method !== 'GET' && method !== 'HEAD';
      const headers: Record<string, string> = {
        ...copyForwardHeaders(init.headers),
        Authorization: `Bearer ${secretKey}`,
        ...(sendsBody ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(apiVersion ? { 'Stripe-Version': apiVersion } : {}),
      };
      const response = await options.fetch(url, {
        method,
        headers,
        // GET/HEAD must not carry a body; mutation bodies are canonicalized.
        ...(sendsBody ? { body: new URLSearchParams(init.body).toString() } : {}),
        signal: controller.signal,
      });
      if (!Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599) {
        throw new StripeTerminalTransportError('Stripe Terminal returned an invalid HTTP status', {
          code: 'invalid_response',
        });
      }
      const payload = await parseResponse(response, secretKey);
      const requestId = safeRequestId(response.headers?.get('request-id'), secretKey);
      if (!isSuccess(response.status)) {
        throw httpFailure(response.status, payload, requestId, secretKey);
      }
      return {
        status: response.status,
        json: async () => payload,
      };
    } catch (error) {
      if (error instanceof StripeTerminalTransportError) throw error;
      if (controller.signal.aborted) {
        throw new StripeTerminalTransportError(
          `Stripe Terminal request timed out after ${requestTimeoutMs}ms`,
          { code: 'request_timeout' },
        );
      }
      // Do not propagate the fetch error/cause: implementations may include
      // request headers or URLs containing credentials in their messages.
      throw new StripeTerminalTransportError(
        'Stripe Terminal request failed before receiving a response',
        { code: 'network_error' },
      );
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Return a live Stripe Terminal provider only when every required credential
 * and the server-owned default reader are present. Partial config stays cold.
 */
export function createConfiguredStripeTerminalProvider(
  config: StripeTerminalConfig,
  dependencies: StripeTerminalProviderDependencies,
): CheckoutProvider | null {
  const secretKey = nonblank(config.secretKey);
  const webhookSecret = nonblank(config.webhookSecret);
  const defaultReaderId = nonblank(config.defaultReaderId);
  const currency = (nonblank(config.currency) ?? 'usd').toLowerCase();
  if (!secretKey || !webhookSecret || !defaultReaderId || currency !== 'usd') return null;

  const apiBase = nonblank(config.apiBase)?.replace(/\/+$/, '');
  const webhookToleranceSeconds =
    typeof config.webhookToleranceSeconds === 'number'
    && Number.isSafeInteger(config.webhookToleranceSeconds)
    && config.webhookToleranceSeconds >= 0
      ? config.webhookToleranceSeconds
      : undefined;

  return stripeTerminalCheckoutProvider({
    secretKey,
    webhookSecret,
    defaultReaderId,
    transport: createStripeTerminalHttpTransport({
      secretKey,
      fetch: dependencies.fetch,
      apiVersion: config.apiVersion,
      requestTimeoutMs: config.requestTimeoutMs,
    }),
    ...(apiBase ? { apiBase } : {}),
    currency: 'usd',
    ...(webhookToleranceSeconds !== undefined ? { webhookToleranceSeconds } : {}),
  });
}

function unconfiguredReaderVerification(config: StripeTerminalConfig): StripeTerminalReaderVerification {
  const secretKey = nonblank(config.secretKey) ?? '';
  const webhookSecret = nonblank(config.webhookSecret) ?? '';
  return {
    configured: false,
    verified: false,
    reason: 'not_configured',
    expectedReaderId: readerPayloadField(nonblank(config.defaultReaderId), secretKey, webhookSecret),
    observedReaderId: null,
    status: null,
    error: null,
  };
}

function readerPayloadField(value: unknown, ...secrets: string[]): string | null {
  if (typeof value !== 'string') return null;
  let safe = value;
  for (const secret of secrets) {
    if (secret !== '') safe = safe.split(secret).join('[redacted]');
  }
  return safeMessage(safe, secrets[0] ?? '') ?? null;
}

/**
 * Query the configured Stripe reader using the same bounded, credential-safe
 * transport as checkout. Verification succeeds only when Stripe returns the
 * exact configured reader id and the exact `online` status.
 */
export async function verifyConfiguredStripeTerminalReader(
  config: StripeTerminalConfig,
  dependencies: StripeTerminalProviderDependencies,
): Promise<StripeTerminalReaderVerification> {
  const secretKey = nonblank(config.secretKey);
  const webhookSecret = nonblank(config.webhookSecret);
  const expectedReaderId = nonblank(config.defaultReaderId);
  if (!secretKey || !webhookSecret || !expectedReaderId) {
    return unconfiguredReaderVerification(config);
  }
  if ((nonblank(config.currency) ?? 'usd').toLowerCase() !== 'usd') {
    return {
      configured: false,
      verified: false,
      reason: 'unsupported_currency',
      expectedReaderId: readerPayloadField(expectedReaderId, secretKey, webhookSecret),
      observedReaderId: null,
      status: null,
      error: null,
    };
  }
  const reportedReaderId = readerPayloadField(expectedReaderId, secretKey, webhookSecret);

  const apiBase = nonblank(config.apiBase)?.replace(/\/+$/, '') ?? 'https://api.stripe.com';
  const transport = createStripeTerminalHttpTransport({
    secretKey,
    fetch: dependencies.fetch,
    apiVersion: config.apiVersion,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  try {
    const response = await transport(
      `${apiBase}/v1/terminal/readers/${encodeURIComponent(expectedReaderId)}`,
      { method: 'GET', headers: {}, body: '' },
    );
    const payload = await response.json();
    if (!payload || typeof payload !== 'object') {
      return {
        configured: true,
        verified: false,
        reason: 'invalid_response',
        expectedReaderId: reportedReaderId,
        observedReaderId: null,
        status: null,
        error: null,
      };
    }
    const reader = payload as { id?: unknown; status?: unknown; device_type?: unknown };
    const observedReaderId = readerPayloadField(reader.id, secretKey, webhookSecret);
    const status = readerPayloadField(reader.status, secretKey, webhookSecret);
    if (typeof reader.id !== 'string' || typeof reader.status !== 'string') {
      return {
        configured: true,
        verified: false,
        reason: 'invalid_response',
        expectedReaderId: reportedReaderId,
        observedReaderId,
        status,
        error: null,
      };
    }
    if (reader.id !== expectedReaderId) {
      return {
        configured: true,
        verified: false,
        reason: 'reader_mismatch',
        expectedReaderId: reportedReaderId,
        observedReaderId,
        status,
        error: null,
      };
    }
    if (reader.device_type !== undefined && !['bbpos_wisepos_e', 'stripe_s700'].includes(String(reader.device_type))) {
      return { configured: true, verified: false, reason: 'unsupported_reader',
        expectedReaderId: reportedReaderId, observedReaderId, status, error: null };
    }
    if (reader.status !== 'online') {
      return {
        configured: true,
        verified: false,
        reason: reader.status === 'offline' ? 'offline' : 'not_online',
        expectedReaderId: reportedReaderId,
        observedReaderId,
        status,
        error: null,
      };
    }
    return {
      configured: true,
      verified: true,
      reason: 'online',
      expectedReaderId: reportedReaderId,
      observedReaderId,
      status,
      error: null,
    };
  } catch (error) {
    let safeError: StripeTerminalReaderVerificationError;
    if (error instanceof StripeTerminalTransportError) {
      const code = readerPayloadField(error.code, secretKey, webhookSecret);
      const requestId = readerPayloadField(error.requestId, secretKey, webhookSecret);
      safeError = {
        code: code === error.code ? code : 'redacted_error',
        status: error.status ?? null,
        requestId: requestId === error.requestId ? requestId : null,
      };
    } else {
      safeError = { code: 'unknown_error', status: null, requestId: null };
    }
    return {
      configured: true,
      verified: false,
      reason: 'request_failed',
      expectedReaderId: reportedReaderId,
      observedReaderId: null,
      status: null,
      error: safeError,
    };
  }
}

/** Read-only account connection check, independent of checkout readiness. */
export async function inspectStripeTerminalConnection(config: StripeTerminalConfig, dependencies: StripeTerminalProviderDependencies) {
  const secretKey = nonblank(config.secretKey);
  if (!secretKey) return { connected: false, mode: null, readers: [], webhookConfigured: false, code: 'missing_credentials' };
  const transport = createStripeTerminalHttpTransport({ secretKey, fetch: dependencies.fetch,
    apiVersion: config.apiVersion, requestTimeoutMs: config.requestTimeoutMs });
  try {
    const response = await transport(`${nonblank(config.apiBase)?.replace(/\/+$/, '') ?? 'https://api.stripe.com'}/v1/terminal/readers?limit=100`,
      { method: 'GET', headers: {}, body: '' });
    const payload = await response.json() as { data?: Array<Record<string, unknown>> };
    if (!Array.isArray(payload.data)) throw new Error('invalid reader list');
    const readers = payload.data.map((reader) => ({
      id: readerPayloadField(reader.id, secretKey, config.webhookSecret ?? ''),
      label: readerPayloadField(reader.label, secretKey, config.webhookSecret ?? ''),
      status: readerPayloadField(reader.status, secretKey, config.webhookSecret ?? ''),
      deviceType: readerPayloadField(reader.device_type, secretKey, config.webhookSecret ?? ''),
      live: reader.livemode === true,
      compatible: ['bbpos_wisepos_e', 'stripe_s700'].includes(String(reader.device_type)),
    }));
    return { connected: true, mode: /^(?:sk|rk)_live_/.test(secretKey) ? 'live' : 'test', readers,
      webhookConfigured: Boolean(nonblank(config.webhookSecret)), code: 'connected' };
  } catch (error) {
    return { connected: false, mode: null, readers: [], webhookConfigured: Boolean(nonblank(config.webhookSecret)),
      code: error instanceof StripeTerminalTransportError ? error.code : 'connection_failed' };
  }
}
