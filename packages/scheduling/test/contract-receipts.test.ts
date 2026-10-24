import { describe, expect, it } from 'vitest';
import { EventBus } from '@blacklabel/core';
import { sql } from '@blacklabel/db';
import { setup } from './helpers';
import { cancelAppointment, createSchedulingContract, getAppointment, type ExternalCalendarProvider } from '../src/service';

function calendarProvider() {
  const calls: string[] = [];
  const provider: ExternalCalendarProvider = {
    name: 'synthetic-calendar',
    async upsertEvent(event) { calls.push(event.appointmentId); return { externalId: `fixture:${event.appointmentId}` }; },
    async deleteEvent() {},
  };
  return { calls, provider };
}

const base = { customerId: 'fixture-customer', startsAt: '2027-01-11T10:00:00Z', endsAt: '2027-01-11T11:00:00Z', serviceKey: 'Fixture service' };

describe('atomic scheduling contract receipts', () => {
  it('reconciles concurrent duplicate calls as one booking, default calendar, receipt, event and provider operation', async () => {
    const { db, events, tenantA } = await setup();
    const calendar = calendarProvider();
    const contract = createSchedulingContract({ db, events, calendarSync: calendar.provider });
    let scheduled = 0;
    events.on('scheduling.appointment.scheduled', () => { scheduled++; });
    const input = { ...base, tenantId: tenantA.id, idempotencyKey: 'workflow:one:action' };
    const [first, second] = await Promise.all([contract.createAppointment(input), contract.createAppointment(input)]);
    expect(first.id).toBe(second.id);
    expect(await db.selectFrom('scheduling_appointments').selectAll().where('tenant_id', '=', tenantA.id).execute()).toHaveLength(1);
    expect(await db.selectFrom('scheduling_appointment_receipts').selectAll().where('tenant_id', '=', tenantA.id).execute()).toHaveLength(1);
    expect(await db.selectFrom('scheduling_calendars').selectAll().where('tenant_id', '=', tenantA.id).execute()).toHaveLength(1);
    expect(scheduled).toBe(1); expect(calendar.calls).toEqual([first.id]);
    await db.destroy();
  });

  it('rejects changed key payloads and reconciles an original booking after cancellation', async () => {
    const { ctx, db, events, tenantA } = await setup();
    const contract = createSchedulingContract({ db, events });
    const input = { ...base, tenantId: tenantA.id, idempotencyKey: 'one-request' };
    const first = await contract.createAppointment(input);
    await expect(contract.createAppointment({ ...input, notes: 'Different work' })).rejects.toMatchObject({ status: 409 });
    await cancelAppointment(ctx, tenantA.id, first.id);
    expect(await contract.createAppointment(input)).toEqual(first);
    expect((await getAppointment(ctx, tenantA.id, first.id)).status).toBe('canceled');
    expect(await db.selectFrom('scheduling_appointments').selectAll().where('tenant_id', '=', tenantA.id).execute()).toHaveLength(1);
    await db.destroy();
  });

  it('rolls back booking, default calendar and audit rows if receipt persistence fails, with no released effects', async () => {
    const { db, events, tenantA } = await setup();
    const calendar = calendarProvider();
    const contract = createSchedulingContract({ db, events, calendarSync: calendar.provider });
    let scheduled = 0;
    events.on('scheduling.appointment.scheduled', () => { scheduled++; });
    await sql.raw(`CREATE TRIGGER fail_receipt BEFORE INSERT ON scheduling_appointment_receipts BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END`).execute(db);
    await expect(contract.createAppointment({ ...base, tenantId: tenantA.id, idempotencyKey: 'atomic-failure' })).rejects.toThrow('injected receipt failure');
    expect(await db.selectFrom('scheduling_appointments').selectAll().where('tenant_id', '=', tenantA.id).execute()).toEqual([]);
    expect(await db.selectFrom('scheduling_calendars').selectAll().where('tenant_id', '=', tenantA.id).execute()).toEqual([]);
    expect(await db.selectFrom('audit_log').selectAll().where('tenant_id', '=', tenantA.id).where('entity_type', '=', 'scheduling.appointment').execute()).toEqual([]);
    expect(scheduled).toBe(0); expect(calendar.calls).toEqual([]);
    await db.destroy();
  });

  it('supports caller transactions without nested transactions or external calendar calls before their commit', async () => {
    const { ctx, db, tenantA } = await setup();
    const deferred = new EventBus();
    const calendar = calendarProvider();
    await expect(db.transaction().execute(async (tx) => {
      const contract = createSchedulingContract({ db: tx, events: deferred, calendarSync: calendar.provider });
      const booked = await contract.createAppointment({ ...base, tenantId: tenantA.id, idempotencyKey: 'outer-transaction' });
      const row = await getAppointment({ ...ctx, db: tx }, tenantA.id, booked.id);
      expect(row.calendar_sync_status).toBe('pending');
      throw new Error('caller rollback');
    })).rejects.toThrow('caller rollback');
    expect(await db.selectFrom('scheduling_appointments').selectAll().where('tenant_id', '=', tenantA.id).execute()).toEqual([]);
    expect(await db.selectFrom('scheduling_appointment_receipts').selectAll().where('tenant_id', '=', tenantA.id).execute()).toEqual([]);
    expect(calendar.calls).toEqual([]);
    await db.destroy();
  });

  it('scopes an identical receipt key to its tenant and blocks a dangling receipt from duplicating work', async () => {
    const { db, events, tenantA, tenantB } = await setup();
    const contract = createSchedulingContract({ db, events });
    const first = await contract.createAppointment({ ...base, tenantId: tenantA.id, idempotencyKey: 'shared-key' });
    const second = await contract.createAppointment({ ...base, tenantId: tenantB.id, idempotencyKey: 'shared-key' });
    expect(first.id).not.toBe(second.id);
    await db.deleteFrom('scheduling_appointments').where('tenant_id', '=', tenantA.id).where('id', '=', first.id).execute();
    await expect(contract.createAppointment({ ...base, tenantId: tenantA.id, idempotencyKey: 'shared-key' })).rejects.toMatchObject({ status: 409 });
    expect(await db.selectFrom('scheduling_appointments').selectAll().where('tenant_id', '=', tenantA.id).execute()).toEqual([]);
    expect(await db.selectFrom('scheduling_appointments').selectAll().where('tenant_id', '=', tenantB.id).execute()).toHaveLength(1);
    await db.destroy();
  });
});
