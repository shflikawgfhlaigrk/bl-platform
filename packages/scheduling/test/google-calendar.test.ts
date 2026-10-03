import { describe, expect, it, vi } from 'vitest';
import { GoogleCalendarProvider } from '../src/google-calendar';
import type { ExternalEventInput } from '../src/service';

const fixtureEvent: ExternalEventInput = { tenantId: 'company-fixture', calendarId: 'local-fixture', appointmentId: 'appointment-fixture', title: 'Customer service fixture', startsAt: '2027-02-10T16:00:00.000Z', endsAt: '2027-02-10T17:00:00.000Z', status: 'confirmed' };
function fixture() {
  const events = new Map<string, any>(); const writes: string[] = [];
  let loseWriteResponse = false, corruptReadback = false;
  const transport = vi.fn(async (url: any, init: any = {}) => {
    const u = new URL(String(url));
    if (u.origin === 'https://oauth2.googleapis.com') return Response.json({ access_token: 'fixture-only-token', token_type: 'Bearer' });
    expect(u.origin).toBe('https://www.googleapis.com'); expect(init.headers.authorization).toBe('Bearer fixture-only-token');
    expect(u.pathname).toContain('/calendars/fixture%40example.test/events');
    const id = u.pathname.split('/').at(-1)!;
    if (!init.method || init.method === 'GET') {
      const row = events.get(id); return row ? Response.json(corruptReadback ? { ...row, end: { dateTime: '2099-01-01T00:00:00Z' } } : row) : new Response('', { status: 404 });
    }
    writes.push(init.method); expect(u.searchParams.get('sendUpdates')).toBe('none');
    if (init.method === 'DELETE') { events.delete(id); if (loseWriteResponse) throw Error('lost response'); return new Response(null, { status: 204 }); }
    const row = JSON.parse(init.body); events.set(row.id, { ...row, status: 'confirmed' });
    if (loseWriteResponse) throw Error('lost response after write');
    return Response.json(row, { status: init.method === 'POST' ? 201 : 200 });
  }) as unknown as typeof fetch;
  const provider = new GoogleCalendarProvider({ fetchImpl: transport, connection: async tenantId => tenantId === fixtureEvent.tenantId ? { calendarId: 'fixture@example.test', clientId: 'fixture-client', clientSecret: 'fixture-secret', refreshToken: 'fixture-refresh' } : undefined });
  return { events, writes, transport, provider, lose: () => { loseWriteResponse = true; }, corrupt: () => { corruptReadback = true; } };
}
describe('Google Calendar destination acceptance', () => {
  it('creates, updates and cancels the deterministic appointment and verifies each destination', async () => {
    const f=fixture();const saved=await f.provider.upsertEvent(fixtureEvent);expect(saved.externalId).toMatch(/^[a-f0-9]{64}$/);expect(f.events.size).toBe(1);
    expect(await f.provider.upsertEvent({...fixtureEvent,title:'Changed fixture title'})).toEqual(saved);expect(f.events.size).toBe(1);expect(f.events.get(saved.externalId).summary).toBe('Changed fixture title');
    f.lose();await f.provider.deleteEvent(fixtureEvent);expect(f.events.size).toBe(0);expect(f.writes).toEqual(['POST','PUT','DELETE']);await f.provider.deleteEvent(fixtureEvent);expect(f.writes).toHaveLength(3);
  });
  it('resolves a lost write response by reading back one event and rejects mismatching readback',async()=>{
    const f=fixture();f.lose();await f.provider.upsertEvent(fixtureEvent);expect(f.events.size).toBe(1);expect(f.writes).toEqual(['POST']);f.corrupt();await expect(f.provider.upsertEvent(fixtureEvent)).rejects.toThrow('readback differs');
  });
  it('does not overwrite an unrelated destination or borrow another tenant connection',async()=>{
    const f=fixture();const saved=await f.provider.upsertEvent(fixtureEvent);f.events.get(saved.externalId).extendedProperties={};
    await expect(f.provider.upsertEvent(fixtureEvent)).rejects.toThrow('does not belong');await expect(f.provider.deleteEvent(fixtureEvent)).rejects.toThrow('does not belong');expect(f.writes).toEqual(['POST']);
    const calls=(f.transport as any).mock.calls.length;await expect(f.provider.upsertEvent({...fixtureEvent,tenantId:'other-company'})).rejects.toThrow('Connect');expect((f.transport as any).mock.calls).toHaveLength(calls);
  });
  it('rejects authorization failures without leaking response bodies or credentials',async()=>{
    const provider=new GoogleCalendarProvider({connection:async()=>({calendarId:'fixture',clientId:'fixture',clientSecret:'private-fixture',refreshToken:'private-refresh'}),fetchImpl:vi.fn(async()=>new Response('secret provider response',{status:401}))});
    await expect(provider.upsertEvent(fixtureEvent)).rejects.toThrow('Google authorization failed (HTTP 401)');
  });
});
