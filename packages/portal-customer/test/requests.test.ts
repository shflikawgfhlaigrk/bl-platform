import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, createAccountViaApi, login, setup } from './helpers';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-03T12:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

async function fixture() {
  let jobStatus = 'completed';
  let appointmentStatus = 'confirmed';
  const ctx = await setup({ providers: {
    jobs: { listForCustomer: async (_tenant, customer) => customer === 'customer-own' ? [{ id: 'job-own', title: 'Completed service', status: jobStatus }] : [] },
    appointments: { listForCustomer: async (_tenant, customer) => customer === 'customer-own' ? [{ id: 'appointment-own', title: 'Upcoming service', startsAt: '2027-01-10T10:00:00Z', endsAt: '2027-01-10T11:30:00Z', status: appointmentStatus }] : [] },
  } });
  const account = await createAccountViaApi(ctx.app, ctx.tenantA, { customerId: 'customer-own', email: 'own@example.test' });
  const other = await createAccountViaApi(ctx.app, ctx.tenantA, { customerId: 'customer-other', email: 'other@example.test' });
  const session = await login(ctx, ctx.tenantA, account.email);
  const otherSession = await login(ctx, ctx.tenantA, other.email);
  const submit = (body: unknown, token = session, tenant = ctx.tenantA) => api(ctx.app, tenant, 'POST', '/me/requests', body, token);
  return { ...ctx, session, otherSession, submit, setJobStatus: (value: string) => { jobStatus = value; }, setAppointmentStatus: (value: string) => { appointmentStatus = value; } };
}

describe('durable customer work requests', () => {
  it('stores a repeat request and reuses one receipt under simultaneous retries and refreshed form keys', async () => {
    const f = await fixture();
    let events = 0;
    f.events.on('portal_customer.request.created', () => { events++; });
    const body = { kind: 'repeat', referenceId: 'job-own', idempotencyKey: 'repeat-1', note: 'Same work next month, please.' };
    const responses = await Promise.all([f.submit(body), f.submit(body)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
    const receipts = await Promise.all(responses.map(response => response.json())) as any[];
    expect(receipts[0].data.request.id).toBe(receipts[1].data.request.id);
    expect(receipts[0].data.request).toMatchObject({ kind: 'repeat', source_title: 'Completed service', status: 'pending', version: 1 });
    expect(receipts[0].data.request.payload_hash).toBeUndefined();
    const refreshed = await f.submit({ ...body, idempotencyKey: 'repeat-2' });
    expect(refreshed.status).toBe(200);
    expect(((await refreshed.json()) as any).data.request.id).toBe(receipts[0].data.request.id);
    expect(await f.db.selectFrom('portal_customer_service_requests').selectAll().where('tenant_id', '=', f.tenantA).execute()).toHaveLength(1);
    expect(events).toBe(1);
    await f.db.destroy();
  });

  it('rejects a reused key or open work request with changed details', async () => {
    const f = await fixture();
    const body = { kind: 'repeat', referenceId: 'job-own', idempotencyKey: 'repeat-1', note: 'Original scope' };
    expect((await f.submit(body)).status).toBe(201);
    expect((await f.submit({ ...body, note: 'Changed scope' })).status).toBe(409);
    expect((await f.submit({ ...body, idempotencyKey: 'another-key', note: 'Changed scope' })).status).toBe(409);
    await f.db.destroy();
  });

  it('denies missing login, another customer, another tenant, and non-completed repeat work', async () => {
    const f = await fixture();
    const body = { kind: 'repeat', referenceId: 'job-own', idempotencyKey: 'repeat-1' };
    expect((await api(f.app, f.tenantA, 'POST', '/me/requests', body)).status).toBe(401);
    expect((await f.submit(body, f.otherSession)).status).toBe(404);
    expect((await f.submit(body, f.session, f.tenantB)).status).toBe(401);
    f.setJobStatus('planned');
    expect((await f.submit(body)).status).toBe(409);
    expect((await f.submit({ ...body, customerId: 'customer-other' })).status).toBe(400);
    expect(await f.db.selectFrom('portal_customer_service_requests').selectAll().where('tenant_id', '=', f.tenantA).execute()).toEqual([]);
    await f.db.destroy();
  });

  it('records preferred UTC times with original duration, and rejects terminal appointments and DST gaps', async () => {
    const f = await fixture();
    const body = { kind: 'reschedule', referenceId: 'appointment-own', idempotencyKey: 'reschedule-1', requestedStartsAt: '2027-01-11T10:00:00', timezone: 'America/Chicago' };
    const response = await f.submit(body);
    expect(response.status).toBe(201);
    expect(((await response.json()) as any).data.request).toMatchObject({ requested_starts_at: '2027-01-11T16:00:00.000Z', requested_ends_at: '2027-01-11T17:30:00.000Z', status: 'pending' });
    expect((await f.submit({ ...body, idempotencyKey: 'dst-gap', requestedStartsAt: '2027-03-14T02:30:00', timezone: 'America/New_York' })).status).toBe(400);
    expect((await f.submit({ ...body, idempotencyKey: 'dst-repeat', requestedStartsAt: '2027-11-07T01:30:00', timezone: 'America/New_York' })).status).toBe(400);
    f.setAppointmentStatus('canceled');
    expect((await f.submit({ ...body, idempotencyKey: 'canceled' })).status).toBe(409);
    // Original key still reconciles its receipt even when the source later changes.
    expect((await f.submit(body)).status).toBe(200);
    await f.db.destroy();
  });

  it('exposes only customer-owned receipts and makes owner responses visible with version checks', async () => {
    const f = await fixture();
    const created = await f.submit({ kind: 'repeat', referenceId: 'job-own', idempotencyKey: 'repeat-1' });
    const row = ((await created.json()) as any).data.request;
    expect(((await (await api(f.app, f.tenantA, 'GET', '/me/requests', undefined, f.otherSession)).json()) as any).data).toEqual([]);
    expect((await api(f.app, f.tenantB, 'GET', `/requests/${row.id}`)).status).toBe(404);
    expect((await api(f.app, f.tenantA, 'PATCH', `/requests/${row.id}`, { status: 'resolved', expectedVersion: 1 })).status).toBe(400);
    const acknowledged = await api(f.app, f.tenantA, 'PATCH', `/requests/${row.id}`, { status: 'acknowledged', response: 'We are checking dates.', expectedVersion: 1 });
    expect(acknowledged.status).toBe(200);
    expect((await api(f.app, f.tenantA, 'PATCH', `/requests/${row.id}`, { status: 'resolved', response: 'Confirmed with you.', expectedVersion: 1 })).status).toBe(409);
    const resolved = await api(f.app, f.tenantA, 'PATCH', `/requests/${row.id}`, { status: 'resolved', response: 'Please review the new quote for next month.', expectedVersion: 2 });
    expect(resolved.status).toBe(200);
    const receipts = await api(f.app, f.tenantA, 'GET', '/me/requests', undefined, f.session);
    expect(((await receipts.json()) as any).data).toMatchObject([{ id: row.id, status: 'resolved', response: 'Please review the new quote for next month.', version: 3 }]);
    expect((await api(f.app, f.tenantA, 'PATCH', `/requests/${row.id}`, { status: 'acknowledged', expectedVersion: 3 })).status).toBe(409);
    await f.db.destroy();
  });

  it('renders actual customer actions, creates a receipt through the HTML form, and protects its readback', async () => {
    const f = await fixture();
    const cookie = `portal_session=${f.session}`;
    const dashboard = await f.app.request('/ui', { headers: { 'x-tenant-id': f.tenantA, cookie } });
    const html = await dashboard.text();
    expect(html).toContain('Request this service again');
    expect(html).toContain('Request a reschedule');
    const created = await f.app.request('/ui/requests', { method: 'POST', headers: { 'x-tenant-id': f.tenantA, cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ kind: 'repeat', referenceId: 'job-own', idempotencyKey: 'form-1', note: '<script>customer note</script>' }) });
    expect(created.status).toBe(303);
    const location = created.headers.get('location')!;
    const receipt = await f.app.request(location, { headers: { 'x-tenant-id': f.tenantA, cookie } });
    expect(receipt.status).toBe(200);
    const receiptHtml = await receipt.text();
    expect(receiptHtml).toContain('Your request is recorded');
    expect(receiptHtml).toContain('&lt;script&gt;customer note&lt;/script&gt;');
    expect(receiptHtml).not.toContain('<script>customer note</script>');
    expect((await f.app.request(location, { headers: { 'x-tenant-id': f.tenantA, cookie: `portal_session=${f.otherSession}` } })).status).toBe(404);
    await f.db.destroy();
  });
});
