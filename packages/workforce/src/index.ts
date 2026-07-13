/**
 * @blacklabel/workforce — RBAC-as-data (roles/permissions), scheduling, the
 * payroll time-export lane, and shift handoffs for Mags Commerce OS.
 *
 * Boundaries (see /CONVENTIONS.md + /CONTRACTS-MAGS.md):
 * - Owns the ROLE/PERMISSION layer, scheduling, time EXPORT, and handoffs.
 *   portal-employee already owns employees, shifts, time entries, and
 *   checklists — this module references those + core users by id STRING only.
 * - NEVER computes pay, overtime, or legal rules — the export lane only
 *   reshapes APPROVED time rows into an adapter CSV for a downstream payroll
 *   system.
 *
 * Internal events emitted (module.entity.verb, payloads include v:1):
 * - workforce.schedule.published     { v, scheduleId, userId, overridden }
 * - workforce.handoff.acknowledged   { v, handoffId, acknowledgedBy }
 *
 * (No canonical cross-module events in CONTRACTS-MAGS §2 belong to workforce;
 * the above are module-internal and safe to replay — handlers must be
 * idempotent.)
 */

export const MODULE_KEY = 'workforce' as const;

// Migrations
export { workforceMigrations } from './migrations';

// Router factory + the RBAC enforcement middleware the integrator wires
export { workforceRouter, requirePermission } from './router';
export type { GetUserId } from './router';

// Permission catalog + built-in role matrix (stable strings — route guards)
export {
  WORKFORCE_PERMISSIONS,
  isWorkforcePermission,
  BUILTIN_ROLE_KEYS,
  BUILTIN_ROLE_NAMES,
  BUILTIN_ROLE_PERMISSIONS,
} from './permissions';
export type { WorkforcePermission, BuiltinRoleKey } from './permissions';

// Seed + the permission checker + payroll adapter surface the integrator uses
export {
  seedBuiltinRoles,
  can,
  listUserPermissions,
  createRole,
  assignRole,
  unassignRole,
  listUserRoles,
  genericCsvAdapter,
  registerPayrollAdapter,
  listPayrollAdapters,
  exportApprovedTime,
} from './service';

// Public boundary types
export type {
  Role,
  RoleWithPermissions,
  Invitation,
  CreatedInvitation,
  AcceptInvitationResult,
  Schedule,
  Handoff,
  SeedBuiltinRolesResult,
  ApprovedTimeRow,
  PayrollAdapter,
  CreateScheduleInput,
  CreateHandoffInput,
  CreateTimeExportInput,
} from './service';

// Row + database map types
export type {
  WorkforceDatabase,
  ScheduleKind,
  RoleRow,
  RolePermissionRow,
  UserRoleRow,
  InvitationRow,
  SessionPolicyRow,
  ScheduleRow,
  TimeExportRow,
  HandoffRow,
} from './schema';
