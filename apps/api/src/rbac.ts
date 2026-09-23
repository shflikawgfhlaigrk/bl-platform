/**
 * Local-first single-owner RBAC, enforced at the composition root.
 *
 * Acting user: the tenant-bound, signed credential verified at the composition
 * root. An absent user header never selects an owner.
 *
 * We centralize enforcement in ONE middleware (rather than wrapping each module
 * router) so the guard can resolve the tenant itself and match a small, explicit
 * route→permission table. Owner holds every permission; a cashier hits 403 on
 * purchasing/finance/admin/etc. Permissions come straight from workforce's
 * catalog + `can()` (the RBAC-as-data source of truth).
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { Kysely } from 'kysely';
import privilegedRoutes from './privileged-routes.json';
import { ApiError, asCoreDb, getTenant, type CoreDatabase } from '@blacklabel/core';
import { can, type WorkforceDatabase, type WorkforcePermission } from '@blacklabel/workforce';
import { independentIdentity } from './identity';

export interface RbacRule {
  /** True when this rule governs the request. */
  test: (method: string, path: string) => boolean;
  permission: WorkforcePermission;
}

const isRead = (m: string) => m === 'GET' || m === 'HEAD';
const privileged = (p: string) => /^\/api\/(?:finance|admin)(?:\/|$)/.test(p);
// This inventory is specific to this worktree; new privileged endpoints need review.
const reviewed = privilegedRoutes.map(([method, path]) => ({ method, pattern: new RegExp('^' + path.split('/').map(s => s.startsWith(':') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/') + '$') }));
const knownPrivileged = (method: string, path: string) => reviewed.some(r => r.method === (method === 'HEAD' ? 'GET' : method) && r.pattern.test(path));
const endsWith = (suffix: string) => (_m: string, p: string) => p.endsWith(suffix);

/**
 * Route→permission matrix (README §RBAC minimum + the four journey-18 asserts).
 * Ordered most-specific first; the first matching rule wins.
 */
export function defaultRbacRules(): RbacRule[] {
  return [
    // purchasing: approving a PO is the guarded privilege (journey 18).
    { test: endsWith('/approve'), permission: 'purchasing.approve' },
    // customers PII export.
    { test: (_m, p) => p.includes('/customers') && p.includes('export'), permission: 'customers.export' },
    // outreach arming + approval.
    { test: (_m, p) => p.includes('/outreach') && p.endsWith('/arm'), permission: 'outreach.arm' },
    { test: (_m, p) => p.includes('/outreach') && p.endsWith('/approve'), permission: 'outreach.approve' },
    // storefront publish (module not yet mounted — guard is inert until it is).
    { test: (_m, p) => p.includes('/storefront') && p.includes('publish'), permission: 'storefront.publish' },
    // workforce administration (roles/permissions, invitations, session policy).
    {
      test: (_m, p) =>
        p.includes('/workforce') &&
        (p.includes('/roles') || p.includes('/invitations') || p.includes('/users/') || p.includes('/session-policy')),
      permission: 'workforce.admin',
    },
    { test: (m, p) => m === 'POST' && /^\/api\/finance\/cash-sessions\/[^/]+\/close$/.test(p), permission: 'finance.close' },
    { test: (m, p) => m === 'POST' && p === '/api/finance/margin', permission: 'finance.read' },
    { test: (m, p) => isRead(m) && /^\/api\/finance(?:\/|$)/.test(p), permission: 'finance.read' },
    { test: (m, p) => !isRead(m) && /^\/api\/finance(?:\/|$)/.test(p), permission: 'finance.write' },
    { test: (m, p) => isRead(m) && /^\/api\/admin(?:\/|$)/.test(p), permission: 'admin.read' },
    { test: (m, p) => !isRead(m) && /^\/api\/admin(?:\/|$)/.test(p), permission: 'admin.admin' },
  ];
}

/** Identity is supplied only by the preceding credential middleware. */
export type GetActingUser = (c: Context, tenantId: string) => Promise<string | undefined>;
export function makeGetActingUser(_db: Kysely<CoreDatabase>): GetActingUser {
  return async (c, _tenantId) => c.get('authenticatedUserId') as string | undefined;
}

/**
 * The RBAC enforcement middleware. Matches the request against `rules`; if a
 * rule applies, resolves tenant + acting user and calls workforce `can()`.
 *  - no rule → pass (unguarded route)
 *  - tenant header missing/unknown → pass (the module's tenantMiddleware will
 *    return the canonical 400/404 — we don't duplicate that error here)
 *  - no acting user → 401
 *  - lacks the permission → 403
 */
export function rbacGuard(
  db: Kysely<WorkforceDatabase & CoreDatabase>,
  getActingUser: GetActingUser,
  rules: RbacRule[] = defaultRbacRules(),
): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    const path = c.req.path;
    if (independentIdentity(method, path)) return next();
    if (privileged(path) && !knownPrivileged(method, path)) throw ApiError.forbidden('unreviewed privileged operation');
    const rule = rules.find((r) => {
      try {
        return r.test(method, path);
      } catch {
        return false;
      }
    });
    if (!rule) {
      if (privileged(path)) throw ApiError.forbidden('privileged operation has no permission disposition');
      return next();
    }

    const tenantId = c.req.header('x-tenant-id');
    if (!tenantId) return next();
    const tenant = await getTenant(asCoreDb(db), tenantId);
    if (!tenant) return next();

    const userId = await getActingUser(c, tenantId);
    if (!userId) throw ApiError.unauthorized('no acting user for permission check');
    const allowed = await can(db, tenantId, userId, rule.permission);
    if (!allowed) throw ApiError.forbidden(`missing permission: ${rule.permission}`);
    return next();
  };
}
