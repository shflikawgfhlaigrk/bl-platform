/** Per-user, tenant-bound credentials. Only trusted local code can issue them. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { ApiError, asCoreDb } from '@blacklabel/core';
import type { Kysely } from 'kysely';
import type { PlatformDatabase } from './app';

export interface Principal { v: 1; tenantId: string; userId: string; issuedAt: number; expiresAt: number; nonce: string }
declare module 'hono' {
  interface ContextVariableMap { authenticatedUserId: string; authenticatedPrincipal: Principal }
}
export function identityCredentials(secret: Buffer | string = randomBytes(32)) {
  const key = createHmac('sha256', secret).update('blacklabel-platform-request-identity-v1').digest();
  const signature = (body: string) => createHmac('sha256', key).update(body).digest();
  return {
    issue(tenantId: string, userId: string, now = Date.now()): string {
      if (!tenantId || !userId) throw new Error('A tenant and user are required');
      const value: Principal = { v:1, tenantId, userId, issuedAt:now, expiresAt:now+3600_000, nonce:randomBytes(16).toString('hex') };
      const body = Buffer.from(JSON.stringify(value)).toString('base64url');
      return body + '.' + signature(body).toString('base64url');
    },
    verify(token: string, now = Date.now()): Principal | undefined {
      if (!token || token.length > 2048) return;
      const parts = token.split('.'); if (parts.length !== 2) return;
      try {
        const actual = Buffer.from(parts[1], 'base64url'), expected = signature(parts[0]);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return;
        const p = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as Principal;
        if (p.v !== 1 || typeof p.tenantId !== 'string' || !p.tenantId || typeof p.userId !== 'string' || !p.userId ||
            !Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.expiresAt) || p.issuedAt > now ||
            p.expiresAt <= now || p.expiresAt <= p.issuedAt || p.expiresAt - p.issuedAt > 3600_000) return;
        return p;
      } catch { return; }
    },
  };
}

export function requestToken(c: Context): string {
  const header = c.req.header('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

/** These routes enforce customer/employee/provider tokens inside their own handler. */
export function independentIdentity(method: string, path: string): boolean {
  if ((method === 'GET' || method === 'HEAD') && path === '/api/health') return true;
  if (/^\/api\/portal-customer\/(?:auth\/(?:request-link|exchange|logout)|me(?:\/.*)?|ui(?:\/.*)?)$/.test(path)) return true;
  if (/^\/api\/portal-employee\/portal(?:\/|$)/.test(path)) return true;
  if (method === 'GET' && path === '/api/outreach/unsubscribe') return true;
  if (method === 'POST' && path === '/api/customers/consents/double-opt-in/confirm') return true;
  if ((method === 'GET' && /^\/api\/reviews\/public\/requests\/[^/]+$/.test(path)) ||
      (method === 'POST' && /^\/api\/reviews\/public\/requests\/[^/]+\/(?:submit|opt-out)$/.test(path))) return true;
  return method === 'POST' && /^\/api\/orders\/webhooks\/[^/]+$/.test(path);
}

export function identityGuard(db: Kysely<PlatformDatabase>, credentials: ReturnType<typeof identityCredentials>): MiddlewareHandler {
  return async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (independentIdentity(c.req.method, c.req.path)) return next();
    const principal = credentials.verify(requestToken(c));
    if (!principal) throw ApiError.unauthorized('A signed user credential is required');
    const tenantHeader = c.req.header('x-tenant-id'), userHeader = c.req.header('x-user-id');
    if ((tenantHeader && tenantHeader !== principal.tenantId) || (userHeader && userHeader !== principal.userId)) {
      throw ApiError.forbidden('Credential identity does not match requested user or tenant');
    }
    const user = await asCoreDb(db).selectFrom('users').select('id').where('tenant_id','=',principal.tenantId).where('id','=',principal.userId).executeTakeFirst();
    if (!user) throw ApiError.unauthorized('Credential user no longer belongs to this tenant');
    const policy = await db.selectFrom('workforce_session_policies').select(['sessions_invalidated_after','max_age_hours']).where('tenant_id','=',principal.tenantId).executeTakeFirst();
    if (policy && ((policy.sessions_invalidated_after && principal.issuedAt <= Date.parse(policy.sessions_invalidated_after)) ||
        Date.now() - principal.issuedAt >= policy.max_age_hours * 3600_000)) throw ApiError.unauthorized('Credential has been invalidated');
    c.set('authenticatedUserId', principal.userId);
    c.set('authenticatedPrincipal', principal);
    // Legacy module audit/tenant readers receive only the verified identity.
    c.req.raw.headers.set('x-tenant-id',principal.tenantId);
    c.req.raw.headers.set('x-user-id',principal.userId);
    await next();
  };
}
