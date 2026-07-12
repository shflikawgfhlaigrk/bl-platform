/**
 * workforce router factory.
 *
 * Surfaces (all tenant-header scoped like every module router):
 * - roles CRUD (+ built-in roles are not deletable)
 * - role-permission grants
 * - user-role assignment
 * - permission check endpoint (GET /can)
 * - invitations (create/accept/revoke — hash-only token storage)
 * - session policy (get/update + invalidate-all)
 * - schedules CRUD + conflict detection + publish
 * - time exports (create/list/download CSV — NO pay math)
 * - handoffs CRUD + acknowledge
 *
 * The RBAC enforcement middleware (`permissionMiddleware`) is built + tested
 * here but WIRED by the integrator per route group — these back-office routes
 * are not self-guarded (mirrors the rest of the platform's trusted routers).
 */
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import {
  ApiError,
  asCoreDb,
  errorHandler,
  parseFilters,
  parsePagination,
  tenantMiddleware,
  type ModuleDeps,
  type TenantEnv,
} from '@blacklabel/core';
import type { WorkforceDatabase } from './schema';
import { WORKFORCE_PERMISSIONS, type WorkforcePermission } from './permissions';
import {
  acceptInvitation,
  acknowledgeHandoff,
  assignRole,
  can,
  createHandoff,
  createInvitation,
  createRole,
  createSchedule,
  deleteRole,
  deleteSchedule,
  exportApprovedTime,
  getHandoff,
  getRoleWithPermissions,
  getSchedule,
  getSessionPolicy,
  getTimeExport,
  grantPermission,
  invalidateAllSessions,
  listHandoffs,
  listInvitations,
  listPayrollAdapters,
  listRoles,
  listSchedules,
  listTimeExports,
  listUserPermissions,
  listUserRoles,
  publishSchedule,
  revokeInvitation,
  revokePermission,
  unassignRole,
  updateRole,
  updateSchedule,
  updateSessionPolicy,
} from './service';

const BACK_OFFICE_ACTOR = 'system';

async function jsonBody(c: Context): Promise<unknown> {
  return c.req.json().catch(() => ({}));
}

/* ------------------------------------------------------------------ *
 * RBAC enforcement middleware (built + tested here, wired by integrator)
 * ------------------------------------------------------------------ */

/** Resolves the acting user id from the request (integrator supplies this). */
export type GetUserId = (c: Context) => string | undefined | Promise<string | undefined>;

/**
 * `requirePermission(db)` returns the middleware factory
 * `permissionMiddleware(getUserId, permission)`. The integrator mounts the
 * returned middleware in front of a route group:
 *
 *   const guard = requirePermission(deps.db);
 *   app.use('/purchasing/*', guard(sessionUserId, 'purchasing.write'));
 *
 * 401 when no acting user resolves; 403 (canonical envelope) when the user's
 * roles do not union to `permission`.
 */
export function requirePermission(db: ModuleDeps<WorkforceDatabase>['db']) {
  return function permissionMiddleware(
    getUserId: GetUserId,
    permission: WorkforcePermission,
  ): MiddlewareHandler<TenantEnv> {
    return async (c, next) => {
      const tenantId = c.get('tenantId');
      const userId = await getUserId(c);
      if (!userId) {
        throw ApiError.unauthorized('no acting user for permission check');
      }
      const allowed = await can(db, tenantId, userId, permission);
      if (!allowed) {
        throw ApiError.forbidden(`missing permission: ${permission}`);
      }
      await next();
    };
  };
}

/* ------------------------------------------------------------------ *
 * Validation schemas
 * ------------------------------------------------------------------ */

const permissionEnum = z.enum(
  WORKFORCE_PERMISSIONS as unknown as [WorkforcePermission, ...WorkforcePermission[]],
);
const scheduleKindEnum = z.enum(['shop', 'show', 'receiving', 'fulfillment', 'admin']);

const createRoleSchema = z.object({ key: z.string(), name: z.string() });
const updateRoleSchema = z.object({ name: z.string().optional() });
const grantSchema = z.object({ permission: permissionEnum });
const assignRoleSchema = z.object({ roleId: z.string().min(1) });
const invitationSchema = z.object({
  email: z.string(),
  roleId: z.string().min(1),
  expiresInHours: z.number().positive().optional(),
});
const acceptSchema = z.object({ token: z.string().min(1) });
const sessionPolicySchema = z.object({
  maxAgeHours: z.number().positive().optional(),
  deviceLogoutAll: z.boolean().optional(),
});
const scheduleSchema = z.object({
  userId: z.string().min(1),
  startsAt: z.string().min(1),
  endsAt: z.string().min(1),
  kind: scheduleKindEnum,
  showRef: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  published: z.boolean().optional(),
  override: z.boolean().optional(),
});
const updateScheduleSchema = z.object({
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  kind: scheduleKindEnum.optional(),
  showRef: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});
const publishSchema = z.object({ override: z.boolean().optional() });
const breakSchema = z.object({ start: z.string(), end: z.string() });
const timeExportSchema = z.object({
  adapter: z.string().optional(),
  rows: z.array(
    z.object({
      id: z.string().min(1),
      userId: z.string().min(1),
      start: z.string().min(1),
      end: z.string().min(1),
      breaks: z.array(breakSchema).optional(),
    }),
  ),
});
const handoffSchema = z.object({
  fromUser: z.string().min(1),
  toUser: z.string().nullable().optional(),
  shiftRef: z.string().nullable().optional(),
  body: z.string().min(1),
  openItems: z.array(z.unknown()).optional(),
});

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

export function workforceRouter(deps: ModuleDeps<WorkforceDatabase>): Hono<TenantEnv> {
  const { db, events } = deps;
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(db)));

  /* ---- roles ---- */
  app.post('/roles', async (c) => {
    const input = createRoleSchema.parse(await jsonBody(c));
    const role = await createRole(db, c.get('tenantId'), BACK_OFFICE_ACTOR, input);
    return c.json({ data: role }, 201);
  });
  app.get('/roles', async (c) => {
    const roles = await listRoles(db, c.get('tenantId'));
    return c.json({ data: roles });
  });
  app.get('/roles/:roleId', async (c) => {
    const role = await getRoleWithPermissions(db, c.get('tenantId'), c.req.param('roleId'));
    return c.json({ data: role });
  });
  app.patch('/roles/:roleId', async (c) => {
    const patch = updateRoleSchema.parse(await jsonBody(c));
    const role = await updateRole(db, c.get('tenantId'), BACK_OFFICE_ACTOR, c.req.param('roleId'), patch);
    return c.json({ data: role });
  });
  app.delete('/roles/:roleId', async (c) => {
    await deleteRole(db, c.get('tenantId'), BACK_OFFICE_ACTOR, c.req.param('roleId'));
    return c.json({ data: { deleted: true } });
  });

  /* ---- role permissions ---- */
  app.get('/roles/:roleId/permissions', async (c) => {
    const role = await getRoleWithPermissions(db, c.get('tenantId'), c.req.param('roleId'));
    return c.json({ data: role.permissions });
  });
  app.post('/roles/:roleId/permissions', async (c) => {
    const { permission } = grantSchema.parse(await jsonBody(c));
    const permissions = await grantPermission(
      db,
      c.get('tenantId'),
      BACK_OFFICE_ACTOR,
      c.req.param('roleId'),
      permission,
    );
    return c.json({ data: permissions }, 201);
  });
  app.delete('/roles/:roleId/permissions/:permission', async (c) => {
    const permissions = await revokePermission(
      db,
      c.get('tenantId'),
      BACK_OFFICE_ACTOR,
      c.req.param('roleId'),
      c.req.param('permission'),
    );
    return c.json({ data: permissions });
  });

  /* ---- user roles ---- */
  app.get('/users/:userId/roles', async (c) => {
    const roles = await listUserRoles(db, c.get('tenantId'), c.req.param('userId'));
    return c.json({ data: roles });
  });
  app.get('/users/:userId/permissions', async (c) => {
    const permissions = await listUserPermissions(db, c.get('tenantId'), c.req.param('userId'));
    return c.json({ data: permissions });
  });
  app.post('/users/:userId/roles', async (c) => {
    const { roleId } = assignRoleSchema.parse(await jsonBody(c));
    await assignRole(db, c.get('tenantId'), BACK_OFFICE_ACTOR, c.req.param('userId'), roleId);
    return c.json({ data: { assigned: true } }, 201);
  });
  app.delete('/users/:userId/roles/:roleId', async (c) => {
    await unassignRole(
      db,
      c.get('tenantId'),
      BACK_OFFICE_ACTOR,
      c.req.param('userId'),
      c.req.param('roleId'),
    );
    return c.json({ data: { unassigned: true } });
  });

  /* ---- permission check ---- */
  app.get('/can', async (c) => {
    const userId = c.req.query('userId');
    const permission = c.req.query('permission');
    if (!userId || !permission) {
      throw ApiError.badRequest('userId and permission query params are required');
    }
    const allowed = await can(db, c.get('tenantId'), userId, permission);
    return c.json({ data: { userId, permission, allowed } });
  });

  /* ---- invitations ---- */
  app.post('/invitations', async (c) => {
    const input = invitationSchema.parse(await jsonBody(c));
    const created = await createInvitation(db, c.get('tenantId'), BACK_OFFICE_ACTOR, input);
    // Raw token returned exactly once.
    return c.json({ data: { ...created.invitation, token: created.token } }, 201);
  });
  app.get('/invitations', async (c) => {
    const invitations = await listInvitations(db, c.get('tenantId'));
    return c.json({ data: invitations });
  });
  app.post('/invitations/:invitationId/accept', async (c) => {
    const { token } = acceptSchema.parse(await jsonBody(c));
    const result = await acceptInvitation(db, c.get('tenantId'), c.req.param('invitationId'), token);
    return c.json({ data: result });
  });
  app.post('/invitations/:invitationId/revoke', async (c) => {
    const invitation = await revokeInvitation(
      db,
      c.get('tenantId'),
      BACK_OFFICE_ACTOR,
      c.req.param('invitationId'),
    );
    return c.json({ data: invitation });
  });

  /* ---- session policy ---- */
  app.get('/session-policy', async (c) => {
    const policy = await getSessionPolicy(db, c.get('tenantId'), BACK_OFFICE_ACTOR);
    return c.json({ data: policy });
  });
  app.put('/session-policy', async (c) => {
    const patch = sessionPolicySchema.parse(await jsonBody(c));
    const policy = await updateSessionPolicy(db, c.get('tenantId'), BACK_OFFICE_ACTOR, patch);
    return c.json({ data: policy });
  });
  app.post('/session-policy/invalidate-all', async (c) => {
    const policy = await invalidateAllSessions(db, c.get('tenantId'), BACK_OFFICE_ACTOR);
    return c.json({ data: policy });
  });

  /* ---- schedules ---- */
  app.post('/schedules', async (c) => {
    const input = scheduleSchema.parse(await jsonBody(c));
    const schedule = await createSchedule(db, events, c.get('tenantId'), BACK_OFFICE_ACTOR, input);
    return c.json({ data: schedule }, 201);
  });
  app.get('/schedules', async (c) => {
    const query = c.req.query();
    const page = parsePagination(query);
    const filters = parseFilters(query, ['userId', 'kind', 'published']);
    const schedules = await listSchedules(db, c.get('tenantId'), filters, page);
    return c.json({ data: schedules, limit: page.limit, offset: page.offset });
  });
  app.get('/schedules/:scheduleId', async (c) => {
    const schedule = await getSchedule(db, c.get('tenantId'), c.req.param('scheduleId'));
    return c.json({ data: schedule });
  });
  app.patch('/schedules/:scheduleId', async (c) => {
    const patch = updateScheduleSchema.parse(await jsonBody(c));
    const schedule = await updateSchedule(
      db,
      c.get('tenantId'),
      BACK_OFFICE_ACTOR,
      c.req.param('scheduleId'),
      patch,
    );
    return c.json({ data: schedule });
  });
  app.post('/schedules/:scheduleId/publish', async (c) => {
    const options = publishSchema.parse(await jsonBody(c));
    const schedule = await publishSchedule(
      db,
      events,
      c.get('tenantId'),
      BACK_OFFICE_ACTOR,
      c.req.param('scheduleId'),
      options,
    );
    return c.json({ data: schedule });
  });
  app.delete('/schedules/:scheduleId', async (c) => {
    await deleteSchedule(db, c.get('tenantId'), BACK_OFFICE_ACTOR, c.req.param('scheduleId'));
    return c.json({ data: { deleted: true } });
  });

  /* ---- time exports (no pay math) ---- */
  app.get('/time-exports/adapters', (c) => c.json({ data: listPayrollAdapters() }));
  app.post('/time-exports', async (c) => {
    const input = timeExportSchema.parse(await jsonBody(c));
    const exported = await exportApprovedTime(db, c.get('tenantId'), BACK_OFFICE_ACTOR, input);
    return c.json({ data: exported }, 201);
  });
  app.get('/time-exports', async (c) => {
    const exports = await listTimeExports(db, c.get('tenantId'));
    return c.json({ data: exports });
  });
  app.get('/time-exports/:exportId/download', async (c) => {
    const row = await getTimeExport(db, c.get('tenantId'), c.req.param('exportId'));
    return c.body(row.payload, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="time-export-${row.id}.csv"`,
    });
  });

  /* ---- handoffs ---- */
  app.post('/handoffs', async (c) => {
    const input = handoffSchema.parse(await jsonBody(c));
    const handoff = await createHandoff(db, c.get('tenantId'), BACK_OFFICE_ACTOR, input);
    return c.json({ data: handoff }, 201);
  });
  app.get('/handoffs', async (c) => {
    const query = c.req.query();
    const page = parsePagination(query);
    const filters = parseFilters(query, ['toUser', 'acknowledged']);
    const handoffs = await listHandoffs(db, c.get('tenantId'), filters, page);
    return c.json({ data: handoffs, limit: page.limit, offset: page.offset });
  });
  app.get('/handoffs/:handoffId', async (c) => {
    const handoff = await getHandoff(db, c.get('tenantId'), c.req.param('handoffId'));
    return c.json({ data: handoff });
  });
  app.post('/handoffs/:handoffId/acknowledge', async (c) => {
    const handoff = await acknowledgeHandoff(
      db,
      events,
      c.get('tenantId'),
      BACK_OFFICE_ACTOR,
      c.req.param('handoffId'),
    );
    return c.json({ data: handoff });
  });

  return app;
}
