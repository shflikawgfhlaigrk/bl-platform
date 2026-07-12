/**
 * Row types for the scheduling module. All tables are prefixed
 * `scheduling_` and carry `tenant_id` (see /CONVENTIONS.md §3–5).
 *
 * Conventions:
 * - ids: TEXT nanoid via id()
 * - timestamps: TEXT ISO-8601 UTC via nowIso() / luxon .toISO()
 * - booleans: INTEGER 0/1
 * - cross-module references (customer_id, user_id) are id STRINGS only
 */
import type { CoreDatabase } from '@blacklabel/core';

export type AppointmentStatus =
  | 'requested'
  | 'confirmed'
  | 'completed'
  | 'canceled'
  | 'no_show';

/** Who an availability window / exception belongs to. */
export type OwnerType = 'staff' | 'resource';

/** RRULE-lite frequencies. */
export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly';

export type ReminderStatus = 'pending' | 'sent' | 'canceled';

export interface SchedulingCalendarRow {
  id: string;
  tenant_id: string;
  name: string;
  /** IANA timezone, e.g. "America/Chicago". Appointments are stored UTC. */
  timezone: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface SchedulingLocationRow {
  id: string;
  tenant_id: string;
  name: string;
  address: string | null;
  /** Optional IANA timezone override for this location. */
  timezone: string | null;
  created_at: string;
}

export interface SchedulingStaffMemberRow {
  id: string;
  tenant_id: string;
  name: string;
  email: string | null;
  /** Optional reference to a core users.id (id string only). */
  user_id: string | null;
  /** INTEGER boolean 0/1. */
  active: number;
  created_at: string;
}

export interface SchedulingResourceRow {
  id: string;
  tenant_id: string;
  name: string;
  /** Free-form kind, e.g. "room", "vehicle", "chair". Industry-neutral. */
  kind: string | null;
  /** Reference to scheduling_locations.id. */
  location_id: string | null;
  active: number;
  created_at: string;
}

export interface SchedulingAppointmentTypeRow {
  id: string;
  tenant_id: string;
  name: string;
  duration_minutes: number;
  /** Idle padding blocked before/after appointments of this type. */
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  active: number;
  created_at: string;
}

/** Recurring weekly availability for a staff member or resource. */
export interface SchedulingAvailabilityWindowRow {
  id: string;
  tenant_id: string;
  owner_type: OwnerType;
  owner_id: string;
  /** ISO weekday: 1 = Monday … 7 = Sunday (luxon convention). */
  weekday: number;
  /** "HH:MM" local wall-clock time (interpreted in the query timezone). */
  start_time: string;
  end_time: string;
  created_at: string;
}

/** A dated exception to the weekly windows (time off, or extra hours). */
export interface SchedulingAvailabilityExceptionRow {
  id: string;
  tenant_id: string;
  owner_type: OwnerType;
  owner_id: string;
  /** "YYYY-MM-DD" local date. */
  date: string;
  /** 1 = extra availability on this date, 0 = unavailable. */
  available: number;
  /** "HH:MM"; both null on available=0 means the whole day is off. */
  start_time: string | null;
  end_time: string | null;
  reason: string | null;
  created_at: string;
}

/** RRULE-lite recurrence rule; occurrences are materialized as appointments. */
export interface SchedulingScheduleRuleRow {
  id: string;
  tenant_id: string;
  frequency: RecurrenceFrequency;
  /** Every N days/weeks/months. */
  interval: number;
  /** Number of occurrences, mutually exclusive with until. */
  count: number | null;
  /** ISO-8601 UTC inclusive end bound, mutually exclusive with count. */
  until: string | null;
  created_at: string;
}

export interface SchedulingAppointmentRow {
  id: string;
  tenant_id: string;
  calendar_id: string;
  appointment_type_id: string | null;
  /** Cross-module reference (e.g. crm customer id) — id string only. */
  customer_id: string | null;
  location_id: string | null;
  title: string;
  status: AppointmentStatus;
  /** ISO-8601 UTC. */
  starts_at: string;
  ends_at: string;
  /** Internal notes — never exposed in ICS export. */
  notes: string | null;
  canceled_reason: string | null;
  /** Set when this row is a materialized occurrence of a schedule rule. */
  schedule_rule_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Staff assignment (many-to-many). */
export interface SchedulingAppointmentStaffRow {
  id: string;
  tenant_id: string;
  appointment_id: string;
  staff_id: string;
  created_at: string;
}

/** Resource assignment (many-to-many). */
export interface SchedulingAppointmentResourceRow {
  id: string;
  tenant_id: string;
  appointment_id: string;
  resource_id: string;
  created_at: string;
}

export interface SchedulingReminderRow {
  id: string;
  tenant_id: string;
  appointment_id: string;
  /** ISO-8601 UTC — when the reminder should be delivered. */
  send_at: string;
  /** e.g. "email" | "sms" | "portal" — free text, provider decides. */
  channel: string;
  /** Address for the channel (email address, phone, portal id). */
  recipient: string;
  message: string | null;
  status: ReminderStatus;
  sent_at: string | null;
  /** Name of the provider that delivered it. */
  provider: string | null;
  created_at: string;
}

export interface SchedulingDatabase extends CoreDatabase {
  scheduling_calendars: SchedulingCalendarRow;
  scheduling_locations: SchedulingLocationRow;
  scheduling_staff_members: SchedulingStaffMemberRow;
  scheduling_resources: SchedulingResourceRow;
  scheduling_appointment_types: SchedulingAppointmentTypeRow;
  scheduling_availability_windows: SchedulingAvailabilityWindowRow;
  scheduling_availability_exceptions: SchedulingAvailabilityExceptionRow;
  scheduling_schedule_rules: SchedulingScheduleRuleRow;
  scheduling_appointments: SchedulingAppointmentRow;
  scheduling_appointment_staff: SchedulingAppointmentStaffRow;
  scheduling_appointment_resources: SchedulingAppointmentResourceRow;
  scheduling_reminders: SchedulingReminderRow;
}
