/**
 * Scheduling business logic. Every function is tenant-scoped, audits its
 * mutations, and emits domain events AFTER the DB write succeeds.
 *
 * Timezone model: all stored timestamps are ISO-8601 UTC. Calendars carry an
 * IANA timezone; inputs may supply local wall-clock times plus a `timezone`
 * which luxon converts to UTC at the boundary.
 */
import type { Kysely } from 'kysely';
import { DateTime, IANAZone } from 'luxon';
import {
  ApiError,
  audit,
  asCoreDb,
  id,
  nowIso,
  type CreateAppointmentContract,
  type CreateAppointmentInput,
  type CreateAppointmentTypeContract,
  type CreateAppointmentTypeInput,
  type EventBus,
} from '@blacklabel/core';
import type {
  AppointmentStatus,
  OwnerType,
  RecurrenceFrequency,
  ReminderStatus,
  SchedulingAppointmentRow,
  SchedulingAppointmentTypeRow,
  SchedulingAvailabilityExceptionRow,
  SchedulingAvailabilityWindowRow,
  SchedulingCalendarRow,
  SchedulingDatabase,
  SchedulingLocationRow,
  SchedulingReminderRow,
  SchedulingResourceRow,
  SchedulingScheduleRuleRow,
  SchedulingStaffMemberRow,
} from './schema';

/* ------------------------------------------------------------------ *
 * Integration providers (Google-Calendar-ready layer + reminder stub)
 * ------------------------------------------------------------------ */

/** Snapshot of an appointment pushed to an external calendar provider. */
export interface ExternalEventInput {
  tenantId: string;
  calendarId: string;
  appointmentId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
}

/**
 * External calendar sync layer. A real Google Calendar implementation would
 * map calendars/appointments to Google events; the platform ships the no-op
 * stub. Provider failures are best-effort and never break the mutation.
 */
export interface ExternalCalendarProvider {
  readonly name: string;
  upsertEvent(event: ExternalEventInput): Promise<{ externalId: string | null }>;
  deleteEvent(ref: { tenantId: string; calendarId: string; appointmentId: string }): Promise<void>;
}

/** Fail-closed stub — records calls in memory but never claims external delivery. */
export class NoopExternalCalendarProvider implements ExternalCalendarProvider {
  readonly name = 'noop';
  readonly upserts: ExternalEventInput[] = [];
  readonly deletes: { tenantId: string; calendarId: string; appointmentId: string }[] = [];

  async upsertEvent(event: ExternalEventInput): Promise<{ externalId: string | null }> {
    this.upserts.push(event);
    throw new Error('external calendar provider is not configured');
  }

  async deleteEvent(ref: { tenantId: string; calendarId: string; appointmentId: string }): Promise<void> {
    this.deletes.push(ref);
    throw new Error('external calendar provider is not configured');
  }
}

export interface ReminderDeliveryInput {
  tenantId: string;
  reminderId: string;
  appointmentId: string;
  channel: string;
  recipient: string;
  message: string | null;
  sendAt: string;
  deliveryReference?: string | null;
}

export interface ReminderDeliveryResult {
  delivered: boolean;
  detail?: string;
  state?: 'submitted' | 'failed' | 'review';
  deliveryReference?: string;
}

/** Delivery transport for customer reminders (email/sms/...). */
export interface ReminderDeliveryProvider {
  readonly name: string;
  /** A repeated reminder id only reconciles its existing operation. */
  readonly durableOperations?: boolean;
  deliver(input: ReminderDeliveryInput): Promise<ReminderDeliveryResult>;
}

/** Fail-closed stub transport: records attempts but never claims delivery. */
export class StubReminderProvider implements ReminderDeliveryProvider {
  readonly name = 'stub';
  readonly deliveries: ReminderDeliveryInput[] = [];

  async deliver(input: ReminderDeliveryInput): Promise<{ delivered: boolean; detail: string }> {
    this.deliveries.push(input);
    return { delivered: false, detail: 'reminder delivery provider is not configured' };
  }
}

/* ------------------------------------------------------------------ *
 * Context
 * ------------------------------------------------------------------ */

export interface SchedulingCtx {
  db: Kysely<SchedulingDatabase>;
  events: EventBus;
  calendarSync: ExternalCalendarProvider;
  reminderDelivery: ReminderDeliveryProvider;
}

export function createSchedulingContext(deps: {
  db: Kysely<SchedulingDatabase>;
  events: EventBus;
  calendarSync?: ExternalCalendarProvider;
  reminderDelivery?: ReminderDeliveryProvider;
}): SchedulingCtx {
  return {
    db: deps.db,
    events: deps.events,
    calendarSync: deps.calendarSync ?? new NoopExternalCalendarProvider(),
    reminderDelivery: deps.reminderDelivery ?? new StubReminderProvider(),
  };
}

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_OCCURRENCES = 100;

export const ACTIVE_STATUSES: readonly AppointmentStatus[] = ['requested', 'confirmed'];

export const STATUS_TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  requested: ['confirmed', 'canceled'],
  confirmed: ['completed', 'canceled', 'no_show'],
  completed: [],
  canceled: [],
  no_show: [],
};

function assertZone(zone: string): void {
  if (!IANAZone.isValidZone(zone)) {
    throw ApiError.badRequest(`invalid IANA timezone: "${zone}"`);
  }
}

/**
 * Parse an incoming timestamp to a stored UTC ISO string. If the value has
 * no explicit offset, it is interpreted in `zone` (wall-clock time there).
 */
export function toUtcIso(value: string, zone = 'utc'): string {
  if (zone !== 'utc') assertZone(zone);
  const dt = DateTime.fromISO(value, { zone });
  if (!dt.isValid) {
    throw ApiError.badRequest(`invalid ISO-8601 timestamp: "${value}"`);
  }
  return dt.toUTC().toISO()!;
}

function ms(iso: string): number {
  return DateTime.fromISO(iso).toMillis();
}

interface Interval {
  start: number;
  end: number;
}

function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const iv of sorted) {
    if (iv.end <= iv.start) continue;
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) {
      last.end = Math.max(last.end, iv.end);
    } else {
      out.push({ ...iv });
    }
  }
  return out;
}

function subtractIntervals(base: Interval[], remove: Interval[]): Interval[] {
  let current = mergeIntervals(base);
  for (const r of mergeIntervals(remove)) {
    const next: Interval[] = [];
    for (const b of current) {
      if (r.end <= b.start || r.start >= b.end) {
        next.push(b);
        continue;
      }
      if (r.start > b.start) next.push({ start: b.start, end: r.start });
      if (r.end < b.end) next.push({ start: r.end, end: b.end });
    }
    current = next;
  }
  return current;
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && a.end > b.start;
}

function dedupe(ids: readonly string[] | undefined): string[] {
  return [...new Set(ids ?? [])];
}

export interface SchedulingReadinessConfig {
  expected_staff_count: number;
}

export interface SchedulingReadinessResult {
  expected_staff_count: number;
  active_staff_count: number;
}

/** Startup/readiness invariant for a configured tenant; never guesses staff identities. */
export async function assertExpectedActiveStaffCount(
  db: Kysely<SchedulingDatabase>,
  tenantId: string,
  config: SchedulingReadinessConfig,
): Promise<SchedulingReadinessResult> {
  if (!Number.isInteger(config.expected_staff_count) || config.expected_staff_count < 1) {
    throw ApiError.badRequest('expected_staff_count must be a positive integer');
  }
  const count = await db
    .selectFrom('scheduling_staff_members')
    .select(db.fn.countAll<number>().as('n'))
    .where('tenant_id', '=', tenantId)
    .where('active', '=', 1)
    .executeTakeFirstOrThrow();
  const active_staff_count = Number(count.n);
  if (active_staff_count !== config.expected_staff_count) {
    throw ApiError.conflict('scheduling staff readiness check failed', {
      expected_staff_count: config.expected_staff_count,
      active_staff_count,
    });
  }
  return { expected_staff_count: config.expected_staff_count, active_staff_count };
}

/* ------------------------------------------------------------------ *
 * Calendars
 * ------------------------------------------------------------------ */

export interface CalendarInput {
  name: string;
  timezone?: string;
  description?: string;
}

export async function createCalendar(
  ctx: SchedulingCtx,
  tenantId: string,
  input: CalendarInput,
  actor = 'system',
): Promise<SchedulingCalendarRow> {
  const timezone = input.timezone ?? 'UTC';
  assertZone(timezone);
  const now = nowIso();
  const row: SchedulingCalendarRow = {
    id: id(),
    tenant_id: tenantId,
    name: input.name.trim(),
    timezone,
    description: input.description ?? null,
    created_at: now,
    updated_at: now,
  };
  if (!row.name) throw ApiError.badRequest('calendar name is required');
  await ctx.db.insertInto('scheduling_calendars').values(row).execute();
  await audit(asCoreDb(ctx.db), tenantId, actor, 'scheduling.calendar.created', 'scheduling.calendar', row.id, { name: row.name });
  return row;
}

export async function getCalendar(
  ctx: SchedulingCtx,
  tenantId: string,
  calendarId: string,
): Promise<SchedulingCalendarRow> {
  const row = await ctx.db
    .selectFrom('scheduling_calendars')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', calendarId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`calendar not found: ${calendarId}`);
  return row;
}

export async function listCalendars(
  ctx: SchedulingCtx,
  tenantId: string,
  page = { limit: 50, offset: 0 },
): Promise<SchedulingCalendarRow[]> {
  return ctx.db
    .selectFrom('scheduling_calendars')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export async function updateCalendar(
  ctx: SchedulingCtx,
  tenantId: string,
  calendarId: string,
  patch: Partial<CalendarInput>,
  actor = 'system',
): Promise<SchedulingCalendarRow> {
  await getCalendar(ctx, tenantId, calendarId);
  const set: Partial<SchedulingCalendarRow> = { updated_at: nowIso() };
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw ApiError.badRequest('calendar name cannot be blank');
    set.name = patch.name.trim();
  }
  if (patch.timezone !== undefined) {
    assertZone(patch.timezone);
    set.timezone = patch.timezone;
  }
  if (patch.description !== undefined) set.description = patch.description;
  await ctx.db
    .updateTable('scheduling_calendars')
    .set(set)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', calendarId)
    .execute();
  await audit(asCoreDb(ctx.db), tenantId, actor, 'scheduling.calendar.updated', 'scheduling.calendar', calendarId, patch);
  return getCalendar(ctx, tenantId, calendarId);
}

export async function deleteCalendar(
  ctx: SchedulingCtx,
  tenantId: string,
  calendarId: string,
  actor = 'system',
): Promise<void> {
  const appointmentCount = await ctx.db
    .selectFrom('scheduling_appointments')
    .select(ctx.db.fn.countAll<number>().as('n'))
    .where('tenant_id', '=', tenantId)
    .where('calendar_id', '=', calendarId)
    .executeTakeFirst();
  if (appointmentCount && Number(appointmentCount.n) > 0) {
    throw ApiError.conflict('calendar has appointments; cancel/move them first');
  }
  const result = await ctx.db
    .deleteFrom('scheduling_calendars')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', calendarId)
    .executeTakeFirst();
  if (result.numDeletedRows === 0n) throw ApiError.notFound(`calendar not found: ${calendarId}`);
  await audit(asCoreDb(ctx.db), tenantId, actor, 'scheduling.calendar.deleted', 'scheduling.calendar', calendarId);
}

/* ------------------------------------------------------------------ *
 * Locations
 * ------------------------------------------------------------------ */

export interface LocationInput {
  name: string;
  address?: string;
  timezone?: string;
}

export async function createLocation(
  ctx: SchedulingCtx,
  tenantId: string,
  input: LocationInput,
  actor = 'system',
): Promise<SchedulingLocationRow> {
  if (!input.name.trim()) throw ApiError.badRequest('location name is required');
  if (input.timezone !== undefined) assertZone(input.timezone);
  const row: SchedulingLocationRow = {
    id: id(),
    tenant_id: tenantId,
    name: input.name.trim(),
    address: input.address ?? null,
    timezone: input.timezone ?? null,
    created_at: nowIso(),
  };
  await ctx.db.insertInto('scheduling_locations').values(row).execute();
  await audit(asCoreDb(ctx.db), tenantId, actor, 'scheduling.location.created', 'scheduling.location', row.id, { name: row.name });
  return row;
}

export async function getLocation(
  ctx: SchedulingCtx,
  tenantId: string,
  locationId: string,
): Promise<SchedulingLocationRow> {
  const row = await ctx.db
    .selectFrom('scheduling_locations')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', locationId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`location not found: ${locationId}`);
  return row;
}

export async function listLocations(
  ctx: SchedulingCtx,
  tenantId: string,
  page = { limit: 50, offset: 0 },
): Promise<SchedulingLocationRow[]> {
  return ctx.db
    .selectFrom('scheduling_locations')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('name')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export async function deleteLocation(
  ctx: SchedulingCtx,
  tenantId: string,
  locationId: string,
  actor = 'system',
): Promise<void> {
  const result = await ctx.db
    .deleteFrom('scheduling_locations')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', locationId)
    .executeTakeFirst();
  if (result.numDeletedRows === 0n) throw ApiError.notFound(`location not found: ${locationId}`);
  await audit(asCoreDb(ctx.db), tenantId, actor, 'scheduling.location.deleted', 'scheduling.location', locationId);
}

/* ------------------------------------------------------------------ *
 * Staff members
 * ------------------------------------------------------------------ */

export interface StaffInput {
  name: string;
  email?: string;
  userId?: string;
  active?: boolean;
}

export async function createStaffMember(
  ctx: SchedulingCtx,
  tenantId: string,
  input: StaffInput,
  actor = 'system',
): Promise<SchedulingStaffMemberRow> {
  if (!input.name.trim()) throw ApiError.badRequest('staff name is required');
  const row: SchedulingStaffMemberRow = {
    id: id(),
    tenant_id: tenantId,
    name: input.name.trim(),
    email: input.email ?? null,
    user_id: input.userId ?? null,
    active: input.active === false ? 0 : 1,
    created_at: nowIso(),
  };
  await ctx.db.insertInto('scheduling_staff_members').values(row).execute();
  await audit(asCoreDb(ctx.db), tenantId, actor, 'scheduling.staff.created', 'scheduling.staff', row.id, { name: row.name });
  return row;
}

export async function getStaffMember(
  ctx: SchedulingCtx,
  tenantId: string,
  staffId: string,
): Promise<SchedulingStaffMemberRow> {
  const row = await ctx.db
    .selectFrom('scheduling_staff_members')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', staffId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`staff member not found: ${staffId}`);
  return row;
}

export async function listStaffMembers(
  ctx: SchedulingCtx,
  tenantId: string,
  page = { limit: 50, offset: 0 },
): Promise<SchedulingStaffMemberRow[]> {
  return ctx.db
    .selectFrom('scheduling_staff_members')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('name')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export async function updateStaffMember(
  ctx: SchedulingCtx,
  tenantId: string,
  staffId: string,
  patch: Partial<StaffInput>,
  actor = 'system',
): Promise<SchedulingStaffMemberRow> {
  await getStaffMember(ctx, tenantId, staffId);
  const set: Partial<SchedulingStaffMemberRow> = {};
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw ApiError.badRequest('staff name cannot be blank');
    set.name = patch.name.trim();
  }
  if (patch.email !== undefined) set.email = patch.email;
  if (patch.userId !== undefined) set.user_id = patch.userId;
  if (patch.active !== undefined) set.active = patch.active ? 1 : 0;
  if (Object.keys(set).length > 0) {
    await ctx.db
      .updateTable('scheduling_staff_members')
      .set(set)
      .where('tenant_id', '=', tenantId)
      .where('id', '=', staffId)
      .execute();
  }
  await audit(asCoreDb(ctx.db), tenantId, actor, 'scheduling.staff.updated', 'scheduling.staff', staffId, patch);
  return getStaffMember(ctx, tenantId, staffId);
}

export async function deleteStaffMember(
  ctx: SchedulingCtx,
  tenantId: string,
  staffId: string,
  actor = 'system',
): Promise<void> {
  const result = await ctx.db
    .deleteFrom('scheduling_staff_members')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', staffId)
    .executeTakeFirst();
  if (result.numDeletedRows === 0n) throw ApiError.notFound(`staff member not found: ${staffId}`);
  await audit(asCoreDb(ctx.db), tenantId, actor, 'scheduling.staff.deleted', 'scheduling.staff', staffId);
}

/* ------------------------------------------------------------------ *
 * Resources
 * ------------------------------------------------------------------ */

export interface ResourceInput {
  name: string;
  kind?: string;
  locationId?: string;
  active?: boolean;
}

export async function createResource(
  ctx: SchedulingCtx,
  tenantId: string,
  input: ResourceInput,
  actor = 'system',
): Promise<SchedulingResourceRow> {
  if (!input.name.trim()) throw ApiError.badRequest('resource name is required');
  if (input.locationId !== undefined) await getLocation(ctx, tenantId, input.locationId);
  const row: SchedulingResourceRow = {
    id: id(),
    tenant_id: tenantId,
    name: input.name.trim(),
    kind: input.kind ?? null,
    location_id: input.locationId ?? null,
    active: input.active === false ? 0 : 1,
    created_at: nowIso(),
  };
  await ctx.db.insertInto('scheduling_resources').values(row).execute();
  await audit(asCoreDb(ctx.db), tenantId, actor, 'scheduling.resource.created', 'scheduling.resource', row.id, { name: row.name });
  return row;
}

export async function getResource(
  ctx: SchedulingCtx,
  tenantId: string,
  resourceId: string,
): Promise<SchedulingResourceRow> {
  const row = await ctx.db
    .selectFrom('scheduling_resources')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', resourceId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`resource not found: ${resourceId}`);
  return row;
}

export async function listResources(
  ctx: SchedulingCtx,
  tenantId: string,
  page = { limit: 50, offset: 0 },
): Promise<SchedulingResourceRow[]> {
  return ctx.db
    .selectFrom('scheduling_resources')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('name')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export async function deleteResource(
  ctx: SchedulingCtx,
  tenantId: string,
  resourceId: string,
  actor = 'system',
): Promise<void> {
  const result = await ctx.db
    .deleteFrom('scheduling_resources')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', resourceId)
    .executeTakeFirst();
  if (result.numDeletedRows === 0n) throw ApiError.notFound(`resource not found: ${resourceId}`);
  await audit(asCoreDb(ctx.db), tenantId, actor, 'scheduling.resource.deleted', 'scheduling.resource', resourceId);
}

/* ------------------------------------------------------------------ *
 * Appointment types
 * ------------------------------------------------------------------ */

export interface AppointmentTypeInput {
  name: string;
  durationMinutes: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  active?: boolean;
}

export async function createAppointmentType(
  ctx: SchedulingCtx,
  tenantId: string,
  input: AppointmentTypeInput,
  actor = 'system',
): Promise<SchedulingAppointmentTypeRow> {
  if (!input.name.trim()) throw ApiError.badRequest('appointment type name is required');
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes <= 0) {
    throw ApiError.badRequest('durationMinutes must be a positive integer');
  }
  const row: SchedulingAppointmentTypeRow = {
    id: id(),
    tenant_id: tenantId,
    name: input.name.trim(),
    duration_minutes: input.durationMinutes,
    buffer_before_minutes: input.bufferBeforeMinutes ?? 0,
    buffer_after_minutes: input.bufferAfterMinutes ?? 0,
    active: input.active === false ? 0 : 1,
    created_at: nowIso(),
  };
  await ctx.db.insertInto('scheduling_appointment_types').values(row).execute();
  await audit(asCoreDb(ctx.db), tenantId, actor, 'scheduling.appointment_type.created', 'scheduling.appointment_type', row.id, { name: row.name });
  return row;
}

export async function getAppointmentType(
  ctx: SchedulingCtx,
  tenantId: string,
  typeId: string,
): Promise<SchedulingAppointmentTypeRow> {
  const row = await ctx.db
    .selectFrom('scheduling_appointment_types')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', typeId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`appointment type not found: ${typeId}`);
  return row;
}

export async function listAppointmentTypes(
  ctx: SchedulingCtx,
  tenantId: string,
  page = { limit: 50, offset: 0 },
): Promise<SchedulingAppointmentTypeRow[]> {
  return ctx.db
    .selectFrom('scheduling_appointment_types')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('name')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export async function deleteAppointmentType(
  ctx: SchedulingCtx,
  tenantId: string,
  typeId: string,
  actor = 'system',
): Promise<void> {
  const result = await ctx.db
    .deleteFrom('scheduling_appointment_types')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', typeId)
    .executeTakeFirst();
  if (result.numDeletedRows === 0n) throw ApiError.notFound(`appointment type not found: ${typeId}`);
  await audit(asCoreDb(ctx.db), tenantId, actor, 'scheduling.appointment_type.deleted', 'scheduling.appointment_type', typeId);
}

/* ------------------------------------------------------------------ *
 * Availability windows + exceptions
 * ------------------------------------------------------------------ */

async function assertOwner(ctx: SchedulingCtx, tenantId: string, ownerType: OwnerType, ownerId: string): Promise<void> {
  if (ownerType === 'staff') {
    const staff = await getStaffMember(ctx, tenantId, ownerId);
    if (staff.active !== 1) throw ApiError.conflict(`staff member is inactive: ${ownerId}`);
  } else {
    const resource = await getResource(ctx, tenantId, ownerId);
    if (resource.active !== 1) throw ApiError.conflict(`resource is inactive: ${ownerId}`);
  }
}

export interface AvailabilityWindowInput {
  ownerType: OwnerType;
  ownerId: string;
  /** 1 = Monday … 7 = Sunday. */
  weekday: number;
  startTime: string;
  endTime: string;
}

export async function createAvailabilityWindow(
  ctx: SchedulingCtx,
  tenantId: string,
  input: AvailabilityWindowInput,
  actor = 'system',
): Promise<SchedulingAvailabilityWindowRow> {
  await assertOwner(ctx, tenantId, input.ownerType, input.ownerId);
  if (!Number.isInteger(input.weekday) || input.weekday < 1 || input.weekday > 7) {
    throw ApiError.badRequest('weekday must be 1 (Monday) … 7 (Sunday)');
  }
  if (!TIME_RE.test(input.startTime) || !TIME_RE.test(input.endTime)) {
    throw ApiError.badRequest('startTime/endTime must be "HH:MM" 24h');
  }
  if (input.startTime >= input.endTime) {
    throw ApiError.badRequest('startTime must be before endTime');
  }
  const row: SchedulingAvailabilityWindowRow = {
    id: id(),
    tenant_id: tenantId,
    owner_type: input.ownerType,
    owner_id: input.ownerId,
    weekday: input.weekday,
    start_time: input.startTime,
    end_time: input.endTime,
    created_at: nowIso(),
  };
  await ctx.db.insertInto('scheduling_availability_windows').values(row).execute();
  await audit(asCoreDb(ctx.db), tenantId, actor, 'scheduling.availability_window.created', 'scheduling.availability_window', row.id, input);
  return row;
}

export async function listAvailabilityWindows(
  ctx: SchedulingCtx,
  tenantId: string,
  filter: { ownerType?: OwnerType; ownerId?: string } = {},
): Promise<SchedulingAvailabilityWindowRow[]> {
  let q = ctx.db
    .selectFrom('scheduling_availability_windows')
    .selectAll()
    .where('tenant_id', '=', tenantId);
  if (filter.ownerType) q = q.where('owner_type', '=', filter.ownerType);
  if (filter.ownerId) q = q.where('owner_id', '=', filter.ownerId);
  return q.orderBy('weekday').orderBy('start_time').orderBy('id').execute();
}

export async function deleteAvailabilityWindow(
  ctx: SchedulingCtx,
  tenantId: string,
  windowId: string,
  actor = 'system',
): Promise<void> {
  const result = await ctx.db
    .deleteFrom('scheduling_availability_windows')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', windowId)
    .executeTakeFirst();
  if (result.numDeletedRows === 0n) throw ApiError.notFound(`availability window not found: ${windowId}`);
  await audit(asCoreDb(ctx.db), tenantId, actor, 'scheduling.availability_window.deleted', 'scheduling.availability_window', windowId);
}

export interface AvailabilityExceptionInput {
  ownerType: OwnerType;
  ownerId: string;
  date: string;
  available: boolean;
  startTime?: string;
  endTime?: string;
  reason?: string;
}

export async function createAvailabilityException(
  ctx: SchedulingCtx,
  tenantId: string,
  input: AvailabilityExceptionInput,
  actor = 'system',
): Promise<SchedulingAvailabilityExceptionRow> {
  await assertOwner(ctx, tenantId, input.ownerType, input.ownerId);
  if (!DATE_RE.test(input.date)) throw ApiError.badRequest('date must be "YYYY-MM-DD"');
  const hasTimes = input.startTime !== undefined || input.endTime !== undefined;
  if (hasTimes) {
    if (
      input.startTime === undefined ||
      input.endTime === undefined ||
      !TIME_RE.test(input.startTime) ||
      !TIME_RE.test(input.endTime) ||
      input.startTime >= input.endTime
    ) {
      throw ApiError.badRequest('startTime/endTime must both be "HH:MM" with startTime < endTime');
    }
  }
  if (input.available && !hasTimes) {
    throw ApiError.badRequest('an available=true exception requires startTime and endTime');
  }
  const row: SchedulingAvailabilityExceptionRow = {
    id: id(),
    tenant_id: tenantId,
    owner_type: input.ownerType,
    owner_id: input.ownerId,
    date: input.date,
    available: input.available ? 1 : 0,
    start_time: input.startTime ?? null,
    end_time: input.endTime ?? null,
    reason: input.reason ?? null,
    created_at: nowIso(),
  };
  await ctx.db.insertInto('scheduling_availability_exceptions').values(row).execute();
  await audit(asCoreDb(ctx.db), tenantId, actor, 'scheduling.availability_exception.created', 'scheduling.availability_exception', row.id, input);
  return row;
}

export async function listAvailabilityExceptions(
  ctx: SchedulingCtx,
  tenantId: string,
  filter: { ownerType?: OwnerType; ownerId?: string; date?: string } = {},
): Promise<SchedulingAvailabilityExceptionRow[]> {
  let q = ctx.db
    .selectFrom('scheduling_availability_exceptions')
    .selectAll()
    .where('tenant_id', '=', tenantId);
  if (filter.ownerType) q = q.where('owner_type', '=', filter.ownerType);
  if (filter.ownerId) q = q.where('owner_id', '=', filter.ownerId);
  if (filter.date) q = q.where('date', '=', filter.date);
  return q.orderBy('date').orderBy('id').execute();
}

export async function deleteAvailabilityException(
  ctx: SchedulingCtx,
  tenantId: string,
  exceptionId: string,
  actor = 'system',
): Promise<void> {
  const result = await ctx.db
    .deleteFrom('scheduling_availability_exceptions')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', exceptionId)
    .executeTakeFirst();
  if (result.numDeletedRows === 0n) throw ApiError.notFound(`availability exception not found: ${exceptionId}`);
  await audit(asCoreDb(ctx.db), tenantId, actor, 'scheduling.availability_exception.deleted', 'scheduling.availability_exception', exceptionId);
}

/* ------------------------------------------------------------------ *
 * Conflict detection
 * ------------------------------------------------------------------ */

export interface ConflictDetail {
  owner_type: OwnerType;
  owner_id: string;
  appointment_id: string;
  starts_at: string;
  ends_at: string;
}

interface ConflictQuery {
  startsAt: string;
  endsAt: string;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  staffIds: string[];
  resourceIds: string[];
  excludeAppointmentId?: string;
}

/** Slack around the candidate window so other appointments' buffers are caught. */
const CONFLICT_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * Find staff/resource double-bookings for a candidate time slot. Buffers on
 * both the candidate (its type) and existing appointments (their types) count
 * as blocked time. Only `requested`/`confirmed` appointments block.
 */
export async function findConflicts(
  ctx: SchedulingCtx,
  tenantId: string,
  q: ConflictQuery,
): Promise<ConflictDetail[]> {
  const candidate: Interval = {
    start: ms(q.startsAt) - q.bufferBeforeMinutes * 60_000,
    end: ms(q.endsAt) + q.bufferAfterMinutes * 60_000,
  };
  const windowStart = new Date(candidate.start - CONFLICT_SLACK_MS).toISOString();
  const windowEnd = new Date(candidate.end + CONFLICT_SLACK_MS).toISOString();

  interface Hit {
    owner_id: string;
    appointment_id: string;
    starts_at: string;
    ends_at: string;
    appointment_type_id: string | null;
  }

  const staffHits: Hit[] =
    q.staffIds.length === 0
      ? []
      : await (() => {
          let query = ctx.db
            .selectFrom('scheduling_appointment_staff as asg')
            .innerJoin('scheduling_appointments as a', 'a.id', 'asg.appointment_id')
            .select([
              'asg.staff_id as owner_id',
              'a.id as appointment_id',
              'a.starts_at',
              'a.ends_at',
              'a.appointment_type_id',
            ])
            .where('asg.tenant_id', '=', tenantId)
            .where('a.tenant_id', '=', tenantId)
            .where('asg.staff_id', 'in', q.staffIds)
            .where('a.status', 'in', [...ACTIVE_STATUSES])
            .where('a.starts_at', '<', windowEnd)
            .where('a.ends_at', '>', windowStart);
          if (q.excludeAppointmentId) query = query.where('a.id', '!=', q.excludeAppointmentId);
          return query.orderBy('a.starts_at').orderBy('a.id').execute();
        })();

  const resourceHits: Hit[] =
    q.resourceIds.length === 0
      ? []
      : await (() => {
          let query = ctx.db
            .selectFrom('scheduling_appointment_resources as asg')
            .innerJoin('scheduling_appointments as a', 'a.id', 'asg.appointment_id')
            .select([
              'asg.resource_id as owner_id',
              'a.id as appointment_id',
              'a.starts_at',
              'a.ends_at',
              'a.appointment_type_id',
            ])
            .where('asg.tenant_id', '=', tenantId)
            .where('a.tenant_id', '=', tenantId)
            .where('asg.resource_id', 'in', q.resourceIds)
            .where('a.status', 'in', [...ACTIVE_STATUSES])
            .where('a.starts_at', '<', windowEnd)
            .where('a.ends_at', '>', windowStart);
          if (q.excludeAppointmentId) query = query.where('a.id', '!=', q.excludeAppointmentId);
          return query.orderBy('a.starts_at').orderBy('a.id').execute();
        })();

  const typeIds = dedupe(
    [...staffHits, ...resourceHits]
      .map((h) => h.appointment_type_id)
      .filter((t): t is string => t !== null),
  );
  const typeBuffers = new Map<string, { before: number; after: number }>();
  if (typeIds.length > 0) {
    const types = await ctx.db
      .selectFrom('scheduling_appointment_types')
      .select(['id', 'buffer_before_minutes', 'buffer_after_minutes'])
      .where('tenant_id', '=', tenantId)
      .where('id', 'in', typeIds)
      .execute();
    for (const t of types) {
      typeBuffers.set(t.id, { before: t.buffer_before_minutes, after: t.buffer_after_minutes });
    }
  }

  const conflicts: ConflictDetail[] = [];
  const collect = (hits: Hit[], ownerType: OwnerType) => {
    for (const hit of hits) {
      const buf = (hit.appointment_type_id && typeBuffers.get(hit.appointment_type_id)) || {
        before: 0,
        after: 0,
      };
      const blocked: Interval = {
        start: ms(hit.starts_at) - buf.before * 60_000,
        end: ms(hit.ends_at) + buf.after * 60_000,
      };
      if (overlaps(candidate, blocked)) {
        conflicts.push({
          owner_type: ownerType,
          owner_id: hit.owner_id,
          appointment_id: hit.appointment_id,
          starts_at: hit.starts_at,
          ends_at: hit.ends_at,
        });
      }
    }
  };
  collect(staffHits, 'staff');
  collect(resourceHits, 'resource');
  return conflicts;
}

/* ------------------------------------------------------------------ *
 * Recurrence (RRULE-lite)
 * ------------------------------------------------------------------ */

export interface RecurrenceInput {
  frequency: RecurrenceFrequency;
  interval?: number;
  count?: number;
  /** Inclusive last-start bound; interpreted in the appointment timezone if no offset. */
  until?: string;
}

/**
 * Materialize occurrence times. Steps in the given zone so weekly/monthly
 * recurrences keep their wall-clock time across DST transitions.
 */
export function materializeOccurrences(
  startUtcIso: string,
  endUtcIso: string,
  rule: Required<Pick<RecurrenceInput, 'frequency' | 'interval'>> & Pick<RecurrenceInput, 'count' | 'until'>,
  zone: string,
): { starts_at: string; ends_at: string }[] {
  if (rule.count === undefined && rule.until === undefined) {
    throw ApiError.badRequest('recurrence requires either count or until');
  }
  if (rule.count !== undefined && rule.until !== undefined) {
    throw ApiError.badRequest('recurrence takes count OR until, not both');
  }
  if (rule.count !== undefined && (rule.count < 1 || rule.count > MAX_OCCURRENCES)) {
    throw ApiError.badRequest(`recurrence count must be 1..${MAX_OCCURRENCES}`);
  }
  const durationMs = ms(endUtcIso) - ms(startUtcIso);
  const untilMs = rule.until === undefined ? undefined : DateTime.fromISO(rule.until, { zone }).toMillis();
  if (rule.until !== undefined && Number.isNaN(untilMs)) {
    throw ApiError.badRequest(`invalid recurrence until: "${rule.until}"`);
  }

  const step =
    rule.frequency === 'daily'
      ? { days: rule.interval }
      : rule.frequency === 'weekly'
        ? { weeks: rule.interval }
        : { months: rule.interval };

  const out: { starts_at: string; ends_at: string }[] = [];
  let cursor = DateTime.fromISO(startUtcIso, { zone: 'utc' }).setZone(zone);
  for (let i = 0; i < MAX_OCCURRENCES; i++) {
    const startMs = cursor.toMillis();
    if (rule.count !== undefined && out.length >= rule.count) break;
    if (untilMs !== undefined && startMs > untilMs) break;
    out.push({
      starts_at: cursor.toUTC().toISO()!,
      ends_at: DateTime.fromMillis(startMs + durationMs, { zone: 'utc' }).toISO()!,
    });
    cursor = cursor.plus(step);
  }
  // An `until` bound that would keep going past the cap is rejected rather
  // than silently truncated (the stored rule must match what materialized).
  if (untilMs !== undefined && out.length === MAX_OCCURRENCES && cursor.toMillis() <= untilMs) {
    throw ApiError.badRequest(
      `recurrence until produces more than ${MAX_OCCURRENCES} occurrences; use a nearer until or count`,
    );
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Appointments
 * ------------------------------------------------------------------ */

export interface AppointmentWithAssignments extends SchedulingAppointmentRow {
  staff_ids: string[];
  resource_ids: string[];
}

export interface CreateAppointmentServiceInput {
  calendarId: string;
  title: string;
  appointmentTypeId?: string;
  customerId?: string;
  locationId?: string;
  startsAt: string;
  endsAt?: string;
  /** IANA zone used to interpret naive startsAt/endsAt; defaults to the calendar's zone. */
  timezone?: string;
  status?: 'requested' | 'confirmed';
  notes?: string;
  staffIds?: string[];
  resourceIds?: string[];
  recurrence?: RecurrenceInput;
}

async function attachAssignments(
  ctx: SchedulingCtx,
  tenantId: string,
  rows: SchedulingAppointmentRow[],
): Promise<AppointmentWithAssignments[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const staffRows = await ctx.db
    .selectFrom('scheduling_appointment_staff')
    .select(['appointment_id', 'staff_id'])
    .where('tenant_id', '=', tenantId)
    .where('appointment_id', 'in', ids)
    .orderBy('staff_id')
    .orderBy('id')
    .execute();
  const resourceRows = await ctx.db
    .selectFrom('scheduling_appointment_resources')
    .select(['appointment_id', 'resource_id'])
    .where('tenant_id', '=', tenantId)
    .where('appointment_id', 'in', ids)
    .orderBy('resource_id')
    .orderBy('id')
    .execute();
  const staffBy = new Map<string, string[]>();
  for (const r of staffRows) {
    const list = staffBy.get(r.appointment_id) ?? [];
    list.push(r.staff_id);
    staffBy.set(r.appointment_id, list);
  }
  const resourceBy = new Map<string, string[]>();
  for (const r of resourceRows) {
    const list = resourceBy.get(r.appointment_id) ?? [];
    list.push(r.resource_id);
    resourceBy.set(r.appointment_id, list);
  }
  return rows.map((row) => ({
    ...row,
    staff_ids: staffBy.get(row.id) ?? [],
    resource_ids: resourceBy.get(row.id) ?? [],
  }));
}

function providerErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function syncAppointment(ctx: SchedulingCtx, row: SchedulingAppointmentRow): Promise<void> {
  try {
    const result = await ctx.calendarSync.upsertEvent({
      tenantId: row.tenant_id,
      calendarId: row.calendar_id,
      appointmentId: row.id,
      title: row.title,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      status: row.status,
    });
    if (!result.externalId) {
      throw new Error(`calendar provider "${ctx.calendarSync.name}" returned no external event id`);
    }
    await ctx.db
      .updateTable('scheduling_appointments')
      .set({
        calendar_sync_status: 'synced',
        calendar_sync_error: null,
        calendar_external_id: result.externalId,
        calendar_synced_at: nowIso(),
      })
      .where('tenant_id', '=', row.tenant_id)
      .where('id', '=', row.id)
      .execute();
  } catch (error) {
    await ctx.db
      .updateTable('scheduling_appointments')
      .set({
        calendar_sync_status: 'failed',
        calendar_sync_error: providerErrorMessage(error),
        calendar_synced_at: null,
      })
      .where('tenant_id', '=', row.tenant_id)
      .where('id', '=', row.id)
      .execute();
  }
}

async function syncAppointmentDeletion(ctx: SchedulingCtx, row: SchedulingAppointmentRow): Promise<void> {
  try {
    await ctx.calendarSync.deleteEvent({
      tenantId: row.tenant_id,
      calendarId: row.calendar_id,
      appointmentId: row.id,
    });
    await ctx.db
      .updateTable('scheduling_appointments')
      .set({
        calendar_sync_status: 'synced',
        calendar_sync_error: null,
        calendar_external_id: null,
        calendar_synced_at: nowIso(),
      })
      .where('tenant_id', '=', row.tenant_id)
      .where('id', '=', row.id)
      .execute();
  } catch (error) {
    await ctx.db
      .updateTable('scheduling_appointments')
      .set({ calendar_sync_status: 'failed', calendar_sync_error: providerErrorMessage(error) })
      .where('tenant_id', '=', row.tenant_id)
      .where('id', '=', row.id)
      .execute();
  }
}

export async function createAppointment(
  ctx: SchedulingCtx,
  tenantId: string,
  input: CreateAppointmentServiceInput,
  actor = 'system',
  /** Internal composition hook; never parsed from a public appointment body. */
  admission?: (transaction: SchedulingCtx) => Promise<{ customerId: string }>,
): Promise<{ appointments: AppointmentWithAssignments[]; scheduleRule: SchedulingScheduleRuleRow | null }> {
  if (!input.title.trim()) throw ApiError.badRequest('title is required');
  const calendar = await getCalendar(ctx, tenantId, input.calendarId);
  const type = input.appointmentTypeId
    ? await getAppointmentType(ctx, tenantId, input.appointmentTypeId)
    : null;
  if (type && type.active !== 1) {
    throw ApiError.conflict(`appointment type is inactive: ${type.id}`);
  }
  if (input.locationId !== undefined) await getLocation(ctx, tenantId, input.locationId);
  const staffIds = dedupe(input.staffIds);
  const resourceIds = dedupe(input.resourceIds);
  for (const staffId of staffIds) {
    const staff = await getStaffMember(ctx, tenantId, staffId);
    if (staff.active !== 1) throw ApiError.conflict(`staff member is inactive: ${staffId}`);
  }
  for (const resourceId of resourceIds) {
    const resource = await getResource(ctx, tenantId, resourceId);
    if (resource.active !== 1) throw ApiError.conflict(`resource is inactive: ${resourceId}`);
  }

  const zone = input.timezone ?? calendar.timezone;
  const startsAt = toUtcIso(input.startsAt, zone);
  const endsAt = input.endsAt
    ? toUtcIso(input.endsAt, zone)
    : type
      ? DateTime.fromISO(startsAt, { zone: 'utc' }).plus({ minutes: type.duration_minutes }).toISO()!
      : null;
  if (endsAt === null) {
    throw ApiError.badRequest('endsAt is required when no appointmentTypeId provides a duration');
  }
  if (ms(endsAt) <= ms(startsAt)) throw ApiError.badRequest('endsAt must be after startsAt');

  const bufferBefore = type?.buffer_before_minutes ?? 0;
  const bufferAfter = type?.buffer_after_minutes ?? 0;

  // Occurrence times (single slot unless a recurrence rule is given).
  let occurrences: { starts_at: string; ends_at: string }[];
  let scheduleRule: SchedulingScheduleRuleRow | null = null;
  if (input.recurrence) {
    const interval = input.recurrence.interval ?? 1;
    if (!Number.isInteger(interval) || interval < 1) {
      throw ApiError.badRequest('recurrence interval must be a positive integer');
    }
    occurrences = materializeOccurrences(
      startsAt,
      endsAt,
      { frequency: input.recurrence.frequency, interval, count: input.recurrence.count, until: input.recurrence.until },
      zone,
    );
    if (occurrences.length === 0) throw ApiError.badRequest('recurrence produces no occurrences');
    scheduleRule = {
      id: id(),
      tenant_id: tenantId,
      frequency: input.recurrence.frequency,
      interval,
      count: input.recurrence.count ?? null,
      until: input.recurrence.until === undefined ? null : toUtcIso(input.recurrence.until, zone),
      created_at: nowIso(),
    };
  } else {
    occurrences = [{ starts_at: startsAt, ends_at: endsAt }];
  }

  if ((staffIds.length > 0 || resourceIds.length > 0) && occurrences.length > 1) {
    for (let i = 0; i < occurrences.length; i++) {
      for (let j = i + 1; j < occurrences.length; j++) {
        const a: Interval = {
          start: ms(occurrences[i].starts_at) - bufferBefore * 60_000,
          end: ms(occurrences[i].ends_at) + bufferAfter * 60_000,
        };
        const b: Interval = {
          start: ms(occurrences[j].starts_at) - bufferBefore * 60_000,
          end: ms(occurrences[j].ends_at) + bufferAfter * 60_000,
        };
        if (overlaps(a, b)) {
          throw ApiError.badRequest('recurrence occurrences overlap each other; widen the interval');
        }
      }
    }
  }
  // SQLite is the single-process source of truth. Keep conflict detection,
  // recurrence materialization, assignments, and audit rows in one serialized
  // transaction so parallel requests cannot both reserve the same owner/time.
  const created = await ctx.db.transaction().execute(async (trx) => {
    const txCtx: SchedulingCtx = { ...ctx, db: trx };
    const admitted = await admission?.(txCtx);
    const allConflicts: ConflictDetail[] = [];
    for (const occ of occurrences) {
      allConflicts.push(
        ...(await findConflicts(txCtx, tenantId, {
          startsAt: occ.starts_at,
          endsAt: occ.ends_at,
          bufferBeforeMinutes: bufferBefore,
          bufferAfterMinutes: bufferAfter,
          staffIds,
          resourceIds,
        })),
      );
    }
    if (allConflicts.length > 0) {
      throw ApiError.conflict('scheduling conflict: staff or resource is already booked', {
        conflicts: allConflicts,
      });
    }

    if (scheduleRule) {
      await trx.insertInto('scheduling_schedule_rules').values(scheduleRule).execute();
    }

    const rows: SchedulingAppointmentRow[] = [];
    for (const occ of occurrences) {
      const now = nowIso();
      const row: SchedulingAppointmentRow = {
        id: id(),
        tenant_id: tenantId,
        calendar_id: calendar.id,
        appointment_type_id: type?.id ?? null,
        customer_id: admitted?.customerId ?? input.customerId ?? null,
        location_id: input.locationId ?? null,
        title: input.title.trim(),
        status: input.status ?? 'confirmed',
        starts_at: occ.starts_at,
        ends_at: occ.ends_at,
        notes: input.notes ?? null,
        canceled_reason: null,
        schedule_rule_id: scheduleRule?.id ?? null,
        calendar_sync_status: 'pending',
        calendar_sync_error: null,
        calendar_external_id: null,
        calendar_synced_at: null,
        created_at: now,
        updated_at: now,
      };
      await trx.insertInto('scheduling_appointments').values(row).execute();
      for (const staffId of staffIds) {
        await trx
          .insertInto('scheduling_appointment_staff')
          .values({ id: id(), tenant_id: tenantId, appointment_id: row.id, staff_id: staffId, created_at: now })
          .execute();
      }
      for (const resourceId of resourceIds) {
        await trx
          .insertInto('scheduling_appointment_resources')
          .values({ id: id(), tenant_id: tenantId, appointment_id: row.id, resource_id: resourceId, created_at: now })
          .execute();
      }
      await audit(asCoreDb(trx), tenantId, actor, 'scheduling.appointment.created', 'scheduling.appointment', row.id, {
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        status: row.status,
      });
      rows.push(row);
    }
    return rows;
  });

  for (const row of created) {
    await ctx.events.emit(tenantId, 'scheduling.appointment.scheduled', {
      appointmentId: row.id,
      customerId: row.customer_id,
      startsAt: row.starts_at,
    });
    await syncAppointment(ctx, row);
  }

  const refreshed = await Promise.all(created.map((row) => getAppointment(ctx, tenantId, row.id)));
  return { appointments: refreshed, scheduleRule };
}

export async function getAppointment(
  ctx: SchedulingCtx,
  tenantId: string,
  appointmentId: string,
): Promise<AppointmentWithAssignments> {
  const row = await ctx.db
    .selectFrom('scheduling_appointments')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', appointmentId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`appointment not found: ${appointmentId}`);
  const [withAssignments] = await attachAssignments(ctx, tenantId, [row]);
  return withAssignments;
}

export interface ListAppointmentsFilter {
  calendarId?: string;
  status?: AppointmentStatus;
  staffId?: string;
  resourceId?: string;
  customerId?: string;
  /** UTC ISO bounds on starts_at. */
  from?: string;
  to?: string;
}

export async function listAppointments(
  ctx: SchedulingCtx,
  tenantId: string,
  filter: ListAppointmentsFilter = {},
  page = { limit: 50, offset: 0 },
): Promise<AppointmentWithAssignments[]> {
  let q = ctx.db
    .selectFrom('scheduling_appointments')
    .selectAll()
    .where('tenant_id', '=', tenantId);
  if (filter.calendarId) q = q.where('calendar_id', '=', filter.calendarId);
  if (filter.status) q = q.where('status', '=', filter.status);
  if (filter.customerId) q = q.where('customer_id', '=', filter.customerId);
  if (filter.from) q = q.where('starts_at', '>=', filter.from);
  if (filter.to) q = q.where('starts_at', '<', filter.to);
  if (filter.staffId) {
    q = q.where('id', 'in', (eb) =>
      eb
        .selectFrom('scheduling_appointment_staff')
        .select('appointment_id')
        .where('tenant_id', '=', tenantId)
        .where('staff_id', '=', filter.staffId!),
    );
  }
  if (filter.resourceId) {
    q = q.where('id', 'in', (eb) =>
      eb
        .selectFrom('scheduling_appointment_resources')
        .select('appointment_id')
        .where('tenant_id', '=', tenantId)
        .where('resource_id', '=', filter.resourceId!),
    );
  }
  const rows = await q.orderBy('starts_at').orderBy('id').limit(page.limit).offset(page.offset).execute();
  return attachAssignments(ctx, tenantId, rows);
}

export interface UpdateAppointmentInput {
  title?: string;
  notes?: string | null;
  customerId?: string | null;
  locationId?: string | null;
}

export async function updateAppointment(
  ctx: SchedulingCtx,
  tenantId: string,
  appointmentId: string,
  patch: UpdateAppointmentInput,
  actor = 'system',
): Promise<AppointmentWithAssignments> {
  await getAppointment(ctx, tenantId, appointmentId);
  const set: Partial<SchedulingAppointmentRow> = {
    updated_at: nowIso(),
    calendar_sync_status: 'pending',
    calendar_sync_error: null,
  };
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw ApiError.badRequest('title cannot be blank');
    set.title = patch.title.trim();
  }
  if (patch.notes !== undefined) set.notes = patch.notes;
  if (patch.customerId !== undefined) set.customer_id = patch.customerId;
  if (patch.locationId !== undefined) {
    if (patch.locationId !== null) await getLocation(ctx, tenantId, patch.locationId);
    set.location_id = patch.locationId;
  }
  await ctx.db
    .updateTable('scheduling_appointments')
    .set(set)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', appointmentId)
    .execute();
  await audit(asCoreDb(ctx.db), tenantId, actor, 'scheduling.appointment.updated', 'scheduling.appointment', appointmentId, patch);
  const updated = await getAppointment(ctx, tenantId, appointmentId);
  await syncAppointment(ctx, updated);
  return getAppointment(ctx, tenantId, appointmentId);
}

export async function rescheduleAppointment(
  ctx: SchedulingCtx,
  tenantId: string,
  appointmentId: string,
  input: { startsAt: string; endsAt?: string; timezone?: string },
  actor = 'system',
): Promise<AppointmentWithAssignments> {
  const existing = await getAppointment(ctx, tenantId, appointmentId);
  if (!ACTIVE_STATUSES.includes(existing.status)) {
    throw ApiError.conflict(`cannot reschedule a ${existing.status} appointment`);
  }
  const calendar = await getCalendar(ctx, tenantId, existing.calendar_id);
  const zone = input.timezone ?? calendar.timezone;
  const startsAt = toUtcIso(input.startsAt, zone);
  const durationMs = ms(existing.ends_at) - ms(existing.starts_at);
  const endsAt = input.endsAt
    ? toUtcIso(input.endsAt, zone)
    : DateTime.fromMillis(ms(startsAt) + durationMs, { zone: 'utc' }).toISO()!;
  if (ms(endsAt) <= ms(startsAt)) throw ApiError.badRequest('endsAt must be after startsAt');

  const type = existing.appointment_type_id
    ? await getAppointmentType(ctx, tenantId, existing.appointment_type_id)
    : null;
  if (type && type.active !== 1) throw ApiError.conflict(`appointment type is inactive: ${type.id}`);
  for (const staffId of existing.staff_ids) {
    const staff = await getStaffMember(ctx, tenantId, staffId);
    if (staff.active !== 1) throw ApiError.conflict(`staff member is inactive: ${staffId}`);
  }
  for (const resourceId of existing.resource_ids) {
    const resource = await getResource(ctx, tenantId, resourceId);
    if (resource.active !== 1) throw ApiError.conflict(`resource is inactive: ${resourceId}`);
  }

  await ctx.db.transaction().execute(async (trx) => {
    const txCtx: SchedulingCtx = { ...ctx, db: trx };
    const conflicts = await findConflicts(txCtx, tenantId, {
      startsAt,
      endsAt,
      bufferBeforeMinutes: type?.buffer_before_minutes ?? 0,
      bufferAfterMinutes: type?.buffer_after_minutes ?? 0,
      staffIds: existing.staff_ids,
      resourceIds: existing.resource_ids,
      excludeAppointmentId: appointmentId,
    });
    if (conflicts.length > 0) {
      throw ApiError.conflict('scheduling conflict: staff or resource is already booked', { conflicts });
    }

    await trx
      .updateTable('scheduling_appointments')
      .set({
        starts_at: startsAt,
        ends_at: endsAt,
        updated_at: nowIso(),
        calendar_sync_status: 'pending',
        calendar_sync_error: null,
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', appointmentId)
      .execute();
    await audit(asCoreDb(trx), tenantId, actor, 'scheduling.appointment.rescheduled', 'scheduling.appointment', appointmentId, {
      before: { startsAt: existing.starts_at, endsAt: existing.ends_at },
      after: { startsAt, endsAt },
    });
  });
  await ctx.events.emit(tenantId, 'scheduling.appointment.rescheduled', {
    appointmentId,
    startsAt,
    endsAt,
  });
  const updated = await getAppointment(ctx, tenantId, appointmentId);
  await syncAppointment(ctx, updated);
  return getAppointment(ctx, tenantId, appointmentId);
}

export async function changeAppointmentStatus(
  ctx: SchedulingCtx,
  tenantId: string,
  appointmentId: string,
  next: AppointmentStatus,
  opts: { reason?: string; actor?: string } = {},
): Promise<AppointmentWithAssignments> {
  const actor = opts.actor ?? 'system';
  const existing = await getAppointment(ctx, tenantId, appointmentId);
  const allowed = STATUS_TRANSITIONS[existing.status];
  if (!allowed.includes(next)) {
    throw ApiError.conflict(`invalid status transition: ${existing.status} -> ${next}`, {
      from: existing.status,
      to: next,
      allowed,
    });
  }

  const set: Partial<SchedulingAppointmentRow> = {
    status: next,
    updated_at: nowIso(),
    calendar_sync_status: 'pending',
    calendar_sync_error: null,
  };
  if (next === 'canceled') set.canceled_reason = opts.reason ?? null;
  await ctx.db
    .updateTable('scheduling_appointments')
    .set(set)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', appointmentId)
    .execute();
  await audit(asCoreDb(ctx.db), tenantId, actor, `scheduling.appointment.${next}`, 'scheduling.appointment', appointmentId, {
    from: existing.status,
    to: next,
    reason: opts.reason,
  });

  if (next === 'canceled') {
    // Cascade: pending reminders for a canceled appointment are canceled.
    await ctx.db
      .updateTable('scheduling_reminders')
      .set({ status: 'canceled' })
      .where('tenant_id', '=', tenantId)
      .where('appointment_id', '=', appointmentId)
      .where('status', '=', 'pending')
      .execute();
    await ctx.events.emit(tenantId, 'scheduling.appointment.canceled', {
      appointmentId,
      reason: opts.reason,
    });
    await syncAppointmentDeletion(ctx, { ...existing, status: next });
  } else if (next === 'completed') {
    await ctx.events.emit(tenantId, 'scheduling.appointment.completed', { appointmentId });
  }

  const updated = await getAppointment(ctx, tenantId, appointmentId);
  if (next !== 'canceled') await syncAppointment(ctx, updated);
  return getAppointment(ctx, tenantId, appointmentId);
}

export async function cancelAppointment(
  ctx: SchedulingCtx,
  tenantId: string,
  appointmentId: string,
  opts: { reason?: string; actor?: string } = {},
): Promise<AppointmentWithAssignments> {
  return changeAppointmentStatus(ctx, tenantId, appointmentId, 'canceled', opts);
}

/* ------------------------------------------------------------------ *
 * Availability query
 * ------------------------------------------------------------------ */

export interface FreeInterval {
  starts_at: string;
  ends_at: string;
}

/**
 * Free time for a staff member/resource on one local date: weekly windows,
 * adjusted by dated exceptions, minus booked (requested/confirmed)
 * appointments including their type buffers. Returns UTC ISO intervals.
 */
export async function getAvailability(
  ctx: SchedulingCtx,
  tenantId: string,
  q: { ownerType: OwnerType; ownerId: string; date: string; timezone?: string },
): Promise<{ date: string; timezone: string; free: FreeInterval[] }> {
  await assertOwner(ctx, tenantId, q.ownerType, q.ownerId);
  if (!DATE_RE.test(q.date)) throw ApiError.badRequest('date must be "YYYY-MM-DD"');
  const zone = q.timezone ?? 'UTC';
  assertZone(zone);
  const dayStart = DateTime.fromISO(q.date, { zone });
  if (!dayStart.isValid) throw ApiError.badRequest(`invalid date: "${q.date}"`);

  const localInterval = (start: string, end: string): Interval => ({
    start: DateTime.fromISO(`${q.date}T${start}`, { zone }).toMillis(),
    end: DateTime.fromISO(`${q.date}T${end}`, { zone }).toMillis(),
  });

  const windows = await ctx.db
    .selectFrom('scheduling_availability_windows')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('owner_type', '=', q.ownerType)
    .where('owner_id', '=', q.ownerId)
    .where('weekday', '=', dayStart.weekday)
    .orderBy('start_time')
    .orderBy('id')
    .execute();
  let base: Interval[] = windows.map((w) => localInterval(w.start_time, w.end_time));

  const exceptions = await ctx.db
    .selectFrom('scheduling_availability_exceptions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('owner_type', '=', q.ownerType)
    .where('owner_id', '=', q.ownerId)
    .where('date', '=', q.date)
    .orderBy('id')
    .execute();
  for (const ex of exceptions) {
    if (ex.available === 1) {
      base.push(localInterval(ex.start_time!, ex.end_time!));
    } else if (ex.start_time !== null && ex.end_time !== null) {
      base = subtractIntervals(base, [localInterval(ex.start_time, ex.end_time)]);
    } else {
      base = []; // whole day off
    }
  }
  base = mergeIntervals(base);

  // Booked time (with buffers) for this owner around the local day.
  const rangeStart = dayStart.minus({ days: 1 }).toUTC().toISO()!;
  const rangeEnd = dayStart.plus({ days: 2 }).toUTC().toISO()!;
  const busySource =
    q.ownerType === 'staff'
      ? await ctx.db
          .selectFrom('scheduling_appointment_staff as asg')
          .innerJoin('scheduling_appointments as a', 'a.id', 'asg.appointment_id')
          .select(['a.starts_at', 'a.ends_at', 'a.appointment_type_id'])
          .where('asg.tenant_id', '=', tenantId)
          .where('a.tenant_id', '=', tenantId)
          .where('asg.staff_id', '=', q.ownerId)
          .where('a.status', 'in', [...ACTIVE_STATUSES])
          .where('a.starts_at', '<', rangeEnd)
          .where('a.ends_at', '>', rangeStart)
          .orderBy('a.starts_at')
          .orderBy('a.id')
          .execute()
      : await ctx.db
          .selectFrom('scheduling_appointment_resources as asg')
          .innerJoin('scheduling_appointments as a', 'a.id', 'asg.appointment_id')
          .select(['a.starts_at', 'a.ends_at', 'a.appointment_type_id'])
          .where('asg.tenant_id', '=', tenantId)
          .where('a.tenant_id', '=', tenantId)
          .where('asg.resource_id', '=', q.ownerId)
          .where('a.status', 'in', [...ACTIVE_STATUSES])
          .where('a.starts_at', '<', rangeEnd)
          .where('a.ends_at', '>', rangeStart)
          .orderBy('a.starts_at')
          .orderBy('a.id')
          .execute();

  const typeIds = dedupe(busySource.map((b) => b.appointment_type_id).filter((t): t is string => t !== null));
  const buffers = new Map<string, { before: number; after: number }>();
  if (typeIds.length > 0) {
    const types = await ctx.db
      .selectFrom('scheduling_appointment_types')
      .select(['id', 'buffer_before_minutes', 'buffer_after_minutes'])
      .where('tenant_id', '=', tenantId)
      .where('id', 'in', typeIds)
      .execute();
    for (const t of types) buffers.set(t.id, { before: t.buffer_before_minutes, after: t.buffer_after_minutes });
  }
  const busy: Interval[] = busySource.map((b) => {
    const buf = (b.appointment_type_id && buffers.get(b.appointment_type_id)) || { before: 0, after: 0 };
    return { start: ms(b.starts_at) - buf.before * 60_000, end: ms(b.ends_at) + buf.after * 60_000 };
  });

  const free = subtractIntervals(base, busy).map((iv) => ({
    starts_at: DateTime.fromMillis(iv.start, { zone: 'utc' }).toISO()!,
    ends_at: DateTime.fromMillis(iv.end, { zone: 'utc' }).toISO()!,
  }));
  return { date: q.date, timezone: zone, free };
}

/* ------------------------------------------------------------------ *
 * Next-available slot finder (Front Desk V2)
 * ------------------------------------------------------------------ */

export interface AvailableSlot {
  /** UTC ISO. */
  starts_at: string;
  /** UTC ISO. */
  ends_at: string;
  staff_id: string;
  /** Local date (query timezone) the slot falls on. */
  date: string;
}

export interface NextAvailableQuery {
  appointmentTypeId: string;
  /** Inclusive local start date "YYYY-MM-DD". */
  from: string;
  /** Forward scan length in days (default 14, max 60). */
  days?: number;
  /** IANA zone the local dates/windows are interpreted in (default UTC). */
  timezone?: string;
  /** A specific staff member id … */
  staffId?: string;
  /** … OR set staffAny to scan every active staff member ("first free"). */
  staffAny?: boolean;
  /** Max slots returned (default 20, max 100). */
  limit?: number;
  /** Minutes between candidate starts inside a free block (default = duration). */
  granularityMinutes?: number;
  /** Drop slots starting at or before this UTC ISO (pass "now" to hide the past). */
  after?: string;
}

export interface NextAvailableResult {
  appointment_type_id: string;
  timezone: string;
  from: string;
  days: number;
  duration_minutes: number;
  slots: AvailableSlot[];
}

const MAX_SCAN_DAYS = 60;
const MAX_NEXT_SLOTS = 100;

/**
 * Forward-scan bookable slots for an appointment type. Uses getAvailability()
 * (weekly windows + dated exceptions − others' booked+buffered time) to place
 * duration-sized candidates inside business hours, then re-checks each with the
 * SAME findConflicts() that createAppointment() uses, so every returned slot is
 * genuinely bookable (won't 409) — buffers included. Scans day by day and stops
 * after the first full day that yields >= limit slots (later days are strictly
 * later, so the earliest `limit` are already settled). `staffAny` aggregates the
 * "first free" across every active staff member, each slot tagged with staff_id.
 */
export async function findNextAvailable(
  ctx: SchedulingCtx,
  tenantId: string,
  q: NextAvailableQuery,
): Promise<NextAvailableResult> {
  const type = await getAppointmentType(ctx, tenantId, q.appointmentTypeId);
  if (type.active !== 1) throw ApiError.conflict(`appointment type is inactive: ${type.id}`);
  if (!DATE_RE.test(q.from)) throw ApiError.badRequest('from must be "YYYY-MM-DD"');
  const zone = q.timezone ?? 'UTC';
  assertZone(zone);
  const fromDt = DateTime.fromISO(q.from, { zone });
  if (!fromDt.isValid) throw ApiError.badRequest(`invalid from date: "${q.from}"`);

  const days = q.days ?? 14;
  if (!Number.isInteger(days) || days < 1 || days > MAX_SCAN_DAYS) {
    throw ApiError.badRequest(`days must be an integer 1..${MAX_SCAN_DAYS}`);
  }
  const limit = q.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_NEXT_SLOTS) {
    throw ApiError.badRequest(`limit must be an integer 1..${MAX_NEXT_SLOTS}`);
  }
  if (!q.staffId && !q.staffAny) {
    throw ApiError.badRequest('specify staffId, or staffAny=true to scan every active staff member');
  }
  const granularity = q.granularityMinutes ?? type.duration_minutes;
  if (!Number.isInteger(granularity) || granularity < 1) {
    throw ApiError.badRequest('granularityMinutes must be a positive integer');
  }
  const afterMs = q.after === undefined ? undefined : ms(toUtcIso(q.after, 'utc'));

  const staffList: string[] = q.staffId
    ? [
        await (async () => {
          const staff = await getStaffMember(ctx, tenantId, q.staffId!);
          if (staff.active !== 1) throw ApiError.conflict(`staff member is inactive: ${staff.id}`);
          return staff.id;
        })(),
      ]
    : (await listStaffMembers(ctx, tenantId, { limit: 500, offset: 0 }))
        .filter((s) => s.active === 1)
        .map((s) => s.id);

  const durationMs = type.duration_minutes * 60_000;
  const stepMs = granularity * 60_000;
  const slots: AvailableSlot[] = [];

  for (let d = 0; d < days; d++) {
    const date = fromDt.plus({ days: d }).toFormat('yyyy-MM-dd');
    for (const staffId of staffList) {
      const { free } = await getAvailability(ctx, tenantId, {
        ownerType: 'staff',
        ownerId: staffId,
        date,
        timezone: zone,
      });
      for (const block of free) {
        const blockEnd = ms(block.ends_at);
        for (let s = ms(block.starts_at); s + durationMs <= blockEnd; s += stepMs) {
          if (afterMs !== undefined && s <= afterMs) continue;
          const startsAt = DateTime.fromMillis(s, { zone: 'utc' }).toISO()!;
          const endsAt = DateTime.fromMillis(s + durationMs, { zone: 'utc' }).toISO()!;
          const conflicts = await findConflicts(ctx, tenantId, {
            startsAt,
            endsAt,
            bufferBeforeMinutes: type.buffer_before_minutes,
            bufferAfterMinutes: type.buffer_after_minutes,
            staffIds: [staffId],
            resourceIds: [],
          });
          if (conflicts.length === 0) {
            slots.push({ starts_at: startsAt, ends_at: endsAt, staff_id: staffId, date });
          }
        }
      }
    }
    if (slots.length >= limit) break;
  }

  slots.sort((a, b) =>
    a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : a.staff_id < b.staff_id ? -1 : a.staff_id > b.staff_id ? 1 : 0,
  );
  return {
    appointment_type_id: type.id,
    timezone: zone,
    from: q.from,
    days,
    duration_minutes: type.duration_minutes,
    slots: slots.slice(0, limit),
  };
}

/* ------------------------------------------------------------------ *
 * Reminders
 * ------------------------------------------------------------------ */

export interface ReminderInput {
  sendAt: string;
  timezone?: string;
  channel: string;
  recipient: string;
  message?: string;
}

export async function createReminder(
  ctx: SchedulingCtx,
  tenantId: string,
  appointmentId: string,
  input: ReminderInput,
  actor = 'system',
): Promise<SchedulingReminderRow> {
  const appointment = await getAppointment(ctx, tenantId, appointmentId);
  if (!ACTIVE_STATUSES.includes(appointment.status)) {
    throw ApiError.conflict(`cannot add a reminder to a ${appointment.status} appointment`);
  }
  if (!input.channel.trim()) throw ApiError.badRequest('channel is required');
  if (!input.recipient.trim()) throw ApiError.badRequest('recipient is required');
  const row: SchedulingReminderRow = {
    id: id(),
    tenant_id: tenantId,
    appointment_id: appointmentId,
    send_at: toUtcIso(input.sendAt, input.timezone ?? 'utc'),
    channel: input.channel.trim(),
    recipient: input.recipient.trim(),
    message: input.message ?? null,
    status: 'pending',
    attempts: 0,
    last_attempt_at: null,
    next_attempt_at: null,
    lease_expires_at: null,
    delivery_reference: null,
    last_error: null,
    sent_at: null,
    provider: null,
    created_at: nowIso(),
  };
  await ctx.db.insertInto('scheduling_reminders').values(row).execute();
  await audit(asCoreDb(ctx.db), tenantId, actor, 'scheduling.reminder.created', 'scheduling.reminder', row.id, {
    appointmentId,
    sendAt: row.send_at,
    channel: row.channel,
  });
  return row;
}

export async function listRemindersForAppointment(
  ctx: SchedulingCtx,
  tenantId: string,
  appointmentId: string,
): Promise<SchedulingReminderRow[]> {
  await getAppointment(ctx, tenantId, appointmentId);
  return ctx.db
    .selectFrom('scheduling_reminders')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('appointment_id', '=', appointmentId)
    .orderBy('send_at')
    .orderBy('id')
    .execute();
}

/** Reminders due for delivery: status=pending and send_at <= before (default now). */
export async function listPendingReminders(
  ctx: SchedulingCtx,
  tenantId: string,
  opts: { before?: string } = {},
  page = { limit: 50, offset: 0 },
): Promise<SchedulingReminderRow[]> {
  const before = opts.before ? toUtcIso(opts.before) : nowIso();
  return ctx.db
    .selectFrom('scheduling_reminders')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'pending')
    .where('send_at', '<=', before)
    .orderBy('send_at')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

/** Claim delivery once; durable adapters reconcile the same operation on recovery. */
export async function sendReminder(
  ctx: SchedulingCtx, tenantId: string, reminderId: string, actor = 'system',
): Promise<SchedulingReminderRow> {
  const reminder = await ctx.db.selectFrom('scheduling_reminders').selectAll()
    .where('tenant_id', '=', tenantId).where('id', '=', reminderId).executeTakeFirst();
  if (!reminder) throw ApiError.notFound(`reminder not found: ${reminderId}`);
  const at = nowIso();
  const recovering = reminder.status === 'sending' && (!reminder.lease_expires_at || reminder.lease_expires_at <= at);
  if (!['pending', 'submitted'].includes(reminder.status) && !recovering) throw ApiError.conflict(`reminder is ${reminder.status}; it is not ready for delivery`);
  const appointment = await getAppointment(ctx, tenantId, reminder.appointment_id);
  if (!ACTIVE_STATUSES.includes(appointment.status)) {
    await ctx.db.updateTable('scheduling_reminders').set({ status: 'canceled', lease_expires_at: null, next_attempt_at: null })
      .where('tenant_id', '=', tenantId).where('id', '=', reminderId).where('status', '=', reminder.status).execute();
    return { ...reminder, status: 'canceled', lease_expires_at: null, next_attempt_at: null };
  }
  if (recovering && !ctx.reminderDelivery.durableOperations) {
    await ctx.db.updateTable('scheduling_reminders').set({ status: 'review', lease_expires_at: null, last_error: 'Interrupted delivery requires provider reconciliation.' })
      .where('tenant_id', '=', tenantId).where('id', '=', reminderId).where('status', '=', 'sending').execute();
    await audit(asCoreDb(ctx.db), tenantId, actor, 'scheduling.reminder.review', 'scheduling.reminder', reminderId, {});
    return { ...reminder, status: 'review', lease_expires_at: null, last_error: 'Interrupted delivery requires provider reconciliation.' };
  }
  const lease = DateTime.fromISO(at).plus({ minutes: 2 }).toUTC().toISO()!;
  let claim = ctx.db.updateTable('scheduling_reminders').set({ status: 'sending', attempts: reminder.attempts + 1, last_attempt_at: at, lease_expires_at: lease })
    .where('tenant_id', '=', tenantId).where('id', '=', reminderId).where('status', '=', reminder.status);
  claim = reminder.lease_expires_at ? claim.where('lease_expires_at', '=', reminder.lease_expires_at) : claim.where('lease_expires_at', 'is', null);
  if (!(await claim.executeTakeFirst()).numUpdatedRows) throw ApiError.conflict('reminder is already being processed');
  let result: ReminderDeliveryResult;
  try {
    result = await ctx.reminderDelivery.deliver({ tenantId, reminderId, appointmentId: reminder.appointment_id,
      channel: reminder.channel, recipient: reminder.recipient, message: reminder.message, sendAt: reminder.send_at,
      deliveryReference: reminder.delivery_reference });
  } catch (error) {
    result = { delivered: false, ...(ctx.reminderDelivery.durableOperations ? {} : { state: 'review' as const }), detail: providerErrorMessage(error) };
  }
  const status: ReminderStatus = result.delivered ? 'sent' : result.state ?? 'pending';
  const attempts = reminder.attempts + 1;
  const nextAttempt = ['pending', 'submitted'].includes(status) ? DateTime.fromISO(at).plus({ seconds: Math.min(3600, 15 * 2 ** Math.min(attempts, 8)) }).toUTC().toISO()! : null;
  const patch = { status, attempts, last_attempt_at: at, lease_expires_at: null, next_attempt_at: nextAttempt,
    delivery_reference: result.deliveryReference ?? reminder.delivery_reference, last_error: result.detail?.slice(0, 500) ?? null,
    provider: ctx.reminderDelivery.name, sent_at: result.delivered ? nowIso() : null };
  const finalized = await ctx.db.updateTable('scheduling_reminders').set(patch)
    .where('tenant_id', '=', tenantId).where('id', '=', reminderId).where('status', '=', 'sending').where('lease_expires_at', '=', lease).executeTakeFirst();
  if (!finalized.numUpdatedRows) throw ApiError.conflict('reminder delivery state changed before finalization');
  await audit(asCoreDb(ctx.db), tenantId, actor, `scheduling.reminder.${status}`, 'scheduling.reminder', reminderId,
    { appointmentId: reminder.appointment_id, provider: ctx.reminderDelivery.name, deliveryReference: patch.delivery_reference, attempts });
  if (status === 'sent') await ctx.events.emit(tenantId, 'scheduling.reminder.sent', { reminderId, appointmentId: reminder.appointment_id, channel: reminder.channel });
  if (status === 'pending') throw ApiError.conflict(`reminder delivery failed: ${result.detail ?? 'provider error'}`);
  return { ...reminder, ...patch };
}

/** A bounded queue pass; interrupted sends only resume through a durable adapter. */
export async function runReminderQueue(ctx: SchedulingCtx, tenantId: string, before = nowIso()) {
  const rows = await ctx.db.selectFrom('scheduling_reminders').selectAll().where('tenant_id', '=', tenantId)
    .where('send_at', '<=', before).where('status', 'in', ['pending', 'submitted', 'sending'])
    .where(eb => eb.or([eb('next_attempt_at', 'is', null), eb('next_attempt_at', '<=', before)]))
    .where(eb => eb.or([eb('status', '!=', 'sending'), eb('lease_expires_at', 'is', null), eb('lease_expires_at', '<=', before)]))
    .orderBy('send_at').orderBy('id').limit(50).execute();
  const results: Array<{ id: string; status: string }> = [];
  for (const row of rows) {
    try { results.push({ id: row.id, status: (await sendReminder(ctx, tenantId, row.id)).status }); }
    catch { results.push({ id: row.id, status: 'pending-or-review' }); }
  }
  return results;
}

/* ------------------------------------------------------------------ *
 * ICS export
 * ------------------------------------------------------------------ */

function icsDate(iso: string): string {
  return DateTime.fromISO(iso, { zone: 'utc' }).toFormat("yyyyLLdd'T'HHmmss") + 'Z';
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** RFC 5545 line folding at 74 octets (approximated as chars). */
function foldIcsLine(line: string): string[] {
  if (line.length <= 74) return [line];
  const out: string[] = [line.slice(0, 74)];
  let rest = line.slice(74);
  while (rest.length > 73) {
    out.push(' ' + rest.slice(0, 73));
    rest = rest.slice(73);
  }
  if (rest.length > 0) out.push(' ' + rest);
  return out;
}

const ICS_STATUS: Record<AppointmentStatus, string> = {
  requested: 'TENTATIVE',
  confirmed: 'CONFIRMED',
  completed: 'CONFIRMED',
  canceled: 'CANCELLED',
  no_show: 'CONFIRMED',
};

/**
 * Valid VCALENDAR text for one calendar. Canceled appointments are excluded;
 * internal notes are NEVER exported.
 */
export async function buildCalendarIcs(
  ctx: SchedulingCtx,
  tenantId: string,
  calendarId: string,
): Promise<string> {
  const calendar = await getCalendar(ctx, tenantId, calendarId);
  const appointments = await ctx.db
    .selectFrom('scheduling_appointments')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('calendar_id', '=', calendarId)
    .where('status', '!=', 'canceled')
    .orderBy('starts_at')
    .orderBy('id')
    .execute();

  const stamp = icsDate(nowIso());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BlackLabel Platform//Scheduling//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeIcsText(calendar.name)}`,
    `X-WR-TIMEZONE:${calendar.timezone}`,
  ];
  for (const appt of appointments) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${appt.id}@blacklabel.scheduling`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(appt.starts_at)}`,
      `DTEND:${icsDate(appt.ends_at)}`,
      `SUMMARY:${escapeIcsText(appt.title)}`,
      `STATUS:${ICS_STATUS[appt.status]}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.flatMap(foldIcsLine).join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ *
 * CreateAppointmentContract implementation (wired by apps/api)
 * ------------------------------------------------------------------ */

/**
 * The scheduling module's implementation of core's CreateAppointmentContract.
 * Other modules call this via deps.contracts.createAppointment — never by
 * importing this package.
 *
 * - Books on the tenant's first calendar (creates a "Default" UTC calendar
 *   if the tenant has none).
 * - assigneeUserId is resolved to a staff member via staff.user_id; if no
 *   staff member matches, the appointment is created unassigned.
 */
export function createSchedulingContract(deps: {
  db: Kysely<SchedulingDatabase>;
  events: EventBus;
  calendarSync?: ExternalCalendarProvider;
  reminderDelivery?: ReminderDeliveryProvider;
}): CreateAppointmentContract {
  const ctx = createSchedulingContext(deps);
  return {
    async createAppointment(input: CreateAppointmentInput): Promise<{ id: string }> {
      const calendars = await listCalendars(ctx, input.tenantId, { limit: 1, offset: 0 });
      const calendar =
        calendars[0] ?? (await createCalendar(ctx, input.tenantId, { name: 'Default', timezone: 'UTC' }));

      let staffIds: string[] = [];
      if (input.assigneeUserId) {
        const staff = await ctx.db
          .selectFrom('scheduling_staff_members')
          .select('id')
          .where('tenant_id', '=', input.tenantId)
          .where('user_id', '=', input.assigneeUserId)
          .where('active', '=', 1)
          .orderBy('created_at')
          .orderBy('id')
          .executeTakeFirst();
        if (staff) staffIds = [staff.id];
      }

      const { appointments } = await createAppointment(ctx, input.tenantId, {
        calendarId: calendar.id,
        title: input.serviceKey ?? 'Appointment',
        customerId: input.customerId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        timezone: 'utc',
        notes: input.notes,
        staffIds,
      });
      return { id: appointments[0].id };
    },
  };
}

/**
 * CreateAppointmentTypeContract implementation. Idempotent per (tenant, name):
 * if an appointment type with the same name already exists for the tenant it is
 * reused (created=false), so re-provisioning (e.g. re-applying an industry) is
 * safe and never duplicates bookable types.
 */
export function createSchedulingAppointmentTypeContract(deps: {
  db: Kysely<SchedulingDatabase>;
  events: EventBus;
}): CreateAppointmentTypeContract {
  const ctx = createSchedulingContext(deps);
  return {
    async createAppointmentType(
      input: CreateAppointmentTypeInput,
    ): Promise<{ id: string; created: boolean }> {
      const name = input.name.trim();
      const existing = await ctx.db
        .selectFrom('scheduling_appointment_types')
        .select('id')
        .where('tenant_id', '=', input.tenantId)
        .where('name', '=', name)
        .orderBy('created_at')
        .orderBy('id')
        .executeTakeFirst();
      if (existing) return { id: existing.id, created: false };
      const row = await createAppointmentType(ctx, input.tenantId, {
        name,
        durationMinutes: input.durationMinutes,
        bufferBeforeMinutes: input.bufferBeforeMinutes,
        bufferAfterMinutes: input.bufferAfterMinutes,
      });
      return { id: row.id, created: true };
    },
  };
}
