/**
 * workforce business logic. Every function is tenant-scoped (tenant_id filter
 * on EVERY query), audits every mutation with before/after where it matters,
 * and never computes payroll/pay/overtime/legal rules.
 */
import { createHash, randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import type { Kysely } from 'kysely';
import {
  ApiError,
  asCoreDb,
  audit,
  id,
  nowIso,
  serializeCsv,
  type EventBus,
} from '@blacklabel/core';
import {
  BUILTIN_ROLE_KEYS,
  BUILTIN_ROLE_NAMES,
  BUILTIN_ROLE_PERMISSIONS,
  isWorkforcePermission,
  type BuiltinRoleKey,
  type WorkforcePermission,
} from './permissions';
import type {
  HandoffRow,
  InvitationRow,
  RoleRow,
  ScheduleKind,
  ScheduleRow,
  SessionPolicyRow,
  TimeExportRow,
  WorkforceDatabase,
} from './schema';

type Db = Kysely<WorkforceDatabase>;

const ENTITY = {
  role: 'workforce.role',
  rolePermission: 'workforce.role_permission',
  userRole: 'workforce.user_role',
  invitation: 'workforce.invitation',
  sessionPolicy: 'workforce.session_policy',
  schedule: 'workforce.schedule',
  timeExport: 'workforce.time_export',
  handoff: 'workforce.handoff',
} as const;

/* ------------------------------------------------------------------ *
 * Boundary types (integer 0/1 -> boolean, JSON text -> objects)
 * ------------------------------------------------------------------ */

export interface Role extends Omit<RoleRow, 'builtin'> {
  builtin: boolean;
}

export interface RoleWithPermissions extends Role {
  permissions: WorkforcePermission[];
}

export interface Invitation extends Omit<InvitationRow, 'revoked' | 'token_hash'> {
  revoked: boolean;
}

export interface Schedule extends Omit<ScheduleRow, 'published' | 'overridden'> {
  published: boolean;
  overridden: boolean;
}

export interface Handoff extends Omit<HandoffRow, 'acknowledged' | 'open_items'> {
  acknowledged: boolean;
  open_items: unknown[];
}

function toRole(row: RoleRow): Role {
  return { ...row, builtin: row.builtin === 1 };
}

function toInvitation(row: InvitationRow): Invitation {
  const { token_hash: _hash, revoked, ...rest } = row;
  return { ...rest, revoked: revoked === 1 };
}

function toSchedule(row: ScheduleRow): Schedule {
  return { ...row, published: row.published === 1, overridden: row.overridden === 1 };
}

function toHandoff(row: HandoffRow): Handoff {
  return {
    ...row,
    acknowledged: row.acknowledged === 1,
    open_items: JSON.parse(row.open_items) as unknown[],
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/* ================================================================== *
 * A. RBAC — roles
 * ================================================================== */

async function getRoleRow(db: Db, tenantId: string, roleId: string): Promise<RoleRow> {
  const row = await db
    .selectFrom('workforce_roles')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', roleId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`role not found: ${roleId}`);
  return row;
}

async function findRoleByKey(db: Db, tenantId: string, key: string): Promise<RoleRow | undefined> {
  return db
    .selectFrom('workforce_roles')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('key', '=', key)
    .executeTakeFirst();
}

const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

export async function createRole(
  db: Db,
  tenantId: string,
  actor: string,
  input: { key: string; name: string },
): Promise<Role> {
  const key = input.key.trim();
  const name = input.name.trim();
  if (!KEY_PATTERN.test(key)) {
    throw ApiError.badRequest('role key must match /^[a-z][a-z0-9_]*$/', { key });
  }
  if (name === '') throw ApiError.badRequest('role name is required');
  const existing = await findRoleByKey(db, tenantId, key);
  if (existing) throw ApiError.conflict(`role key already exists: ${key}`, { roleId: existing.id });

  const now = nowIso();
  const row: RoleRow = {
    id: id(),
    tenant_id: tenantId,
    key,
    name,
    builtin: 0,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('workforce_roles').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'workforce.role.created', ENTITY.role, row.id, {
    after: toRole(row),
  });
  return toRole(row);
}

export async function listRoles(db: Db, tenantId: string): Promise<Role[]> {
  const rows = await db
    .selectFrom('workforce_roles')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('builtin', 'desc')
    .orderBy('key')
    .orderBy('id')
    .execute();
  return rows.map(toRole);
}

export async function getRoleWithPermissions(
  db: Db,
  tenantId: string,
  roleId: string,
): Promise<RoleWithPermissions> {
  const row = await getRoleRow(db, tenantId, roleId);
  const permissions = await listRolePermissions(db, tenantId, roleId);
  return { ...toRole(row), permissions };
}

export async function updateRole(
  db: Db,
  tenantId: string,
  actor: string,
  roleId: string,
  patch: { name?: string },
): Promise<Role> {
  const before = await getRoleRow(db, tenantId, roleId);
  const name = patch.name === undefined ? before.name : patch.name.trim();
  if (name === '') throw ApiError.badRequest('role name is required');
  const updated_at = nowIso();
  await db
    .updateTable('workforce_roles')
    .set({ name, updated_at })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', roleId)
    .execute();
  const after: RoleRow = { ...before, name, updated_at };
  await audit(asCoreDb(db), tenantId, actor, 'workforce.role.updated', ENTITY.role, roleId, {
    before: toRole(before),
    after: toRole(after),
  });
  return toRole(after);
}

export async function deleteRole(
  db: Db,
  tenantId: string,
  actor: string,
  roleId: string,
): Promise<void> {
  const before = await getRoleRow(db, tenantId, roleId);
  if (before.builtin === 1) {
    throw ApiError.conflict('built-in roles cannot be deleted', { roleId, key: before.key });
  }
  await db
    .deleteFrom('workforce_role_permissions')
    .where('tenant_id', '=', tenantId)
    .where('role_id', '=', roleId)
    .execute();
  await db
    .deleteFrom('workforce_user_roles')
    .where('tenant_id', '=', tenantId)
    .where('role_id', '=', roleId)
    .execute();
  await db
    .deleteFrom('workforce_roles')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', roleId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'workforce.role.deleted', ENTITY.role, roleId, {
    before: toRole(before),
  });
}

/* ------------------------------------------------------------------ *
 * Built-in role seeding (migration-adjacent, idempotent)
 * ------------------------------------------------------------------ */

export interface SeedBuiltinRolesResult {
  /** Built-in role key -> role id. */
  roleIds: Record<BuiltinRoleKey, string>;
  createdRoleKeys: BuiltinRoleKey[];
}

/**
 * Seed (or backfill) the built-in roles and their least-privilege permission
 * matrix for a tenant. Idempotent: existing roles keep their id; missing
 * permission grants are backfilled; nothing is removed.
 */
export async function seedBuiltinRoles(
  db: Db,
  tenantId: string,
  actor = 'system',
): Promise<SeedBuiltinRolesResult> {
  const roleIds = {} as Record<BuiltinRoleKey, string>;
  const createdRoleKeys: BuiltinRoleKey[] = [];

  for (const key of BUILTIN_ROLE_KEYS) {
    let role = await findRoleByKey(db, tenantId, key);
    if (!role) {
      const now = nowIso();
      const row: RoleRow = {
        id: id(),
        tenant_id: tenantId,
        key,
        name: BUILTIN_ROLE_NAMES[key],
        builtin: 1,
        created_at: now,
        updated_at: now,
      };
      await db.insertInto('workforce_roles').values(row).execute();
      role = row;
      createdRoleKeys.push(key);
      await audit(asCoreDb(db), tenantId, actor, 'workforce.role.seeded', ENTITY.role, row.id, {
        after: toRole(row),
      });
    }
    roleIds[key] = role.id;

    // Backfill missing permission grants (check-then-insert; no ON CONFLICT).
    const have = new Set(await listRolePermissions(db, tenantId, role.id));
    for (const permission of BUILTIN_ROLE_PERMISSIONS[key]) {
      if (have.has(permission)) continue;
      await db
        .insertInto('workforce_role_permissions')
        .values({
          id: id(),
          tenant_id: tenantId,
          role_id: role.id,
          permission,
          created_at: nowIso(),
        })
        .execute();
    }
  }

  return { roleIds, createdRoleKeys };
}

/* ================================================================== *
 * A. RBAC — role permissions
 * ================================================================== */

export async function listRolePermissions(
  db: Db,
  tenantId: string,
  roleId: string,
): Promise<WorkforcePermission[]> {
  const rows = await db
    .selectFrom('workforce_role_permissions')
    .select('permission')
    .where('tenant_id', '=', tenantId)
    .where('role_id', '=', roleId)
    .orderBy('permission')
    .execute();
  return rows.map((r) => r.permission);
}

export async function grantPermission(
  db: Db,
  tenantId: string,
  actor: string,
  roleId: string,
  permission: string,
): Promise<WorkforcePermission[]> {
  await getRoleRow(db, tenantId, roleId); // tenant-scoped existence check
  if (!isWorkforcePermission(permission)) {
    throw ApiError.badRequest(`unknown permission: ${permission}`);
  }
  const before = await listRolePermissions(db, tenantId, roleId);
  if (!before.includes(permission)) {
    await db
      .insertInto('workforce_role_permissions')
      .values({
        id: id(),
        tenant_id: tenantId,
        role_id: roleId,
        permission,
        created_at: nowIso(),
      })
      .execute();
  }
  const after = await listRolePermissions(db, tenantId, roleId);
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'workforce.role_permission.granted',
    ENTITY.rolePermission,
    roleId,
    { permission, before, after },
  );
  return after;
}

export async function revokePermission(
  db: Db,
  tenantId: string,
  actor: string,
  roleId: string,
  permission: string,
): Promise<WorkforcePermission[]> {
  await getRoleRow(db, tenantId, roleId);
  const before = await listRolePermissions(db, tenantId, roleId);
  await db
    .deleteFrom('workforce_role_permissions')
    .where('tenant_id', '=', tenantId)
    .where('role_id', '=', roleId)
    .where('permission', '=', permission as WorkforcePermission)
    .execute();
  const after = await listRolePermissions(db, tenantId, roleId);
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'workforce.role_permission.revoked',
    ENTITY.rolePermission,
    roleId,
    { permission, before, after },
  );
  return after;
}

/* ================================================================== *
 * A. RBAC — user roles + can()
 * ================================================================== */

export async function assignRole(
  db: Db,
  tenantId: string,
  actor: string,
  userId: string,
  roleId: string,
): Promise<void> {
  await getRoleRow(db, tenantId, roleId);
  const existing = await db
    .selectFrom('workforce_user_roles')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('user_id', '=', userId)
    .where('role_id', '=', roleId)
    .executeTakeFirst();
  if (existing) return; // idempotent
  await db
    .insertInto('workforce_user_roles')
    .values({ id: id(), tenant_id: tenantId, user_id: userId, role_id: roleId, created_at: nowIso() })
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'workforce.user_role.assigned', ENTITY.userRole, userId, {
    after: { userId, roleId },
  });
}

export async function unassignRole(
  db: Db,
  tenantId: string,
  actor: string,
  userId: string,
  roleId: string,
): Promise<void> {
  await db
    .deleteFrom('workforce_user_roles')
    .where('tenant_id', '=', tenantId)
    .where('user_id', '=', userId)
    .where('role_id', '=', roleId)
    .execute();
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'workforce.user_role.unassigned',
    ENTITY.userRole,
    userId,
    { before: { userId, roleId } },
  );
}

export async function listUserRoles(db: Db, tenantId: string, userId: string): Promise<Role[]> {
  const rows = await db
    .selectFrom('workforce_user_roles as ur')
    .innerJoin('workforce_roles as r', 'r.id', 'ur.role_id')
    .selectAll('r')
    .where('ur.tenant_id', '=', tenantId)
    .where('ur.user_id', '=', userId)
    .orderBy('r.key')
    .orderBy('r.id')
    .execute();
  return rows.map((r) => toRole(r as RoleRow));
}

/**
 * Does `userId` have `permission`? Union over all the user's roles.
 * Tenant-scoped; unknown permission strings can never resolve to true.
 */
export async function can(
  db: Db,
  tenantId: string,
  userId: string,
  permission: string,
): Promise<boolean> {
  if (!isWorkforcePermission(permission)) return false;
  const hit = await db
    .selectFrom('workforce_user_roles as ur')
    .innerJoin('workforce_role_permissions as rp', 'rp.role_id', 'ur.role_id')
    .select('rp.id')
    .where('ur.tenant_id', '=', tenantId)
    .where('ur.user_id', '=', userId)
    .where('rp.permission', '=', permission)
    .limit(1)
    .executeTakeFirst();
  return hit !== undefined;
}

/** All permissions a user holds (union over roles), sorted. */
export async function listUserPermissions(
  db: Db,
  tenantId: string,
  userId: string,
): Promise<WorkforcePermission[]> {
  const rows = await db
    .selectFrom('workforce_user_roles as ur')
    .innerJoin('workforce_role_permissions as rp', 'rp.role_id', 'ur.role_id')
    .select('rp.permission')
    .where('ur.tenant_id', '=', tenantId)
    .where('ur.user_id', '=', userId)
    .orderBy('rp.permission')
    .execute();
  const set = new Set<WorkforcePermission>(rows.map((r) => r.permission));
  return [...set].sort();
}

/* ================================================================== *
 * A. Invitations
 * ================================================================== */

export interface CreatedInvitation {
  invitation: Invitation;
  /** Raw token — returned exactly once; only its sha256 hash is stored. */
  token: string;
}

export async function createInvitation(
  db: Db,
  tenantId: string,
  actor: string,
  input: { email: string; roleId: string; expiresInHours?: number },
): Promise<CreatedInvitation> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes('@')) throw ApiError.badRequest('valid email is required');
  await getRoleRow(db, tenantId, input.roleId);
  const hours = input.expiresInHours ?? 72;
  if (!Number.isFinite(hours) || hours <= 0) {
    throw ApiError.badRequest('expiresInHours must be a positive number');
  }
  const token = randomBytes(32).toString('hex');
  const now = nowIso();
  const row: InvitationRow = {
    id: id(),
    tenant_id: tenantId,
    email,
    role_id: input.roleId,
    token_hash: hashToken(token),
    expires_at: DateTime.utc().plus({ hours }).toISO()!,
    accepted_at: null,
    revoked: 0,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('workforce_invitations').values(row).execute();
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'workforce.invitation.created',
    ENTITY.invitation,
    row.id,
    { after: { email, roleId: input.roleId, expiresAt: row.expires_at } },
  );
  return { invitation: toInvitation(row), token };
}

export async function listInvitations(db: Db, tenantId: string): Promise<Invitation[]> {
  const rows = await db
    .selectFrom('workforce_invitations')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .execute();
  return rows.map(toInvitation);
}

export interface AcceptInvitationResult {
  invitation: Invitation;
  roleId: string;
  email: string;
}

/**
 * Accept an invitation by presenting its raw token. Single-use: validates the
 * hash, expiry, revoked, and not-already-accepted, then stamps accepted_at.
 * The integrator is responsible for creating/binding the actual user + role
 * assignment; this proves the token and returns the target role/email.
 */
export async function acceptInvitation(
  db: Db,
  tenantId: string,
  invitationId: string,
  token: string,
): Promise<AcceptInvitationResult> {
  const row = await db
    .selectFrom('workforce_invitations')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', invitationId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`invitation not found: ${invitationId}`);
  if (row.token_hash !== hashToken(token)) throw ApiError.unauthorized('invalid invitation token');
  if (row.revoked === 1) throw ApiError.conflict('invitation has been revoked');
  if (row.accepted_at !== null) throw ApiError.conflict('invitation already accepted');
  if (DateTime.fromISO(row.expires_at) <= DateTime.utc()) {
    throw ApiError.conflict('invitation has expired');
  }
  const accepted_at = nowIso();
  await db
    .updateTable('workforce_invitations')
    .set({ accepted_at, updated_at: accepted_at })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', invitationId)
    .execute();
  await audit(
    asCoreDb(db),
    tenantId,
    row.email,
    'workforce.invitation.accepted',
    ENTITY.invitation,
    invitationId,
    { after: { acceptedAt: accepted_at } },
  );
  return {
    invitation: toInvitation({ ...row, accepted_at, updated_at: accepted_at }),
    roleId: row.role_id,
    email: row.email,
  };
}

export async function revokeInvitation(
  db: Db,
  tenantId: string,
  actor: string,
  invitationId: string,
): Promise<Invitation> {
  const row = await db
    .selectFrom('workforce_invitations')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', invitationId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`invitation not found: ${invitationId}`);
  const updated_at = nowIso();
  await db
    .updateTable('workforce_invitations')
    .set({ revoked: 1, updated_at })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', invitationId)
    .execute();
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'workforce.invitation.revoked',
    ENTITY.invitation,
    invitationId,
    { before: { revoked: row.revoked === 1 }, after: { revoked: true } },
  );
  return toInvitation({ ...row, revoked: 1, updated_at });
}

/* ================================================================== *
 * A. Session policy
 * ================================================================== */

const DEFAULT_MAX_AGE_HOURS = 720; // 30 days

/** Get (creating a default if absent) the tenant's session policy. */
export async function getSessionPolicy(
  db: Db,
  tenantId: string,
  actor = 'system',
): Promise<SessionPolicyRow> {
  const existing = await db
    .selectFrom('workforce_session_policies')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('id')
    .executeTakeFirst();
  if (existing) return existing;
  const now = nowIso();
  const row: SessionPolicyRow = {
    id: id(),
    tenant_id: tenantId,
    max_age_hours: DEFAULT_MAX_AGE_HOURS,
    sessions_invalidated_after: null,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('workforce_session_policies').values(row).execute();
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'workforce.session_policy.created',
    ENTITY.sessionPolicy,
    row.id,
    { after: row },
  );
  return row;
}

export async function updateSessionPolicy(
  db: Db,
  tenantId: string,
  actor: string,
  patch: { maxAgeHours?: number; deviceLogoutAll?: boolean },
): Promise<SessionPolicyRow> {
  const before = await getSessionPolicy(db, tenantId, actor);
  let max_age_hours = before.max_age_hours;
  if (patch.maxAgeHours !== undefined) {
    if (!Number.isFinite(patch.maxAgeHours) || patch.maxAgeHours <= 0) {
      throw ApiError.badRequest('maxAgeHours must be a positive number');
    }
    max_age_hours = Math.trunc(patch.maxAgeHours);
  }
  const updated_at = nowIso();
  // "device_logout_all" toggles the sessions_invalidated_after cut-line.
  const sessions_invalidated_after = patch.deviceLogoutAll
    ? updated_at
    : before.sessions_invalidated_after;
  await db
    .updateTable('workforce_session_policies')
    .set({ max_age_hours, sessions_invalidated_after, updated_at })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', before.id)
    .execute();
  const after: SessionPolicyRow = { ...before, max_age_hours, sessions_invalidated_after, updated_at };
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'workforce.session_policy.updated',
    ENTITY.sessionPolicy,
    before.id,
    { before, after },
  );
  return after;
}

/** Force "log out all devices": bump the invalidation cut-line to now. */
export async function invalidateAllSessions(
  db: Db,
  tenantId: string,
  actor: string,
): Promise<SessionPolicyRow> {
  return updateSessionPolicy(db, tenantId, actor, { deviceLogoutAll: true });
}

/* ================================================================== *
 * B. Scheduling
 * ================================================================== */

/** Two half-open intervals overlap iff aStart < bEnd AND bStart < aEnd (end == start is NOT a conflict). */
function intervalsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd;
}

async function findPublishedConflicts(
  db: Db,
  tenantId: string,
  userId: string,
  startsAt: string,
  endsAt: string,
  excludeId?: string,
): Promise<string[]> {
  let q = db
    .selectFrom('workforce_schedules')
    .select(['id', 'starts_at', 'ends_at'])
    .where('tenant_id', '=', tenantId)
    .where('user_id', '=', userId)
    .where('published', '=', 1);
  if (excludeId) q = q.where('id', '!=', excludeId);
  const rows = await q.execute();
  return rows
    .filter((r) => intervalsOverlap(startsAt, endsAt, r.starts_at, r.ends_at))
    .map((r) => r.id);
}

export interface CreateScheduleInput {
  userId: string;
  startsAt: string;
  endsAt: string;
  kind: ScheduleKind;
  showRef?: string | null;
  note?: string | null;
  published?: boolean;
  /** Allow creating a published shift despite a conflict (recorded). */
  override?: boolean;
}

export async function createSchedule(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  input: CreateScheduleInput,
): Promise<Schedule> {
  if (input.endsAt <= input.startsAt) {
    throw ApiError.badRequest('endsAt must be after startsAt');
  }
  const published = input.published ? 1 : 0;
  let overridden = 0;
  if (published === 1) {
    const conflicts = await findPublishedConflicts(
      db,
      tenantId,
      input.userId,
      input.startsAt,
      input.endsAt,
    );
    if (conflicts.length > 0) {
      if (!input.override) {
        throw ApiError.conflict('overlapping published shift for this user', {
          conflictingScheduleIds: conflicts,
        });
      }
      overridden = 1;
    }
  }
  const now = nowIso();
  const row: ScheduleRow = {
    id: id(),
    tenant_id: tenantId,
    user_id: input.userId,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
    kind: input.kind,
    show_ref: input.showRef ?? null,
    note: input.note ?? null,
    published,
    overridden,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('workforce_schedules').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'workforce.schedule.created', ENTITY.schedule, row.id, {
    after: toSchedule(row),
  });
  if (published === 1) {
    events.emit(tenantId, 'workforce.schedule.published', {
      v: 1,
      scheduleId: row.id,
      userId: row.user_id,
      overridden: overridden === 1,
    });
  }
  return toSchedule(row);
}

async function getScheduleRow(db: Db, tenantId: string, scheduleId: string): Promise<ScheduleRow> {
  const row = await db
    .selectFrom('workforce_schedules')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', scheduleId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`schedule not found: ${scheduleId}`);
  return row;
}

export async function getSchedule(db: Db, tenantId: string, scheduleId: string): Promise<Schedule> {
  return toSchedule(await getScheduleRow(db, tenantId, scheduleId));
}

export async function listSchedules(
  db: Db,
  tenantId: string,
  filters: { userId?: string; kind?: string; published?: string },
  page: { limit: number; offset: number },
): Promise<Schedule[]> {
  let q = db
    .selectFrom('workforce_schedules')
    .selectAll()
    .where('tenant_id', '=', tenantId);
  if (filters.userId) q = q.where('user_id', '=', filters.userId);
  if (filters.kind) q = q.where('kind', '=', filters.kind as ScheduleKind);
  if (filters.published !== undefined) {
    q = q.where('published', '=', filters.published === 'true' || filters.published === '1' ? 1 : 0);
  }
  const rows = await q
    .orderBy('starts_at')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
  return rows.map(toSchedule);
}

export async function updateSchedule(
  db: Db,
  tenantId: string,
  actor: string,
  scheduleId: string,
  patch: {
    startsAt?: string;
    endsAt?: string;
    kind?: ScheduleKind;
    showRef?: string | null;
    note?: string | null;
  },
): Promise<Schedule> {
  const before = await getScheduleRow(db, tenantId, scheduleId);
  const starts_at = patch.startsAt ?? before.starts_at;
  const ends_at = patch.endsAt ?? before.ends_at;
  if (ends_at <= starts_at) throw ApiError.badRequest('endsAt must be after startsAt');
  const updated_at = nowIso();
  const next = {
    starts_at,
    ends_at,
    kind: patch.kind ?? before.kind,
    show_ref: patch.showRef === undefined ? before.show_ref : patch.showRef,
    note: patch.note === undefined ? before.note : patch.note,
    updated_at,
  };
  await db
    .updateTable('workforce_schedules')
    .set(next)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', scheduleId)
    .execute();
  const after: ScheduleRow = { ...before, ...next };
  await audit(asCoreDb(db), tenantId, actor, 'workforce.schedule.updated', ENTITY.schedule, scheduleId, {
    before: toSchedule(before),
    after: toSchedule(after),
  });
  return toSchedule(after);
}

export async function publishSchedule(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  scheduleId: string,
  options: { override?: boolean } = {},
): Promise<Schedule> {
  const before = await getScheduleRow(db, tenantId, scheduleId);
  let overridden = before.overridden;
  if (before.published !== 1) {
    const conflicts = await findPublishedConflicts(
      db,
      tenantId,
      before.user_id,
      before.starts_at,
      before.ends_at,
      scheduleId,
    );
    if (conflicts.length > 0) {
      if (!options.override) {
        throw ApiError.conflict('overlapping published shift for this user', {
          conflictingScheduleIds: conflicts,
        });
      }
      overridden = 1;
    }
  }
  const updated_at = nowIso();
  await db
    .updateTable('workforce_schedules')
    .set({ published: 1, overridden, updated_at })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', scheduleId)
    .execute();
  const after: ScheduleRow = { ...before, published: 1, overridden, updated_at };
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'workforce.schedule.published',
    ENTITY.schedule,
    scheduleId,
    { before: toSchedule(before), after: toSchedule(after) },
  );
  if (before.published !== 1) {
    events.emit(tenantId, 'workforce.schedule.published', {
      v: 1,
      scheduleId,
      userId: after.user_id,
      overridden: overridden === 1,
    });
  }
  return toSchedule(after);
}

export async function deleteSchedule(
  db: Db,
  tenantId: string,
  actor: string,
  scheduleId: string,
): Promise<void> {
  const before = await getScheduleRow(db, tenantId, scheduleId);
  await db
    .deleteFrom('workforce_schedules')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', scheduleId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'workforce.schedule.deleted', ENTITY.schedule, scheduleId, {
    before: toSchedule(before),
  });
}

/* ================================================================== *
 * C. Time export lane (payroll adapter — NO pay math EVER)
 * ================================================================== */

/** One APPROVED time row, fed by the integrator from portal-employee. */
export interface ApprovedTimeRow {
  id: string;
  userId: string;
  /** ISO-8601 UTC clock-in. */
  start: string;
  /** ISO-8601 UTC clock-out. */
  end: string;
  /** Break intervals; passed through verbatim — never summed into pay/minutes here. */
  breaks?: { start: string; end: string }[];
}

/**
 * A payroll adapter renders approved rows into export columns/records. It MUST
 * NOT compute pay, overtime, worked-minutes, or legal rules — only reshape the
 * raw approved rows. Future adapters (ADP, Gusto, ...) register the same shape.
 */
export interface PayrollAdapter {
  key: string;
  columns: string[];
  render(rows: ApprovedTimeRow[]): Record<string, unknown>[];
}

/**
 * The generic CSV adapter. Emits the raw approved fields ONLY. `break_count`
 * is the array length (structural), NOT a duration — no time is summed.
 */
export const genericCsvAdapter: PayrollAdapter = {
  key: 'generic_csv',
  columns: ['time_entry_id', 'user_id', 'clock_in', 'clock_out', 'break_count', 'breaks'],
  render(rows) {
    return rows.map((r) => ({
      time_entry_id: r.id,
      user_id: r.userId,
      clock_in: r.start,
      clock_out: r.end,
      break_count: r.breaks ? r.breaks.length : 0,
      breaks: JSON.stringify(r.breaks ?? []),
    }));
  },
};

const ADAPTER_REGISTRY = new Map<string, PayrollAdapter>([[genericCsvAdapter.key, genericCsvAdapter]]);

/** Register an additional payroll adapter (future ADP/Gusto/etc.). */
export function registerPayrollAdapter(adapter: PayrollAdapter): void {
  ADAPTER_REGISTRY.set(adapter.key, adapter);
}

export function listPayrollAdapters(): string[] {
  return [...ADAPTER_REGISTRY.keys()].sort();
}

export interface CreateTimeExportInput {
  adapter?: string;
  rows: ApprovedTimeRow[];
}

/**
 * Build a time export: reshape the APPROVED rows via the adapter, render CSV,
 * and persist a `workforce_time_exports` record. This lane NEVER computes pay,
 * overtime, or legal rules — that is the downstream payroll system's job.
 */
export async function exportApprovedTime(
  db: Db,
  tenantId: string,
  actor: string,
  input: CreateTimeExportInput,
): Promise<TimeExportRow> {
  const adapterKey = input.adapter ?? genericCsvAdapter.key;
  const adapter = ADAPTER_REGISTRY.get(adapterKey);
  if (!adapter) throw ApiError.badRequest(`unknown payroll adapter: ${adapterKey}`, {
    available: listPayrollAdapters(),
  });
  for (const r of input.rows) {
    if (!r.id || !r.userId || !r.start || !r.end) {
      throw ApiError.badRequest('every approved time row needs id, userId, start, end');
    }
    if (r.end < r.start) throw ApiError.badRequest(`time row ${r.id}: end is before start`);
  }
  const records = adapter.render(input.rows);
  const payload = serializeCsv(records, adapter.columns);
  const row: TimeExportRow = {
    id: id(),
    tenant_id: tenantId,
    adapter: adapterKey,
    row_count: input.rows.length,
    payload,
    created_at: nowIso(),
  };
  await db.insertInto('workforce_time_exports').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'workforce.time_export.created', ENTITY.timeExport, row.id, {
    after: { adapter: adapterKey, rowCount: row.row_count },
  });
  return row;
}

export async function listTimeExports(db: Db, tenantId: string): Promise<TimeExportRow[]> {
  return db
    .selectFrom('workforce_time_exports')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .execute();
}

export async function getTimeExport(
  db: Db,
  tenantId: string,
  exportId: string,
): Promise<TimeExportRow> {
  const row = await db
    .selectFrom('workforce_time_exports')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', exportId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`time export not found: ${exportId}`);
  return row;
}

/* ================================================================== *
 * D. Handoffs
 * ================================================================== */

export interface CreateHandoffInput {
  fromUser: string;
  toUser?: string | null;
  shiftRef?: string | null;
  body: string;
  openItems?: unknown[];
}

export async function createHandoff(
  db: Db,
  tenantId: string,
  actor: string,
  input: CreateHandoffInput,
): Promise<Handoff> {
  if (!input.fromUser || input.fromUser.trim() === '') {
    throw ApiError.badRequest('fromUser is required');
  }
  if (!input.body || input.body.trim() === '') throw ApiError.badRequest('handoff body is required');
  const now = nowIso();
  const row: HandoffRow = {
    id: id(),
    tenant_id: tenantId,
    from_user: input.fromUser,
    to_user: input.toUser ?? null,
    shift_ref: input.shiftRef ?? null,
    body: input.body,
    open_items: JSON.stringify(input.openItems ?? []),
    acknowledged: 0,
    acknowledged_at: null,
    acknowledged_by: null,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('workforce_handoffs').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'workforce.handoff.created', ENTITY.handoff, row.id, {
    after: toHandoff(row),
  });
  return toHandoff(row);
}

export async function listHandoffs(
  db: Db,
  tenantId: string,
  filters: { toUser?: string; acknowledged?: string },
  page: { limit: number; offset: number },
): Promise<Handoff[]> {
  let q = db.selectFrom('workforce_handoffs').selectAll().where('tenant_id', '=', tenantId);
  if (filters.toUser) q = q.where('to_user', '=', filters.toUser);
  if (filters.acknowledged !== undefined) {
    q = q.where(
      'acknowledged',
      '=',
      filters.acknowledged === 'true' || filters.acknowledged === '1' ? 1 : 0,
    );
  }
  const rows = await q
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
  return rows.map(toHandoff);
}

async function getHandoffRow(db: Db, tenantId: string, handoffId: string): Promise<HandoffRow> {
  const row = await db
    .selectFrom('workforce_handoffs')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', handoffId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`handoff not found: ${handoffId}`);
  return row;
}

export async function getHandoff(db: Db, tenantId: string, handoffId: string): Promise<Handoff> {
  return toHandoff(await getHandoffRow(db, tenantId, handoffId));
}

export async function acknowledgeHandoff(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  handoffId: string,
): Promise<Handoff> {
  const before = await getHandoffRow(db, tenantId, handoffId);
  if (before.acknowledged === 1) return toHandoff(before); // idempotent
  const now = nowIso();
  await db
    .updateTable('workforce_handoffs')
    .set({ acknowledged: 1, acknowledged_at: now, acknowledged_by: actor, updated_at: now })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', handoffId)
    .execute();
  const after: HandoffRow = {
    ...before,
    acknowledged: 1,
    acknowledged_at: now,
    acknowledged_by: actor,
    updated_at: now,
  };
  await audit(asCoreDb(db), tenantId, actor, 'workforce.handoff.acknowledged', ENTITY.handoff, handoffId, {
    before: toHandoff(before),
    after: toHandoff(after),
  });
  events.emit(tenantId, 'workforce.handoff.acknowledged', {
    v: 1,
    handoffId,
    acknowledgedBy: actor,
  });
  return toHandoff(after);
}
