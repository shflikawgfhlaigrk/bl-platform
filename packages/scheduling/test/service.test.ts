import { describe, expect, it } from 'vitest';
import { ApiError, listAuditEntries, asCoreDb, type PlatformEvent } from '@blacklabel/core';
import { createSchedulingContract, seedScheduling } from '@blacklabel/scheduling';
import { sql } from '@blacklabel/db';
import {
  buildCalendarIcs,
  assertExpectedActiveStaffCount,
  cancelAppointment,
  changeAppointmentStatus,
  createAppointment,
  createAppointmentType,
  createAvailabilityException,
  createAvailabilityWindow,
  createCalendar,
  createReminder,
  createResource,
  createStaffMember,
  createSchedulingContext,
  getAppointment,
  getAvailability,
  listPendingReminders,
  rescheduleAppointment,
  sendReminder,
  type ReminderDeliveryInput,
  type ReminderDeliveryProvider,
} from '../src/service';
import { setup } from './helpers';

describe('timezone handling', () => {
  it('stores wall-clock input converted to UTC using the given IANA zone', async () => {
    const { ctx, tenantA } = await setup();
    const cal = await createCalendar(ctx, tenantA.id, { name: 'NY', timezone: 'America/New_York' });
    const { appointments } = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'Morning visit',
      startsAt: '2027-01-15T09:00:00', // EST = UTC-5
      endsAt: '2027-01-15T10:00:00',
    });
    expect(appointments[0].starts_at).toBe('2027-01-15T14:00:00.000Z');
    expect(appointments[0].ends_at).toBe('2027-01-15T15:00:00.000Z');
  });

  it('an explicit timezone param overrides the calendar zone', async () => {
    const { ctx, tenantA } = await setup();
    const cal = await createCalendar(ctx, tenantA.id, { name: 'UTC cal', timezone: 'UTC' });
    const { appointments } = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'Chicago slot',
      startsAt: '2027-06-01T09:00:00', // CDT = UTC-5
      endsAt: '2027-06-01T09:30:00',
      timezone: 'America/Chicago',
    });
    expect(appointments[0].starts_at).toBe('2027-06-01T14:00:00.000Z');
  });

  it('rejects an invalid IANA timezone', async () => {
    const { ctx, tenantA } = await setup();
    await expect(
      createCalendar(ctx, tenantA.id, { name: 'Bad', timezone: 'Not/AZone' }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('recurrence (RRULE-lite)', () => {
  it('daily with count materializes N occurrences sharing one schedule rule', async () => {
    const { ctx, tenantA, db } = await setup();
    const cal = await createCalendar(ctx, tenantA.id, { name: 'C', timezone: 'UTC' });
    const { appointments, scheduleRule } = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'Daily standup',
      startsAt: '2027-03-01T15:00:00Z',
      endsAt: '2027-03-01T15:30:00Z',
      recurrence: { frequency: 'daily', count: 5 },
    });
    expect(appointments).toHaveLength(5);
    expect(scheduleRule).not.toBeNull();
    expect(appointments.map((a) => a.starts_at)).toEqual([
      '2027-03-01T15:00:00.000Z',
      '2027-03-02T15:00:00.000Z',
      '2027-03-03T15:00:00.000Z',
      '2027-03-04T15:00:00.000Z',
      '2027-03-05T15:00:00.000Z',
    ]);
    for (const a of appointments) expect(a.schedule_rule_id).toBe(scheduleRule!.id);

    const rules = await db
      .selectFrom('scheduling_schedule_rules')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .execute();
    expect(rules).toHaveLength(1);
    expect(rules[0].frequency).toBe('daily');
    expect(rules[0].count).toBe(5);
  });

  it('weekly with until stops at the inclusive bound', async () => {
    const { ctx, tenantA } = await setup();
    const cal = await createCalendar(ctx, tenantA.id, { name: 'C', timezone: 'UTC' });
    const { appointments } = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'Weekly sync',
      startsAt: '2027-03-01T10:00:00Z',
      endsAt: '2027-03-01T11:00:00Z',
      recurrence: { frequency: 'weekly', until: '2027-03-22T10:00:00Z' },
    });
    expect(appointments.map((a) => a.starts_at)).toEqual([
      '2027-03-01T10:00:00.000Z',
      '2027-03-08T10:00:00.000Z',
      '2027-03-15T10:00:00.000Z',
      '2027-03-22T10:00:00.000Z',
    ]);
  });

  it('monthly with interval=2 steps two months per occurrence', async () => {
    const { ctx, tenantA } = await setup();
    const cal = await createCalendar(ctx, tenantA.id, { name: 'C', timezone: 'UTC' });
    const { appointments } = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'Bi-monthly review',
      startsAt: '2027-01-10T09:00:00Z',
      endsAt: '2027-01-10T10:00:00Z',
      recurrence: { frequency: 'monthly', interval: 2, count: 3 },
    });
    expect(appointments.map((a) => a.starts_at)).toEqual([
      '2027-01-10T09:00:00.000Z',
      '2027-03-10T09:00:00.000Z',
      '2027-05-10T09:00:00.000Z',
    ]);
  });

  it('weekly recurrence keeps local wall-clock time across a DST transition', async () => {
    const { ctx, tenantA } = await setup();
    const cal = await createCalendar(ctx, tenantA.id, { name: 'NY', timezone: 'America/New_York' });
    // US DST ends 2027-11-07: EDT (UTC-4) -> EST (UTC-5).
    const { appointments } = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'Weekly 9am local',
      startsAt: '2027-11-04T09:00:00',
      endsAt: '2027-11-04T09:30:00',
      recurrence: { frequency: 'weekly', count: 2 },
    });
    expect(appointments[0].starts_at).toBe('2027-11-04T13:00:00.000Z'); // EDT
    expect(appointments[1].starts_at).toBe('2027-11-11T14:00:00.000Z'); // EST — same 9am local
  });

  it('rejects an until bound that exceeds the occurrence cap instead of silently truncating', async () => {
    const { ctx, tenantA, db } = await setup();
    const cal = await createCalendar(ctx, tenantA.id, { name: 'C', timezone: 'UTC' });
    await expect(
      createAppointment(ctx, tenantA.id, {
        calendarId: cal.id,
        title: 'Daily forever',
        startsAt: '2027-01-01T10:00:00Z',
        endsAt: '2027-01-01T11:00:00Z',
        recurrence: { frequency: 'daily', until: '2027-07-20T10:00:00Z' }, // ~200 occurrences
      }),
    ).rejects.toMatchObject({ status: 400 });
    // Nothing half-created.
    const appts = await db
      .selectFrom('scheduling_appointments')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .execute();
    expect(appts).toEqual([]);
    const rules = await db
      .selectFrom('scheduling_schedule_rules')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .execute();
    expect(rules).toEqual([]);
  });

  it('rejects recurrence with neither count nor until, or with both', async () => {
    const { ctx, tenantA } = await setup();
    const cal = await createCalendar(ctx, tenantA.id, { name: 'C', timezone: 'UTC' });
    const base = {
      calendarId: cal.id,
      title: 'X',
      startsAt: '2027-03-01T10:00:00Z',
      endsAt: '2027-03-01T11:00:00Z',
    };
    await expect(
      createAppointment(ctx, tenantA.id, { ...base, recurrence: { frequency: 'daily' } }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      createAppointment(ctx, tenantA.id, {
        ...base,
        recurrence: { frequency: 'daily', count: 2, until: '2027-04-01T00:00:00Z' },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('conflict detection', () => {
  it('rejects a staff double-booking with 409 and conflict details', async () => {
    const { ctx, tenantA } = await setup();
    const cal = await createCalendar(ctx, tenantA.id, { name: 'C', timezone: 'UTC' });
    const staff = await createStaffMember(ctx, tenantA.id, { name: 'Sam' });
    const first = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'First',
      startsAt: '2027-04-01T10:00:00Z',
      endsAt: '2027-04-01T11:00:00Z',
      staffIds: [staff.id],
    });
    const err = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'Overlapping',
      startsAt: '2027-04-01T10:30:00Z',
      endsAt: '2027-04-01T11:30:00Z',
      staffIds: [staff.id],
    }).catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    const details = (err as ApiError).details as { conflicts: any[] };
    expect(details.conflicts).toHaveLength(1);
    expect(details.conflicts[0]).toMatchObject({
      owner_type: 'staff',
      owner_id: staff.id,
      appointment_id: first.appointments[0].id,
    });
  });

  it('rejects a resource double-booking', async () => {
    const { ctx, tenantA } = await setup();
    const cal = await createCalendar(ctx, tenantA.id, { name: 'C', timezone: 'UTC' });
    const room = await createResource(ctx, tenantA.id, { name: 'Room 1' });
    await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'Uses room',
      startsAt: '2027-04-01T10:00:00Z',
      endsAt: '2027-04-01T11:00:00Z',
      resourceIds: [room.id],
    });
    await expect(
      createAppointment(ctx, tenantA.id, {
        calendarId: cal.id,
        title: 'Wants same room',
        startsAt: '2027-04-01T10:59:00Z',
        endsAt: '2027-04-01T12:00:00Z',
        resourceIds: [room.id],
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('appointment-type buffers extend the blocked window', async () => {
    const { ctx, tenantA } = await setup();
    const cal = await createCalendar(ctx, tenantA.id, { name: 'C', timezone: 'UTC' });
    const staff = await createStaffMember(ctx, tenantA.id, { name: 'Sam' });
    const type = await createAppointmentType(ctx, tenantA.id, {
      name: 'Padded',
      durationMinutes: 60,
      bufferAfterMinutes: 30,
    });
    await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'Padded job',
      appointmentTypeId: type.id,
      startsAt: '2027-04-01T10:00:00Z', // ends 11:00, blocked until 11:30
      staffIds: [staff.id],
    });
    // 11:15 starts inside the buffer -> conflict, even with no direct overlap.
    await expect(
      createAppointment(ctx, tenantA.id, {
        calendarId: cal.id,
        title: 'Too soon',
        startsAt: '2027-04-01T11:15:00Z',
        endsAt: '2027-04-01T11:45:00Z',
        staffIds: [staff.id],
      }),
    ).rejects.toMatchObject({ status: 409 });
    // 11:30 is exactly at the end of the buffer -> allowed.
    const ok = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'Right after buffer',
      startsAt: '2027-04-01T11:30:00Z',
      endsAt: '2027-04-01T12:00:00Z',
      staffIds: [staff.id],
    });
    expect(ok.appointments).toHaveLength(1);
  });

  it('does not conflict with canceled appointments or different staff', async () => {
    const { ctx, tenantA } = await setup();
    const cal = await createCalendar(ctx, tenantA.id, { name: 'C', timezone: 'UTC' });
    const staff1 = await createStaffMember(ctx, tenantA.id, { name: 'S1' });
    const staff2 = await createStaffMember(ctx, tenantA.id, { name: 'S2' });
    const first = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'Original',
      startsAt: '2027-04-01T10:00:00Z',
      endsAt: '2027-04-01T11:00:00Z',
      staffIds: [staff1.id],
    });
    // Different staff, same time: fine.
    await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'Parallel',
      startsAt: '2027-04-01T10:00:00Z',
      endsAt: '2027-04-01T11:00:00Z',
      staffIds: [staff2.id],
    });
    // Cancel the original; its slot frees up.
    await cancelAppointment(ctx, tenantA.id, first.appointments[0].id);
    const replacement = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'Replacement',
      startsAt: '2027-04-01T10:00:00Z',
      endsAt: '2027-04-01T11:00:00Z',
      staffIds: [staff1.id],
    });
    expect(replacement.appointments).toHaveLength(1);
  });

  it('reschedule re-checks conflicts but ignores the appointment itself', async () => {
    const { ctx, tenantA } = await setup();
    const cal = await createCalendar(ctx, tenantA.id, { name: 'C', timezone: 'UTC' });
    const staff = await createStaffMember(ctx, tenantA.id, { name: 'Sam' });
    const a = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'A',
      startsAt: '2027-04-01T10:00:00Z',
      endsAt: '2027-04-01T11:00:00Z',
      staffIds: [staff.id],
    });
    const b = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'B',
      startsAt: '2027-04-01T14:00:00Z',
      endsAt: '2027-04-01T15:00:00Z',
      staffIds: [staff.id],
    });
    // Shifting A by 15 minutes overlaps only itself -> allowed.
    const moved = await rescheduleAppointment(ctx, tenantA.id, a.appointments[0].id, {
      startsAt: '2027-04-01T10:15:00Z',
      endsAt: '2027-04-01T11:15:00Z',
      timezone: 'UTC',
    });
    expect(moved.starts_at).toBe('2027-04-01T10:15:00.000Z');
    // Moving A onto B -> 409.
    await expect(
      rescheduleAppointment(ctx, tenantA.id, a.appointments[0].id, {
        startsAt: '2027-04-01T14:30:00Z',
        timezone: 'UTC',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('status transitions', () => {
  it('follows requested -> confirmed -> completed and rejects invalid jumps', async () => {
    const { ctx, tenantA } = await setup();
    const cal = await createCalendar(ctx, tenantA.id, { name: 'C', timezone: 'UTC' });
    const { appointments } = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'Flow',
      startsAt: '2027-04-01T10:00:00Z',
      endsAt: '2027-04-01T11:00:00Z',
      status: 'requested',
    });
    const apptId = appointments[0].id;

    // requested -> completed is not allowed.
    await expect(
      changeAppointmentStatus(ctx, tenantA.id, apptId, 'completed'),
    ).rejects.toMatchObject({ status: 409 });

    const confirmed = await changeAppointmentStatus(ctx, tenantA.id, apptId, 'confirmed');
    expect(confirmed.status).toBe('confirmed');
    const completed = await changeAppointmentStatus(ctx, tenantA.id, apptId, 'completed');
    expect(completed.status).toBe('completed');

    // Terminal: nothing else allowed.
    await expect(
      changeAppointmentStatus(ctx, tenantA.id, apptId, 'canceled'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('confirmed -> no_show works; canceled is terminal and cannot be rescheduled', async () => {
    const { ctx, tenantA } = await setup();
    const cal = await createCalendar(ctx, tenantA.id, { name: 'C', timezone: 'UTC' });
    const { appointments } = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'NS',
      startsAt: '2027-04-01T10:00:00Z',
      endsAt: '2027-04-01T11:00:00Z',
    });
    const ns = await changeAppointmentStatus(ctx, tenantA.id, appointments[0].id, 'no_show');
    expect(ns.status).toBe('no_show');

    const second = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'To cancel',
      startsAt: '2027-04-02T10:00:00Z',
      endsAt: '2027-04-02T11:00:00Z',
    });
    await cancelAppointment(ctx, tenantA.id, second.appointments[0].id, { reason: 'customer request' });
    const row = await getAppointment(ctx, tenantA.id, second.appointments[0].id);
    expect(row.status).toBe('canceled');
    expect(row.canceled_reason).toBe('customer request');
    await expect(
      rescheduleAppointment(ctx, tenantA.id, second.appointments[0].id, { startsAt: '2027-04-03T10:00:00Z' }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('events', () => {
  it('emits scheduled / completed / canceled with catalog payloads', async () => {
    const { ctx, events, tenantA } = await setup();
    const received: PlatformEvent[] = [];
    events.on('scheduling.appointment.scheduled', (e) => void received.push(e));
    events.on('scheduling.appointment.completed', (e) => void received.push(e));
    events.on('scheduling.appointment.canceled', (e) => void received.push(e));

    const cal = await createCalendar(ctx, tenantA.id, { name: 'C', timezone: 'UTC' });
    const { appointments } = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'Evented',
      customerId: 'customer-123',
      startsAt: '2027-04-01T10:00:00Z',
      endsAt: '2027-04-01T11:00:00Z',
    });
    const apptId = appointments[0].id;
    await changeAppointmentStatus(ctx, tenantA.id, apptId, 'completed');

    const second = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'Cancel me',
      startsAt: '2027-04-02T10:00:00Z',
      endsAt: '2027-04-02T11:00:00Z',
    });
    await cancelAppointment(ctx, tenantA.id, second.appointments[0].id, { reason: 'weather' });

    const types = received.map((e) => e.type);
    expect(types).toEqual([
      'scheduling.appointment.scheduled',
      'scheduling.appointment.completed',
      'scheduling.appointment.scheduled',
      'scheduling.appointment.canceled',
    ]);
    expect(received[0].tenantId).toBe(tenantA.id);
    expect(received[0].payload).toEqual({
      appointmentId: apptId,
      customerId: 'customer-123',
      startsAt: '2027-04-01T10:00:00.000Z',
    });
    expect(received[1].payload).toEqual({ appointmentId: apptId });
    expect(received[3].payload).toEqual({
      appointmentId: second.appointments[0].id,
      reason: 'weather',
    });
  });

  it('emits one scheduled event per materialized occurrence', async () => {
    const { ctx, events, tenantA } = await setup();
    let count = 0;
    events.on('scheduling.appointment.scheduled', () => void count++);
    const cal = await createCalendar(ctx, tenantA.id, { name: 'C', timezone: 'UTC' });
    await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'Recurring',
      startsAt: '2027-04-01T10:00:00Z',
      endsAt: '2027-04-01T11:00:00Z',
      recurrence: { frequency: 'daily', count: 3 },
    });
    expect(count).toBe(3);
  });
});

describe('availability', () => {
  it('computes free slots from weekly windows minus exceptions and bookings', async () => {
    const { ctx, tenantA } = await setup();
    const zone = 'America/Chicago'; // CDT = UTC-5 on 2027-06-07 (a Monday)
    const cal = await createCalendar(ctx, tenantA.id, { name: 'C', timezone: zone });
    const staff = await createStaffMember(ctx, tenantA.id, { name: 'Sam' });
    await createAvailabilityWindow(ctx, tenantA.id, {
      ownerType: 'staff',
      ownerId: staff.id,
      weekday: 1, // Monday
      startTime: '09:00',
      endTime: '17:00',
    });
    // Afternoon off.
    await createAvailabilityException(ctx, tenantA.id, {
      ownerType: 'staff',
      ownerId: staff.id,
      date: '2027-06-07',
      available: false,
      startTime: '13:00',
      endTime: '17:00',
    });
    // Booked 10:00–10:30 local with a 30-minute after-buffer -> blocks until 11:00 local.
    const type = await createAppointmentType(ctx, tenantA.id, {
      name: 'Buffered',
      durationMinutes: 30,
      bufferAfterMinutes: 30,
    });
    await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'Booked',
      appointmentTypeId: type.id,
      startsAt: '2027-06-07T10:00:00',
      staffIds: [staff.id],
    });

    const result = await getAvailability(ctx, tenantA.id, {
      ownerType: 'staff',
      ownerId: staff.id,
      date: '2027-06-07',
      timezone: zone,
    });
    // Local free: 09:00–10:00 and 11:00–13:00 -> UTC 14:00–15:00 and 16:00–18:00.
    expect(result.free).toEqual([
      { starts_at: '2027-06-07T14:00:00.000Z', ends_at: '2027-06-07T15:00:00.000Z' },
      { starts_at: '2027-06-07T16:00:00.000Z', ends_at: '2027-06-07T18:00:00.000Z' },
    ]);
  });

  it('a whole-day unavailable exception clears the day; an available exception adds hours', async () => {
    const { ctx, tenantA } = await setup();
    const staff = await createStaffMember(ctx, tenantA.id, { name: 'Sam' });
    await createAvailabilityWindow(ctx, tenantA.id, {
      ownerType: 'staff',
      ownerId: staff.id,
      weekday: 1,
      startTime: '09:00',
      endTime: '17:00',
    });
    await createAvailabilityException(ctx, tenantA.id, {
      ownerType: 'staff',
      ownerId: staff.id,
      date: '2027-06-07',
      available: false,
      reason: 'holiday',
    });
    const off = await getAvailability(ctx, tenantA.id, {
      ownerType: 'staff',
      ownerId: staff.id,
      date: '2027-06-07',
      timezone: 'UTC',
    });
    expect(off.free).toEqual([]);

    // Saturday has no window, but an available=true exception opens hours.
    await createAvailabilityException(ctx, tenantA.id, {
      ownerType: 'staff',
      ownerId: staff.id,
      date: '2027-06-12',
      available: true,
      startTime: '10:00',
      endTime: '12:00',
    });
    const extra = await getAvailability(ctx, tenantA.id, {
      ownerType: 'staff',
      ownerId: staff.id,
      date: '2027-06-12',
      timezone: 'UTC',
    });
    expect(extra.free).toEqual([
      { starts_at: '2027-06-12T10:00:00.000Z', ends_at: '2027-06-12T12:00:00.000Z' },
    ]);
  });
});

describe('reminders', () => {
  it('lists pending reminders due before a cutoff and delivers via the stub provider', async () => {
    const { ctx, tenantA, reminderDelivery, events } = await setup();
    const cal = await createCalendar(ctx, tenantA.id, { name: 'C', timezone: 'UTC' });
    const { appointments } = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'With reminder',
      startsAt: '2027-04-01T10:00:00Z',
      endsAt: '2027-04-01T11:00:00Z',
    });
    const reminder = await createReminder(ctx, tenantA.id, appointments[0].id, {
      sendAt: '2027-03-31T10:00:00Z',
      channel: 'email',
      recipient: 'c@example.com',
      message: 'See you tomorrow',
    });

    const notYet = await listPendingReminders(ctx, tenantA.id, { before: '2027-03-30T00:00:00Z' });
    expect(notYet).toEqual([]);
    const due = await listPendingReminders(ctx, tenantA.id, { before: '2027-03-31T12:00:00Z' });
    expect(due.map((r) => r.id)).toEqual([reminder.id]);

    let sentEvent: PlatformEvent | undefined;
    events.on('scheduling.reminder.sent', (e) => void (sentEvent = e));
    const sent = await sendReminder(ctx, tenantA.id, reminder.id);
    expect(sent.status).toBe('sent');
    expect(sent.provider).toBe('test');
    expect(reminderDelivery.deliveries).toHaveLength(1);
    expect(reminderDelivery.deliveries[0]).toMatchObject({
      reminderId: reminder.id,
      recipient: 'c@example.com',
      channel: 'email',
    });
    expect(sentEvent?.payload).toEqual({
      reminderId: reminder.id,
      appointmentId: appointments[0].id,
      channel: 'email',
    });

    // Already sent -> conflict; and it left the pending queue.
    await expect(sendReminder(ctx, tenantA.id, reminder.id)).rejects.toMatchObject({ status: 409 });
    expect(await listPendingReminders(ctx, tenantA.id, { before: '2027-04-01T00:00:00Z' })).toEqual([]);
  });

  it('canceling an appointment cancels its pending reminders', async () => {
    const { ctx, tenantA, db } = await setup();
    const cal = await createCalendar(ctx, tenantA.id, { name: 'C', timezone: 'UTC' });
    const { appointments } = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'Cancel cascades',
      startsAt: '2027-04-01T10:00:00Z',
      endsAt: '2027-04-01T11:00:00Z',
    });
    const reminder = await createReminder(ctx, tenantA.id, appointments[0].id, {
      sendAt: '2027-03-31T10:00:00Z',
      channel: 'sms',
      recipient: '+15550001111',
    });
    await cancelAppointment(ctx, tenantA.id, appointments[0].id);
    const row = await db
      .selectFrom('scheduling_reminders')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .where('id', '=', reminder.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('canceled');
  });
});

describe('ICS export', () => {
  it('produces a valid VCALENDAR with UTC times, escaping, and no canceled events', async () => {
    const { ctx, tenantA } = await setup();
    const cal = await createCalendar(ctx, tenantA.id, { name: 'Team Calendar', timezone: 'America/New_York' });
    const kept = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'Review; part 1, with client',
      startsAt: '2027-01-15T09:00:00', // EST -> 14:00Z
      endsAt: '2027-01-15T10:00:00',
      notes: 'internal-only note',
    });
    const toCancel = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'Will be canceled',
      startsAt: '2027-01-16T09:00:00',
      endsAt: '2027-01-16T10:00:00',
    });
    await cancelAppointment(ctx, tenantA.id, toCancel.appointments[0].id);

    const ics = await buildCalendarIcs(ctx, tenantA.id, cal.id);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('X-WR-CALNAME:Team Calendar');
    expect(ics).toContain('X-WR-TIMEZONE:America/New_York');
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(1);
    expect(ics).toContain(`UID:${kept.appointments[0].id}@blacklabel.scheduling`);
    expect(ics).toContain('DTSTART:20270115T140000Z');
    expect(ics).toContain('DTEND:20270115T150000Z');
    expect(ics).toContain('SUMMARY:Review\\; part 1\\, with client');
    expect(ics).toContain('STATUS:CONFIRMED');
    expect(ics).not.toContain('Will be canceled');
    expect(ics).not.toContain('internal-only note'); // notes never exported
  });
});

describe('CreateAppointmentContract implementation', () => {
  it('creates an appointment (and a default calendar) and maps assigneeUserId to staff', async () => {
    const { ctx, db, events, tenantA } = await setup();
    const staff = await createStaffMember(ctx, tenantA.id, { name: 'Sam', userId: 'user-42' });
    const contract = createSchedulingContract({ db, events });

    const { id: apptId } = await contract.createAppointment({
      tenantId: tenantA.id,
      customerId: 'customer-9',
      startsAt: '2027-05-01T10:00:00Z',
      endsAt: '2027-05-01T11:00:00Z',
      assigneeUserId: 'user-42',
      serviceKey: 'consultation',
      notes: 'from workflows',
    });

    const appt = await getAppointment(ctx, tenantA.id, apptId);
    expect(appt.customer_id).toBe('customer-9');
    expect(appt.title).toBe('consultation');
    expect(appt.notes).toBe('from workflows');
    expect(appt.staff_ids).toEqual([staff.id]);
    expect(appt.starts_at).toBe('2027-05-01T10:00:00.000Z');

    // A default calendar was created because the tenant had none.
    const calendars = await db
      .selectFrom('scheduling_calendars')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .execute();
    expect(calendars).toHaveLength(1);
    expect(calendars[0].name).toBe('Default');
  });
});

describe('launch-safety regressions', () => {
  it('serializes simultaneous booking attempts for the same practitioner', async () => {
    const { ctx, tenantA, db } = await setup();
    const cal = await createCalendar(ctx, tenantA.id, { name: 'C', timezone: 'UTC' });
    const staff = await createStaffMember(ctx, tenantA.id, { name: 'Sam' });
    const attempts = await Promise.allSettled([
      createAppointment(ctx, tenantA.id, {
        calendarId: cal.id,
        title: 'A',
        startsAt: '2027-09-01T10:00:00Z',
        endsAt: '2027-09-01T11:00:00Z',
        staffIds: [staff.id],
      }),
      createAppointment(ctx, tenantA.id, {
        calendarId: cal.id,
        title: 'B',
        startsAt: '2027-09-01T10:30:00Z',
        endsAt: '2027-09-01T11:30:00Z',
        staffIds: [staff.id],
      }),
    ]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await db.selectFrom('scheduling_appointments').selectAll().execute()).toHaveLength(1);
  });

  it('rolls back the entire recurrence when a later occurrence insert fails', async () => {
    const { ctx, tenantA, db } = await setup();
    const cal = await createCalendar(ctx, tenantA.id, { name: 'C', timezone: 'UTC' });
    await sql.raw(`
      CREATE TRIGGER fail_second_recurrence_insert
      BEFORE INSERT ON scheduling_appointments
      WHEN (SELECT COUNT(*) FROM scheduling_appointments) >= 1
      BEGIN SELECT RAISE(ABORT, 'injected recurrence failure'); END
    `).execute(db);
    await expect(
      createAppointment(ctx, tenantA.id, {
        calendarId: cal.id,
        title: 'Series',
        startsAt: '2027-09-01T10:00:00Z',
        endsAt: '2027-09-01T11:00:00Z',
        recurrence: { frequency: 'daily', count: 3 },
      }),
    ).rejects.toThrow('injected recurrence failure');
    expect(await db.selectFrom('scheduling_appointments').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('scheduling_schedule_rules').selectAll().execute()).toEqual([]);
  });

  it('rejects inactive staff, resources, and appointment types', async () => {
    const { ctx, tenantA } = await setup();
    const cal = await createCalendar(ctx, tenantA.id, { name: 'C', timezone: 'UTC' });
    const staff = await createStaffMember(ctx, tenantA.id, { name: 'Former', active: false });
    const resource = await createResource(ctx, tenantA.id, { name: 'Closed room', active: false });
    const type = await createAppointmentType(ctx, tenantA.id, {
      name: 'Disabled service',
      durationMinutes: 30,
      active: false,
    });
    const base = {
      calendarId: cal.id,
      title: 'Blocked',
      startsAt: '2027-09-01T10:00:00Z',
      endsAt: '2027-09-01T11:00:00Z',
    };
    await expect(createAppointment(ctx, tenantA.id, { ...base, staffIds: [staff.id] })).rejects.toMatchObject({ status: 409 });
    await expect(createAppointment(ctx, tenantA.id, { ...base, resourceIds: [resource.id] })).rejects.toMatchObject({ status: 409 });
    await expect(createAppointment(ctx, tenantA.id, { ...base, appointmentTypeId: type.id })).rejects.toMatchObject({ status: 409 });
  });

  it('keeps reminders pending when no real provider is configured', async () => {
    const { db, events, tenantA, ctx } = await setup();
    const failClosedCtx = createSchedulingContext({ db, events });
    const cal = await createCalendar(ctx, tenantA.id, { name: 'C', timezone: 'UTC' });
    const { appointments } = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'Reminder',
      startsAt: '2027-09-01T10:00:00Z',
      endsAt: '2027-09-01T11:00:00Z',
    });
    const reminder = await createReminder(ctx, tenantA.id, appointments[0].id, {
      sendAt: '2027-08-31T10:00:00Z',
      channel: 'sms',
      recipient: '+15550001111',
    });
    await expect(sendReminder(failClosedCtx, tenantA.id, reminder.id)).rejects.toMatchObject({ status: 409 });
    const row = await db.selectFrom('scheduling_reminders').selectAll().where('id', '=', reminder.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('pending');
    expect(row.sent_at).toBeNull();
  });

  it('claims a reminder before delivery so concurrent sends deliver once', async () => {
    const { db, events, tenantA, ctx } = await setup();
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    const releasePromise = new Promise<void>((resolve) => (release = resolve));
    class BlockingProvider implements ReminderDeliveryProvider {
      readonly name = 'blocking-test';
      calls = 0;
      async deliver(_input: ReminderDeliveryInput): Promise<{ delivered: boolean }> {
        this.calls += 1;
        started();
        await releasePromise;
        return { delivered: true };
      }
    }
    const provider = new BlockingProvider();
    const blockingCtx = createSchedulingContext({ db, events, reminderDelivery: provider });
    const cal = await createCalendar(ctx, tenantA.id, { name: 'C', timezone: 'UTC' });
    const { appointments } = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'Reminder',
      startsAt: '2027-09-01T10:00:00Z',
      endsAt: '2027-09-01T11:00:00Z',
    });
    const reminder = await createReminder(ctx, tenantA.id, appointments[0].id, {
      sendAt: '2027-08-31T10:00:00Z',
      channel: 'email',
      recipient: 'c@example.com',
    });
    const first = sendReminder(blockingCtx, tenantA.id, reminder.id);
    await startedPromise;
    await expect(sendReminder(blockingCtx, tenantA.id, reminder.id)).rejects.toMatchObject({ status: 409 });
    release();
    await expect(first).resolves.toMatchObject({ status: 'sent' });
    expect(provider.calls).toBe(1);
  });

  it('reports calendar sync failure and enforces expected_staff_count=5', async () => {
    const { ctx, db, tenantA } = await setup();
    const cal = await createCalendar(ctx, tenantA.id, { name: 'C', timezone: 'UTC' });
    const { appointments } = await createAppointment(ctx, tenantA.id, {
      calendarId: cal.id,
      title: 'Unsynced',
      startsAt: '2027-09-01T10:00:00Z',
      endsAt: '2027-09-01T11:00:00Z',
    });
    expect(appointments[0].calendar_sync_status).toBe('failed');
    expect(appointments[0].calendar_sync_error).toContain('not configured');

    const syncedCtx = createSchedulingContext({
      db,
      events: ctx.events,
      calendarSync: {
        name: 'real-test',
        async upsertEvent(event) {
          return { externalId: `external:${event.appointmentId}` };
        },
        async deleteEvent() {},
      },
    });
    const synced = await createAppointment(syncedCtx, tenantA.id, {
      calendarId: cal.id,
      title: 'Synced',
      startsAt: '2027-09-01T12:00:00Z',
      endsAt: '2027-09-01T13:00:00Z',
    });
    expect(synced.appointments[0]).toMatchObject({
      calendar_sync_status: 'synced',
      calendar_sync_error: null,
      calendar_external_id: `external:${synced.appointments[0].id}`,
    });

    for (let i = 0; i < 5; i++) await createStaffMember(ctx, tenantA.id, { name: `Staff ${i + 1}` });
    await expect(assertExpectedActiveStaffCount(db, tenantA.id, { expected_staff_count: 4 })).rejects.toMatchObject({
      status: 409,
      details: { expected_staff_count: 4, active_staff_count: 5 },
    });
    await expect(assertExpectedActiveStaffCount(db, tenantA.id, { expected_staff_count: 5 })).resolves.toEqual({
      expected_staff_count: 5,
      active_staff_count: 5,
    });
  });
});

describe('audit + seed', () => {
  it('audits appointment mutations', async () => {
    const { ctx, db, tenantA } = await setup();
    const cal = await createCalendar(ctx, tenantA.id, { name: 'C', timezone: 'UTC' });
    const { appointments } = await createAppointment(
      ctx,
      tenantA.id,
      {
        calendarId: cal.id,
        title: 'Audited',
        startsAt: '2027-04-01T10:00:00Z',
        endsAt: '2027-04-01T11:00:00Z',
      },
      'user-7',
    );
    const entries = await listAuditEntries(
      asCoreDb(db),
      tenantA.id,
      'scheduling.appointment',
      appointments[0].id,
    );
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].actor).toBe('user-7');
    expect(entries[0].action).toBe('scheduling.appointment.created');
  });

  it('seedScheduling populates a working demo dataset', async () => {
    const { db, events, tenantA, ctx } = await setup();
    const result = await seedScheduling(db, tenantA.id, events);
    expect(result.staffIds).toHaveLength(2);
    expect(result.appointmentIds.length).toBe(5); // 1 single + 4 weekly occurrences
    const appts = await db
      .selectFrom('scheduling_appointments')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .execute();
    expect(appts).toHaveLength(5);
    const reminder = await db
      .selectFrom('scheduling_reminders')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .execute();
    expect(reminder).toHaveLength(1);
    expect(reminder[0].status).toBe('pending');
    // Seeded ICS is valid too.
    const ics = await buildCalendarIcs(ctx, tenantA.id, result.calendarId);
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(5);
  });
});
