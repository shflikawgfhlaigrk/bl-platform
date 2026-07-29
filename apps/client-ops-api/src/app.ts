import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono, type MiddlewareHandler } from 'hono';
import type { Kysely } from '@blacklabel/db';
import {
  CLIENT_OPS_CATALOG,
  CLIENT_OPS_MANIFEST_SHA256,
  clientOpsRouter,
  type ClientOpsDatabase,
  type ServiceFoundationRegistry,
} from '@blacklabel/client-ops';
import { EventBus, type Contracts } from '@blacklabel/core';

export interface ClientOpsHttpAppOptions {
  db: Kysely<ClientOpsDatabase>;
  events: EventBus;
  tenantId: string;
  tenantName: string;
  environment?: string;
  /** Execution registry; without it the execute/foundations routes answer 501 honestly. */
  registry?: ServiceFoundationRegistry;
}

function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.res.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'",
    );
    c.res.headers.set('Referrer-Policy', 'no-referrer');
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('X-Frame-Options', 'DENY');
    c.res.headers.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
  };
}

function csrfGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      const host = c.req.header('host');
      let sameOrigin = false;
      if (origin && host) {
        try {
          sameOrigin = new URL(origin).host === host;
        } catch {
          sameOrigin = false;
        }
      }
      if (origin && !sameOrigin && c.req.header('x-mags-csrf') !== '1') {
        return c.json(
          { error: { code: 'csrf_blocked', message: 'cross-origin request blocked', details: null } },
          403,
        );
      }
    }
    await next();
  };
}

function bodySizeGuard(maxBytes = 1024 * 1024): MiddlewareHandler {
  return async (c, next) => {
    const declared = Number(c.req.header('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      return c.json(
        { error: { code: 'body_too_large', message: 'request body is too large', details: { maxBytes } } },
        413,
      );
    }
    await next();
  };
}

export function createClientOpsHttpApp(options: ClientOpsHttpAppOptions): Hono {
  const app = new Hono();
  app.use('*', securityHeaders());
  app.use('/api/*', csrfGuard());
  app.use('/api/*', bodySizeGuard());

  app.get('/api/health', (c) => c.json({
    data: {
      ok: true,
      service: 'blacklabel-client-ops',
      catalogVersion: CLIENT_OPS_CATALOG.catalogVersion,
      manifestSha256: CLIENT_OPS_MANIFEST_SHA256,
    },
  }));

  app.get('/api/bootstrap', (c) => c.json({
    data: {
      tenantId: options.tenantId,
      tenantName: options.tenantName,
      environment: options.environment ?? 'Production onboarding',
      apiBase: '/api/client-ops',
      catalogVersion: CLIENT_OPS_CATALOG.catalogVersion,
      manifestSha256: CLIENT_OPS_MANIFEST_SHA256,
    },
  }));

  app.route('/api/client-ops', clientOpsRouter({
    db: options.db,
    events: options.events,
    contracts: {} satisfies Contracts,
  }, { registry: options.registry }));

  app.notFound((c) => c.json({
    error: { code: 'not_found', message: 'route not found', details: null },
  }, 404));
  return app;
}

function tokenMatches(presented: string, expected: string): boolean {
  // Hash both sides so timingSafeEqual gets equal-length buffers regardless of input length.
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Shared-secret gate for any non-loopback exposure. Compose it OUTSIDE
 * withDefaultTenant so an unauthenticated caller is rejected before any tenant
 * injection can happen. `/api/health` stays open for uptime checks. With no
 * token configured the wrapper is a pass-through (loopback-only deployments).
 */
export function withBearerAuth(
  fetcher: (request: Request) => Response | Promise<Response>,
  token: string | undefined,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const pathname = new URL(request.url).pathname;
    const guarded = pathname.startsWith('/api/') && pathname !== '/api/health';
    if (!token || !guarded) return fetcher(request);
    const header = request.headers.get('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (presented === '' || !tokenMatches(presented, token)) {
      return Response.json(
        { error: { code: 'unauthorized', message: 'missing or invalid bearer token', details: null } },
        { status: 401, headers: { 'www-authenticate': 'Bearer' } },
      );
    }
    return fetcher(request);
  };
}

export interface TenantGuardOptions {
  /**
   * Loopback-development escape hatch ONLY (CLIENT_OPS_DEV_DEFAULT_TENANT).
   * Leave it unset everywhere else: once the engine hosts more than one paying
   * client an unlabelled request has no honest tenant, and injecting one would
   * pool every client's data, runs and receipts into whichever tenant the
   * process happens to own. server.ts refuses to boot with it set alongside
   * NODE_ENV=production or a configured bearer token.
   */
  devDefaultTenantId?: string;
}

/**
 * Tenancy fails closed. Every /api/client-ops request must name its tenant; an
 * unlabelled one is refused with `tenant_required` instead of being silently
 * defaulted. An x-tenant-id naming a tenant that does not exist is rejected
 * downstream by tenantMiddleware (404 `tenant_unknown`) — the engine never
 * creates or assumes a tenant. Compose this INSIDE withBearerAuth so an
 * unauthenticated caller is rejected before any tenant work happens.
 */
export function withTenantGuard(
  fetcher: (request: Request) => Response | Promise<Response>,
  options: TenantGuardOptions = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    const pathname = new URL(request.url).pathname;
    if (!pathname.startsWith('/api/client-ops')) return fetcher(request);
    if ((request.headers.get('x-tenant-id') ?? '').trim() !== '') return fetcher(request);
    const fallback = (options.devDefaultTenantId ?? '').trim();
    if (fallback === '') {
      return Response.json(
        {
          error: {
            code: 'tenant_required',
            message: 'x-tenant-id is required; the engine never assumes a tenant',
            details: null,
          },
        },
        { status: 400 },
      );
    }
    const headers = new Headers(request.headers);
    headers.set('x-tenant-id', fallback);
    return fetcher(new Request(request, { headers }));
  };
}
