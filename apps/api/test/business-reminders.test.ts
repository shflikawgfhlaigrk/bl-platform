import { describe, expect, it, vi } from 'vitest';
import { createTestDb, type Kysely } from '@blacklabel/db';
import { asCoreDb, createTenant } from '@blacklabel/core';
import { createSchedulingContext, runReminderQueue, type SchedulingDatabase } from '@blacklabel/scheduling';
import { type ChannelProvider, type MessagingServiceOptions, type MessagingDatabase } from '@blacklabel/messaging';
import { createApp, type PlatformDatabase } from '../src/app';
import { businessReminderDelivery } from '../src/business-reminders';

async function fixture(provider?: ChannelProvider) {
  const db = createTestDb<PlatformDatabase>();
  const messaging: MessagingServiceOptions = provider ? { providers: { email: provider } } : {};
  const platform = await createApp({ db, businessPortals: true, messaging, disableRateLimit: true, includeCheckoutSimulator: false });
  const tenant = (await createTenant(asCoreDb(db), { name: 'Reminder fixture' })).id;
  const other = (await createTenant(asCoreDb(db), { name: 'Other company fixture' })).id;
  const { ownerUserId } = await platform.seedTenant(tenant);
  const otherOwner = await platform.seedTenant(other);
  const request = (route: string, method = 'GET', body?: unknown, tenantId = tenant) => platform.app.request(`/api/${route}`, {
    method, headers: { 'x-tenant-id': tenantId, 'x-user-id': tenantId === tenant ? ownerUserId : otherOwner.ownerUserId, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = async (route: string, method = 'GET', body?: unknown) => { const r = await request(route, method, body); expect(r.status, await r.clone().text()).toBeLessThan(300); return (await r.json() as any).data; };
  await data('messaging/channels','POST',{type:'email',name:'Fixture sender',address:'sender@example.test'});
  const calendar = await data('scheduling/calendars', 'POST', { name: 'Fixture calendar', timezone: 'UTC' });
  const { appointments } = await data('scheduling/appointments', 'POST', { calendarId: calendar.id, title: 'Reminder fixture', startsAt: '2090-01-01T10:00:00Z', endsAt: '2090-01-01T11:00:00Z' });
  const reminder = await data(`scheduling/appointments/${appointments[0].id}/reminders`, 'POST', { sendAt: '2000-01-01T10:00:00Z', channel: 'email', recipient: 'customer@example.test', message: 'Final fixture appointment reminder.' });
  const context = () => createSchedulingContext({ db: db as unknown as Kysely<SchedulingDatabase>, events: platform.events, reminderDelivery: businessReminderDelivery(db as unknown as Kysely<MessagingDatabase>, platform.events, messaging) });
  const row = () => db.selectFrom('scheduling_reminders').selectAll().where('tenant_id', '=', tenant).where('id', '=', reminder.id).executeTakeFirstOrThrow();
  return { db, platform, tenant, other, request, data, reminder, context, row, close: async () => { platform.detachEngine(); await db.destroy(); } };
}

describe('durable business appointment reminders', () => {
  it('reconciles an accepted submission after restart and emits delivered only after exact provider readback', async () => {
    let delivered = false;
    const send = vi.fn(async () => ({ status: 'sent' as const, providerMessageId: 'fixture-provider-id' }));
    const reconcile = vi.fn(async () => ({ status: delivered ? 'delivered' as const : 'accepted' as const, providerMessageId: 'fixture-provider-id', evidenceSha256: 'a'.repeat(64) }));
    const f = await fixture({ type: 'email', send, reconcile });
    try {
      const emitted = vi.fn(); f.platform.events.on('scheduling.reminder.sent', emitted);
      await runReminderQueue(f.context(), f.tenant);
      const accepted = await f.row(); expect(accepted.status).toBe('submitted'); expect(accepted.delivery_reference).toBeTruthy(); expect(accepted.sent_at).toBeNull(); expect(emitted).not.toHaveBeenCalled();
      // A second queue cycle respects backoff and never submits again.
      await runReminderQueue(f.context(), f.tenant); expect(reconcile).toHaveBeenCalledTimes(1);
      await f.db.updateTable('scheduling_reminders').set({status:'sending',lease_expires_at:'2000-01-01T00:00:00Z',next_attempt_at:null}).where('tenant_id','=',f.tenant).where('id','=',f.reminder.id).execute();
      delivered = true; await runReminderQueue(f.context(), f.tenant);
      expect((await f.row()).status).toBe('sent'); expect((await f.row()).sent_at).toBeTruthy(); expect(send).toHaveBeenCalledTimes(1); expect(reconcile).toHaveBeenCalledTimes(2); expect(emitted).toHaveBeenCalledTimes(1);
      expect((await f.request(`scheduling/reminders/${f.reminder.id}/send`,'POST',{},f.other)).status).toBe(404);
    } finally { await f.close(); }
  });
  it('keeps ambiguous submissions for review and never resends, including after a crashed claim', async () => {
    const send = vi.fn(async () => { throw Error('lost response after provider acceptance'); });
    const f = await fixture({ type: 'email', send });
    try {
      await runReminderQueue(f.context(), f.tenant); expect((await f.row()).status).toBe('review');
      await f.db.updateTable('scheduling_reminders').set({status:'sending',lease_expires_at:'2000-01-01T00:00:00Z',next_attempt_at:null}).where('tenant_id','=',f.tenant).where('id','=',f.reminder.id).execute();
      await runReminderQueue(f.context(), f.tenant);expect((await f.row()).status).toBe('review');expect(send).toHaveBeenCalledTimes(1);
      expect(await f.db.selectFrom('messaging_messages').selectAll().where('tenant_id','=',f.tenant).execute()).toHaveLength(1);
    } finally { await f.close(); }
  });
  it('keeps an unconnected reminder pending with backoff and no invented delivery', async () => {
    const f = await fixture();
    try {
      await runReminderQueue(f.context(),f.tenant);const row=await f.row();expect(row.status).toBe('pending');expect(row.attempts).toBe(1);expect(row.next_attempt_at).toBeTruthy();expect(row.sent_at).toBeNull();
      await runReminderQueue(f.context(),f.tenant);expect((await f.row()).attempts).toBe(1);
      expect(await f.db.selectFrom('messaging_messages').selectAll().where('tenant_id','=',f.tenant).execute()).toHaveLength(0);
    } finally { await f.close(); }
  });
  it('stops on provider rejection and isolates another tenant queue', async () => {
    const send=vi.fn(async()=>({status:'failed' as const,providerMessageId:'',detail:'Fixture rejection'}));const f=await fixture({type:'email',send});
    try {
      expect(await runReminderQueue(f.context(),f.other)).toEqual([]);expect(send).not.toHaveBeenCalled();
      await runReminderQueue(f.context(),f.tenant);expect((await f.row()).status).toBe('failed');await runReminderQueue(f.context(),f.tenant);expect(send).toHaveBeenCalledTimes(1);
    } finally {await f.close();}
  });
  it('requires review after an interrupted provider without durable operation support', async()=>{
    const f=await fixture();const deliver=vi.fn(async()=>({delivered:true}));
    try{
      await f.db.updateTable('scheduling_reminders').set({status:'sending',lease_expires_at:null}).where('tenant_id','=',f.tenant).where('id','=',f.reminder.id).execute();
      await runReminderQueue(createSchedulingContext({db:f.db as unknown as Kysely<SchedulingDatabase>,events:f.platform.events,reminderDelivery:{name:'non-durable-fixture',deliver}}),f.tenant);
      expect((await f.row()).status).toBe('review');expect(deliver).not.toHaveBeenCalled();
    }finally{await f.close();}
  });
});
