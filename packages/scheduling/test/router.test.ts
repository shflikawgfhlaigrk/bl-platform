import { describe, expect, it } from 'vitest';
import type { PlatformEvent } from '@blacklabel/core';
import { api, setup } from './helpers';

async function createBasics(world: Awaited<ReturnType<typeof setup>>) {
  const { app, tenantA } = world;
  const cal = await api(app, tenantA.id, 'POST', '/calendars', { name: 'Main', timezone: 'UTC' });
  const staff = await api(app, tenantA.id, 'POST', '/staff', { name: 'Sam', email: 's@example.com' });
  const resource = await api(app, tenantA.id, 'POST', '/resources', { name: 'Room 1', kind: 'room' });
  const type = await api(app, tenantA.id, 'POST', '/appointment-types', {
    name: 'Standard',
    durationMinutes: 60,
    bufferAfterMinutes: 15,
  });
  return {
    calendarId: cal.json.data.id as string,
    staffId: staff.json.data.id as string,
    resourceId: resource.json.data.id as string,
    typeId: type.json.data.id as string,
  };
}

describe('router CRUD happy paths', () => {
  it('creates and reads calendars, staff, resources, and appointment types', async () => {
    const world = await setup();
    const { app, tenantA } = world;
    const ids = await createBasics(world);

    const calList = await api(app, tenantA.id, 'GET', '/calendars');
    expect(calList.status).toBe(200);
    expect(calList.json.data).toHaveLength(1);
    expect(calList.json.limit).toBe(50);
    expect(calList.json.offset).toBe(0);

    const calGet = await api(app, tenantA.id, 'GET', `/calendars/${ids.calendarId}`);
    expect(calGet.status).toBe(200);
    expect(calGet.json.data.name).toBe('Main');

    const calPatch = await api(app, tenantA.id, 'PATCH', `/calendars/${ids.calendarId}`, {
      name: 'Renamed',
      timezone: 'America/Chicago',
    });
    expect(calPatch.status).toBe(200);
    expect(calPatch.json.data.name).toBe('Renamed');
    expect(calPatch.json.data.timezone).toBe('America/Chicago');

    const staffPatch = await api(app, tenantA.id, 'PATCH', `/staff/${ids.staffId}`, { active: false });
    expect(staffPatch.status).toBe(200);
    expect(staffPatch.json.data.active).toBe(0);

    const typeList = await api(app, tenantA.id, 'GET', '/appointment-types');
    expect(typeList.json.data[0].duration_minutes).toBe(60);

    const resourceGet = await api(app, tenantA.id, 'GET', `/resources/${ids.resourceId}`);
    expect(resourceGet.json.data.kind).toBe('room');
  });

  it('books, lists, fetches, patches notes, reschedules, and cancels an appointment', async () => {
    const world = await setup();
    const { app, tenantA } = world;
    const ids = await createBasics(world);

    const create = await api(app, tenantA.id, 'POST', '/appointments', {
      calendarId: ids.calendarId,
      title: 'Job #1',
      appointmentTypeId: ids.typeId,
      customerId: 'cust-1',
      startsAt: '2027-04-05T10:00:00Z',
      staffIds: [ids.staffId],
      resourceIds: [ids.resourceId],
      notes: 'gate code 1234',
    });
    expect(create.status).toBe(201);
    const appt = create.json.data.appointments[0];
    expect(create.json.data.scheduleRuleId).toBeNull();
    expect(appt.status).toBe('confirmed');
    expect(appt.ends_at).toBe('2027-04-05T11:00:00.000Z'); // duration from type
    expect(appt.staff_ids).toEqual([ids.staffId]);
    expect(appt.resource_ids).toEqual([ids.resourceId]);

    const list = await api(app, tenantA.id, 'GET', `/appointments?staff_id=${ids.staffId}&status=confirmed`);
    expect(list.status).toBe(200);
    expect(list.json.data).toHaveLength(1);

    const get = await api(app, tenantA.id, 'GET', `/appointments/${appt.id}`);
    expect(get.json.data.notes).toBe('gate code 1234');

    const patch = await api(app, tenantA.id, 'PATCH', `/appointments/${appt.id}`, {
      notes: 'gate code changed to 9999',
    });
    expect(patch.json.data.notes).toBe('gate code changed to 9999');

    const reschedule = await api(app, tenantA.id, 'POST', `/appointments/${appt.id}/reschedule`, {
      startsAt: '2027-04-06T10:00:00Z',
      timezone: 'UTC',
    });
    expect(reschedule.status).toBe(200);
    expect(reschedule.json.data.starts_at).toBe('2027-04-06T10:00:00.000Z');
    expect(reschedule.json.data.ends_at).toBe('2027-04-06T11:00:00.000Z'); // duration preserved

    const cancel = await api(app, tenantA.id, 'POST', `/appointments/${appt.id}/cancel`, {
      reason: 'customer moved',
    });
    expect(cancel.status).toBe(200);
    expect(cancel.json.data.status).toBe('canceled');
    expect(cancel.json.data.canceled_reason).toBe('customer moved');
  });

  it('returns 400 with the canonical envelope on invalid bodies', async () => {
    const world = await setup();
    const { app, tenantA } = world;
    const res = await api(app, tenantA.id, 'POST', '/calendars', { timezone: 'UTC' }); // name missing
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('validation_error');
  });

  it('emits scheduling.appointment.scheduled through the router', async () => {
    const world = await setup();
    const { app, tenantA, events } = world;
    const ids = await createBasics(world);
    const seen: PlatformEvent[] = [];
    events.on('scheduling.appointment.scheduled', (e) => void seen.push(e));
    const res = await api(app, tenantA.id, 'POST', '/appointments', {
      calendarId: ids.calendarId,
      title: 'Evented',
      startsAt: '2027-04-05T10:00:00Z',
      endsAt: '2027-04-05T11:00:00Z',
    });
    expect(res.status).toBe(201);
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toMatchObject({
      appointmentId: res.json.data.appointments[0].id,
      startsAt: '2027-04-05T10:00:00.000Z',
    });
  });
});

describe('router conflicts and transitions', () => {
  it('returns 409 with conflict details on a double-book', async () => {
    const world = await setup();
    const { app, tenantA } = world;
    const ids = await createBasics(world);
    const first = await api(app, tenantA.id, 'POST', '/appointments', {
      calendarId: ids.calendarId,
      title: 'First',
      startsAt: '2027-04-05T10:00:00Z',
      endsAt: '2027-04-05T11:00:00Z',
      staffIds: [ids.staffId],
    });
    expect(first.status).toBe(201);

    const clash = await api(app, tenantA.id, 'POST', '/appointments', {
      calendarId: ids.calendarId,
      title: 'Clash',
      startsAt: '2027-04-05T10:30:00Z',
      endsAt: '2027-04-05T11:30:00Z',
      staffIds: [ids.staffId],
    });
    expect(clash.status).toBe(409);
    expect(clash.json.error.code).toBe('conflict');
    expect(clash.json.error.details.conflicts[0]).toMatchObject({
      owner_type: 'staff',
      owner_id: ids.staffId,
      appointment_id: first.json.data.appointments[0].id,
    });
  });

  it('creates recurring appointments via the router and validates transitions', async () => {
    const world = await setup();
    const { app, tenantA } = world;
    const ids = await createBasics(world);
    const rec = await api(app, tenantA.id, 'POST', '/appointments', {
      calendarId: ids.calendarId,
      title: 'Recurring',
      startsAt: '2027-04-05T10:00:00Z',
      endsAt: '2027-04-05T10:30:00Z',
      recurrence: { frequency: 'weekly', count: 3 },
      status: 'requested',
    });
    expect(rec.status).toBe(201);
    expect(rec.json.data.appointments).toHaveLength(3);
    expect(rec.json.data.scheduleRuleId).toBeTruthy();

    const apptId = rec.json.data.appointments[0].id;
    // requested -> no_show is invalid.
    const bad = await api(app, tenantA.id, 'POST', `/appointments/${apptId}/status`, { status: 'no_show' });
    expect(bad.status).toBe(409);
    expect(bad.json.error.details.allowed).toEqual(['confirmed', 'canceled']);

    const confirm = await api(app, tenantA.id, 'POST', `/appointments/${apptId}/status`, { status: 'confirmed' });
    expect(confirm.status).toBe(200);
    const complete = await api(app, tenantA.id, 'POST', `/appointments/${apptId}/status`, { status: 'completed' });
    expect(complete.status).toBe(200);
    expect(complete.json.data.status).toBe('completed');
  });
});

describe('router availability + ICS + reminders', () => {
  it('serves availability for a staff member', async () => {
    const world = await setup();
    const { app, tenantA } = world;
    const ids = await createBasics(world);
    const win = await api(app, tenantA.id, 'POST', '/availability-windows', {
      ownerType: 'staff',
      ownerId: ids.staffId,
      weekday: 1,
      startTime: '09:00',
      endTime: '12:00',
    });
    expect(win.status).toBe(201);

    const res = await api(
      app,
      tenantA.id,
      'GET',
      `/availability?owner_type=staff&owner_id=${ids.staffId}&date=2027-06-07&timezone=UTC`,
    );
    expect(res.status).toBe(200);
    expect(res.json.data.free).toEqual([
      { starts_at: '2027-06-07T09:00:00.000Z', ends_at: '2027-06-07T12:00:00.000Z' },
    ]);
  });

  it('exports ICS with the text/calendar content type', async () => {
    const world = await setup();
    const { app, tenantA } = world;
    const ids = await createBasics(world);
    await api(app, tenantA.id, 'POST', '/appointments', {
      calendarId: ids.calendarId,
      title: 'Exported',
      startsAt: '2027-04-05T10:00:00Z',
      endsAt: '2027-04-05T11:00:00Z',
    });
    const res = await app.request(`/calendars/${ids.calendarId}/ics`, {
      headers: { 'x-tenant-id': tenantA.id },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/calendar');
    const body = await res.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).toContain('SUMMARY:Exported');
    expect(body).toContain('DTSTART:20270405T100000Z');
  });

  it('creates reminders, lists pending ones, and sends via the stub provider', async () => {
    const world = await setup();
    const { app, tenantA, reminderDelivery } = world;
    const ids = await createBasics(world);
    const create = await api(app, tenantA.id, 'POST', '/appointments', {
      calendarId: ids.calendarId,
      title: 'Reminded',
      startsAt: '2027-04-05T10:00:00Z',
      endsAt: '2027-04-05T11:00:00Z',
    });
    const apptId = create.json.data.appointments[0].id;

    const reminder = await api(app, tenantA.id, 'POST', `/appointments/${apptId}/reminders`, {
      sendAt: '2027-04-04T10:00:00Z',
      channel: 'email',
      recipient: 'c@example.com',
      message: 'Tomorrow!',
    });
    expect(reminder.status).toBe(201);
    expect(reminder.json.data.status).toBe('pending');

    const forAppt = await api(app, tenantA.id, 'GET', `/appointments/${apptId}/reminders`);
    expect(forAppt.json.data).toHaveLength(1);

    const pending = await api(app, tenantA.id, 'GET', '/reminders/pending?before=2027-04-04T12:00:00Z');
    expect(pending.json.data.map((r: any) => r.id)).toEqual([reminder.json.data.id]);

    const send = await api(app, tenantA.id, 'POST', `/reminders/${reminder.json.data.id}/send`);
    expect(send.status).toBe(200);
    expect(send.json.data.status).toBe('sent');
    expect(reminderDelivery.deliveries).toHaveLength(1);

    const again = await api(app, tenantA.id, 'POST', `/reminders/${reminder.json.data.id}/send`);
    expect(again.status).toBe(409);
  });
});

describe('tenant isolation (denial tests)', () => {
  it('tenant B cannot read, update, cancel, or list tenant A appointments', async () => {
    const world = await setup();
    const { app, tenantA, tenantB } = world;
    const ids = await createBasics(world);
    const create = await api(app, tenantA.id, 'POST', '/appointments', {
      calendarId: ids.calendarId,
      title: 'A-private',
      startsAt: '2027-04-05T10:00:00Z',
      endsAt: '2027-04-05T11:00:00Z',
      notes: 'secret',
    });
    const apptId = create.json.data.appointments[0].id;

    expect((await api(app, tenantB.id, 'GET', `/appointments/${apptId}`)).status).toBe(404);
    expect((await api(app, tenantB.id, 'PATCH', `/appointments/${apptId}`, { title: 'stolen' })).status).toBe(404);
    expect((await api(app, tenantB.id, 'POST', `/appointments/${apptId}/cancel`, {})).status).toBe(404);
    expect(
      (await api(app, tenantB.id, 'POST', `/appointments/${apptId}/reschedule`, { startsAt: '2027-04-06T10:00:00Z' }))
        .status,
    ).toBe(404);

    const bList = await api(app, tenantB.id, 'GET', '/appointments');
    expect(bList.json.data).toEqual([]);

    // A's data untouched.
    const aGet = await api(app, tenantA.id, 'GET', `/appointments/${apptId}`);
    expect(aGet.status).toBe(200);
    expect(aGet.json.data.title).toBe('A-private');
    expect(aGet.json.data.status).toBe('confirmed');
  });

  it('tenant B cannot touch tenant A calendars, staff, resources, or types', async () => {
    const world = await setup();
    const { app, tenantA, tenantB } = world;
    const ids = await createBasics(world);

    expect((await api(app, tenantB.id, 'GET', `/calendars/${ids.calendarId}`)).status).toBe(404);
    expect((await api(app, tenantB.id, 'PATCH', `/calendars/${ids.calendarId}`, { name: 'x' })).status).toBe(404);
    expect((await api(app, tenantB.id, 'DELETE', `/calendars/${ids.calendarId}`)).status).toBe(404);
    expect((await api(app, tenantB.id, 'GET', `/calendars/${ids.calendarId}/ics`)).status).toBe(404);
    expect((await api(app, tenantB.id, 'GET', `/staff/${ids.staffId}`)).status).toBe(404);
    expect((await api(app, tenantB.id, 'DELETE', `/staff/${ids.staffId}`)).status).toBe(404);
    expect((await api(app, tenantB.id, 'GET', `/resources/${ids.resourceId}`)).status).toBe(404);
    expect((await api(app, tenantB.id, 'DELETE', `/appointment-types/${ids.typeId}`)).status).toBe(404);

    expect((await api(app, tenantB.id, 'GET', '/calendars')).json.data).toEqual([]);
    expect((await api(app, tenantB.id, 'GET', '/staff')).json.data).toEqual([]);
    expect((await api(app, tenantB.id, 'GET', '/resources')).json.data).toEqual([]);
    expect((await api(app, tenantB.id, 'GET', '/appointment-types')).json.data).toEqual([]);

    // A still owns everything.
    expect((await api(app, tenantA.id, 'GET', '/calendars')).json.data).toHaveLength(1);
    expect((await api(app, tenantA.id, 'GET', '/staff')).json.data).toHaveLength(1);
  });

  it('tenant B cannot see or send tenant A reminders and availability data', async () => {
    const world = await setup();
    const { app, tenantA, tenantB } = world;
    const ids = await createBasics(world);
    const create = await api(app, tenantA.id, 'POST', '/appointments', {
      calendarId: ids.calendarId,
      title: 'A appt',
      startsAt: '2027-04-05T10:00:00Z',
      endsAt: '2027-04-05T11:00:00Z',
    });
    const apptId = create.json.data.appointments[0].id;
    const reminder = await api(app, tenantA.id, 'POST', `/appointments/${apptId}/reminders`, {
      sendAt: '2027-04-04T10:00:00Z',
      channel: 'email',
      recipient: 'c@example.com',
    });
    const win = await api(app, tenantA.id, 'POST', '/availability-windows', {
      ownerType: 'staff',
      ownerId: ids.staffId,
      weekday: 1,
      startTime: '09:00',
      endTime: '17:00',
    });

    expect((await api(app, tenantB.id, 'POST', `/reminders/${reminder.json.data.id}/send`)).status).toBe(404);
    expect(
      (await api(app, tenantB.id, 'GET', '/reminders/pending?before=2027-04-04T12:00:00Z')).json.data,
    ).toEqual([]);
    expect((await api(app, tenantB.id, 'DELETE', `/availability-windows/${win.json.data.id}`)).status).toBe(404);
    expect(
      (await api(app, tenantB.id, 'GET', `/availability?owner_type=staff&owner_id=${ids.staffId}&date=2027-06-07`))
        .status,
    ).toBe(404); // A's staff member is invisible to B

    // A's reminder is still pending and its window still exists.
    const aPending = await api(app, tenantA.id, 'GET', '/reminders/pending?before=2027-04-04T12:00:00Z');
    expect(aPending.json.data).toHaveLength(1);
    const aWindows = await api(app, tenantA.id, 'GET', '/availability-windows');
    expect(aWindows.json.data).toHaveLength(1);
  });

  it('conflict detection never crosses tenants', async () => {
    const world = await setup();
    const { app, tenantA, tenantB, db, events } = world;
    const ids = await createBasics(world);
    await api(app, tenantA.id, 'POST', '/appointments', {
      calendarId: ids.calendarId,
      title: 'A busy',
      startsAt: '2027-04-05T10:00:00Z',
      endsAt: '2027-04-05T11:00:00Z',
      staffIds: [ids.staffId],
    });
    // B has its own staff with the same working hours — booking the identical
    // slot must NOT collide with A's appointment.
    const bCal = await api(app, tenantB.id, 'POST', '/calendars', { name: 'B cal', timezone: 'UTC' });
    const bStaff = await api(app, tenantB.id, 'POST', '/staff', { name: 'B staff' });
    const bAppt = await api(app, tenantB.id, 'POST', '/appointments', {
      calendarId: bCal.json.data.id,
      title: 'B parallel',
      startsAt: '2027-04-05T10:00:00Z',
      endsAt: '2027-04-05T11:00:00Z',
      staffIds: [bStaff.json.data.id],
    });
    expect(bAppt.status).toBe(201);
    void db;
    void events;
  });

  it('requests without a tenant header are rejected', async () => {
    const world = await setup();
    const res = await world.app.request('/calendars');
    expect(res.status).toBe(400);
  });
});
