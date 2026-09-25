import { afterEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { sql, createTestDb } from '@blacklabel/db';
import { asCoreDb, createTenant, createUser } from '@blacklabel/core';
import { createApp, type PlatformDatabase } from '../src/app';
import { createBusinessApp } from '../../business/src/app';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
const phone = '+15555550101';

async function fixture() {
  const db = createTestDb<PlatformDatabase>();
  let business: ReturnType<typeof createBusinessApp> | undefined;
  let installedTenant = "";
  const sessions = new Map<string, { user: string; tenant: string }>();
  const platform = await createApp({ db, businessPortals: true, disableRateLimit: true,
    includeCheckoutSimulator: false, browserSessionUser: async (req, tenant) => {
      const record = sessions.get(req.headers.get('authorization') ?? '');
      return record?.tenant === tenant ? record.user : (tenant === installedTenant ? business?.resolveOwnerRequest(req) : undefined);
    } });
  cleanups.push(async () => { platform.detachEngine(); await db.destroy(); });
  const tenant = (await createTenant(asCoreDb(db), { name: 'Phone admission fixture' })).id;
  const other = (await createTenant(asCoreDb(db), { name: 'Other company' })).id;
  const seeded = await platform.seedTenant(tenant); await platform.seedTenant(other);
  installedTenant = tenant;
  business = createBusinessApp({ platform, tenantId: tenant, ownerUserId: seeded.ownerUserId, accessToken: 'fixture-owner',
    settings: async () => ({ companyName: 'Phone fixture' }), saveSettings: async () => {},
    asset: async () => new Uint8Array(), version: 'test' });
  const member = await createUser(asCoreDb(db), tenant, { name: 'Unprivileged', email: 'unprivileged@example.test', role: 'member' });
  sessions.set('Bearer fixture-member', { user: member.id, tenant });
  async function request(path: string, method = 'POST', body?: unknown, token = 'fixture-owner', tid = tenant, portal?: string) {
    return platform.app.request('/api/' + path, { method, headers: { 'x-tenant-id': tid,
      'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(portal ? { 'x-portal-session': portal, cookie: `portal_session=${portal}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async function data(path: string, method = 'POST', body?: unknown, portal?: string) {
    const response = await request(path, method, body, portal ? '' : 'fixture-owner', tenant, portal);
    const json = await response.json() as any;
    expect(response.status, JSON.stringify(json)).toBeLessThan(300); return json.data;
  }
  const calendar = await data('scheduling/calendars', 'POST', { name: 'Phone calendar', timezone: 'America/Chicago' });
  const type = await data('scheduling/appointment-types', 'POST', { name: 'Consult', durationMinutes: 60 });
  const staff = await data('scheduling/staff', 'POST', { name: 'Appointment staff' });
  const date = DateTime.now().setZone('America/Chicago').plus({ days: 30 }).startOf('day');
  await data('scheduling/availability-windows', 'POST', { ownerType: 'staff', ownerId: staff.id,
    weekday: date.weekday, startTime: '09:00', endTime: '17:00' });
  const start = date.set({ hour: 9 });
  const body = { callerNumber: phone, calendarId: calendar.id, appointmentTypeId: type.id, staffId: staff.id,
    startsAt: start.toUTC().toISO()!, endsAt: start.plus({ hours: 1 }).toUTC().toISO()!, title: 'Phone visit' };
  async function customer(number = phone, linked = true) {
    const customer = await data('crm/customers', 'POST', { name: 'Customer fixture', phone: number });
    const contact = await data('crm/contacts', 'POST', { first_name: 'Caller', phone: number, ...(linked ? { customer_id: customer.id } : {}) });
    return { customer, contact };
  }
  async function portal(customerId: string) {
    const email = `${customerId}@example.test`;
    const account = await data('portal-customer/accounts', 'POST', { name: 'Portal fixture', customerId, email });
    await data('portal-customer/auth/request-link', 'POST', { email });
    const link = await db.selectFrom('portal_customer_login_tokens').selectAll().where('account_id', '=', account.id).executeTakeFirstOrThrow();
    return (await data('portal-customer/auth/exchange', 'POST', { token: link.token })).sessionToken as string;
  }
  async function completed(customerId: string) {
    const past = DateTime.now().minus({ days: 2 });
    const appointment = (await data('scheduling/appointments', 'POST', { calendarId: calendar.id, customerId, title: 'Completed visit', status: 'confirmed',
      startsAt: past.toUTC().toISO(), endsAt: past.plus({ hours: 1 }).toUTC().toISO() })).appointments[0];
    await data(`scheduling/appointments/${appointment.id}/status`, 'POST', { status: 'completed' });
    return appointment;
  }
  return { db, platform, business, tenant, other, request, data, calendar, type, staff, date, start, body, customer, portal, completed };
}

describe('phone booking admission against real Platform database and routes', () => {
  it('requires a verified adapter identity and RBAC; rejects model-selected customer IDs', async () => {
    const f = await fixture(); await f.customer();
    for (const path of ['scheduling/phone-bookings', 'reviews/phone-request']) {
      const body = path.startsWith('scheduling') ? f.body : { callerNumber: phone };
      expect((await f.request(path, 'POST', body, '')).status).toBe(401);
      expect((await f.request(path, 'POST', body, 'fixture-member')).status).toBe(403);
      expect((await f.request(path, 'POST', { ...body, customerId: 'victim' })).status).toBe(400);
      expect((await f.request(path, 'POST', body, 'fixture-owner', f.other)).status).toBe(401);
    }
    expect(await f.db.selectFrom('scheduling_appointments').selectAll().execute()).toEqual([]);
  });

  it('resolves contact to customer, preserves exact slot and rejects concurrent double bookings', async () => {
    const f = await fixture(); const { customer, contact } = await f.customer();
    const responses = await Promise.all([f.request('scheduling/phone-bookings', 'POST', f.body), f.request('scheduling/phone-bookings', 'POST', f.body)]);
    expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
    const rows = await f.db.selectFrom('scheduling_appointments').selectAll().execute();
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ customer_id: customer.id, starts_at: f.body.startsAt, ends_at: f.body.endsAt });
    expect(rows[0].customer_id).not.toBe(contact.id);
  });

  it('creates and links a customer for an existing contact, emitting only after the booking commits', async () => {
    const f = await fixture(); const contact = await f.data('crm/contacts', 'POST', { first_name: 'New caller', phone });
    const observed: number[] = [];
    f.platform.events.on('crm.customer.created', async () => {
      observed.push((await f.db.selectFrom('scheduling_appointments').selectAll().execute()).length);
    });
    const result = await f.data('scheduling/phone-bookings', 'POST', f.body);
    const customerId = result.appointments[0].customer_id;
    expect(customerId).toBeTruthy(); expect(customerId).not.toBe(contact.id);
    expect((await f.db.selectFrom('crm_contacts').select('customer_id').where('id', '=', contact.id).executeTakeFirstOrThrow()).customer_id).toBe(customerId);
    expect(observed).toEqual([1]);
  });

  it('rolls back new customer, contact link, audit and events if insertion fails', async () => {
    const f = await fixture(); const contact = await f.data('crm/contacts', 'POST', { first_name: 'New caller', phone });
    const events: unknown[] = []; f.platform.events.on('crm.customer.created', e => { events.push(e); });
    const before = await f.db.selectFrom('audit_log').selectAll().execute();
    await sql`CREATE TRIGGER reject_fixture_booking BEFORE INSERT ON scheduling_appointments BEGIN SELECT RAISE(ABORT, 'fixture insertion failure'); END`.execute(f.db);
    expect((await f.request('scheduling/phone-bookings', 'POST', f.body)).status).toBe(500);
    expect(await f.db.selectFrom('crm_customers').selectAll().execute()).toEqual([]);
    expect((await f.db.selectFrom('crm_contacts').selectAll().where('id', '=', contact.id).executeTakeFirstOrThrow()).customer_id).toBeNull();
    expect(await f.db.selectFrom('audit_log').selectAll().execute()).toEqual(before); expect(events).toEqual([]);
  });

  it.each(['duration', 'closed-hours', 'exception', 'inactive-type', 'inactive-staff', 'missing-caller', 'ambiguous-contact', 'ambiguous-customer', 'inactive-customer', 'foreign-customer'])('denies %s without a booking', async scenario => {
    const f = await fixture(); const { customer, contact } = await f.customer(phone, scenario !== 'ambiguous-customer');
    const body = { ...f.body };
    if (scenario === 'duration') body.endsAt = f.start.plus({ hours: 4 }).toUTC().toISO()!;
    if (scenario === 'closed-hours') { body.startsAt = f.start.set({ hour: 22 }).toUTC().toISO()!; body.endsAt = f.start.set({ hour: 23 }).toUTC().toISO()!; }
    if (scenario === 'exception') await f.data('scheduling/availability-exceptions', 'POST', { ownerType: 'staff', ownerId: f.staff.id, date: f.date.toISODate(), available: false });
    if (scenario === 'inactive-type') await f.db.updateTable('scheduling_appointment_types').set({ active: 0 }).where('id', '=', f.type.id).execute();
    if (scenario === 'inactive-staff') await f.data(`scheduling/staff/${f.staff.id}`, 'PATCH', { active: false });
    if (scenario === 'missing-caller') body.callerNumber = '+15555559999';
    if (scenario === 'ambiguous-contact') await f.data('crm/contacts', 'POST', { first_name: 'Ambiguous', phone });
    if (scenario === 'ambiguous-customer') await f.data('crm/customers', 'POST', { name: 'Ambiguous', phone });
    if (scenario === 'inactive-customer') await f.data(`crm/customers/${customer.id}`, 'PATCH', { status: 'inactive' });
    if (scenario === 'foreign-customer') await f.db.updateTable('crm_customers').set({ tenant_id: f.other }).where('id', '=', customer.id).execute();
    const response = await f.request('scheduling/phone-bookings', 'POST', body);
    expect(response.status, await response.text()).toBe(409);
    expect(await f.db.selectFrom('scheduling_appointments').selectAll().execute()).toEqual([]);
  });

  it('links a unique existing customer without duplicating it', async () => {
    const f = await fixture(); const { customer } = await f.customer(phone, false);
    expect((await f.data('scheduling/phone-bookings', 'POST', f.body)).appointments[0].customer_id).toBe(customer.id);
    expect(await f.db.selectFrom('crm_customers').selectAll().execute()).toHaveLength(1);
  });

  it('requires a completed visit and portal, returns no capability, and isolates portal delivery', async () => {
    const f = await fixture(); const { customer } = await f.customer();
    const request = () => f.request('reviews/phone-request', 'POST', { callerNumber: phone });
    expect((await request()).status).toBe(409);
    const session = await f.portal(customer.id); expect((await request()).status).toBe(409);
    await f.completed(customer.id);
    const response = await request(), result = (await response.json() as any).data;
    expect(response.status).toBe(201); expect(Object.keys(result).sort()).toEqual(['availableInCustomerPortal', 'requestId']);
    expect((await (await request()).json() as any).data).toEqual(result);
    const rows = await f.db.selectFrom('reviews_requests').selectAll().execute(); expect(rows).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(rows[0].token);
    const pending = await f.data('portal-customer/me/reviews/pending', 'GET', undefined, session);
    expect(pending).toMatchObject([{ id: result.requestId }]); expect(pending[0].url).toContain(rows[0].token);
    const portalPage = await f.request('portal-customer/ui', 'GET', undefined, '', f.tenant, session);
    expect(portalPage.status).toBe(200); expect(await portalPage.text()).toContain(`href="/review#${rows[0].token}"`);
    const second = await f.customer('+15555550202'); const otherSession = await f.portal(second.customer.id);
    expect(await f.data('portal-customer/me/reviews/pending', 'GET', undefined, otherSession)).toEqual([]);
    expect((await f.request('portal-customer/me/reviews/pending', 'GET')).status).toBe(401);
    await f.db.updateTable('reviews_requests').set({ status: 'completed' }).where('id', '=', rows[0].id).execute();
    expect((await request()).status).toBe(409);
  });
});
