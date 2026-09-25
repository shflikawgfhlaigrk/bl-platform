/**
 * @blacklabel/portal-employee — employee portal: field workers, technicians,
 * salespeople, media staff, operators. Industry-neutral (assignment.kind is
 * free-form per tenant).
 *
 * Events emitted (module.entity.verb):
 * - portal_employee.shift.clocked_in   { shiftId, timeEntryId, employeeId, userId, at }   (catalog)
 * - portal_employee.shift.clocked_out  { shiftId, timeEntryId, employeeId, userId, at }   (catalog)
 * - portal_employee.task.completed     { assignmentId, employeeId, kind }
 * - portal_employee.assignment.created { assignmentId, employeeId, kind }
 * - portal_employee.employee.created   { employeeId, role }
 */

export const MODULE_KEY = 'portal-employee' as const;

// Migrations
export { portalEmployeeMigrations } from './migrations';

// Router factory (+ portal middleware/env for reuse by the integrator)
export { portalEmployeeRouter, employeeAuthMiddleware, requireRole } from './router';
export type { PortalEmployeeEnv } from './router';

// Seed
export { seedPortalEmployee } from './seed';
export type { PortalEmployeeSeedResult } from './seed';

// Public types — database map + row types
export type {
  PortalEmployeeDatabase,
  EmployeeRole,
  AssignmentStatus,
  WorkLogKind,
  EmployeeRow,
  EmployeeTokenRow,
  AssignmentRow,
  ShiftRow,
  TimeEntryRow,
  ChecklistTemplateRow,
  ChecklistTemplateItemRow,
  ChecklistRow,
  ChecklistItemRow,
  WorkLogRow,
  JobPhotoRow,
} from './schema';

// Public boundary types
export type {
  Employee,
  Assignment,
  ChecklistItem,
  ChecklistWithItems,
  ChecklistTemplateWithItems,
  DailySchedule,
} from './service';

// Composition may bind authenticated work photos to the shared file vault.
export { authenticateEmployeeToken, getAssignmentForActor, addJobPhoto, listJobPhotos } from './service';
