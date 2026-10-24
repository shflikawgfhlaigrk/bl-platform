/**
 * Security hardening for the composition-root app (applied ONCE, in front of
 * every route). Deterministic and testable — the rate limiter takes an
 * injectable clock, and request bodies are bounded before parsing (no hidden global state
 * beyond the limiter's in-memory buckets).
 *
 * Rules:
 *  - Security headers on EVERY response: self-only active content, local inline
 *    layout styles used by the DOM renderer, nosniff, no-referrer, DENY framing.
 *  - Origin/CSRF: a browser mutation (POST/PUT/PATCH/DELETE carrying an `Origin`
 *    header) is rejected 403 unless the Origin is same-origin OR it carries the
 *    custom `x-mags-csrf: 1` header. Loopback tools (no Origin) always pass —
 *    a browser cannot forge a missing Origin cross-site.
 *  - Rate limit: bounded per-source buckets. General 300/min; the
 *    "auth-ish" groups (credentials, invitations, accept, session policy) 30/min.
 *  - Streamed request-body caps: auth 64KiB, general 5MiB, files 15MiB,
 *    imports 50MiB; bounded reads have a 30 second deadline.
 *  - Structured request log (admin.createLogger) with a correlation id — method,
 *    path, status, ms only. NEVER a body, never PII.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { ApiError, id } from '@blacklabel/core';
import type { Logger } from '@blacklabel/admin';
import { isIP } from 'node:net';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const FIVE_MB = 5 * 1024 * 1024;
const FIFTY_MB = 50 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * Security headers
 * ------------------------------------------------------------------ */

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    // Active content stays self-only. The UI renderer intentionally composes
    // responsive flex/grid declarations in element style attributes, so styles
    // permit inline declarations while scripts retain default-src 'self'.
    c.res.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'",
    );
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('Referrer-Policy', 'no-referrer');
    c.res.headers.set('X-Frame-Options', 'DENY');
  };
}

/* ------------------------------------------------------------------ *
 * Origin / CSRF
 * ------------------------------------------------------------------ */

export function csrfGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (MUTATING.has(c.req.method)) {
      const origin = c.req.header('Origin');
      if (origin) {
        const host = c.req.header('Host');
        const sameOrigin = host !== undefined && originHost(origin) === host;
        const hasCsrf = c.req.header('x-mags-csrf') === '1';
        if (!sameOrigin && !hasCsrf) {
          throw new ApiError(403, 'cross-origin request blocked', 'csrf_blocked');
        }
      }
      // No Origin header → a non-browser loopback tool. Allowed.
    }
    await next();
  };
}

function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Rate limiter (token bucket, injectable clock)
 * ------------------------------------------------------------------ */

interface Bucket {
  tokens: number;
  authTokens: number;
  updatedAtMs: number;
}

export interface RateLimitOptions {
  /** ms epoch clock. Injected in tests for determinism. Default Date.now. */
  now?: () => number;
  generalPerMinute?: number;
  authPerMinute?: number;
  /** Maximum retained source identities; new sources fail closed at capacity. */
  maxBuckets?: number;
  /** Idle eviction cannot precede a full token refill (at least one minute). */
  idleMs?: number;
}

const AUTH_ISH = /\/(credentials|invitations|accept|session-policy)\b/;


export function clientIp(c: Context): string {
  // Forwarded headers are caller-controlled without an explicitly trusted
  // proxy boundary. Use the node server's socket identity, never those headers.
  const peer = c.env?.incoming?.socket?.remoteAddress;
  return typeof peer === 'string' && isIP(peer) ? peer : 'unknown';
}

export class RateLimiter {
  // Only source identities are retained. The two budget categories are fixed;
  // neither known modules nor arbitrary unknown paths allocate a new bucket.
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly general: number;
  private readonly auth: number;
  private readonly maxBuckets: number;
  private readonly idleMs: number;
  private lastNow = 0;

  constructor(opts: RateLimitOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.general = opts.generalPerMinute ?? 300;
    this.auth = opts.authPerMinute ?? 30;
    this.maxBuckets = opts.maxBuckets ?? 10_000;
    this.idleMs = opts.idleMs ?? 120_000;
    for (const value of [this.general, this.auth, this.maxBuckets]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('rate-limit capacities must be positive integers');
    }
    if (!Number.isFinite(this.idleMs) || this.idleMs < 60_000) throw new Error('rate-limit idle expiry must be at least one minute');
  }

  /** Returns true when allowed; both auth and general budgets use one source. */
  take(ip: string, path: string): boolean {
    const clock = this.now();
    if (!Number.isFinite(clock)) return false;
    const nowMs = Math.max(this.lastNow, clock);
    this.lastNow = nowMs;
    // Map insertion order tracks last use. Only the idle prefix is scanned.
    // Active/depleted clients are never evicted just to admit a new identity.
    for (const [key, bucket] of this.buckets) {
      if (nowMs - bucket.updatedAtMs < this.idleMs) break;
      this.buckets.delete(key);
    }
    const key = typeof ip === 'string' && ip.length <= 128 ? ip : 'unknown';
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxBuckets) return false;
      bucket = { tokens: this.general, authTokens: this.auth, updatedAtMs: nowMs };
    }
    const elapsed = nowMs - bucket.updatedAtMs;
    bucket.tokens = Math.min(this.general, bucket.tokens + elapsed * this.general / 60_000);
    bucket.authTokens = Math.min(this.auth, bucket.authTokens + elapsed * this.auth / 60_000);
    bucket.updatedAtMs = nowMs;
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    const authRequest = AUTH_ISH.test(path);
    if (bucket.tokens < 1 || (authRequest && bucket.authTokens < 1)) return false;
    bucket.tokens -= 1;
    if (authRequest) bucket.authTokens -= 1;
    return true;
  }

  middleware(): MiddlewareHandler {
    return async (c, next) => {
      if (!this.take(clientIp(c), c.req.path)) {
        throw new ApiError(429, 'rate limit exceeded', 'rate_limited');
      }
      await next();
    };
  }
}

/* ------------------------------------------------------------------ *
 * Actual body-size admission (before downstream parsing or signature checks)
 * ------------------------------------------------------------------ */

export interface BodyLimitOptions {
  /** Absolute body-read deadline, not an idle timer reset by incoming bytes. */
  timeoutMs?: number;
}

async function readBoundedBody(request: Request, cap: number, declared: number | undefined, timeoutMs: number): Promise<Buffer> {
  const reader = request.body!.getReader();
  const blocks: Buffer[] = [];
  let size = 0;
  let block: Buffer | undefined;
  let used = 0;
  let stopped = false;
  const started = performance.now();
  const timeoutError = () => new ApiError(408, 'request body read timed out', 'body_timeout');
  let interrupt!: (error: Error) => void;
  const interrupted = new Promise<never>((_, reject) => { interrupt = reject; });
  const timer = setTimeout(() => interrupt(timeoutError()), timeoutMs);
  const onAbort = () => interrupt(ApiError.badRequest('request body interrupted'));
  request.signal.addEventListener('abort', onAbort, { once: true });

  async function consume(): Promise<Buffer> {
    if (request.signal.aborted) throw ApiError.badRequest('request body interrupted');
    while (!stopped) {
      // A stream of immediately resolved tiny chunks must not starve the timer.
      if (performance.now() - started >= timeoutMs) throw timeoutError();
      const { done, value } = await reader.read();
      if (stopped) break;
      if (done) {
        if (declared !== undefined && declared !== size) throw ApiError.badRequest('content-length does not match body');
        if (block && used) blocks.push(block.subarray(0, used));
        return Buffer.concat(blocks, size);
      }
      if (value.byteLength > cap - size) throw new ApiError(413, 'request body too large', 'payload_too_large');
      size += value.byteLength;
      // Retain fixed slabs, not one object per attacker-controlled tiny chunk.
      let offset = 0;
      while (offset < value.byteLength) {
        block ??= Buffer.allocUnsafe(64 * 1024);
        const count = Math.min(block.length - used, value.byteLength - offset);
        block.set(value.subarray(offset, offset + count), used);
        used += count; offset += count;
        if (used === block.length) { blocks.push(block); block = undefined; used = 0; }
      }
    }
    throw ApiError.badRequest('request body interrupted');
  }

  try {
    return await Promise.race([consume(), interrupted]);
  } catch (error) {
    stopped = true;
    // Cancellation is best effort and cannot delay the error response.
    void reader.cancel(error).catch(() => {});
    throw error instanceof ApiError ? error : ApiError.badRequest('invalid request body stream');
  } finally {
    stopped = true;
    clearTimeout(timer);
    request.signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

export function bodyLimit(options: BodyLimitOptions = {}): MiddlewareHandler {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('body timeout must be a positive integer');
  return async (c, next) => {
    const original = c.req.raw;
    if (MUTATING.has(c.req.method) || original.body) {
      const fileUpload = /^\/api\/(?:files\/uploads\/[^/]+\/complete|portal-customer\/(?:me|ui)\/uploads)$/.test(c.req.path);
      const auth = /\/(?:auth|login)(?:\/|$)/.test(c.req.path);
      const cap = auth ? 64 * 1024 : fileUpload ? 15 * 1024 * 1024 : /import/.test(c.req.path) ? FIFTY_MB : FIVE_MB;
      const rawLength = c.req.header('content-length');
      let declared: number | undefined;
      if (rawLength !== undefined) {
        declared = Number(rawLength);
        if (!/^\d+$/.test(rawLength) || !Number.isSafeInteger(declared)) {
          void original.body?.cancel().catch(() => {});
          throw ApiError.badRequest('invalid content-length');
        }
        if (declared > cap) {
          void original.body?.cancel().catch(() => {});
          throw new ApiError(413, 'request body too large', 'payload_too_large');
        }
      }
      if (original.body) {
        const bytes = await readBoundedBody(original, cap, declared, timeoutMs);
        // Keep byte-for-byte payloads and metadata for raw-body webhook checks
        // and framework JSON/text parsers. No parser sees unadmitted bytes.
        // The Node adapter supplies a lightweight Request, not a native Fetch
        // object with internal slots. Reconstruct from its public fields.
        c.req.raw = new Request(original.url, {
          method: original.method, headers: original.headers, body: bytes,
          signal: original.signal, redirect: original.redirect,
          credentials: original.credentials, cache: original.cache,
          integrity: original.integrity, keepalive: original.keepalive,
          referrer: original.referrer, referrerPolicy: original.referrerPolicy,
        });
      } else if (declared !== undefined && declared !== 0) {
        throw ApiError.badRequest('content-length does not match body');
      }
    }
    await next();
  };
}

/* ------------------------------------------------------------------ *
 * Structured request logging (correlation id; method/path/status/ms only)
 * ------------------------------------------------------------------ */

export function requestLogger(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const cid = id();
    const startedMs = Date.now();
    c.set('correlationId', cid);
    c.res.headers.set('x-correlation-id', cid);
    let status = 500;
    try {
      await next();
      status = c.res.status;
    } finally {
      c.res.headers.set('x-correlation-id', cid);
      logger.info('request', {
        correlationId: cid,
        method: c.req.method,
        path: c.req.path,
        status,
        ms: Date.now() - startedMs,
      });
    }
  };
}
