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
  const assignment = await getAssignmentForActor(db, tenantId, actor, assignmentId);
  const now = nowIso();
  await db
    .updateTable('portal_employee_assignments')
    .set({ status, updated_at: now })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', assignmentId)
    .execute();

  const log: WorkLogRow = {
    id: id(),
    tenant_id: tenantId,
    assignment_id: assignmentId,
    employee_id: actor.id,
    kind: 'status_update',
    body: note ?? `status changed: ${assignment.status} -> ${status}`,
    status,
    seq: await nextWorkLogSeq(db, tenantId, assignmentId),
    created_at: now,
  };
  await db.insertInto('portal_employee_work_logs').values(log).execute();

  await audit(asCoreDb(db), tenantId, actor.id, 'portal_employee.assignment.status_changed', 'portal_employee.assignment', assignmentId, {
    before: { status: assignment.status },
    after: { status },
  });
  if (status === 'completed') {
    await events.emit(tenantId, 'portal_employee.task.completed', {
      assignmentId,
      employeeId: assignment.employee_id,
      kind: assignment.kind,
    });
  }
  return getAssignment(db, tenantId, assignmentId);
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
export async function clockIn(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: Employee,
  options: { shiftId?: string } = {},
): Promise<TimeEntryRow> {
  const open = await findOpenTimeEntry(db, tenantId, actor.id);
  if (open) {
    throw ApiError.conflict('already clocked in — clock out first', { openTimeEntryId: open.id });
  }
  let shiftId: string | null = null;
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
    clock_in_at: at,
    clock_out_at: null,
    created_at: at,
  };
  await db.insertInto('portal_employee_time_entries').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor.id, 'portal_employee.shift.clocked_in', 'portal_employee.time_entry', row.id, {
    shiftId,
    at,
  });
  await events.emit(tenantId, 'portal_employee.shift.clocked_in', {
    shiftId,
    timeEntryId: row.id,
    employeeId: actor.id,
    userId: actor.user_id ?? actor.id,
    at,
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
  await db
    .updateTable('portal_employee_time_entries')
    .set({ clock_out_at: at })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', open.id)
    .execute();
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
  await getAssignment(db, tenantId, assignmentId); // 404 if absent
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
