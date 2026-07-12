/**
 * Local-first single-owner RBAC, enforced at the composition root.
 *
 * Acting user: the `x-user-id` header. When absent (a loopback owner tool), we
 * resolve the tenant's seeded OWNER user — deterministic, documented, and the
 * reason journey 18 still passes for the owner without any header.
 *
 * We centralize enforcement in ONE middleware (rather than wrapping each module
 * router) so the guard can resolve the tenant itself and match a small, explicit
 * route→permission table. Owner holds every permission; a cashier hits 403 on
 * purchasing/finance/admin/etc. Permissions come straight from workforce's
 * catalog + `can()` (the RBAC-as-data source of truth).
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { Kysely } from 'kysely';
import { ApiError, asCoreDb, getTenant, listUsers, type CoreDatabase } from '@blacklabel/core';
import { can, type WorkforceDatabase, type WorkforcePermission } from '@blacklabel/workforce';

export interface RbacRule {
  /** True when this rule governs the request. */
  test: (method: string, path: string) => boolean;
  permission: WorkforcePermission;
}

const has = (segment: string) => (_m: string, p: string) => p.includes(segment);
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
    // finance: the whole module is owner/accountant surface.
    { test: has('/api/finance'), permission: 'finance.read' },
    // admin: integrations/credentials/backup/restore/diagnostics.
    { test: has('/api/admin'), permission: 'admin.read' },
  ];
}

/** Resolves the acting user id, defaulting to the tenant's seeded owner. */
export type GetActingUser = (c: Context, tenantId: string) => Promise<string | undefined>;

export interface GetActingUserOptions {
  /** Env override for the default owner user id (single-tenant dev). */
  ownerUserIdEnv?: string;
}

/**
 * Build the acting-user resolver. Uses `x-user-id` when present; otherwise the
 * tenant's owner: the env override, else the first core user whose role is
 * 'owner' (created at seed). Cached per tenant for the default path only.
 */
export function makeGetActingUser(
  db: Kysely<CoreDatabase>,
  opts: GetActingUserOptions = {},
): GetActingUser {
  const ownerCache = new Map<string, string>();
  return async (c, tenantId) => {
    const header = c.req.header('x-user-id');
    if (header && header.trim() !== '') return header.trim();
    if (opts.ownerUserIdEnv && opts.ownerUserIdEnv.trim() !== '') return opts.ownerUserIdEnv.trim();
    const cached = ownerCache.get(tenantId);
    if (cached) return cached;
    // First 'owner'-role core user for this tenant (deterministic order).
    for (let offset = 0; ; offset += 100) {
      const page = await listUsers(db, tenantId, { limit: 100, offset });
      const owner = page.find((u) => u.role === 'owner');
      if (owner) {
        ownerCache.set(tenantId, owner.id);
        return owner.id;
      }
      if (page.length < 100) break;
    }
    return undefined;
  };
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
    const rule = rules.find((r) => {
      try {
        return r.test(method, path);
      } catch {
        return false;
      }
    });
    if (!rule) return next();

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
