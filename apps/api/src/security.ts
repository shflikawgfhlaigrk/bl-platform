/**
 * Security hardening for the composition-root app (applied ONCE, in front of
 * every route). Deterministic and testable — the rate limiter takes an
 * injectable clock, and every rule is header-driven (no hidden global state
 * beyond the limiter's in-memory buckets).
 *
 * Rules:
 *  - Security headers on EVERY response: a self-only CSP, nosniff, no-referrer,
 *    DENY framing.
 *  - Origin/CSRF: a browser mutation (POST/PUT/PATCH/DELETE carrying an `Origin`
 *    header) is rejected 403 unless the Origin is same-origin OR it carries the
 *    custom `x-mags-csrf: 1` header. Loopback tools (no Origin) always pass —
 *    a browser cannot forge a missing Origin cross-site.
 *  - Rate limit: a token bucket per (ip, route-group). General 300/min; the
 *    "auth-ish" groups (credentials, invitations, accept, session policy) 30/min.
 *  - Streamed body caps: 64KiB auth, 5MiB general/files, 50MiB imports; 30s deadline.
 *  - Structured request log (admin.createLogger) with a correlation id — method,
 *    path, status, ms only. NEVER a body, never PII.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { ApiError, id } from '@blacklabel/core';
import type { Logger } from '@blacklabel/admin';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const FIVE_MB = 5 * 1024 * 1024;
const FIFTY_MB = 50 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * Security headers
 * ------------------------------------------------------------------ */

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    // Self-only: no external scripts, styles, images, fetch, frames.
    c.res.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'",
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
  updatedAtMs: number;
}

export interface RateLimitOptions {
  /** ms epoch clock. Injected in tests for determinism. Default Date.now. */
  now?: () => number;
  generalPerMinute?: number;
  authPerMinute?: number;
}

const AUTH_ISH = /\/(credentials|invitations|accept|session-policy)\b/;

/** Route group key: /api/<module>, else the first path segment. */
function routeGroup(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'api' && parts[1]) return `api/${parts[1]}`;
  return parts[0] ?? '/';
}

export function clientIp(c: Context): string {
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return c.req.header('x-real-ip') ?? '127.0.0.1';
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly general: number;
  private readonly auth: number;

  constructor(opts: RateLimitOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.general = opts.generalPerMinute ?? 300;
    this.auth = opts.authPerMinute ?? 30;
  }

  /** Returns true when allowed; false when the bucket is empty (429). */
  take(ip: string, path: string): boolean {
    const group = routeGroup(path);
    const capacity = AUTH_ISH.test(path) ? this.auth : this.general;
    const refillPerMs = capacity / 60_000; // capacity tokens per minute
    const key = `${ip}|${group}`;
    const nowMs = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, updatedAtMs: nowMs };
      this.buckets.set(key, bucket);
    }
    // Refill for elapsed time, capped at capacity.
    const elapsed = Math.max(0, nowMs - bucket.updatedAtMs);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
    bucket.updatedAtMs = nowMs;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
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
      const fileUpload = /^\/api\/(?:files\/uploads\/[^/]+\/complete|portal-customer\/me\/uploads)$/.test(c.req.path);
      const auth = /\/(?:auth|login)(?:\/|$)/.test(c.req.path);
      const cap = auth ? 64 * 1024 : fileUpload ? FIVE_MB : /import/.test(c.req.path) ? FIFTY_MB : FIVE_MB;
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
