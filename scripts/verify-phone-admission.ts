/** Isolated FrontDesk Python -> actual business HTTP API -> SQLite proof.
 * All fixtures are synthetic and in memory; no carrier, provider or customer sends.
 * --baseline=PATH loads a preserved FrontDesk tree to reproduce its old tool contract.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { DateTime } from 'luxon';
import { asCoreDb, createTenant } from '@blacklabel/core';
import { createTestDb } from '@blacklabel/db';
import { createApp, type PlatformDatabase } from '../apps/api/src/app';
import { createBusinessApp } from '../apps/business/src/app';

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const frontdesk = process.env.FRONTDESK_ROOT ?? path.resolve(root, '../BlackLabelFrontDesk');
  const baseline = process.argv.find(a => a.startsWith('--baseline='))?.slice(11);
  const db = createTestDb<PlatformDatabase>(), token = randomBytes(32).toString('base64url');
  let app: ReturnType<typeof createBusinessApp> | undefined;
  let tenant = '';
  const platform = await createApp({ db, businessPortals: true, disableRateLimit: true,
    includeCheckoutSimulator: false, browserSessionUser: async (request, tid) => tid === tenant ? app?.resolveOwnerRequest(request) : undefined });
  tenant = (await createTenant(asCoreDb(db), { name: 'Synthetic phone proof' })).id;
  const { ownerUserId } = await platform.seedTenant(tenant);
  app = createBusinessApp({ platform, tenantId: tenant, ownerUserId, accessToken: token,
    settings: async () => ({ companyName: 'Synthetic phone proof' }), saveSettings: async () => {},
    asset: async () => new Uint8Array(), version: 'security-test' });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  async function data(route: string, body: unknown) {
    const response = await fetch(url + '/api/' + route, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await response.json() as any; assert(response.ok, JSON.stringify(json)); return json.data;
  }
  try {
    const calendar = await data('scheduling/calendars', { name: 'Fixture', timezone: 'America/Chicago' });
    const staff = await data('scheduling/staff', { name: 'Fixture staff' });
    const type = await data('scheduling/appointment-types', { name: 'Consult', durationMinutes: 60 });
    const day = DateTime.now().setZone('America/Chicago').plus({ days: 30 }).startOf('day');
    await data('scheduling/availability-windows', { ownerType: 'staff', ownerId: staff.id, weekday: day.weekday, startTime: '09:00', endTime: '17:00' });
    const phone = '+15555550101';
    const caller = await data('crm/customers', { name: 'Fixture caller', phone });
    await data('crm/contacts', { first_name: 'Fixture', last_name: 'Caller', phone, customer_id: caller.id });
    const victim = await data('crm/customers', { name: 'Other synthetic customer', phone: '+15555550202' });
    const account = await data('portal-customer/accounts', { name: 'Fixture portal', customerId: caller.id, email: 'caller@example.test' });
    const past = DateTime.now().minus({ days: 2 }).toUTC();
    const completed = await data('scheduling/appointments', { calendarId: calendar.id, customerId: caller.id, title: 'Past fixture',
      startsAt: past.toISO(), endsAt: past.plus({ hours: 1 }).toISO() });
    await data(`scheduling/appointments/${completed.appointments[0].id}/status`, { status: 'completed' });
    const input = { url, token, tenant, calendar: calendar.id, staff: staff.id, type: type.id, phone, victim: victim.id,
      date: day.toISODate(), baseline: Boolean(baseline), start: day.set({ hour: 9 }).toUTC().toISO(),
      overrideEnd: day.set({ hour: 22 }).toUTC().toISO() };
    const script = `
import json, sys
from frontdesk.platform_client import PlatformClient
from frontdesk.tools import Receptionist
from frontdesk.tenants import Tenant
from frontdesk.phone_agent.agent import PhoneAgent
from frontdesk.phone_agent.brain import ScriptedBrain
c = json.load(sys.stdin)
client = PlatformClient(c['url'], c['tenant'], access_token=c['token'])
tenant = Tenant(c['tenant'], 'Fixture', [], services=[{'appointment_type_id': c['type']}], default_calendar_id=c['calendar'], default_staff_ids=[c['staff']], timezone='America/Chicago')
r = Receptionist(client, tenant, caller_number=c['phone'])
if c['baseline']:
    assert r.run_tool('lookup_caller', {'phone': c['phone']})['found']
    assert r.run_tool('find_slots', {'appointment_type_id': c['type'], 'from_date': c['date']})['ok']
    booked = r.run_tool('book_appointment', {'appointment_type_id': c['type'], 'title': 'Wrong customer and duration fixture', 'starts_at': c['start'], 'ends_at': c['overrideEnd'], 'customer_id': c['victim']})
    review = r.run_tool('request_review', {'contact_id': c['victim']})
    assert booked['ok'] and review['ok'] and review.get('review_link')
    print(json.dumps({'baseline': True, 'appointment_id': booked['appointment_id'], 'review_capability_exposed': True}))
else:
    from frontdesk.phone_agent.brain import scripted_slot_booking
    def tool(i, name, body): return [{'type': 'tool_use', 'id': i, 'name': name, 'input': body}]
    turns = [tool('lookup', 'lookup_caller', {}), tool('slots', 'find_slots', {'appointment_type_id': c['type'], 'from_date': c['date']}), scripted_slot_booking('Safe phone visit'), 'Done']
    agent = PhoneAgent(ScriptedBrain(turns), lambda f: None, 'Fixture', tools=r.tools_schema(), tool_runner=r.run_tool)
    call = agent.reply_to('Please book the first offered appointment.')
    booked = next(t['output'] for t in call.tool_calls if t['name'] == 'book_appointment')
    assert booked['ok'], call.tool_calls
    assert not r.run_tool('book_appointment', {'slot_id': 'arbitrary', 'title': 'Override', 'customer_id': c['victim'], 'ends_at': c['overrideEnd']})['ok']
    review = r.run_tool('request_review', {})
    assert review['ok'] and review['available_in_customer_portal'] and set(review) == {'ok', 'available_in_customer_portal', 'request_id'}
    assert not r.run_tool('request_review', {'contact_id': c['victim']})['ok']
    print(json.dumps({'baseline': False, 'appointment_id': booked['appointment_id'], 'review_request_id': review['request_id'], 'checks': ['authenticated HTTP', 'real CRM caller mapping', 'scripted tool loop', 'opaque offered slot booking', 'customer and duration override denied', 'review override denied', 'review status only']}))
`;
    const python = process.env.FRONTDESK_PYTHON ?? path.join(frontdesk, '.venv/bin/python');
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(python, ['-c', script], { cwd: baseline ?? frontdesk, env: { ...process.env, PYTHONPATH: baseline ?? frontdesk }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject); child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`Python proof exit ${code}: ${stderr}`)));
      child.stdin.end(JSON.stringify(input));
    });
    const result = JSON.parse(output);
    const row = await db.selectFrom('scheduling_appointments').selectAll().where('id', '=', result.appointment_id).executeTakeFirstOrThrow();
    if (baseline) {
      assert.equal(row.customer_id, victim.id); assert.equal(row.ends_at, input.overrideEnd);
      assert.equal((await db.selectFrom('reviews_requests').selectAll().executeTakeFirstOrThrow()).customer_id, victim.id);
      result.persisted_wrong_customer = true; result.persisted_duration_minutes = (Date.parse(row.ends_at) - Date.parse(row.starts_at)) / 60000;
    } else {
      assert.equal(row.customer_id, caller.id); assert.equal((Date.parse(row.ends_at) - Date.parse(row.starts_at)) / 60000, 60);
      const review = await db.selectFrom('reviews_requests').selectAll().where('id', '=', result.review_request_id).executeTakeFirstOrThrow();
      assert.equal(review.customer_id, caller.id); assert(!output.includes(review.token));
      await data('portal-customer/auth/request-link', { email: 'caller@example.test' });
      const login = await db.selectFrom('portal_customer_login_tokens').selectAll().where('account_id', '=', account.id).executeTakeFirstOrThrow();
      const session = await data('portal-customer/auth/exchange', { token: login.token });
      const pending = await fetch(url + '/api/portal-customer/me/reviews/pending', { headers: { 'x-portal-session': session.sessionToken } });
      assert.equal(pending.status, 200); assert((await pending.text()).includes(review.token));
      result.checks.push('database readback: correct customer and 60 minute duration', 'capability visible in authenticated customer portal');
      const anonymous = await fetch(url + '/api/scheduling/phone-bookings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      assert.equal(anonymous.status, 401); result.checks.push('anonymous HTTP denied');
    }
    console.log(JSON.stringify({ status: 'passed', ...result, storage: 'disposable in-memory SQLite', production: false }, null, 2));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    platform.detachEngine(); await db.destroy();
  }
}
let completed = false;
process.once('beforeExit', () => { if (!completed) { console.error('Phone acceptance did not complete'); process.exitCode = 1; } });
main().then(() => { completed = true; }).catch(error => { console.error(error); process.exitCode = 1; });
