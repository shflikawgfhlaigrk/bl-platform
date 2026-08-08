/**
 * @blacklabel/scheduling — universal scheduling/calendar engine.
 *
 * Events emitted (catalog):
 *   scheduling.appointment.scheduled   { appointmentId, customerId, startsAt }
 *   scheduling.appointment.completed   { appointmentId }
 *   scheduling.appointment.canceled    { appointmentId, reason? }
 * Module-internal events (same naming rules):
 *   scheduling.appointment.rescheduled { appointmentId, startsAt, endsAt }
 *   scheduling.reminder.sent           { reminderId, appointmentId, channel }
 *
 * Contract implementations: createSchedulingContract() implements core's
 * CreateAppointmentContract — apps/api wires it into other modules' deps.
 */
export const MODULE_KEY = 'scheduling' as const;

// Migrations
export { schedulingMigrations } from './migrations';

// Router factory
export { schedulingRouter } from './router';
export type { SchedulingRouterOptions } from './router';

// Contract implementations (CreateAppointmentContract, CreateAppointmentTypeContract)
export {
  assertExpectedActiveStaffCount,
  createSchedulingContract,
  createSchedulingAppointmentTypeContract,
} from './service';

// Next-available slot finder (Front Desk V2)
export { findNextAvailable } from './service';
export type { AvailableSlot, NextAvailableQuery, NextAvailableResult } from './service';

// Integration layer (Google-Calendar-ready provider interface + stubs)
export {
  NoopExternalCalendarProvider,
  StubReminderProvider,
} from './service';
export type {
  ExternalCalendarProvider,
  ExternalEventInput,
  ReminderDeliveryProvider,
  ReminderDeliveryInput,
  SchedulingReadinessConfig,
  SchedulingReadinessResult,
} from './service';

// Seed helper
export { seedScheduling } from './seed';
export type { SchedulingSeedResult } from './seed';

// Public types
export type {
  AppointmentStatus,
  OwnerType,
  RecurrenceFrequency,
  ReminderStatus,
  CalendarSyncStatus,
  SchedulingCalendarRow,
  SchedulingLocationRow,
  SchedulingStaffMemberRow,
  SchedulingResourceRow,
  SchedulingAppointmentTypeRow,
  SchedulingAvailabilityWindowRow,
  SchedulingAvailabilityExceptionRow,
  SchedulingScheduleRuleRow,
  SchedulingAppointmentRow,
  SchedulingAppointmentStaffRow,
  SchedulingAppointmentResourceRow,
  SchedulingReminderRow,
  SchedulingDatabase,
} from './schema';
export type {
  AppointmentWithAssignments,
  ConflictDetail,
  CreateAppointmentServiceInput,
  FreeInterval,
  RecurrenceInput,
} from './service';
