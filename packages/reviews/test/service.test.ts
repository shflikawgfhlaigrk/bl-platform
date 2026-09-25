import { describe, expect, it } from 'vitest';
import type { SendMessageInput } from '@blacklabel/core';
import {
  createCampaign,
  createRequest,
  createTestimonial,
  dispatchCampaign,
  getPublicRequest,
  getReviewDashboard,
  listReminders,
  processDueReminders,
  resolveResponse,
  scheduleReminder,
  submitPublicReview,
  optOutPublic,
} from '../src/service';
import { SpyProvider, setup } from './helpers';

describe('campaign dispatch — schedule & throttle', () => {
  it('respects the per-UTC-day throttle and resets the next day', async () => {
    const { db, events, tenantA } = await setup();
    const { campaign } = await createCampaign(db, events, tenantA.id, 'system', {
      name: 'Throttle',
      customerIds: ['c1', 'c2', 'c3', 'c4', 'c5'],
      throttlePerDay: 2,
    });

    const day1 = '2026-07-10T09:00:00.000Z';
    const first = await dispatchCampaign(db, tenantA.id, 'system', campaign.id, { now: day1, provider: new SpyProvider() });
    expect(first).toEqual({ dispatched: 2, reason: null });

    const sameDay = await dispatchCampaign(db, tenantA.id, 'system', campaign.id, {
      now: '2026-07-10T23:00:00.000Z',
    });
    expect(sameDay).toEqual({ dispatched: 0, reason: 'throttled' });

    const nextDay = await dispatchCampaign(db, tenantA.id, 'system', campaign.id, {
      now: '2026-07-11T00:30:00.000Z',
      provider: new SpyProvider(),
    });
    expect(nextDay).toEqual({ dispatched: 2, reason: null });

    const sent = await db
      .selectFrom('reviews_requests')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .where('campaign_id', '=', campaign.id)
      .where('sent_at', 'is not', null)
      .execute();
    expect(sent).toHaveLength(4);
  });

  it('does nothing before schedule_start_at, then dispatches once the schedule opens', async () => {
    const { db, events, tenantA } = await setup();
    const { campaign } = await createCampaign(db, events, tenantA.id, 'system', {
      name: 'Scheduled',
      customerIds: ['c1'],
      scheduleStartAt: '2026-08-01T00:00:00.000Z',
    });

    const early = await dispatchCampaign(db, tenantA.id, 'system', campaign.id, {
      now: '2026-07-15T00:00:00.000Z',
    });
    expect(early).toEqual({ dispatched: 0, reason: 'not_started' });

    const onTime = await dispatchCampaign(db, tenantA.id, 'system', campaign.id, {
      now: '2026-08-01T00:00:01.000Z',
      provider: new SpyProvider(),
    });
    expect(onTime).toEqual({ dispatched: 1, reason: null });

    const done = await dispatchCampaign(db, tenantA.id, 'system', campaign.id, {
      now: '2026-08-01T01:00:00.000Z',
    });
    expect(done).toEqual({ dispatched: 0, reason: 'no_pending' });
  });

  it('uses one configured delivery path without a duplicate messaging send', async () => {
    const { db, events, tenantA } = await setup();
    const provider = new SpyProvider();
    const messages: SendMessageInput[] = [];
    const sendMessage = {
      sendMessage: async (input: SendMessageInput) => {
        messages.push(input);
        return { id: 'msg_1' };
      },
    };
    const { campaign, requests } = await createCampaign(db, events, tenantA.id, 'system', {
      name: 'Wired',
      customerIds: ['c1'],
    });

    await dispatchCampaign(db, tenantA.id, 'system', campaign.id, { provider, sendMessage });
    expect(provider.requests).toHaveLength(1);
    expect(messages).toHaveLength(0);
    expect(provider.requests[0]).toMatchObject({ tenantId: tenantA.id, requestId: requests[0].id });
    expect((provider.requests[0] as any).link).toContain(requests[0].token);
  });

  it('keeps the request unsent when no delivery provider is connected', async () => {
    const { db, events, tenantA } = await setup();
    const { campaign } = await createCampaign(db, events, tenantA.id, 'system', {
      name: 'No contract',
      customerIds: ['c1'],
    });
    await expect(dispatchCampaign(db, tenantA.id, 'system', campaign.id, {})).rejects.toThrow('not connected');
    const row = await db.selectFrom('reviews_requests').selectAll().where('tenant_id', '=', tenantA.id).where('campaign_id', '=', campaign.id).executeTakeFirstOrThrow();
    expect(row.sent_at).toBeNull();
  });
});

describe('follow-up reminders', () => {
  it('schedules a reminder row with send_at and emits reviews.reminder.scheduled', async () => {
    const { db, events, tenantA } = await setup();
    const emitted: any[] = [];
    events.on('reviews.reminder.scheduled', (e) => {
      emitted.push(e);
    });
    const request = await createRequest(db, events, tenantA.id, 'system', { customerId: 'c1' });
    const reminder = await scheduleReminder(
      db,
      events,
      tenantA.id,
      'system',
      request.id,
      '2026-07-20T12:00:00.000Z',
    );
    expect(reminder.status).toBe('scheduled');
    expect(reminder.send_at).toBe('2026-07-20T12:00:00.000Z');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload).toEqual({
      reminderId: reminder.id,
      requestId: request.id,
      sendAt: '2026-07-20T12:00:00.000Z',
    });
  });

  it('refuses to schedule a reminder on a completed request', async () => {
    const { db, events, tenantA } = await setup();
    const request = await createRequest(db, events, tenantA.id, 'system', { customerId: 'c1' });
    await submitPublicReview(db, events, request.token, { rating: 5 });
    await expect(
      scheduleReminder(db, events, tenantA.id, 'system', request.id, '2026-07-20T12:00:00.000Z'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('processes only due reminders through the provider stub and marks them sent', async () => {
    const { db, events, tenantA } = await setup();
    const provider = new SpyProvider();
    const request = await createRequest(db, events, tenantA.id, 'system', { customerId: 'c1' });
    const due = await scheduleReminder(db, events, tenantA.id, 'system', request.id, '2026-07-10T00:00:00.000Z');
    const future = await scheduleReminder(db, events, tenantA.id, 'system', request.id, '2027-01-01T00:00:00.000Z');

    const result = await processDueReminders(db, tenantA.id, 'system', {
      now: '2026-07-10T12:00:00.000Z',
      provider,
    });
    expect(result).toEqual({ sent: 1, canceled: 0 });
    expect(provider.reminders).toHaveLength(1);

    const rows = await listReminders(db, tenantA.id, { requestId: request.id });
    const dueRow = rows.find((r) => r.id === due.id)!;
    const futureRow = rows.find((r) => r.id === future.id)!;
    expect(dueRow.status).toBe('sent');
    expect(dueRow.sent_at).toBe('2026-07-10T12:00:00.000Z');
    expect(futureRow.status).toBe('scheduled');
  });

  it('cancels (never sends) a due reminder whose request opted out', async () => {
    const { db, events, tenantA } = await setup();
    const provider = new SpyProvider();
    const request = await createRequest(db, events, tenantA.id, 'system', { customerId: 'c1' });
    const reminder = await scheduleReminder(
      db,
      events,
      tenantA.id,
      'system',
      request.id,
      '2026-07-10T00:00:00.000Z',
    );
    // Opt out AFTER scheduling; opt-out cancels it immediately...
    await optOutPublic(db, events, request.token);
    // ...but even a reminder that somehow stayed scheduled must be skipped.
    await db
      .updateTable('reviews_reminders')
      .set({ status: 'scheduled' })
      .where('tenant_id', '=', tenantA.id)
      .where('id', '=', reminder.id)
      .execute();

    const result = await processDueReminders(db, tenantA.id, 'system', {
      now: '2026-07-11T00:00:00.000Z',
      provider,
    });
    expect(result).toEqual({ sent: 0, canceled: 1 });
    expect(provider.reminders).toHaveLength(0);
  });
});

describe('testimonials & dashboard (service level)', () => {
  it('rejects testimonial capture without explicit consent', async () => {
    const { db, events, tenantA } = await setup();
    await expect(
      createTestimonial(db, events, tenantA.id, 'system', {
        customerId: 'c1',
        quote: 'Nice',
        consent: false,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('computes dashboard aggregates exactly and reflects follow-up resolution', async () => {
    const { db, events, tenantA } = await setup();
    // 4 requests: two complete (5-star and 2-star), one clicked, one untouched.
    const r1 = await createRequest(db, events, tenantA.id, 'system', { customerId: 'c1' });
    const r2 = await createRequest(db, events, tenantA.id, 'system', { customerId: 'c2' });
    const r3 = await createRequest(db, events, tenantA.id, 'system', { customerId: 'c3' });
    await createRequest(db, events, tenantA.id, 'system', { customerId: 'c4' });

    await submitPublicReview(db, events, r1.token, { rating: 5 });
    const negative = await submitPublicReview(db, events, r2.token, { rating: 2, comment: 'slow' });
    await getPublicRequest(db, r3.token); // clicked only
    await createTestimonial(db, events, tenantA.id, 'system', {
      customerId: 'c1',
      quote: 'Loved it',
      consent: true,
    });

    const dashboard = await getReviewDashboard(db, tenantA.id);
    expect(dashboard.requests).toEqual({ total: 4, pending: 1, clicked: 1, completed: 2, opted_out: 0 });
    expect(dashboard.reviews.volume).toBe(2);
    expect(dashboard.reviews.averageRating).toBe(3.5);
    expect(dashboard.reviews.positive).toBe(1);
    expect(dashboard.reviews.negative).toBe(1);
    expect(dashboard.reviews.flaggedOpen).toBe(1);
    expect(dashboard.responseRate).toBe(0.5);
    expect(dashboard.testimonials).toBe(1);

    const resolved = await resolveResponse(db, tenantA.id, 'user_1', negative.response.id);
    expect(resolved.resolved_at).not.toBeNull();
    const after = await getReviewDashboard(db, tenantA.id);
    expect(after.reviews.flaggedOpen).toBe(0);
  });

  it('audits campaign creation and dispatch', async () => {
    const { db, events, tenantA } = await setup();
    const { campaign } = await createCampaign(db, events, tenantA.id, 'user_42', {
      name: 'Audited',
      customerIds: ['c1'],
    });
    await dispatchCampaign(db, tenantA.id, 'user_42', campaign.id, { provider: new SpyProvider() });
    const entries = await db
      .selectFrom('audit_log')
      .select(['actor', 'action', 'entity_id'])
      .where('tenant_id', '=', tenantA.id)
      .where('entity_type', '=', 'reviews.campaign')
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    // Entries can share a created_at millisecond, so compare order-independently.
    expect(entries.map((e) => e.action).sort()).toEqual([
      'reviews.campaign.created',
      'reviews.campaign.dispatched',
    ]);
    expect(entries.every((e) => e.actor === 'user_42' && e.entity_id === campaign.id)).toBe(true);
  });
});
