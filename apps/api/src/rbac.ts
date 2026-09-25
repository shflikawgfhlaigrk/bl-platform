/**
 * Local-first single-owner RBAC, enforced at the composition root.
 *
 * Acting user: a validated browser session first. Non-browser local tools may
 * still use `x-user-id`; when absent they resolve the tenant's seeded OWNER.
 * Browser traffic is never allowed to fall through to either legacy lane.
 *
 * We centralize enforcement in ONE middleware (rather than wrapping each module
 * router) so the guard can resolve the tenant itself and match a small, explicit
 * route→permission table. Owner holds every permission; a cashier hits 403 on
 * purchasing/finance/admin/etc. Permissions come straight from workforce's
 * catalog + `can()` (the RBAC-as-data source of truth).
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { Kysely } from 'kysely';
import type { ActionsDatabase } from '@blacklabel/actions';
import routeInventory from './rbac-routes.json';
import { isBusinessPortalRoute } from './business-wiring';
import { ApiError, asCoreDb, getTenant, listUsers, type CoreDatabase } from '@blacklabel/core';
import { can, type WorkforceDatabase, type WorkforcePermission } from '@blacklabel/workforce';

/** A deliberate permission disposition for a known mounted route. */
export interface RbacRule {
  test: (method: string, path: string) => boolean;
  permission: WorkforcePermission;
  /** Alternatives are only used for register catalog lookups. */
  anyOf?: readonly WorkforcePermission[];
}

const isRead = (method: string) => method === 'GET' || method === 'HEAD';
const within = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

// This reviewed inventory is intentionally independent of router registration.
// Adding a handler requires adding its method/path and reviewing its policy.
// Unknown methods and paths stay denied, including beneath a known module.
const knownRoutes = routeInventory.map(([method, path]) => ({
  method,
  pattern: new RegExp('^' + path.split('/').map(segment => segment.startsWith(':')
    ? '[^/]+' : segment === '*' ? '.*' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/') + '$'),
}));
export const isKnownRbacRoute = (method: string, path: string) =>
  knownRoutes.some(r => r.method === (method === 'HEAD' ? 'GET' : method) && r.pattern.test(path));

/** These handlers enforce their own sessions/tokens; none receives an owner. */
export const isIndependentAuthRoute = (method: string, path: string) =>
  isKnownRbacRoute(method, path) && (
    (isRead(method) && path === '/api/health') || within(path, '/api/pos/auth') ||
    isBusinessPortalRoute(path)
  );

/** Most-specific operation rules precede deliberate module read/write rules. */
export function defaultRbacRules(): RbacRule[] {
  const rules: RbacRule[] = [
    { test: (_m, p) => /^\/api\/admin\/backups\/[^/]+\/download$/.test(p), permission: 'admin.admin' },
    { test: (m, p) => m === 'POST' && /^\/api\/purchasing\/purchase-orders\/[^/]+\/(?:approve|reject)$/.test(p), permission: 'purchasing.approve' },
    { test: (m, p) => !isRead(m) && /^\/api\/outreach\/(?:settings|arm|sends|send-pending)$/.test(p), permission: 'outreach.arm' },
    { test: (m, p) => !isRead(m) && /^\/api\/outreach\/campaigns\/[^/]+\/(?:approve|queue|pause|resume|cancel)$/.test(p), permission: 'outreach.approve' },
    { test: (m, p) => m === 'POST' && /^\/api\/finance\/cash-sessions\/[^/]+\/close$/.test(p), permission: 'finance.close' },
    { test: (m, p) => m === 'POST' && p === '/api/finance/margin', permission: 'finance.read' },
    { test: (_m, p) => /^\/api\/customers\/.*export/.test(p), permission: 'customers.export' },
    { test: (m, p) => !isRead(m) && within(p, '/api/inventory/count-sessions'), permission: 'inventory.count' },
    { test: (m, p) => !isRead(m) && within(p, '/api/inventory/transfers'), permission: 'inventory.transfer' },
    // Both closeout and P&L GETs can initialize the persisted closeout row.
    { test: (_m, p) => /^\/api\/shows\/shows\/[^/]+\/(?:closeout(?:\/complete)?|pnl)$/.test(p), permission: 'shows.close' },
    { test: (_m, p) => within(p, '/api/workforce/time-exports'), permission: 'workforce.admin' },
    { test: (_m, p) => /^\/api\/workforce\/(?:roles|invitations|users|session-policy)(?:\/|$)/.test(p), permission: 'workforce.admin' },
    { test: (m, p) => isRead(m) && /^\/api\/catalog\/(?:lookup|departments(?:\/tree)?|brands|products(?:\/[^/]+)?|variations(?:\/[^/]+(?:\/(?:barcodes|price|promoted-price))?)?|price-books)$/.test(p), permission: 'catalog.read', anyOf: ['orders.read'] },
    { test: (m, p) => m === 'POST' && /^\/api\/(?:orders\/orders|pos\/orders)\/[^/]+\/refunds$/.test(p), permission: 'orders.refund' },
    { test: (m, p) => m === 'POST' && (/^\/api\/orders\/orders\/[^/]+\/(?:pay|tenders|checkout-sessions|payment-attempts)$/.test(p) || /^\/api\/orders\/payment-attempts\/[^/]+\/cancel$/.test(p)), permission: 'finance.write' },
    { test: (m, p) => (m === 'POST' && p === '/api/orders/orders') || (['PUT', 'PATCH', 'DELETE'].includes(m) && /^\/api\/orders\/orders\/[^/]+$/.test(p)), permission: 'finance.write' },
    { test: (m, p) => within(p, '/api/pos/finance') && isRead(m), permission: 'finance.read' },
    { test: (m, p) => within(p, '/api/pos/finance') && !isRead(m), permission: 'finance.write' },
    { test: (m, p) => within(p, '/api/pos/reconciliation') && isRead(m), permission: 'admin.read' },
    { test: (m, p) => within(p, '/api/pos/reconciliation') && !isRead(m), permission: 'admin.admin' },
    { test: (_m, p) => p === '/api/pos/processor', permission: 'admin.read' },
    { test: (m, p) => within(p, '/api/pos/settings') && !isRead(m), permission: 'admin.admin' },
    { test: (m, p) => !isRead(m) && within(p, '/api/messaging/channels'), permission: 'admin.admin' },
    { test: (m, p) => !isRead(m) && within(p, '/api/reviews/platforms'), permission: 'admin.admin' },
    { test: (_m, p) => p === '/api/actions/wake-due', permission: 'workforce.admin' },
  ];
  const modules: Record<string, readonly [WorkforcePermission, WorkforcePermission]> = {
    catalog: ['catalog.read', 'catalog.write'], inventory: ['inventory.read', 'inventory.write'],
    purchasing: ['purchasing.read', 'purchasing.write'], vendors: ['purchasing.read', 'purchasing.write'],
    shows: ['shows.read', 'shows.write'], workforce: ['workforce.read', 'workforce.admin'],
    'portal-employee': ['workforce.read', 'workforce.admin'], scheduling: ['workforce.read', 'workforce.admin'],
    billing: ['finance.read', 'finance.write'], finance: ['finance.read', 'finance.write'],
    admin: ['admin.read', 'admin.admin'], actions: ['actions.read', 'actions.write'],
    automation: ['automation.read', 'automation.admin'], workflows: ['automation.read', 'automation.admin'],
    orders: ['orders.read', 'orders.write'], pos: ['orders.read', 'orders.write'],
    customers: ['customers.read', 'customers.write'], crm: ['customers.read', 'customers.write'],
    'portal-customer': ['customers.read', 'customers.write'], outreach: ['outreach.read', 'outreach.write'],
    quoting: ['finance.read', 'finance.write'], retail: ['finance.read', 'finance.write'],
    loyalty: ['finance.read', 'finance.write'], messaging: ['customers.read', 'outreach.arm'],
    reviews: ['outreach.read', 'outreach.arm'], files: ['admin.read', 'admin.admin'],
    industries: ['admin.read', 'admin.admin'], dashboard: ['admin.read', 'admin.admin'],
  };
  for (const [key, [read, write]] of Object.entries(modules)) {
    rules.push({ test: (m, p) => within(p, `/api/${key}`) && isRead(m), permission: read });
    rules.push({ test: (m, p) => within(p, `/api/${key}`) && !isRead(m), permission: write });
  }
  return rules;
}

/** Resolves the acting user id, defaulting to the tenant's seeded owner. */
export type GetActingUser = (c: Context, tenantId: string) => Promise<string | undefined>;

export interface GetActingUserOptions {
  /** Env override for the default owner user id (single-tenant dev). */
  ownerUserIdEnv?: string;
  /** Resolve the opaque, server-issued browser session cookie. */
  sessionUser?: (c: Context, tenantId: string) => Promise<string | undefined>;
  /** True for browser API traffic, which must never inherit a tool identity. */
  isBrowserRequest?: (c: Context) => boolean;
}

/**
 * Build the acting-user resolver. A valid server session always wins. Browser
 * traffic with no valid session fails closed. Only non-browser local tools may
 * use `x-user-id` or fall back to the seeded owner. The owner lookup is cached.
 */
export function makeGetActingUser(
  db: Kysely<CoreDatabase>,
  opts: GetActingUserOptions = {},
): GetActingUser {
  const ownerCache = new Map<string, string>();
  return async (c, tenantId) => {
    const sessionUser = await opts.sessionUser?.(c, tenantId);
    if (sessionUser) { c.set('verifiedSession', true); return sessionUser; }
    if (opts.isBrowserRequest?.(c)) return undefined;
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

/** Action writers operate their own/unassigned queue; workforce admins can delegate. */
async function actionOwnership(
  db: Kysely<WorkforceDatabase & CoreDatabase & ActionsDatabase>,
  c: Context, tenantId: string, userId: string,
): Promise<void> {
  const path = c.req.path;
  if (isRead(c.req.method) || !within(path, '/api/actions')) return;
  const manager = await can(db as unknown as Kysely<WorkforceDatabase>, tenantId, userId, 'workforce.admin');
  const body = await c.req.json().catch(() => ({}));
  const actionId = /^\/api\/actions\/([^/]+)\//.exec(path)?.[1];
  // Creation can dedupe-update an existing row, so that lane also checks owner.
  const existing = actionId
    ? await db.selectFrom('actions_actions').selectAll().where('tenant_id', '=', tenantId).where('id', '=', decodeURIComponent(actionId)).executeTakeFirst()
    : typeof body?.dedupeKey === 'string'
      ? await db.selectFrom('actions_actions').selectAll().where('tenant_id', '=', tenantId).where('dedupe_key', '=', body.dedupeKey).where('status', 'in', ['open', 'snoozed', 'in_progress', 'escalated']).executeTakeFirst()
      : undefined;
  if (existing?.owner_user_id && existing.owner_user_id !== userId && !manager) {
    throw ApiError.forbidden('action belongs to another user');
  }
  if (body?.ownerUserId != null) {
    if (typeof body.ownerUserId !== 'string') throw ApiError.badRequest('invalid action owner');
    const target = await db.selectFrom('users').select('id').where('tenant_id', '=', tenantId).where('id', '=', body.ownerUserId.trim()).executeTakeFirst();
    if (!target) throw ApiError.notFound('action owner not found in tenant');
    if (target.id !== userId && !manager) throw ApiError.forbidden('assigning another user requires workforce administration');
  }
}

/** Deny unknown protected operations before resolving identity or entering services. */
export function rbacGuard(
  db: Kysely<WorkforceDatabase & CoreDatabase & ActionsDatabase>,
  getActingUser: GetActingUser,
  rules: RbacRule[] = defaultRbacRules(),
): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    const path = c.req.path;
    if (!isKnownRbacRoute(method, path)) throw ApiError.forbidden('API operation has no permission disposition');
    if (isIndependentAuthRoute(method, path)) return next();
    const rule = rules.find(r => r.test(method, path));
    if (!rule) throw ApiError.forbidden('API operation has no permission disposition');
    const tenantId = c.req.header('x-tenant-id');
    if (!tenantId?.trim()) throw new ApiError(400, 'missing x-tenant-id header', 'tenant_header_missing');
    const tenant = await getTenant(asCoreDb(db), tenantId);
    if (!tenant) throw new ApiError(404, `unknown tenant: ${tenantId}`, 'tenant_unknown');
    const userId = await getActingUser(c, tenantId);
    if (!userId) throw ApiError.unauthorized('no acting user for permission check');
    let allowed = false;
    for (const permission of [rule.permission, ...rule.anyOf ?? []]) {
      if (await can(db as unknown as Kysely<WorkforceDatabase>, tenantId, userId, permission)) { allowed = true; break; }
    }
    if (!allowed) throw ApiError.forbidden(`missing permission: ${rule.permission}`);
    if (within(path, '/api/admin/backups') && (!isRead(method) || path.endsWith('/download')) && !c.get('verifiedSession')) {
      throw ApiError.unauthorized('database backups require a verified administrator session');
    }
    if (method === 'POST' && /^\/api\/shows\/shows\/[^/]+\/transition$/.test(path)) {
      const body = await c.req.json().catch(() => ({}));
      if (['closing', 'closed'].includes(body?.to) && !await can(db as unknown as Kysely<WorkforceDatabase>, tenantId, userId, 'shows.close')) {
        throw ApiError.forbidden('missing permission: shows.close');
      }
    }
    await actionOwnership(db, c, tenantId, userId);
    // Trusted identity is carried to audits even for the injected session lane.
    c.set('actingUserId', userId);
    c.req.raw.headers.set('x-user-id', userId);
    return next();
  };
}
