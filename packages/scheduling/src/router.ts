/**
 * HTTP surface for the scheduling module. Mounted by apps/api at
 * /api/scheduling. Tenant comes EXCLUSIVELY from the core tenant middleware
 * (x-tenant-id header); the acting user may be passed as x-user-id.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  asCoreDb,
  errorHandler,
  parsePagination,
  tenantMiddleware,
  type ModuleDeps,
  type TenantEnv,
} from '@blacklabel/core';
import type { SchedulingDatabase } from './schema';
import {
  buildCalendarIcs,
  cancelAppointment,
  changeAppointmentStatus,
  createAppointment,
  createAppointmentType,
  createAvailabilityException,
  createAvailabilityWindow,
  createCalendar,
  createLocation,
  createReminder,
  createResource,
  createSchedulingContext,
  createStaffMember,
  deleteAppointmentType,
  deleteAvailabilityException,
  deleteAvailabilityWindow,
  deleteCalendar,
  deleteLocation,
  deleteResource,
  deleteStaffMember,
  findNextAvailable,
  getAppointment,
  getAvailability,
  getCalendar,
  getLocation,
  getResource,
  getStaffMember,
  listAppointments,
  listAppointmentTypes,
  listAvailabilityExceptions,
  listAvailabilityWindows,
  listCalendars,
  listLocations,
  listPendingReminders,
  listRemindersForAppointment,
  listResources,
  listStaffMembers,
  rescheduleAppointment,
  sendReminder,
  updateAppointment,
  updateCalendar,
  updateStaffMember,
  type ExternalCalendarProvider,
  type ReminderDeliveryProvider,
} from './service';

/* zod schemas ------------------------------------------------------- */

const calendarCreateSchema = z.object({
  name: z.string().min(1),
  timezone: z.string().min(1).optional(),
  description: z.string().optional(),
});
const calendarPatchSchema = calendarCreateSchema.partial();

const locationCreateSchema = z.object({
  name: z.string().min(1),
  address: z.string().optional(),
  timezone: z.string().optional(),
});

const staffCreateSchema = z.object({
  name: z.string().min(1),
  email: z.string().optional(),
  userId: z.string().optional(),
  active: z.boolean().optional(),
});
const staffPatchSchema = staffCreateSchema.partial();

const resourceCreateSchema = z.object({
  name: z.string().min(1),
  kind: z.string().optional(),
  locationId: z.string().optional(),
  active: z.boolean().optional(),
});

const appointmentTypeCreateSchema = z.object({
  name: z.string().min(1),
  durationMinutes: z.number().int().positive(),
  bufferBeforeMinutes: z.number().int().min(0).optional(),
  bufferAfterMinutes: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
});

const ownerTypeSchema = z.enum(['staff', 'resource']);

const availabilityWindowCreateSchema = z.object({
  ownerType: ownerTypeSchema,
  ownerId: z.string().min(1),
  weekday: z.number().int().min(1).max(7),
  startTime: z.string().min(1),
  endTime: z.string().min(1),
});

const availabilityExceptionCreateSchema = z.object({
  ownerType: ownerTypeSchema,
  ownerId: z.string().min(1),
  date: z.string().min(1),
  available: z.boolean(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  reason: z.string().optional(),
});

const recurrenceSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  interval: z.number().int().min(1).optional(),
  count: z.number().int().min(1).optional(),
  until: z.string().optional(),
});

const appointmentCreateSchema = z.object({
  calendarId: z.string().min(1),
  title: z.string().min(1),
  appointmentTypeId: z.string().optional(),
  customerId: z.string().optional(),
  locationId: z.string().optional(),
  startsAt: z.string().min(1),
  endsAt: z.string().optional(),
  timezone: z.string().optional(),
  status: z.enum(['requested', 'confirmed']).optional(),
  notes: z.string().optional(),
  staffIds: z.array(z.string().min(1)).optional(),
  resourceIds: z.array(z.string().min(1)).optional(),
  recurrence: recurrenceSchema.optional(),
});

const appointmentPatchSchema = z.object({
  title: z.string().optional(),
  notes: z.string().nullable().optional(),
  customerId: z.string().nullable().optional(),
  locationId: z.string().nullable().optional(),
});

const rescheduleSchema = z.object({
  startsAt: z.string().min(1),
  endsAt: z.string().optional(),
  timezone: z.string().optional(),
});

const cancelSchema = z.object({ reason: z.string().optional() });

const statusSchema = z.object({
  status: z.enum(['requested', 'confirmed', 'completed', 'canceled', 'no_show']),
  reason: z.string().optional(),
});

const reminderCreateSchema = z.object({
  sendAt: z.string().min(1),
  timezone: z.string().optional(),
  channel: z.string().min(1),
  recipient: z.string().min(1),
  message: z.string().optional(),
});

/* router ------------------------------------------------------------ */

export interface SchedulingRouterOptions {
  calendarSync?: ExternalCalendarProvider;
  reminderDelivery?: ReminderDeliveryProvider;
}

export function schedulingRouter(
  deps: ModuleDeps<SchedulingDatabase>,
  options: SchedulingRouterOptions = {},
): Hono<TenantEnv> {
  const ctx = createSchedulingContext({
    db: deps.db,
    events: deps.events,
    calendarSync: options.calendarSync,
    reminderDelivery: options.reminderDelivery,
  });

  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(deps.db)));

  const actor = (c: { req: { header(name: string): string | undefined } }): string =>
    c.req.header('x-user-id') ?? 'system';

  /* Calendars */
  app.post('/calendars', async (c) => {
    const body = calendarCreateSchema.parse(await c.req.json());
    const row = await createCalendar(ctx, c.get('tenantId'), body, actor(c));
    return c.json({ data: row }, 201);
  });
  app.get('/calendars', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await listCalendars(ctx, c.get('tenantId'), page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });
  app.get('/calendars/:id', async (c) => {
    return c.json({ data: await getCalendar(ctx, c.get('tenantId'), c.req.param('id')) });
  });
  app.patch('/calendars/:id', async (c) => {
    const body = calendarPatchSchema.parse(await c.req.json());
    return c.json({ data: await updateCalendar(ctx, c.get('tenantId'), c.req.param('id'), body, actor(c)) });
  });
  app.delete('/calendars/:id', async (c) => {
    await deleteCalendar(ctx, c.get('tenantId'), c.req.param('id'), actor(c));
    return c.json({ data: { deleted: true } });
  });

  /** ICS export — valid VCALENDAR/VEVENT text for the whole calendar. */
  app.get('/calendars/:id/ics', async (c) => {
    const ics = await buildCalendarIcs(ctx, c.get('tenantId'), c.req.param('id'));
    return c.body(ics, 200, { 'content-type': 'text/calendar; charset=utf-8' });
  });

  /* Locations */
  app.post('/locations', async (c) => {
    const body = locationCreateSchema.parse(await c.req.json());
    return c.json({ data: await createLocation(ctx, c.get('tenantId'), body, actor(c)) }, 201);
  });
  app.get('/locations', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await listLocations(ctx, c.get('tenantId'), page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });
  app.get('/locations/:id', async (c) => {
    return c.json({ data: await getLocation(ctx, c.get('tenantId'), c.req.param('id')) });
  });
  app.delete('/locations/:id', async (c) => {
    await deleteLocation(ctx, c.get('tenantId'), c.req.param('id'), actor(c));
    return c.json({ data: { deleted: true } });
  });

  /* Staff */
  app.post('/staff', async (c) => {
    const body = staffCreateSchema.parse(await c.req.json());
    return c.json({ data: await createStaffMember(ctx, c.get('tenantId'), body, actor(c)) }, 201);
  });
  app.get('/staff', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await listStaffMembers(ctx, c.get('tenantId'), page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });
  app.get('/staff/:id', async (c) => {
    return c.json({ data: await getStaffMember(ctx, c.get('tenantId'), c.req.param('id')) });
  });
  app.patch('/staff/:id', async (c) => {
    const body = staffPatchSchema.parse(await c.req.json());
    return c.json({ data: await updateStaffMember(ctx, c.get('tenantId'), c.req.param('id'), body, actor(c)) });
  });
  app.delete('/staff/:id', async (c) => {
    await deleteStaffMember(ctx, c.get('tenantId'), c.req.param('id'), actor(c));
    return c.json({ data: { deleted: true } });
  });

  /* Resources */
  app.post('/resources', async (c) => {
    const body = resourceCreateSchema.parse(await c.req.json());
    return c.json({ data: await createResource(ctx, c.get('tenantId'), body, actor(c)) }, 201);
  });
  app.get('/resources', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await listResources(ctx, c.get('tenantId'), page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });
  app.get('/resources/:id', async (c) => {
    return c.json({ data: await getResource(ctx, c.get('tenantId'), c.req.param('id')) });
  });
  app.delete('/resources/:id', async (c) => {
    await deleteResource(ctx, c.get('tenantId'), c.req.param('id'), actor(c));
    return c.json({ data: { deleted: true } });
  });

  /* Appointment types */
  app.post('/appointment-types', async (c) => {
    const body = appointmentTypeCreateSchema.parse(await c.req.json());
    return c.json({ data: await createAppointmentType(ctx, c.get('tenantId'), body, actor(c)) }, 201);
  });
  app.get('/appointment-types', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await listAppointmentTypes(ctx, c.get('tenantId'), page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });
  app.delete('/appointment-types/:id', async (c) => {
    await deleteAppointmentType(ctx, c.get('tenantId'), c.req.param('id'), actor(c));
    return c.json({ data: { deleted: true } });
  });

  /* Availability windows + exceptions */
  app.post('/availability-windows', async (c) => {
    const body = availabilityWindowCreateSchema.parse(await c.req.json());
    return c.json({ data: await createAvailabilityWindow(ctx, c.get('tenantId'), body, actor(c)) }, 201);
  });
  app.get('/availability-windows', async (c) => {
    const q = c.req.query();
    const ownerType = q.owner_type === 'staff' || q.owner_type === 'resource' ? q.owner_type : undefined;
    const rows = await listAvailabilityWindows(ctx, c.get('tenantId'), {
      ownerType,
      ownerId: q.owner_id,
    });
    return c.json({ data: rows, limit: rows.length, offset: 0 });
  });
  app.delete('/availability-windows/:id', async (c) => {
    await deleteAvailabilityWindow(ctx, c.get('tenantId'), c.req.param('id'), actor(c));
    return c.json({ data: { deleted: true } });
  });

  app.post('/availability-exceptions', async (c) => {
    const body = availabilityExceptionCreateSchema.parse(await c.req.json());
    return c.json({ data: await createAvailabilityException(ctx, c.get('tenantId'), body, actor(c)) }, 201);
  });
  app.get('/availability-exceptions', async (c) => {
    const q = c.req.query();
    const ownerType = q.owner_type === 'staff' || q.owner_type === 'resource' ? q.owner_type : undefined;
    const rows = await listAvailabilityExceptions(ctx, c.get('tenantId'), {
      ownerType,
      ownerId: q.owner_id,
      date: q.date,
    });
    return c.json({ data: rows, limit: rows.length, offset: 0 });
  });
  app.delete('/availability-exceptions/:id', async (c) => {
    await deleteAvailabilityException(ctx, c.get('tenantId'), c.req.param('id'), actor(c));
    return c.json({ data: { deleted: true } });
  });

  /** Free/busy for one staff member or resource on one local date. */
  app.get('/availability', async (c) => {
    const q = c.req.query();
    const parsed = z
      .object({
        owner_type: ownerTypeSchema,
        owner_id: z.string().min(1),
        date: z.string().min(1),
        timezone: z.string().optional(),
      })
      .parse(q);
    const result = await getAvailability(ctx, c.get('tenantId'), {
      ownerType: parsed.owner_type,
      ownerId: parsed.owner_id,
      date: parsed.date,
      timezone: parsed.timezone,
    });
    return c.json({ data: result });
  });

  // Duration-sized bookable slots, forward-scanned. `staff=any` scans every
  // active member ("first free"); otherwise pass a staff member id.
  app.get('/next-available', async (c) => {
    const parsed = z
      .object({
        appointment_type_id: z.string().min(1),
        from: z.string().min(1),
        days: z.coerce.number().int().optional(),
        timezone: z.string().optional(),
        staff: z.string().min(1),
        limit: z.coerce.number().int().optional(),
        granularity_minutes: z.coerce.number().int().optional(),
        after: z.string().optional(),
      })
      .parse(c.req.query());
    const staffAny = parsed.staff === 'any';
    const result = await findNextAvailable(ctx, c.get('tenantId'), {
      appointmentTypeId: parsed.appointment_type_id,
      from: parsed.from,
      days: parsed.days,
      timezone: parsed.timezone,
      staffId: staffAny ? undefined : parsed.staff,
      staffAny,
      limit: parsed.limit,
      granularityMinutes: parsed.granularity_minutes,
      after: parsed.after,
    });
    return c.json({ data: result });
  });

  /* Appointments */
  app.post('/appointments', async (c) => {
    const body = appointmentCreateSchema.parse(await c.req.json());
    const result = await createAppointment(ctx, c.get('tenantId'), body, actor(c));
    return c.json(
      {
        data: {
          appointments: result.appointments,
          scheduleRuleId: result.scheduleRule?.id ?? null,
        },
      },
      201,
    );
  });
  app.get('/appointments', async (c) => {
    const q = c.req.query();
    const page = parsePagination(c.req.query());
    const statusFilter = z
      .enum(['requested', 'confirmed', 'completed', 'canceled', 'no_show'])
      .optional()
      .parse(q.status === '' ? undefined : q.status);
    const rows = await listAppointments(
      ctx,
      c.get('tenantId'),
      {
        calendarId: q.calendar_id,
        status: statusFilter,
        staffId: q.staff_id,
        resourceId: q.resource_id,
        customerId: q.customer_id,
        from: q.from,
        to: q.to,
      },
      page,
    );
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });
  app.get('/appointments/:id', async (c) => {
    return c.json({ data: await getAppointment(ctx, c.get('tenantId'), c.req.param('id')) });
  });
  app.patch('/appointments/:id', async (c) => {
    const body = appointmentPatchSchema.parse(await c.req.json());
    return c.json({ data: await updateAppointment(ctx, c.get('tenantId'), c.req.param('id'), body, actor(c)) });
  });
  app.post('/appointments/:id/reschedule', async (c) => {
    const body = rescheduleSchema.parse(await c.req.json());
    return c.json({ data: await rescheduleAppointment(ctx, c.get('tenantId'), c.req.param('id'), body, actor(c)) });
  });
  app.post('/appointments/:id/cancel', async (c) => {
    const body = cancelSchema.parse(await c.req.json().catch(() => ({})));
    return c.json({
      data: await cancelAppointment(ctx, c.get('tenantId'), c.req.param('id'), {
        reason: body.reason,
        actor: actor(c),
      }),
    });
  });
  app.post('/appointments/:id/status', async (c) => {
    const body = statusSchema.parse(await c.req.json());
    return c.json({
      data: await changeAppointmentStatus(ctx, c.get('tenantId'), c.req.param('id'), body.status, {
        reason: body.reason,
        actor: actor(c),
      }),
    });
  });

  /* Reminders */
  app.post('/appointments/:id/reminders', async (c) => {
    const body = reminderCreateSchema.parse(await c.req.json());
    return c.json({ data: await createReminder(ctx, c.get('tenantId'), c.req.param('id'), body, actor(c)) }, 201);
  });
  app.get('/appointments/:id/reminders', async (c) => {
    const rows = await listRemindersForAppointment(ctx, c.get('tenantId'), c.req.param('id'));
    return c.json({ data: rows, limit: rows.length, offset: 0 });
  });
  app.get('/reminders/pending', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await listPendingReminders(ctx, c.get('tenantId'), { before: c.req.query('before') }, page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });
  app.post('/reminders/:id/send', async (c) => {
    return c.json({ data: await sendReminder(ctx, c.get('tenantId'), c.req.param('id'), actor(c)) });
  });

  return app;
}
