/**
 * Row types for the portal-employee module tables.
 *
 * Conventions (see /CONVENTIONS.md):
 * - ids: TEXT, nanoid, generated in code via id()
 * - timestamps: TEXT, ISO-8601 UTC via nowIso()
 * - booleans: INTEGER 0/1 (converted to real booleans at the service boundary)
 * - JSON: serialized TEXT
 * - cross-module references (user_id, file_id, related_entity_id) are id
 *   strings only — never foreign keys or joins into other modules.
 */
import type { CoreDatabase } from '@blacklabel/core';

/** Portal permission role. Managers/admins can view + comment on everything; workers only their own records. */
export type EmployeeRole = 'worker' | 'manager' | 'admin';

export type AssignmentStatus = 'assigned' | 'in_progress' | 'completed' | 'canceled';

export type WorkLogKind = 'note' | 'status_update' | 'manager_comment';

export interface EmployeeRow {
  id: string;
  tenant_id: string;
  /** Optional link to a core users row (id string reference only). */
  user_id: string | null;
  name: string;
  email: string;
  phone: string | null;
  role: EmployeeRole;
  /** Free-form job title per tenant ("technician", "videographer", ...). Never an industry enum. */
  title: string | null;
  /** INTEGER 0/1. */
  active: number;
  /** JSON-serialized custom field values (keys = core custom field definition keys). */
  custom: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmployeeTokenRow {
  id: string;
  tenant_id: string;
  employee_id: string;
  token: string;
  /** ISO-8601 UTC or null = never expires. */
  expires_at: string | null;
  /** INTEGER 0/1. */
  revoked: number;
  created_at: string;
}

export interface AssignmentRow {
  id: string;
  tenant_id: string;
  employee_id: string;
  /** Free-form per tenant: "job", "install", "video_shoot", "campaign", ... — never an industry enum. */
  kind: string;
  title: string;
  description: string | null;
  status: AssignmentStatus;
  /** ISO-8601 UTC, or null when unscheduled. */
  scheduled_at: string | null;
  /** Cross-module reference by id string only (e.g. "scheduling.appointment"). */
  related_entity_type: string | null;
  related_entity_id: string | null;
  /** JSON-serialized custom field values. */
  custom: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShiftRow {
  id: string;
  tenant_id: string;
  employee_id: string;
  starts_at: string;
  ends_at: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface TimeEntryRow {
  id: string;
  tenant_id: string;
  employee_id: string;
  /** Optional link to the shift being worked. */
  shift_id: string | null;
  clock_in_at: string;
  /** Null while the entry is open (clocked in, not yet out). */
  clock_out_at: string | null;
  created_at: string;
}

export interface ChecklistTemplateRow {
  id: string;
  tenant_id: string;
  name: string;
  created_at: string;
}

export interface ChecklistTemplateItemRow {
  id: string;
  tenant_id: string;
  template_id: string;
  label: string;
  position: number;
  created_at: string;
}

/** Per-assignment checklist instance (copied from a template or ad-hoc). */
export interface ChecklistRow {
  id: string;
  tenant_id: string;
  assignment_id: string;
  /** Source template id, or null for ad-hoc checklists. */
  template_id: string | null;
  name: string;
  created_at: string;
}

export interface ChecklistItemRow {
  id: string;
  tenant_id: string;
  checklist_id: string;
  label: string;
  position: number;
  /** INTEGER 0/1. */
  checked: number;
  checked_at: string | null;
  /** Employee id that (un)checked the item last. */
  checked_by: string | null;
  created_at: string;
}

/** Internal notes, status updates, and manager comments on an assignment. */
export interface WorkLogRow {
  id: string;
  tenant_id: string;
  assignment_id: string;
  /** Authoring employee id, or "system" for machine writes. */
  employee_id: string;
  kind: WorkLogKind;
  body: string;
  /** New assignment status when kind = "status_update". */
  status: AssignmentStatus | null;
  /**
   * Per-assignment insertion counter — keeps the log timeline in insertion
   * order even when two logs share the same millisecond `created_at`.
   */
  seq: number;
  created_at: string;
}

/** Photo upload reference — the file itself lives in the files module (id string only). */
export interface JobPhotoRow {
  id: string;
  tenant_id: string;
  assignment_id: string;
  employee_id: string;
  /** files-module file id (reference by id string only). */
  file_id: string;
  caption: string | null;
  created_at: string;
}

export interface PortalEmployeeDatabase extends CoreDatabase {
  portal_employee_employees: EmployeeRow;
  portal_employee_tokens: EmployeeTokenRow;
  portal_employee_assignments: AssignmentRow;
  portal_employee_shifts: ShiftRow;
  portal_employee_time_entries: TimeEntryRow;
  portal_employee_checklist_templates: ChecklistTemplateRow;
  portal_employee_checklist_template_items: ChecklistTemplateItemRow;
  portal_employee_checklists: ChecklistRow;
  portal_employee_checklist_items: ChecklistItemRow;
  portal_employee_work_logs: WorkLogRow;
  portal_employee_job_photos: JobPhotoRow;
}
