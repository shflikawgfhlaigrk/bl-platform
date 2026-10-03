import { describe, expect, it } from 'vitest';
import { api, setup } from './helpers';
import {
  createAppointment,
  createAppointmentType,
  createAvailabilityException,
  createAvailabilityWindow,
  createCalendar,
  createResource,
  createStaffMember,
  findNextAvailable,
  getAppointment,
  getAvailability,
  rescheduleAppointment,
} from '../src/service';

const MONDAY = '2027-06-07';

describe('booking admission follows configured owner availability', () => {
  it('preserves direct booking for an owner without hours, but respects explicit time off', async () => {
    const { ctx, tenantA } = await setup();
    const calendar = await createCalendar(ctx, tenantA.id, { name: 'Main', timezone: 'UTC' });
    const staff = await createStaffMember(ctx, tenantA.id, { name: 'Crew' });
    const input = { calendarId: calendar.id, title: 'Job', startsAt: `${MONDAY}T10:00:00Z`, endsAt: `${MONDAY}T11:00:00Z`, staffIds: [staff.id] };
    await expect(createAppointment(ctx, tenantA.id, input)).resolves.toMatchObject({ appointments: [{ status: 'confirmed' }] });
    await createAvailabilityException(ctx, tenantA.id, { ownerType: 'staff', ownerId: staff.id, date: '2027-06-08', available: false });
    await expect(createAppointment(ctx, tenantA.id, { ...input, startsAt: '2027-06-08T10:00:00Z', endsAt: '2027-06-08T11:00:00Z' })).rejects.toMatchObject({
      status: 409,
      details: { unavailable: [{ owner_type: 'staff', owner_id: staff.id, date: '2027-06-08' }] },
    });
  });

  it('rejects bookings and buffers outside weekly hours, using the calendar zone', async () => {
    const { ctx, tenantA } = await setup();
    const calendar = await createCalendar(ctx, tenantA.id, { name: 'Main', timezone: 'America/Chicago' });
    const staff = await createStaffMember(ctx, tenantA.id, { name: 'Crew' });
    const type = await createAppointmentType(ctx, tenantA.id, { name: 'Service', durationMinutes: 60, bufferBeforeMinutes: 15, bufferAfterMinutes: 15 });
    await createAvailabilityWindow(ctx, tenantA.id, { ownerType: 'staff', ownerId: staff.id, weekday: 1, startTime: '09:00', endTime: '17:00' });
    const input = { calendarId: calendar.id, title: 'Job', appointmentTypeId: type.id, staffIds: [staff.id] };
    await expect(createAppointment(ctx, tenantA.id, { ...input, startsAt: `${MONDAY}T09:00:00` })).rejects.toMatchObject({ status: 409 });
    await expect(createAppointment(ctx, tenantA.id, { ...input, startsAt: `${MONDAY}T16:00:00` })).rejects.toMatchObject({ status: 409 });
    // Input timezone affects timestamp parsing; it cannot redefine the owner's local hours.
    await expect(createAppointment(ctx, tenantA.id, { ...input, startsAt: `${MONDAY}T09:30:00`, timezone: 'UTC' })).rejects.toMatchObject({ status: 409 });
    const booked = await createAppointment(ctx, tenantA.id, { ...input, startsAt: `${MONDAY}T09:15:00` });
    expect(booked.appointments[0].starts_at).toBe(`${MONDAY}T14:15:00.000Z`);
    await expect(createAppointment(ctx, tenantA.id, { ...input, startsAt: '2027-06-08T10:00:00' })).rejects.toMatchObject({ status: 409 });
  });

  it('validates every date touched by an overnight appointment', async () => {
    const { ctx, tenantA } = await setup();
    const calendar = await createCalendar(ctx, tenantA.id, { name: 'Main', timezone: 'UTC' });
    const resource = await createResource(ctx, tenantA.id, { name: 'Vehicle' });
    await createAvailabilityException(ctx, tenantA.id, { ownerType: 'resource', ownerId: resource.id, date: '2027-06-08', available: false });
    await expect(createAppointment(ctx, tenantA.id, { calendarId: calendar.id, title: 'Night job', startsAt: `${MONDAY}T23:30:00Z`, endsAt: '2027-06-08T00:30:00Z', resourceIds: [resource.id] })).rejects.toMatchObject({ status: 409 });
  });

  it('rejects a whole recurring series if a later resource occurrence is unavailable', async () => {
    const { ctx, tenantA, db, events } = await setup();
    const calendar = await createCalendar(ctx, tenantA.id, { name: 'Main', timezone: 'UTC' });
    const resource = await createResource(ctx, tenantA.id, { name: 'Equipment' });
    await createAvailabilityException(ctx, tenantA.id, { ownerType: 'resource', ownerId: resource.id, date: '2027-06-14', available: false });
    let scheduled = 0;
    events.on('scheduling.appointment.scheduled', () => { scheduled++; });
    await expect(createAppointment(ctx, tenantA.id, { calendarId: calendar.id, title: 'Weekly', startsAt: `${MONDAY}T10:00:00Z`, endsAt: `${MONDAY}T11:00:00Z`, resourceIds: [resource.id], recurrence: { frequency: 'weekly', count: 3 } })).rejects.toMatchObject({ status: 409 });
    expect(await db.selectFrom('scheduling_appointments').selectAll().where('tenant_id', '=', tenantA.id).execute()).toEqual([]);
    expect(await db.selectFrom('scheduling_schedule_rules').selectAll().where('tenant_id', '=', tenantA.id).execute()).toEqual([]);
    expect(scheduled).toBe(0);
  });

  it('preserves the original appointment on denied reschedule and reads back a valid move', async () => {
    const { ctx, tenantA } = await setup();
    const calendar = await createCalendar(ctx, tenantA.id, { name: 'Main', timezone: 'UTC' });
    const resource = await createResource(ctx, tenantA.id, { name: 'Equipment' });
    const { appointments: [booked] } = await createAppointment(ctx, tenantA.id, { calendarId: calendar.id, title: 'Job', startsAt: `${MONDAY}T10:00:00Z`, endsAt: `${MONDAY}T11:00:00Z`, resourceIds: [resource.id] });
    await createAvailabilityException(ctx, tenantA.id, { ownerType: 'resource', ownerId: resource.id, date: '2027-06-08', available: false, startTime: '10:00', endTime: '12:00' });
    await expect(rescheduleAppointment(ctx, tenantA.id, booked.id, { startsAt: '2027-06-08T11:00:00Z' })).rejects.toMatchObject({ status: 409 });
    expect((await getAppointment(ctx, tenantA.id, booked.id)).starts_at).toBe(booked.starts_at);
    const moved = await rescheduleAppointment(ctx, tenantA.id, booked.id, { startsAt: '2027-06-08T12:00:00Z' });
    expect(moved).toMatchObject({ starts_at: '2027-06-08T12:00:00.000Z', ends_at: '2027-06-08T13:00:00.000Z', resource_ids: [resource.id], status: 'confirmed' });
  });

  it('makes time off win over added hours independently of exception id order', async () => {
    const { ctx, tenantA, db } = await setup();
    const staff = await createStaffMember(ctx, tenantA.id, { name: 'Crew' });
    const off = await createAvailabilityException(ctx, tenantA.id, { ownerType: 'staff', ownerId: staff.id, date: MONDAY, available: false });
    const open = await createAvailabilityException(ctx, tenantA.id, { ownerType: 'staff', ownerId: staff.id, date: MONDAY, available: true, startTime: '10:00', endTime: '12:00' });
    await db.updateTable('scheduling_availability_exceptions').set({ id: 'aaa-off' }).where('tenant_id', '=', tenantA.id).where('id', '=', off.id).execute();
    await db.updateTable('scheduling_availability_exceptions').set({ id: 'zzz-open' }).where('tenant_id', '=', tenantA.id).where('id', '=', open.id).execute();
    expect((await getAvailability(ctx, tenantA.id, { ownerType: 'staff', ownerId: staff.id, date: MONDAY })).free).toEqual([]);
  });

  it('returns an actionable router denial and leaves tenant appointments unchanged', async () => {
    const { ctx, app, tenantA, tenantB } = await setup();
    const calendar = await createCalendar(ctx, tenantA.id, { name: 'Main', timezone: 'UTC' });
    const resource = await createResource(ctx, tenantA.id, { name: 'Equipment' });
    await createAvailabilityException(ctx, tenantA.id, { ownerType: 'resource', ownerId: resource.id, date: MONDAY, available: false });
    const denied = await api(app, tenantA.id, 'POST', '/appointments', { calendarId: calendar.id, title: 'Unavailable', startsAt: `${MONDAY}T10:00:00Z`, endsAt: `${MONDAY}T11:00:00Z`, resourceIds: [resource.id] });
    expect(denied).toMatchObject({ status: 409, json: { error: { code: 'conflict', details: { timezone: 'UTC', unavailable: [{ owner_type: 'resource', owner_id: resource.id, date: MONDAY }] } } } });
    expect((await api(app, tenantA.id, 'GET', '/appointments')).json.data).toEqual([]);
    const foreign = await api(app, tenantB.id, 'POST', '/appointments', { calendarId: calendar.id, title: 'Foreign', startsAt: `${MONDAY}T10:00:00Z`, endsAt: `${MONDAY}T11:00:00Z`, resourceIds: [resource.id] });
    expect(foreign.status).toBe(404);
    expect((await api(app, tenantA.id, 'GET', '/appointments')).json.data).toEqual([]);
  });

  it('rejects an impossible dated exception without storing it', async () => {
    const { ctx, app, tenantA } = await setup();
    const staff = await createStaffMember(ctx, tenantA.id, { name: 'Crew' });
    const denied = await api(app, tenantA.id, 'POST', '/availability-exceptions', { ownerType: 'staff', ownerId: staff.id, date: '2027-02-30', available: false });
    expect(denied.status).toBe(400);
    expect((await api(app, tenantA.id, 'GET', '/availability-exceptions')).json.data).toEqual([]);
  });

  it('keeps multi-day resource buffers blocked in both readback and later booking admission', async () => {
    const { ctx, tenantA } = await setup();
    const calendar = await createCalendar(ctx, tenantA.id, { name: 'Main', timezone: 'UTC' });
    const resource = await createResource(ctx, tenantA.id, { name: 'Equipment requiring 48-hour cooldown' });
    const type = await createAppointmentType(ctx, tenantA.id, { name: 'Buffered job', durationMinutes: 60, bufferAfterMinutes: 48 * 60 });
    await createAppointment(ctx, tenantA.id, { calendarId: calendar.id, title: 'First job', appointmentTypeId: type.id, startsAt: `${MONDAY}T10:00:00Z`, resourceIds: [resource.id] });
    await createAvailabilityWindow(ctx, tenantA.id, { ownerType: 'resource', ownerId: resource.id, weekday: 3, startTime: '09:00', endTime: '17:00' });
    expect((await getAvailability(ctx, tenantA.id, { ownerType: 'resource', ownerId: resource.id, date: '2027-06-09' })).free).toEqual([{ starts_at: '2027-06-09T11:00:00.000Z', ends_at: '2027-06-09T17:00:00.000Z' }]);
    const next = { calendarId: calendar.id, title: 'Next job', resourceIds: [resource.id], startsAt: '2027-06-09T10:00:00Z', endsAt: '2027-06-09T11:00:00Z' };
    await expect(createAppointment(ctx, tenantA.id, next)).rejects.toMatchObject({ status: 409 });
    await expect(createAppointment(ctx, tenantA.id, { ...next, startsAt: '2027-06-09T11:00:00Z', endsAt: '2027-06-09T12:00:00Z' })).resolves.toMatchObject({ appointments: [{ starts_at: '2027-06-09T11:00:00.000Z' }] });
  });
});

describe('resource-aware slot search through the router', () => {
  it('offers only the staff/resource intersection including both candidate buffers, then removes resource bookings', async () => {
    const { ctx, tenantA, app } = await setup();
    const calendar = await createCalendar(ctx, tenantA.id, { name: 'Main', timezone: 'UTC' });
    const staff = await createStaffMember(ctx, tenantA.id, { name: 'Crew' });
    const resource = await createResource(ctx, tenantA.id, { name: 'Vehicle' });
    const type = await createAppointmentType(ctx, tenantA.id, { name: 'Job', durationMinutes: 60, bufferBeforeMinutes: 15, bufferAfterMinutes: 15 });
    await createAvailabilityWindow(ctx, tenantA.id, { ownerType: 'staff', ownerId: staff.id, weekday: 1, startTime: '09:00', endTime: '17:00' });
    await createAvailabilityWindow(ctx, tenantA.id, { ownerType: 'resource', ownerId: resource.id, weekday: 1, startTime: '10:00', endTime: '14:00' });
    const query = `/next-available?appointment_type_id=${type.id}&from=${MONDAY}&days=1&staff=${staff.id}&resource_ids=${resource.id}`;
    const first = await api(app, tenantA.id, 'GET', query);
    expect(first.status).toBe(200);
    expect(first.json.data.slots.map((s: { starts_at: string }) => s.starts_at.slice(11, 16))).toEqual(['10:15', '11:15', '12:15']);
    expect(first.json.data.slots.every((s: { resource_ids: string[] }) => s.resource_ids[0] === resource.id)).toBe(true);
    await createAppointment(ctx, tenantA.id, { calendarId: calendar.id, title: 'Resource occupied', startsAt: `${MONDAY}T11:00:00Z`, endsAt: `${MONDAY}T12:00:00Z`, resourceIds: [resource.id] });
    const second = await api(app, tenantA.id, 'GET', query);
    expect(second.json.data.slots.map((s: { starts_at: string }) => s.starts_at.slice(11, 16))).toEqual(['12:15']);
    const slot = second.json.data.slots[0];
    await expect(createAppointment(ctx, tenantA.id, { calendarId: calendar.id, title: 'Offered slot', appointmentTypeId: type.id, startsAt: slot.starts_at, staffIds: [staff.id], resourceIds: slot.resource_ids })).resolves.toMatchObject({ appointments: [{ starts_at: slot.starts_at }] });
  });

  it('rejects foreign resources and respects resource time off without weekly resource hours', async () => {
    const { ctx, tenantA, tenantB, app } = await setup();
    const staff = await createStaffMember(ctx, tenantA.id, { name: 'Crew' });
    const resource = await createResource(ctx, tenantA.id, { name: 'Vehicle' });
    const foreign = await createResource(ctx, tenantB.id, { name: 'Other company vehicle' });
    const type = await createAppointmentType(ctx, tenantA.id, { name: 'Job', durationMinutes: 60 });
    await createAvailabilityWindow(ctx, tenantA.id, { ownerType: 'staff', ownerId: staff.id, weekday: 1, startTime: '09:00', endTime: '12:00' });
    await createAvailabilityException(ctx, tenantA.id, { ownerType: 'resource', ownerId: resource.id, date: MONDAY, available: false });
    const unavailable = await findNextAvailable(ctx, tenantA.id, { appointmentTypeId: type.id, from: MONDAY, days: 1, staffId: staff.id, resourceIds: [resource.id] });
    expect(unavailable.slots).toEqual([]);
    const denied = await api(app, tenantA.id, 'GET', `/next-available?appointment_type_id=${type.id}&from=${MONDAY}&staff=${staff.id}&resource_ids=${foreign.id}`);
    expect(denied.status).toBe(404);
  });

  it('uses the selected calendar zone and requires every selected resource', async () => {
    const { ctx, tenantA, app } = await setup();
    const calendar = await createCalendar(ctx, tenantA.id, { name: 'Main', timezone: 'America/Chicago' });
    const staff = await createStaffMember(ctx, tenantA.id, { name: 'Crew' });
    const first = await createResource(ctx, tenantA.id, { name: 'First' });
    const second = await createResource(ctx, tenantA.id, { name: 'Second' });
    const type = await createAppointmentType(ctx, tenantA.id, { name: 'Job', durationMinutes: 60 });
    await createAvailabilityWindow(ctx, tenantA.id, { ownerType: 'staff', ownerId: staff.id, weekday: 1, startTime: '09:00', endTime: '12:00' });
    await createAvailabilityWindow(ctx, tenantA.id, { ownerType: 'resource', ownerId: first.id, weekday: 1, startTime: '09:00', endTime: '11:00' });
    await createAvailabilityWindow(ctx, tenantA.id, { ownerType: 'resource', ownerId: second.id, weekday: 1, startTime: '10:00', endTime: '12:00' });
    const result = await api(app, tenantA.id, 'GET', `/next-available?appointment_type_id=${type.id}&calendar_id=${calendar.id}&timezone=UTC&from=${MONDAY}&days=1&staff=${staff.id}&resource_ids=${first.id},${second.id},${first.id}`);
    expect(result.status).toBe(200);
    expect(result.json.data.timezone).toBe('America/Chicago');
    expect(result.json.data.slots).toHaveLength(1);
    expect(result.json.data.slots[0]).toMatchObject({ starts_at: `${MONDAY}T15:00:00.000Z`, resource_ids: [first.id, second.id] });
  });
});
