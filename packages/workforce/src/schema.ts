/**
 * Row types for the workforce module tables (prefix `workforce_`).
 *
 * Conventions (see /CONVENTIONS.md):
 * - ids: TEXT, nanoid, generated in code via id()
 * - timestamps: TEXT, ISO-8601 UTC via nowIso()
 * - booleans: INTEGER 0/1 (converted at the service boundary)
 * - JSON: serialized TEXT
 * - cross-module references (user_id, show_ref, shift_ref, role permission
 *   strings) are id strings / stable strings only — never FKs or joins into
 *   another module. `user_id` references a core `users` row by id string.
 */
import type { CoreDatabase } from '@blacklabel/core';
import type { WorkforcePermission } from './permissions';

/** A schedule shift is one of these kinds (industry-neutral). */
export type ScheduleKind = 'shop' | 'show' | 'receiving' | 'fulfillment' | 'admin';

export interface RoleRow {
  id: string;
  tenant_id: string;
  /** Machine key, unique per tenant (built-in keys or a custom slug). */
  key: string;
  name: string;
  /** INTEGER 0/1 — built-in roles cannot be deleted. */
  builtin: number;
  created_at: string;
  updated_at: string;
}

export interface RolePermissionRow {
  id: string;
  tenant_id: string;
  role_id: string;
  /** A stable string from the WORKFORCE_PERMISSIONS catalog. */
  permission: WorkforcePermission;
  created_at: string;
}

export interface UserRoleRow {
  id: string;
  tenant_id: string;
  /** core users id string. */
  user_id: string;
  role_id: string;
  created_at: string;
}

export interface InvitationRow {
  id: string;
  tenant_id: string;
  email: string;
  role_id: string;
  /** sha256 hex of the raw token — the raw token is returned exactly once. */
  token_hash: string;
  expires_at: string;
  /** Null until accepted (single-use). */
  accepted_at: string | null;
  /** INTEGER 0/1. */
  revoked: number;
  created_at: string;
  updated_at: string;
}

export interface SessionPolicyRow {
  id: string;
  tenant_id: string;
  /** Sessions older than this many hours are considered expired by the integrator's auth. */
  max_age_hours: number;
  /**
   * When set, the integrator's auth must reject any session established before
   * this instant (a "log out all devices" cut-line). ISO-8601 UTC or null.
   */
  sessions_invalidated_after: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduleRow {
  id: string;
  tenant_id: string;
  /** core users id string. */
  user_id: string;
  starts_at: string;
  ends_at: string;
  kind: ScheduleKind;
  /** shows-module show id string, or null. */
  show_ref: string | null;
  note: string | null;
  /** INTEGER 0/1 — only published shifts participate in conflict detection. */
  published: number;
  /** INTEGER 0/1 — set when published despite a detected conflict (recorded). */
  overridden: number;
  created_at: string;
  updated_at: string;
}

export interface TimeExportRow {
  id: string;
  tenant_id: string;
  /** Payroll adapter key (e.g. "generic_csv"). */
  adapter: string;
  /** Number of approved time rows included. */
  row_count: number;
  /** The rendered CSV payload (no pay/overtime math — raw approved rows only). */
  payload: string;
  created_at: string;
}

export interface HandoffRow {
  id: string;
  tenant_id: string;
  /** core users id string. */
  from_user: string;
  /** core users id string, or null for an unassigned/broadcast handoff. */
  to_user: string | null;
  /** portal-employee shift id string, or null. */
  shift_ref: string | null;
  body: string;
  /** JSON-serialized array of open items. */
  open_items: string;
  /** INTEGER 0/1. */
  acknowledged: number;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkforceDatabase extends CoreDatabase {
  workforce_roles: RoleRow;
  workforce_role_permissions: RolePermissionRow;
  workforce_user_roles: UserRoleRow;
  workforce_invitations: InvitationRow;
  workforce_session_policies: SessionPolicyRow;
  workforce_schedules: ScheduleRow;
  workforce_time_exports: TimeExportRow;
  workforce_handoffs: HandoffRow;
}
