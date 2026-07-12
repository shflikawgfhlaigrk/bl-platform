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
 *  - Request-body size cap by Content-Length: 5MB, except import lanes 50MB.
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
 * Body-size cap (by Content-Length; import lanes get the larger cap)
 * ------------------------------------------------------------------ */

export function bodyLimit(): MiddlewareHandler {
  return async (c, next) => {
    if (MUTATING.has(c.req.method)) {
      const len = Number(c.req.header('content-length') ?? '0');
      if (Number.isFinite(len) && len > 0) {
        const cap = /\/import\b|\/imports\b|import/.test(c.req.path) ? FIFTY_MB : FIVE_MB;
        if (len > cap) {
          throw new ApiError(413, `request body too large (${len} > ${cap})`, 'payload_too_large');
        }
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
