/**
 * Front Desk V2 — next-available slot finder.
 * Covers: basic tiling, buffer edges around a real booking, dated day-off
 * exception + multi-day forward scan, book-then-409 race, cross-staff first-free.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DateTime } from 'luxon';
import { setup, type TestWorld } from './helpers';
import {
  createAppointment,
  createAppointmentType,
  createAvailabilityException,
  createAvailabilityWindow,
  createCalendar,
  createStaffMember,
  findNextAvailable,
} from '../src/service';

const D1 = '2026-07-13'; // a Monday
const WEEKDAY = DateTime.fromISO(D1, { zone: 'UTC' }).weekday; // 1

let w: TestWorld;
beforeEach(async () => {
  w = await setup();
});

async function staffWithWindow(name: string, start: string, end: string) {
  const s = await createStaffMember(w.ctx, w.tenantA.id, { name });
  await createAvailabilityWindow(w.ctx, w.tenantA.id, {
    ownerType: 'staff',
    ownerId: s.id,
    weekday: WEEKDAY,
    startTime: start,
    endTime: end,
  });
  return s;
}

const starts = (r: { slots: { starts_at: string }[] }) => r.slots.map((x) => x.starts_at);

describe('findNextAvailable', () => {
  it('tiles a weekly window into duration-sized slots', async () => {
    const s = await staffWithWindow('Sam', '09:00', '17:00');
    const type = await createAppointmentType(w.ctx, w.tenantA.id, { name: 'Consult', durationMinutes: 60 });
    const r = await findNextAvailable(w.ctx, w.tenantA.id, {
      appointmentTypeId: type.id,
      from: D1,
      days: 1,
      staffId: s.id,
    });
    expect(r.slots.length).toBe(8); // 09..16
    expect(r.slots[0].starts_at).toBe('2026-07-13T09:00:00.000Z');
    expect(r.slots[7].starts_at).toBe('2026-07-13T16:00:00.000Z');
    expect(r.slots.every((x) => x.staff_id === s.id)).toBe(true);
  });

  it('respects buffers around an existing booking', async () => {
    const s = await staffWithWindow('Sam', '09:00', '17:00');
    const cal = await createCalendar(w.ctx, w.tenantA.id, { name: 'Main', timezone: 'UTC' });
    const type = await createAppointmentType(w.ctx, w.tenantA.id, {
      name: 'Consult',
      durationMinutes: 60,
      bufferAfterMinutes: 15,
    });
    // Book 12:00–13:00 for Sam; its type buffer_after=15 blocks through 13:15.
    await createAppointment(w.ctx, w.tenantA.id, {
      calendarId: cal.id,
      title: 'Booked',
      appointmentTypeId: type.id,
      startsAt: '2026-07-13T12:00:00Z',
      timezone: 'UTC',
      staffIds: [s.id],
    });
    const r = await findNextAvailable(w.ctx, w.tenantA.id, {
      appointmentTypeId: type.id,
      from: D1,
      days: 1,
      staffId: s.id,
    });
    const t = starts(r).map((x) => x.slice(11, 16));
    expect(t).toContain('10:00'); // clear of the booking
    expect(t).not.toContain('11:00'); // its buffer_after would collide → excluded
    expect(t).not.toContain('12:00'); // the booking itself
    expect(t).toContain('13:15'); // first slot after booking+buffer
  });

  it('skips a dated day-off and scans forward to the next occurrence', async () => {
    const s = await staffWithWindow('Sam', '09:00', '12:00');
    const type = await createAppointmentType(w.ctx, w.tenantA.id, { name: 'Consult', durationMinutes: 60 });
    await createAvailabilityException(w.ctx, w.tenantA.id, {
      ownerType: 'staff',
      ownerId: s.id,
      date: D1,
      available: false,
    });
    const r = await findNextAvailable(w.ctx, w.tenantA.id, {
      appointmentTypeId: type.id,
      from: D1,
      days: 14,
      staffId: s.id,
    });
    expect(starts(r).some((x) => x.startsWith('2026-07-13'))).toBe(false); // day off
    expect(r.slots[0].starts_at).toBe('2026-07-20T09:00:00.000Z'); // next same weekday
  });

  it('book-then-409: a booked slot drops out, and double-booking it conflicts', async () => {
    const s = await staffWithWindow('Sam', '09:00', '12:00');
    const cal = await createCalendar(w.ctx, w.tenantA.id, { name: 'Main', timezone: 'UTC' });
    const type = await createAppointmentType(w.ctx, w.tenantA.id, { name: 'Consult', durationMinutes: 60 });
    const q = { appointmentTypeId: type.id, from: D1, days: 1, staffId: s.id };
    const first = await findNextAvailable(w.ctx, w.tenantA.id, q);
    const slot = first.slots[0];

    const book = () =>
      createAppointment(w.ctx, w.tenantA.id, {
        calendarId: cal.id,
        title: 'Held',
        appointmentTypeId: type.id,
        startsAt: slot.starts_at,
        timezone: 'UTC',
        staffIds: [s.id],
      });
    await book(); // 201-equivalent
    await expect(book()).rejects.toMatchObject({ status: 409 }); // race: second loses

    const after = await findNextAvailable(w.ctx, w.tenantA.id, q);
    expect(starts(after)).not.toContain(slot.starts_at); // no longer offered
  });

  it('staffAny returns the first free across staff, tagged by member', async () => {
    const early = await staffWithWindow('Early', '08:00', '10:00');
    const late = await staffWithWindow('Late', '11:00', '13:00');
    const type = await createAppointmentType(w.ctx, w.tenantA.id, { name: 'Consult', durationMinutes: 60 });
    const r = await findNextAvailable(w.ctx, w.tenantA.id, {
      appointmentTypeId: type.id,
      from: D1,
      days: 1,
      staffAny: true,
    });
    expect(r.slots[0].starts_at).toBe('2026-07-13T08:00:00.000Z');
    expect(r.slots[0].staff_id).toBe(early.id);
    expect(r.slots.some((x) => x.staff_id === late.id)).toBe(true);
  });
});
