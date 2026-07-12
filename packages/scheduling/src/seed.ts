/**
 * Demo data for the scheduling module. Industry-neutral names; dates are
 * relative to "now" so seeded appointments are always in the future.
 */
import type { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import { EventBus } from '@blacklabel/core';
import type { SchedulingDatabase } from './schema';
import {
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
} from './service';

export interface SchedulingSeedResult {
  calendarId: string;
  locationId: string;
  staffIds: string[];
  resourceId: string;
  appointmentTypeIds: string[];
  appointmentIds: string[];
  reminderId: string;
}

export async function seedScheduling(
  db: Kysely<SchedulingDatabase>,
  tenantId: string,
  events: EventBus = new EventBus(),
): Promise<SchedulingSeedResult> {
  const ctx = createSchedulingContext({ db, events });
  const zone = 'America/Chicago';

  const calendar = await createCalendar(ctx, tenantId, {
    name: 'Main Calendar',
    timezone: zone,
    description: 'Primary booking calendar',
  });
  const location = await createLocation(ctx, tenantId, {
    name: 'Main Office',
    address: '100 Main St',
    timezone: zone,
  });
  const staffA = await createStaffMember(ctx, tenantId, { name: 'Alex Morgan', email: 'alex@example.com' });
  const staffB = await createStaffMember(ctx, tenantId, { name: 'Bailey Reed', email: 'bailey@example.com' });
  const room = await createResource(ctx, tenantId, { name: 'Room 1', kind: 'room', locationId: location.id });

  const consult = await createAppointmentType(ctx, tenantId, {
    name: 'Consultation',
    durationMinutes: 30,
    bufferBeforeMinutes: 5,
    bufferAfterMinutes: 10,
  });
  const fullService = await createAppointmentType(ctx, tenantId, {
    name: 'Full Service',
    durationMinutes: 60,
    bufferBeforeMinutes: 10,
    bufferAfterMinutes: 15,
  });

  // Weekday availability 09:00–17:00 for both staff, and for the room.
  for (const owner of [
    { ownerType: 'staff' as const, ownerId: staffA.id },
    { ownerType: 'staff' as const, ownerId: staffB.id },
    { ownerType: 'resource' as const, ownerId: room.id },
  ]) {
    for (let weekday = 1; weekday <= 5; weekday++) {
      await createAvailabilityWindow(ctx, tenantId, {
        ...owner,
        weekday,
        startTime: '09:00',
        endTime: '17:00',
      });
    }
  }

  // Next Monday in the calendar zone.
  const now = DateTime.now().setZone(zone);
  const nextMonday = now.plus({ days: ((8 - now.weekday) % 7) + 7 }).startOf('day');

  // Staff A takes that Monday afternoon off.
  await createAvailabilityException(ctx, tenantId, {
    ownerType: 'staff',
    ownerId: staffA.id,
    date: nextMonday.toISODate()!,
    available: false,
    startTime: '13:00',
    endTime: '17:00',
    reason: 'Training',
  });

  const morning = await createAppointment(ctx, tenantId, {
    calendarId: calendar.id,
    title: 'Consultation — new customer',
    appointmentTypeId: consult.id,
    startsAt: nextMonday.set({ hour: 9, minute: 30 }).toISO()!,
    staffIds: [staffA.id],
    resourceIds: [room.id],
    locationId: location.id,
    notes: 'First visit; confirm contact details.',
  });

  const weekly = await createAppointment(ctx, tenantId, {
    calendarId: calendar.id,
    title: 'Weekly service',
    appointmentTypeId: fullService.id,
    startsAt: nextMonday.set({ hour: 11 }).toISO()!,
    staffIds: [staffB.id],
    recurrence: { frequency: 'weekly', count: 4 },
  });

  const firstAppointment = morning.appointments[0];
  const reminder = await createReminder(ctx, tenantId, firstAppointment.id, {
    sendAt: DateTime.fromISO(firstAppointment.starts_at, { zone: 'utc' }).minus({ hours: 24 }).toISO()!,
    channel: 'email',
    recipient: 'customer@example.com',
    message: 'Reminder: your appointment is tomorrow.',
  });

  return {
    calendarId: calendar.id,
    locationId: location.id,
    staffIds: [staffA.id, staffB.id],
    resourceId: room.id,
    appointmentTypeIds: [consult.id, fullService.id],
    appointmentIds: [
      ...morning.appointments.map((a) => a.id),
      ...weekly.appointments.map((a) => a.id),
    ],
    reminderId: reminder.id,
  };
}
