/**
 * portal-employee business logic. Every function is tenant-scoped (tenant_id
 * filter on EVERY query), audits every mutation, and emits domain events
 * after the write succeeds.
 */
import { DateTime } from 'luxon';
import type { Kysely } from 'kysely';
import {
  ApiError,
  audit,
  asCoreDb,
  id,
  nowIso,
  type EventBus,
  type Pagination,
} from '@blacklabel/core';
import type {
  AssignmentRow,
  AssignmentStatus,
  AssignmentExceptionRow,
  ChecklistItemRow,
  ChecklistRow,
  ChecklistTemplateItemRow,
  ChecklistTemplateRow,
  EmployeeRole,
  EmployeeRow,
  EmployeeTokenRow,
  JobPhotoRow,
  PortalEmployeeDatabase,
  ShiftRow,
  TimeEntryRow,
  WorkLogRow,
} from './schema';

type Db = Kysely<PortalEmployeeDatabase>;

/* ------------------------------------------------------------------ *
 * Boundary types (integers 0/1 -> booleans, JSON text -> objects)
 * ------------------------------------------------------------------ */

export interface Employee extends Omit<EmployeeRow, 'active' | 'custom'> {
  active: boolean;
  custom: Record<string, unknown> | null;
}

export interface Assignment extends Omit<AssignmentRow, 'custom'> {
  custom: Record<string, unknown> | null;
}

export interface ChecklistItem extends Omit<ChecklistItemRow, 'checked'> {
  checked: boolean;
}

export interface ChecklistWithItems extends ChecklistRow {
  items: ChecklistItem[];
}

export interface ChecklistTemplateWithItems extends ChecklistTemplateRow {
  items: ChecklistTemplateItemRow[];
}

export interface DailySchedule {
  date: string;
  employeeId: string;
  shifts: ShiftRow[];
  assignments: Assignment[];
  openTimeEntry: TimeEntryRow | null;
}

function toEmployee(row: EmployeeRow): Employee {
  return {
    ...row,
    active: row.active === 1,
    custom: row.custom === null ? null : (JSON.parse(row.custom) as Record<string, unknown>),
  };
}

function toAssignment(row: AssignmentRow): Assignment {
  return {
    ...row,
    custom: row.custom === null ? null : (JSON.parse(row.custom) as Record<string, unknown>),
  };
}

function toChecklistItem(row: ChecklistItemRow): ChecklistItem {
  return { ...row, checked: row.checked === 1 };
}

const ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = [
  'assigned',
  'in_progress',
  'completed',
  'canceled',
];

/** Validate an ISO-8601 timestamp (any zone accepted, stored normalized to UTC). */
function normalizeIso(value: string, field: string): string {
  const dt = DateTime.fromISO(value, { setZone: true });
  if (!dt.isValid) {
    throw ApiError.badRequest(`${field} must be an ISO-8601 timestamp`);
  }
  return dt.toUTC().toISO() as string;
}

/** Local calendar day converted to UTC bounds, including daylight-saving changes. */
function dayWindow(date: string, timezone = 'UTC'): { start: string; end: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw ApiError.badRequest('date must be YYYY-MM-DD');
  }
  const start = DateTime.fromISO(date, { zone: timezone });
  if (!start.isValid) {
    throw ApiError.badRequest('date and timezone must be valid');
  }
  return {
    start: start.startOf('day').toUTC().toISO() as string,
    end: start.plus({ days: 1 }).startOf('day').toUTC().toISO() as string,
  };
}

/* ------------------------------------------------------------------ *
 * Permissions
 * ------------------------------------------------------------------ */

export function isManager(employee: Pick<Employee, 'role'>): boolean {
  return employee.role === 'manager' || employee.role === 'admin';
}

/** Workers may only touch their own records; managers/admins may touch anyone's. */
export function assertCanAccessEmployee(
  actor: Pick<Employee, 'id' | 'role'>,
  targetEmployeeId: string,
): void {
  if (!isManager(actor) && actor.id !== targetEmployeeId) {
    throw ApiError.forbidden('workers can only access their own records');
  }
}

/* ------------------------------------------------------------------ *
 * Employees
 * ------------------------------------------------------------------ */

export interface CreateEmployeeInput {
  name: string;
  email: string;
  role?: EmployeeRole;
  phone?: string;
  title?: string;
  userId?: string;
  custom?: Record<string, unknown>;
}

export async function createEmployee(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  input: CreateEmployeeInput,
): Promise<Employee> {
  const now = nowIso();
  const row: EmployeeRow = {
    id: id(),
    tenant_id: tenantId,
    user_id: input.userId ?? null,
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    phone: input.phone ?? null,
    role: input.role ?? 'worker',
    title: input.title ?? null,
    active: 1,
    custom: input.custom === undefined ? null : JSON.stringify(input.custom),
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('portal_employee_employees').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'portal_employee.employee.created', 'portal_employee.employee', row.id, {
    after: { name: row.name, email: row.email, role: row.role },
  });
  await events.emit(tenantId, 'portal_employee.employee.created', { employeeId: row.id, role: row.role });
  return toEmployee(row);
}

export async function getEmployee(
  db: Db,
  tenantId: string,
  employeeId: string,
): Promise<Employee> {
  const row = await db
    .selectFrom('portal_employee_employees')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', employeeId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`employee not found: ${employeeId}`);
  return toEmployee(row);
}

export async function listEmployees(
  db: Db,
  tenantId: string,
  filters: { role?: string; active?: string } = {},
  page: Pagination = { limit: 50, offset: 0 },
): Promise<Employee[]> {
  let q = db
    .selectFrom('portal_employee_employees')
    .selectAll()
    .where('tenant_id', '=', tenantId);
  if (filters.role !== undefined) q = q.where('role', '=', filters.role as EmployeeRole);
  if (filters.active !== undefined) q = q.where('active', '=', filters.active === 'true' ? 1 : 0);
  const rows = await q
    .orderBy('name')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
  return rows.map(toEmployee);
}

export interface UpdateEmployeeInput {
  name?: string;
  email?: string;
  phone?: string | null;
  role?: EmployeeRole;
  title?: string | null;
  userId?: string | null;
  active?: boolean;
  custom?: Record<string, unknown> | null;
}

export async function updateEmployee(
  db: Db,
  tenantId: string,
  actor: string,
  employeeId: string,
  patch: UpdateEmployeeInput,
): Promise<Employee> {
  const before = await getEmployee(db, tenantId, employeeId);
  const set: Partial<EmployeeRow> = { updated_at: nowIso() };
  if (patch.name !== undefined) {
    if (patch.name.trim() === '') throw ApiError.badRequest('name cannot be blank');
    set.name = patch.name.trim();
  }
  if (patch.email !== undefined) {
    if (!patch.email.includes('@')) throw ApiError.badRequest('valid email is required');
    set.email = patch.email.trim().toLowerCase();
  }
  if (patch.phone !== undefined) set.phone = patch.phone;
  if (patch.role !== undefined) set.role = patch.role;
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.userId !== undefined) set.user_id = patch.userId;
  if (patch.active !== undefined) set.active = patch.active ? 1 : 0;
  if (patch.custom !== undefined) set.custom = patch.custom === null ? null : JSON.stringify(patch.custom);

  await db
    .updateTable('portal_employee_employees')
    .set(set)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', employeeId)
    .execute();
  const after = await getEmployee(db, tenantId, employeeId);
  await audit(asCoreDb(db), tenantId, actor, 'portal_employee.employee.updated', 'portal_employee.employee', employeeId, {
    before: { name: before.name, role: before.role, active: before.active },
    after: { name: after.name, role: after.role, active: after.active },
  });
  return after;
}

export async function deleteEmployee(
  db: Db,
  tenantId: string,
  actor: string,
  employeeId: string,
): Promise<void> {
  const result = await db
    .deleteFrom('portal_employee_employees')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', employeeId)
    .executeTakeFirst();
  if (result.numDeletedRows === 0n) {
    throw ApiError.notFound(`employee not found: ${employeeId}`);
  }
  await audit(asCoreDb(db), tenantId, actor, 'portal_employee.employee.deleted', 'portal_employee.employee', employeeId);
}

/* ------------------------------------------------------------------ *
 * Tokens (portal auth)
 * ------------------------------------------------------------------ */

export async function issueEmployeeToken(
  db: Db,
  tenantId: string,
  actor: string,
  employeeId: string,
  options: { expiresAt?: string } = {},
): Promise<EmployeeTokenRow> {
  await getEmployee(db, tenantId, employeeId); // 404 if absent
  const row: EmployeeTokenRow = {
    id: id(),
    tenant_id: tenantId,
    employee_id: employeeId,
    token: `${id()}${id()}`,
    expires_at: options.expiresAt === undefined ? null : normalizeIso(options.expiresAt, 'expiresAt'),
    revoked: 0,
    created_at: nowIso(),
  };
  await db.insertInto('portal_employee_tokens').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'portal_employee.token.issued', 'portal_employee.token', row.id, {
    employeeId,
  });
  return row;
}

export async function revokeEmployeeToken(
  db: Db,
  tenantId: string,
  actor: string,
  tokenId: string,
): Promise<void> {
  const result = await db
    .updateTable('portal_employee_tokens')
    .set({ revoked: 1 })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', tokenId)
    .executeTakeFirst();
  if (result.numUpdatedRows === 0n) {
    throw ApiError.notFound(`token not found: ${tokenId}`);
  }
  await audit(asCoreDb(db), tenantId, actor, 'portal_employee.token.revoked', 'portal_employee.token', tokenId);
}

/** Resolve a portal token to its active employee, or undefined when invalid/expired/revoked. */
export async function authenticateEmployeeToken(
  db: Db,
  tenantId: string,
  token: string,
): Promise<Employee | undefined> {
  const tokenRow = await db
    .selectFrom('portal_employee_tokens')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('token', '=', token)
    .where('revoked', '=', 0)
    .executeTakeFirst();
  if (!tokenRow) return undefined;
  if (tokenRow.expires_at !== null && tokenRow.expires_at <= nowIso()) return undefined;
  const employee = await db
    .selectFrom('portal_employee_employees')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', tokenRow.employee_id)
    .where('active', '=', 1)
    .executeTakeFirst();
  return employee ? toEmployee(employee) : undefined;
}

/* ------------------------------------------------------------------ *
 * Assignments
 * ------------------------------------------------------------------ */

export interface CreateAssignmentInput {
  employeeId: string;
  kind: string;
  title: string;
  description?: string;
  scheduledAt?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  custom?: Record<string, unknown>;
}

export async function createAssignment(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  input: CreateAssignmentInput,
): Promise<Assignment> {
  await getEmployee(db, tenantId, input.employeeId); // 404 if absent
  const now = nowIso();
  const row: AssignmentRow = {
    id: id(),
    tenant_id: tenantId,
    employee_id: input.employeeId,
    kind: input.kind.trim(),
    title: input.title.trim(),
    description: input.description ?? null,
    status: 'assigned',
    completed_at: null,
    scheduled_at: input.scheduledAt === undefined ? null : normalizeIso(input.scheduledAt, 'scheduledAt'),
    related_entity_type: input.relatedEntityType ?? null,
    related_entity_id: input.relatedEntityId ?? null,
    custom: input.custom === undefined ? null : JSON.stringify(input.custom),
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('portal_employee_assignments').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'portal_employee.assignment.created', 'portal_employee.assignment', row.id, {
    after: { employeeId: row.employee_id, kind: row.kind, title: row.title },
  });
  await events.emit(tenantId, 'portal_employee.assignment.created', {
    assignmentId: row.id,
    employeeId: row.employee_id,
    kind: row.kind,
  });
  return toAssignment(row);
}

export async function getAssignment(
  db: Db,
  tenantId: string,
  assignmentId: string,
): Promise<Assignment> {
  const row = await db
    .selectFrom('portal_employee_assignments')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', assignmentId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`assignment not found: ${assignmentId}`);
  return toAssignment(row);
}

/** Load an assignment and enforce worker-owns-it / manager-sees-all. */
export async function getAssignmentForActor(
  db: Db,
  tenantId: string,
  actor: Employee,
  assignmentId: string,
): Promise<Assignment> {
  const assignment = await getAssignment(db, tenantId, assignmentId);
  assertCanAccessEmployee(actor, assignment.employee_id);
  return assignment;
}

export async function listAssignments(
  db: Db,
  tenantId: string,
  filters: { employeeId?: string; status?: string; kind?: string } = {},
  page: Pagination = { limit: 50, offset: 0 },
): Promise<Assignment[]> {
  let q = db
    .selectFrom('portal_employee_assignments')
    .selectAll()
    .where('tenant_id', '=', tenantId);
  if (filters.employeeId !== undefined) q = q.where('employee_id', '=', filters.employeeId);
  if (filters.status !== undefined) {
    if (!ASSIGNMENT_STATUSES.includes(filters.status as AssignmentStatus)) {
      throw ApiError.badRequest(`invalid status: ${filters.status}`, { allowed: ASSIGNMENT_STATUSES });
    }
    q = q.where('status', '=', filters.status as AssignmentStatus);
  }
  if (filters.kind !== undefined) q = q.where('kind', '=', filters.kind);
  const rows = await q
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
  return rows.map(toAssignment);
}

/**
 * Status update by an employee: writes the new status, records a
 * status_update WorkLog, emits portal_employee.task.completed when completed.
 */
export async function updateAssignmentStatus(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: Employee,
  assignmentId: string,
  status: AssignmentStatus,
  note?: string,
): Promise<Assignment> {
  const result = await db.transaction().execute(async (trx) => {
    const assignment = await getAssignmentForActor(trx, tenantId, actor, assignmentId);
    if (assignment.status === status) return { assignment, emitCompleted: false };
    if (['completed', 'canceled'].includes(assignment.status) && !isManager(actor)) {
      throw ApiError.forbidden('A manager must reopen closed work');
    }
    if (status === 'completed') {
      const closeout = await getAssignmentCloseout(trx, tenantId, assignmentId);
      if (closeout.blockers.length) throw ApiError.conflict('Resolve the closeout items before completing this work', { blockers: closeout.blockers });
    }
    const now = nowIso();
    const emitCompleted = status === 'completed' && assignment.completed_at === null;
    await trx.updateTable('portal_employee_assignments')
      .set({ status, updated_at: now, completed_at: emitCompleted ? now : assignment.completed_at })
      .where('tenant_id', '=', tenantId).where('id', '=', assignmentId).execute();
    const log: WorkLogRow = {
      id: id(), tenant_id: tenantId, assignment_id: assignmentId, employee_id: actor.id,
      kind: 'status_update', body: note?.trim() || `status changed: ${assignment.status} -> ${status}`,
      status, seq: await nextWorkLogSeq(trx, tenantId, assignmentId), created_at: now,
    };
    await trx.insertInto('portal_employee_work_logs').values(log).execute();
    await audit(asCoreDb(trx), tenantId, actor.id, 'portal_employee.assignment.status_changed', 'portal_employee.assignment', assignmentId, {
      before: { status: assignment.status }, after: { status }, completedAt: emitCompleted ? now : assignment.completed_at,
    });
    return { assignment: await getAssignment(trx, tenantId, assignmentId), emitCompleted };
  });
  if (result.emitCompleted) {
    await events.emit(tenantId, 'portal_employee.task.completed', {
      assignmentId,
      employeeId: result.assignment.employee_id,
      kind: result.assignment.kind,
    });
  }
  return result.assignment;
}

export interface AssignmentCloseout {
  assignment: Assignment;
  checklists: ChecklistWithItems[];
  exceptions: AssignmentExceptionRow[];
  time_entries: TimeEntryRow[];
  blockers: { kind: 'checklist' | 'exception' | 'open_time' | 'time_review'; id: string; message: string }[];
}

/** Each assignment includes its own checklist, exceptions and reviewed-time closeout. */
export async function getAssignmentCloseout(db: Db, tenantId: string, assignmentId: string): Promise<AssignmentCloseout> {
  const assignment = await getAssignment(db, tenantId, assignmentId);
  const checklists = await listChecklistsForAssignment(db, tenantId, assignmentId);
  const exceptions = await db.selectFrom('portal_employee_exceptions').selectAll()
    .where('tenant_id', '=', tenantId).where('assignment_id', '=', assignmentId)
    .orderBy('created_at').orderBy('id').execute();
  const timeEntries = await db.selectFrom('portal_employee_time_entries').selectAll()
    .where('tenant_id', '=', tenantId).where('assignment_id', '=', assignmentId)
    .orderBy('clock_in_at').orderBy('id').execute();
  const waived = new Set(exceptions.filter((row) => row.status === 'resolved' && row.resolution_kind === 'waived')
    .map((row) => row.checklist_item_id));
  const blockers: AssignmentCloseout['blockers'] = [];
  for (const list of checklists) for (const item of list.items) if (!item.checked && !waived.has(item.id)) {
    blockers.push({ kind: 'checklist', id: item.id, message: `Complete or obtain a manager waiver: ${item.label}` });
  }
  for (const issue of exceptions) if (issue.status === 'open') {
    blockers.push({ kind: 'exception', id: issue.id, message: `Manager resolution needed: ${issue.reason}` });
  }
  for (const entry of timeEntries) {
    if (entry.clock_out_at === null) blockers.push({ kind: 'open_time', id: entry.id, message: 'Clock out linked work time' });
    else if (entry.review_status !== 'approved') blockers.push({ kind: 'time_review', id: entry.id, message: `Manager approval needed for linked time (${entry.review_status})` });
  }
  return { assignment, checklists, exceptions, time_entries: timeEntries, blockers };
}

function reviewActor(actor: Employee | string): string {
  if (typeof actor === 'string') return actor; // Trusted back-office auth belongs to composition.
  if (!isManager(actor)) throw ApiError.forbidden('Only managers can review closeout');
  return actor.id;
}

export async function reportAssignmentException(
  db: Db, events: EventBus, tenantId: string, actor: Employee, assignmentId: string,
  input: { reason: string; checklist_item_id?: string; idempotency_key: string },
): Promise<AssignmentExceptionRow> {
  const reason = input.reason.trim();
  if (!reason || reason.length > 2000) throw ApiError.badRequest('Explain the exception in 1–2000 characters');
  const result = await db.transaction().execute(async (trx) => {
    const assignment = await getAssignmentForActor(trx, tenantId, actor, assignmentId);
    const prior = await trx.selectFrom('portal_employee_exceptions').selectAll()
      .where('tenant_id', '=', tenantId).where('idempotency_key', '=', input.idempotency_key).executeTakeFirst();
    if (prior) {
      if (prior.assignment_id !== assignmentId || prior.reason !== reason || prior.reported_by !== actor.id ||
        prior.checklist_item_id !== (input.checklist_item_id ?? null)) throw ApiError.conflict('Exception key was already used for another report');
      return { row: prior, created: false };
    }
    if (['completed', 'canceled'].includes(assignment.status)) throw ApiError.conflict('Reopen closed work before reporting an exception');
    if (input.checklist_item_id) {
      const lists = await listChecklistsForAssignment(trx, tenantId, assignmentId);
      if (!lists.some((list) => list.items.some((item) => item.id === input.checklist_item_id))) throw ApiError.notFound('Checklist item does not belong to this work');
    }
    const row: AssignmentExceptionRow = {
      id: id(), tenant_id: tenantId, assignment_id: assignmentId,
      checklist_item_id: input.checklist_item_id ?? null, idempotency_key: input.idempotency_key,
      reason, reported_by: actor.id, status: 'open', resolution_kind: null, resolution_note: null,
      resolved_by: null, resolved_at: null, created_at: nowIso(),
    };
    await trx.insertInto('portal_employee_exceptions').values(row).execute();
    await audit(asCoreDb(trx), tenantId, actor.id, 'portal_employee.exception.reported', 'portal_employee.exception', row.id, { assignmentId, reason, checklistItemId: row.checklist_item_id });
    await addWorkLog(trx, tenantId, actor, assignmentId, { kind: 'note', body: `Exception: ${reason}` });
    return { row, created: true };
  });
  if (result.created) await events.emit(tenantId, 'portal_employee.exception.reported', { assignmentId, exceptionId: result.row.id });
  return result.row;
}

export async function resolveAssignmentException(
  db: Db, events: EventBus, tenantId: string, actor: Employee | string, exceptionId: string,
  input: { resolution_note: string; waive_item?: boolean },
): Promise<AssignmentExceptionRow> {
  const actorId = reviewActor(actor), note = input.resolution_note.trim();
  if (!note || note.length > 2000) throw ApiError.badRequest('Record the manager resolution in 1–2000 characters');
  const result = await db.transaction().execute(async (trx) => {
    const issue = await trx.selectFrom('portal_employee_exceptions').selectAll()
      .where('tenant_id', '=', tenantId).where('id', '=', exceptionId).executeTakeFirst();
    if (!issue) throw ApiError.notFound('Exception not found');
    await getAssignment(trx, tenantId, issue.assignment_id);
    if (input.waive_item && !issue.checklist_item_id) throw ApiError.badRequest('A waiver must identify a checklist item');
    const kind = input.waive_item ? 'waived' : 'resolved';
    if (issue.status === 'resolved') {
      if (issue.resolution_note !== note || issue.resolution_kind !== kind) throw ApiError.conflict('This exception already has a recorded resolution');
      return { row: issue, changed: false };
    }
    const patch = { status: 'resolved' as const, resolution_kind: kind as 'waived' | 'resolved', resolution_note: note, resolved_by: actorId, resolved_at: nowIso() };
    await trx.updateTable('portal_employee_exceptions').set(patch).where('tenant_id', '=', tenantId).where('id', '=', exceptionId).execute();
    await audit(asCoreDb(trx), tenantId, actorId, 'portal_employee.exception.resolved', 'portal_employee.exception', exceptionId, { assignmentId: issue.assignment_id, ...patch });
    const log: WorkLogRow = {
      id: id(), tenant_id: tenantId, assignment_id: issue.assignment_id, employee_id: actorId,
      kind: 'manager_comment', body: `Exception ${kind}: ${note}`, status: null,
      seq: await nextWorkLogSeq(trx, tenantId, issue.assignment_id), created_at: patch.resolved_at,
    };
    await trx.insertInto('portal_employee_work_logs').values(log).execute();
    return { row: { ...issue, ...patch }, changed: true };
  });
  if (result.changed) await events.emit(tenantId, 'portal_employee.exception.resolved', { assignmentId: result.row.assignment_id, exceptionId });
  return result.row;
}

export async function reviewTimeEntry(
  db: Db, events: EventBus, tenantId: string, actor: Employee | string, entryId: string,
  input: { status: 'approved' | 'rejected'; note: string },
): Promise<TimeEntryRow> {
  const actorId = reviewActor(actor), note = input.note.trim();
  if (!note || note.length > 2000) throw ApiError.badRequest('Record the time review reason in 1–2000 characters');
  const result = await db.transaction().execute(async (trx) => {
    const entry = await trx.selectFrom('portal_employee_time_entries').selectAll()
      .where('tenant_id', '=', tenantId).where('id', '=', entryId).executeTakeFirst();
    if (!entry) throw ApiError.notFound('Time entry not found');
    if (!entry.clock_out_at) throw ApiError.conflict('Clock out before reviewing time');
    if (entry.review_status === input.status && entry.review_note === note) return { row: entry, changed: false };
    if (entry.assignment_id) {
      const work = await getAssignment(trx, tenantId, entry.assignment_id);
      if (work.status === 'completed') throw ApiError.conflict('Reopen completed work before changing its approved time');
    }
    const patch = { review_status: input.status, reviewed_by: actorId, reviewed_at: nowIso(), review_note: note };
    await trx.updateTable('portal_employee_time_entries').set(patch).where('tenant_id', '=', tenantId).where('id', '=', entryId).execute();
    await audit(asCoreDb(trx), tenantId, actorId, 'portal_employee.time_entry.reviewed', 'portal_employee.time_entry', entryId, { before: { status: entry.review_status }, after: patch, assignmentId: entry.assignment_id });
    return { row: { ...entry, ...patch }, changed: true };
  });
  if (result.changed) await events.emit(tenantId, 'portal_employee.time_entry.reviewed', { timeEntryId: entryId, assignmentId: result.row.assignment_id, status: input.status });
  return result.row;
}

export async function listTimeReviewQueue(
  db: Db, tenantId: string, page: Pagination, status?: 'pending' | 'approved' | 'rejected',
): Promise<{ items: (TimeEntryRow & { employee_name: string; duration_minutes: number | null })[]; summary: { pending: number; approved: number; rejected: number; open: number }; generated_at: string }> {
  const base = db.selectFrom('portal_employee_time_entries').where('tenant_id', '=', tenantId);
  const counts = await base.select((eb) => [
    eb.fn.sum<number>(eb.case().when('review_status', '=', 'pending').then(1).else(0).end()).as('pending'),
    eb.fn.sum<number>(eb.case().when('review_status', '=', 'approved').then(1).else(0).end()).as('approved'),
    eb.fn.sum<number>(eb.case().when('review_status', '=', 'rejected').then(1).else(0).end()).as('rejected'),
    eb.fn.sum<number>(eb.case().when('clock_out_at', 'is', null).then(1).else(0).end()).as('open'),
  ]).executeTakeFirstOrThrow();
  const rows = await (status ? base.where('review_status', '=', status) : base).selectAll()
    .orderBy('clock_in_at', 'desc').orderBy('id').limit(page.limit).offset(page.offset).execute();
  const items = await Promise.all(rows.map(async (entry) => ({ ...entry,
    employee_name: await getEmployee(db, tenantId, entry.employee_id).then((employee) => employee.name).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404) return 'Former team member';
      throw error;
    }),
    duration_minutes: entry.clock_out_at ? Math.max(0, Math.floor((Date.parse(entry.clock_out_at) - Date.parse(entry.clock_in_at)) / 60000)) : null,
  })));
  return { items, summary: { pending: Number(counts.pending ?? 0), approved: Number(counts.approved ?? 0), rejected: Number(counts.rejected ?? 0), open: Number(counts.open ?? 0) }, generated_at: nowIso() };
}

/* ------------------------------------------------------------------ *
 * Work logs (notes, status updates, manager comments)
 * ------------------------------------------------------------------ */

/**
 * Next per-assignment insertion counter. created_at alone has millisecond
 * resolution, so two rapid logs can collide — seq keeps the timeline stable.
 */
async function nextWorkLogSeq(
  db: Db,
  tenantId: string,
  assignmentId: string,
): Promise<number> {
  const row = await db
    .selectFrom('portal_employee_work_logs')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('tenant_id', '=', tenantId)
    .where('assignment_id', '=', assignmentId)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

export async function addWorkLog(
  db: Db,
  tenantId: string,
  actor: Employee,
  assignmentId: string,
  input: { kind: 'note' | 'manager_comment'; body: string },
): Promise<WorkLogRow> {
  if (input.kind === 'manager_comment' && !isManager(actor)) {
    throw ApiError.forbidden('only managers can add manager comments');
  }
  // Managers may log on any assignment; workers only on their own — except
  // manager comments, which by definition target someone's assignment.
  const assignment = await getAssignment(db, tenantId, assignmentId);
  if (input.kind === 'note') {
    assertCanAccessEmployee(actor, assignment.employee_id);
  }
  const row: WorkLogRow = {
    id: id(),
    tenant_id: tenantId,
    assignment_id: assignmentId,
    employee_id: actor.id,
    kind: input.kind,
    body: input.body,
    status: null,
    seq: await nextWorkLogSeq(db, tenantId, assignmentId),
    created_at: nowIso(),
  };
  await db.insertInto('portal_employee_work_logs').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor.id, 'portal_employee.work_log.created', 'portal_employee.work_log', row.id, {
    assignmentId,
    kind: input.kind,
  });
  return row;
}

export async function listWorkLogs(
  db: Db,
  tenantId: string,
  assignmentId: string,
): Promise<WorkLogRow[]> {
  return db
    .selectFrom('portal_employee_work_logs')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('assignment_id', '=', assignmentId)
    .orderBy('created_at')
    .orderBy('seq')
    .orderBy('id')
    .execute();
}

/* ------------------------------------------------------------------ *
 * Shifts
 * ------------------------------------------------------------------ */

export interface CreateShiftInput {
  employeeId: string;
  startsAt: string;
  endsAt: string;
  notes?: string;
}

export async function createShift(
  db: Db,
  tenantId: string,
  actor: string,
  input: CreateShiftInput,
): Promise<ShiftRow> {
  await getEmployee(db, tenantId, input.employeeId);
  const startsAt = normalizeIso(input.startsAt, 'startsAt');
  const endsAt = normalizeIso(input.endsAt, 'endsAt');
  if (endsAt <= startsAt) {
    throw ApiError.badRequest('endsAt must be after startsAt');
  }
  const now = nowIso();
  const row: ShiftRow = {
    id: id(),
    tenant_id: tenantId,
    employee_id: input.employeeId,
    starts_at: startsAt,
    ends_at: endsAt,
    notes: input.notes ?? null,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('portal_employee_shifts').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'portal_employee.shift.created', 'portal_employee.shift', row.id, {
    after: { employeeId: row.employee_id, startsAt, endsAt },
  });
  return row;
}

export async function listShifts(
  db: Db,
  tenantId: string,
  filters: { employeeId?: string } = {},
  page: Pagination = { limit: 50, offset: 0 },
): Promise<ShiftRow[]> {
  let q = db
    .selectFrom('portal_employee_shifts')
    .selectAll()
    .where('tenant_id', '=', tenantId);
  if (filters.employeeId !== undefined) q = q.where('employee_id', '=', filters.employeeId);
  return q
    .orderBy('starts_at')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

/* ------------------------------------------------------------------ *
 * Time entries (clock in / clock out)
 * ------------------------------------------------------------------ */

async function findOpenTimeEntry(
  db: Db,
  tenantId: string,
  employeeId: string,
): Promise<TimeEntryRow | undefined> {
  return db
    .selectFrom('portal_employee_time_entries')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('employee_id', '=', employeeId)
    .where('clock_out_at', 'is', null)
    .orderBy('clock_in_at', 'desc')
    .orderBy('id')
    .executeTakeFirst();
}

/**
 * Clock in. Open-entry guard: an employee with an open entry (no clock-out)
 * cannot clock in again — 409 conflict. Emits portal_employee.shift.clocked_in.
 */
async function writeClockIn(
  db: Db,
  tenantId: string,
  actor: Employee,
  options: { shiftId?: string; assignmentId?: string } = {},
): Promise<TimeEntryRow> {
  const open = await findOpenTimeEntry(db, tenantId, actor.id);
  if (open) {
    throw ApiError.conflict('already clocked in — clock out first', { openTimeEntryId: open.id });
  }
  let shiftId: string | null = null;
  let assignmentId: string | null = null;
  if (options.assignmentId !== undefined) {
    const assignment = await getAssignment(db, tenantId, options.assignmentId);
    if (assignment.employee_id !== actor.id) throw ApiError.forbidden('Clock time only against your own assignment');
    if (['completed', 'canceled'].includes(assignment.status)) throw ApiError.conflict('Reopen closed work before clocking time');
    assignmentId = assignment.id;
  }
  if (options.shiftId !== undefined) {
    const shift = await db
      .selectFrom('portal_employee_shifts')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', options.shiftId)
      .executeTakeFirst();
    if (!shift) throw ApiError.notFound(`shift not found: ${options.shiftId}`);
    if (shift.employee_id !== actor.id) {
      throw ApiError.forbidden('cannot clock in against another employee\'s shift');
    }
    shiftId = shift.id;
  }
  const at = nowIso();
  const row: TimeEntryRow = {
    id: id(),
    tenant_id: tenantId,
    employee_id: actor.id,
    shift_id: shiftId,
    assignment_id: assignmentId,
    clock_in_at: at,
    clock_out_at: null,
    review_status: 'pending',
    reviewed_by: null,
    reviewed_at: null,
    review_note: null,
    created_at: at,
  };
  await db.insertInto('portal_employee_time_entries').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor.id, 'portal_employee.shift.clocked_in', 'portal_employee.time_entry', row.id, {
    shiftId,
    assignmentId,
    at,
  });
  return row;
}

export async function clockIn(
  db: Db, events: EventBus, tenantId: string, actor: Employee,
  options: { shiftId?: string; assignmentId?: string } = {},
): Promise<TimeEntryRow> {
  const row = await db.transaction().execute((trx) => writeClockIn(trx, tenantId, actor, options));
  await events.emit(tenantId, 'portal_employee.shift.clocked_in', {
    shiftId: row.shift_id,
    timeEntryId: row.id,
    employeeId: actor.id,
    userId: actor.user_id ?? actor.id,
    at: row.clock_in_at,
  });
  return row;
}

/** Clock out the open entry — 409 if there is none. Emits portal_employee.shift.clocked_out. */
export async function clockOut(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: Employee,
): Promise<TimeEntryRow> {
  const open = await findOpenTimeEntry(db, tenantId, actor.id);
  if (!open) {
    throw ApiError.conflict('not clocked in');
  }
  const at = nowIso();
  const changed = await db
    .updateTable('portal_employee_time_entries')
    .set({ clock_out_at: at })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', open.id)
    .where('clock_out_at', 'is', null)
    .executeTakeFirst();
  if (changed.numUpdatedRows !== 1n) throw ApiError.conflict('Already clocked out. Refresh the time entry');
  await audit(asCoreDb(db), tenantId, actor.id, 'portal_employee.shift.clocked_out', 'portal_employee.time_entry', open.id, {
    shiftId: open.shift_id,
    at,
  });
  await events.emit(tenantId, 'portal_employee.shift.clocked_out', {
    shiftId: open.shift_id,
    timeEntryId: open.id,
    employeeId: actor.id,
    userId: actor.user_id ?? actor.id,
    at,
  });
  return { ...open, clock_out_at: at };
}

export async function listTimeEntries(
  db: Db,
  tenantId: string,
  employeeId: string,
  page: Pagination = { limit: 50, offset: 0 },
): Promise<TimeEntryRow[]> {
  return db
    .selectFrom('portal_employee_time_entries')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('employee_id', '=', employeeId)
    .orderBy('clock_in_at', 'desc')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

/* ------------------------------------------------------------------ *
 * Daily schedule
 * ------------------------------------------------------------------ */

/** Shifts overlapping the requested local day, its assignments and open clock state. */
export async function getDailySchedule(
  db: Db,
  tenantId: string,
  employeeId: string,
  date: string,
  timezone = 'UTC',
): Promise<DailySchedule> {
  const { start, end } = dayWindow(date, timezone);
  const shifts = await db
    .selectFrom('portal_employee_shifts')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('employee_id', '=', employeeId)
    .where('starts_at', '<', end)
    .where('ends_at', '>', start)
    .orderBy('starts_at')
    .orderBy('id')
    .execute();
  const assignments = await db
    .selectFrom('portal_employee_assignments')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('employee_id', '=', employeeId)
    .where('scheduled_at', '>=', start)
    .where('scheduled_at', '<', end)
    .orderBy('scheduled_at')
    .orderBy('id')
    .execute();
  const open = await findOpenTimeEntry(db, tenantId, employeeId);
  return {
    date,
    employeeId,
    shifts,
    assignments: assignments.map(toAssignment),
    openTimeEntry: open ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Checklists (templates + per-assignment instances)
 * ------------------------------------------------------------------ */

export async function createChecklistTemplate(
  db: Db,
  tenantId: string,
  actor: string,
  input: { name: string; items: string[] },
): Promise<ChecklistTemplateWithItems> {
  const now = nowIso();
  const template: ChecklistTemplateRow = {
    id: id(),
    tenant_id: tenantId,
    name: input.name.trim(),
    created_at: now,
  };
  await db.insertInto('portal_employee_checklist_templates').values(template).execute();
  const items: ChecklistTemplateItemRow[] = input.items.map((label, index) => ({
    id: id(),
    tenant_id: tenantId,
    template_id: template.id,
    label,
    position: index,
    created_at: now,
  }));
  if (items.length > 0) {
    await db.insertInto('portal_employee_checklist_template_items').values(items).execute();
  }
  await audit(asCoreDb(db), tenantId, actor, 'portal_employee.checklist_template.created', 'portal_employee.checklist_template', template.id, {
    after: { name: template.name, items: input.items },
  });
  return { ...template, items };
}

export async function listChecklistTemplates(
  db: Db,
  tenantId: string,
): Promise<ChecklistTemplateWithItems[]> {
  const templates = await db
    .selectFrom('portal_employee_checklist_templates')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('name')
    .orderBy('id')
    .execute();
  const items = await db
    .selectFrom('portal_employee_checklist_template_items')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('position')
    .orderBy('id')
    .execute();
  return templates.map((t) => ({ ...t, items: items.filter((i) => i.template_id === t.id) }));
}

/**
 * Instantiate a checklist on an assignment — from a template (items copied)
 * or ad-hoc (explicit items).
 */
export async function instantiateChecklist(
  db: Db,
  tenantId: string,
  actor: string,
  assignmentId: string,
  input: { templateId?: string; name?: string; items?: string[] },
): Promise<ChecklistWithItems> {
  const assignment = await getAssignment(db, tenantId, assignmentId); // 404 if absent
  if (['completed', 'canceled'].includes(assignment.status)) throw ApiError.conflict('Reopen closed work before adding a checklist');
  const now = nowIso();
  let name = input.name;
  let labels = input.items;
  if (input.templateId !== undefined) {
    const template = await db
      .selectFrom('portal_employee_checklist_templates')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', input.templateId)
      .executeTakeFirst();
    if (!template) throw ApiError.notFound(`checklist template not found: ${input.templateId}`);
    const templateItems = await db
      .selectFrom('portal_employee_checklist_template_items')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('template_id', '=', template.id)
      .orderBy('position')
      .orderBy('id')
      .execute();
    name = name ?? template.name;
    labels = labels ?? templateItems.map((i) => i.label);
  }
  if (name === undefined || labels === undefined) {
    throw ApiError.badRequest('provide templateId, or name + items for an ad-hoc checklist');
  }
  const checklist: ChecklistRow = {
    id: id(),
    tenant_id: tenantId,
    assignment_id: assignmentId,
    template_id: input.templateId ?? null,
    name,
    created_at: now,
  };
  await db.insertInto('portal_employee_checklists').values(checklist).execute();
  const items: ChecklistItemRow[] = labels.map((label, index) => ({
    id: id(),
    tenant_id: tenantId,
    checklist_id: checklist.id,
    label,
    position: index,
    checked: 0,
    checked_at: null,
    checked_by: null,
    created_at: now,
  }));
  if (items.length > 0) {
    await db.insertInto('portal_employee_checklist_items').values(items).execute();
  }
  await audit(asCoreDb(db), tenantId, actor, 'portal_employee.checklist.created', 'portal_employee.checklist', checklist.id, {
    assignmentId,
    templateId: input.templateId ?? null,
    items: labels,
  });
  return { ...checklist, items: items.map(toChecklistItem) };
}

export async function listChecklistsForAssignment(
  db: Db,
  tenantId: string,
  assignmentId: string,
): Promise<ChecklistWithItems[]> {
  const checklists = await db
    .selectFrom('portal_employee_checklists')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('assignment_id', '=', assignmentId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  if (checklists.length === 0) return [];
  const items = await db
    .selectFrom('portal_employee_checklist_items')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where(
      'checklist_id',
      'in',
      checklists.map((c) => c.id),
    )
    .orderBy('position')
    .orderBy('id')
    .execute();
  return checklists.map((c) => ({
    ...c,
    items: items.filter((i) => i.checklist_id === c.id).map(toChecklistItem),
  }));
}

/** Check/uncheck an item. Workers may only touch items on their own assignments. */
export async function setChecklistItemChecked(
  db: Db,
  tenantId: string,
  actor: Employee,
  itemId: string,
  checked: boolean,
): Promise<ChecklistItem> {
  const item = await db
    .selectFrom('portal_employee_checklist_items')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', itemId)
    .executeTakeFirst();
  if (!item) throw ApiError.notFound(`checklist item not found: ${itemId}`);
  const checklist = await db
    .selectFrom('portal_employee_checklists')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', item.checklist_id)
    .executeTakeFirst();
  if (!checklist) throw ApiError.notFound('checklist not found');
  const assignment = await getAssignment(db, tenantId, checklist.assignment_id);
  assertCanAccessEmployee(actor, assignment.employee_id);

  if (['completed', 'canceled'].includes(assignment.status)) throw ApiError.conflict('Reopen closed work before changing its checklist');

  const at = nowIso();
  await db
    .updateTable('portal_employee_checklist_items')
    .set({ checked: checked ? 1 : 0, checked_at: checked ? at : null, checked_by: actor.id })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', itemId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor.id, checked ? 'portal_employee.checklist_item.checked' : 'portal_employee.checklist_item.unchecked', 'portal_employee.checklist_item', itemId, {
    checklistId: checklist.id,
    assignmentId: checklist.assignment_id,
  });
  return toChecklistItem({
    ...item,
    checked: checked ? 1 : 0,
    checked_at: checked ? at : null,
    checked_by: actor.id,
  });
}

/* ------------------------------------------------------------------ *
 * Job photos (file-id references — bytes live in the files module)
 * ------------------------------------------------------------------ */

export async function addJobPhoto(
  db: Db,
  tenantId: string,
  actor: Employee,
  assignmentId: string,
  input: { fileId: string; caption?: string },
): Promise<JobPhotoRow> {
  const assignment = await getAssignment(db, tenantId, assignmentId);
  assertCanAccessEmployee(actor, assignment.employee_id);
  const row: JobPhotoRow = {
    id: id(),
    tenant_id: tenantId,
    assignment_id: assignmentId,
    employee_id: actor.id,
    file_id: input.fileId,
    caption: input.caption ?? null,
    created_at: nowIso(),
  };
  await db.insertInto('portal_employee_job_photos').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor.id, 'portal_employee.job_photo.added', 'portal_employee.job_photo', row.id, {
    assignmentId,
    fileId: input.fileId,
  });
  return row;
}

export async function listJobPhotos(
  db: Db,
  tenantId: string,
  assignmentId: string,
): Promise<JobPhotoRow[]> {
  return db
    .selectFrom('portal_employee_job_photos')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('assignment_id', '=', assignmentId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}
