import type { MiddlewareHandler } from 'hono';
import type { Kysely } from 'kysely';
import type { CoreDatabase } from './schema';

/**
 * Hono Env for tenant-scoped routers. Use it on every module router:
 *   const app = new Hono<TenantEnv>();
 */
export type TenantEnv = {
  Variables: {
    tenantId: string;
  };
};

/**
 * Tenant resolution middleware.
 * - reads the `x-tenant-id` header
 * - 400 if missing/blank
 * - 404 if no such tenant exists
 * - otherwise sets c.set('tenantId', ...) and continues
 *
 * Handlers must ALWAYS read the tenant via c.get('tenantId') — never from
 * the request body or query string.
 */
export function tenantMiddleware(db: Kysely<CoreDatabase>): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    const tenantId = c.req.header('x-tenant-id');
    if (!tenantId || tenantId.trim() === '') {
      return c.json(
        { error: { message: 'missing x-tenant-id header', code: 'tenant_header_missing', details: null } },
        400,
      );
    }
    const tenant = await db
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (!tenant) {
      return c.json(
        { error: { message: `unknown tenant: ${tenantId}`, code: 'tenant_unknown', details: null } },
        404,
      );
    }
    c.set('tenantId', tenantId);
    await next();
  };
}

/**
 * Narrow any wider Kysely instance (a module DB map extends CoreDatabase) to
 * the core view, for passing into core services/middleware.
 */
export function asCoreDb(db: Kysely<any>): Kysely<CoreDatabase> {
  return db as Kysely<CoreDatabase>;
}
