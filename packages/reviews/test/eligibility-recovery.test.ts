import { describe, expect, it, vi } from 'vitest';
import { reviewsRouter } from '@blacklabel/reviews';
import { createCampaign, createRequest, dispatchCampaign, getRequest, optOutPublic, processDueReminders, reconcileReviewDelivery, scheduleReminder } from '../src/service';
import { getPublicRequest, submitPublicReview } from '../src/service';
import type { ReviewCompletedJob, ReviewProvider } from '../src/service';
import { getInit, jsonInit, setup, SpyProvider } from './helpers';

const completed = (customerId: string, contactReady = true): ReviewCompletedJob => ({ customerId, jobId: `job-${customerId}`,
  sourceType: 'crm.job', completedAt: '2026-07-01T12:00:00.000Z', contactReady, customerName: customerId });

describe('completed-job eligibility and customer-wide preferences', () => {
  it('records one response under simultaneous submissions and a landing visit cannot reopen it', async () => {
    const f = await setup(), seen: unknown[] = [];
    f.events.on('reviews.review.submitted', event => { seen.push(event); });
    const request = await createRequest(f.db, f.events, f.tenantA.id, 'system', { customerId: 'concurrent' });
    const submissions = await Promise.allSettled([submitPublicReview(f.db, f.events, request.token, { rating: 1 }),
      submitPublicReview(f.db, f.events, request.token, { rating: 5 }), getPublicRequest(f.db, request.token)]);
    expect(submissions.slice(0, 2).filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await getRequest(f.db, f.tenantA.id, request.id)).status).toBe('completed');
    const responses = await f.db.selectFrom('reviews_responses').selectAll().where('tenant_id', '=', f.tenantA.id).where('request_id', '=', request.id).execute();
    expect(responses).toHaveLength(1); expect(seen).toHaveLength(1);
  });

  it('makes simultaneous opt-outs idempotent and duplicate completed-job campaigns leave no orphan campaign', async () => {
    const f = await setup(), seen: unknown[] = [];
    f.events.on('reviews.request.opted_out', event => { seen.push(event); });
    const request = await createRequest(f.db, f.events, f.tenantA.id, 'system', { customerId: 'concurrent-opt-out' });
    await Promise.all(Array.from({ length: 4 }, () => optOutPublic(f.db, f.events, request.token)));
    expect(seen).toHaveLength(1);
    const input = { name: 'Single completed job', customerIds: ['completed-customer'], completedJobs: [completed('completed-customer')] };
    const campaigns = await Promise.allSettled([createCampaign(f.db, f.events, f.tenantA.id, 'system', input), createCampaign(f.db, f.events, f.tenantA.id, 'system', input)]);
    expect(campaigns.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await f.db.selectFrom('reviews_campaigns').selectAll().where('tenant_id', '=', f.tenantA.id).execute()).toHaveLength(1);
  });

  it('prepares all eligible customers, with no rating selection and verified source receipts', async () => {
    const f = await setup();
    const jobs = [completed('never-rated'), completed('prior-low-rating'), completed('no-email', false), completed('opted-out'), completed('already-requested')];
    const optedOut = await createRequest(f.db, f.events, f.tenantA.id, 'system', { customerId: 'opted-out' });
    await optOutPublic(f.db, f.events, optedOut.token);
    await createRequest(f.db, f.events, f.tenantA.id, 'system', { customerId: 'already-requested', completedJob: jobs[4] });
    const provider: ReviewProvider = Object.assign(new SpyProvider(), { listCompletedJobs: async (tenantId: string) => tenantId === f.tenantA.id ? jobs : [] });
    const app = reviewsRouter({ db: f.db, events: f.events, contracts: {} }, provider);
    const audience = (await (await app.request('/eligible-customers', getInit(f.tenantA.id))).json() as any).data;
    expect(audience.eligible.map((job: any) => job.customerId).sort()).toEqual(['never-rated', 'prior-low-rating']);
    expect(audience.excluded.map((job: any) => job.reason).sort()).toEqual(['already_requested', 'no_contact', 'opted_out']);
    const result = await app.request('/campaigns/completed-jobs', jsonInit(f.tenantA.id, { name: 'All completed customers' }));
    expect(result.status).toBe(201);
    const campaign = (await result.json() as any).data;
    expect(campaign.requests.map((row: any) => row.customer_id).sort()).toEqual(['never-rated', 'prior-low-rating']);
    expect(campaign.requests.every((row: any) => row.source_job_id === `job-${row.customer_id}` && row.source_job_type === 'crm.job')).toBe(true);
    expect((await app.request('/campaigns/completed-jobs', jsonInit(f.tenantA.id, { name: 'Duplicate' }))).status).toBe(409);
    expect((await app.request('/requests', jsonInit(f.tenantA.id, { customerId: 'no-completed-job' }))).status).toBe(409);
    expect((await app.request('/requests', jsonInit(f.tenantB.id, { customerId: 'never-rated' }))).status).toBe(409);
  });

  it('an opt-out cancels every customer request/reminder, blocks new requests, and stays tenant scoped', async () => {
    const f = await setup(), provider = new SpyProvider();
    const first = await createRequest(f.db, f.events, f.tenantA.id, 'system', { customerId: 'same-customer-id' });
    const second = await createRequest(f.db, f.events, f.tenantA.id, 'system', { customerId: 'same-customer-id' });
    const other = await createRequest(f.db, f.events, f.tenantB.id, 'system', { customerId: 'same-customer-id' });
    for (const request of [first, second]) await scheduleReminder(f.db, f.events, f.tenantA.id, 'system', request.id, '2020-01-01T00:00:00.000Z');
    await optOutPublic(f.db, f.events, first.token);
    expect((await getRequest(f.db, f.tenantA.id, second.id)).status).toBe('opted_out');
    expect((await getRequest(f.db, f.tenantB.id, other.id)).status).toBe('pending');
    await expect(createRequest(f.db, f.events, f.tenantA.id, 'system', { customerId: 'same-customer-id' })).rejects.toMatchObject({ status: 409 });
    const campaign = await createCampaign(f.db, f.events, f.tenantA.id, 'system', { name: 'Future audience', customerIds: ['same-customer-id', 'new-customer'] });
    expect(campaign.requests.map(row => row.customer_id)).toEqual(['new-customer']);
    expect(await processDueReminders(f.db, f.tenantA.id, 'system', { provider })).toEqual({ sent: 0, canceled: 0 });
    expect(provider.reminders).toEqual([]);
    expect(await optOutPublic(f.db, f.events, first.token)).toEqual({ status: 'opted_out' });
  });
});

describe('review delivery receipts and recovery', () => {
  it('continues the batch after uncertainty and reconciles without resending', async () => {
    const f = await setup();
    const send = vi.fn(async (context: any) => {
      if (context.customerId === 'uncertain') throw Error('provider timed out with private detail that must not be stored');
      return { delivered: false, submitted: true, messageId: 'accepted-message' };
    });
    const provider: ReviewProvider = Object.assign(new SpyProvider(), { sendReviewRequest: send,
      getDeliveryStatus: vi.fn(async () => ({ status: 'submitted' as const, messageId: 'reconciled-message' })) });
    const { campaign, requests } = await createCampaign(f.db, f.events, f.tenantA.id, 'system', { name: 'Recoverable batch', customerIds: ['uncertain', 'accepted'] });
    expect(await dispatchCampaign(f.db, f.tenantA.id, 'system', campaign.id, { provider })).toEqual({ dispatched: 1, failed: 1, reason: 'needs_attention' });
    const uncertain = requests.find(row => row.customer_id === 'uncertain')!;
    const saved = await getRequest(f.db, f.tenantA.id, uncertain.id);
    expect(saved.delivery_status).toBe('needs_attention'); expect(saved.sent_at).toBeNull();
    expect(saved.delivery_error).not.toContain('private detail');
    expect(await dispatchCampaign(f.db, f.tenantA.id, 'system', campaign.id, { provider })).toEqual({ dispatched: 0, reason: 'no_pending' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(await reconcileReviewDelivery(f.db, f.tenantA.id, 'system', uncertain.id, provider)).toEqual({ status: 'submitted', messageId: 'reconciled-message' });
    expect((await getRequest(f.db, f.tenantA.id, uncertain.id)).delivery_message_id).toBe('reconciled-message');
    expect((await getRequest(f.db, f.tenantA.id, uncertain.id)).sent_at).not.toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
    await expect(reconcileReviewDelivery(f.db, f.tenantB.id, 'system', uncertain.id, provider)).rejects.toMatchObject({ status: 404 });
  });

  it('atomically claims a request so overlapping dispatch calls submit it once', async () => {
    const f = await setup();
    let release!: () => void, started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), began = new Promise<void>(resolve => { started = resolve; });
    const send = vi.fn(async () => { started(); await held; return { delivered: false, submitted: true, messageId: 'one-message' }; });
    const provider: ReviewProvider = Object.assign(new SpyProvider(), { sendReviewRequest: send });
    const { campaign } = await createCampaign(f.db, f.events, f.tenantA.id, 'system', { name: 'Concurrent', customerIds: ['one'] });
    const first = dispatchCampaign(f.db, f.tenantA.id, 'system', campaign.id, { provider });
    await began;
    expect(await dispatchCampaign(f.db, f.tenantA.id, 'system', campaign.id, { provider })).toEqual({ dispatched: 0, reason: 'no_pending' });
    release(); expect(await first).toEqual({ dispatched: 1, reason: null });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('holds uncertain reminders and distinguishes a delivered receipt from provider acceptance', async () => {
    const f = await setup();
    const request = await createRequest(f.db, f.events, f.tenantA.id, 'system', { customerId: 'one' });
    const reminder = await scheduleReminder(f.db, f.events, f.tenantA.id, 'system', request.id, '2020-01-01T00:00:00.000Z');
    const send = vi.fn(async () => { throw Error('unknown outcome'); });
    const provider: ReviewProvider = Object.assign(new SpyProvider(), { sendReminder: send,
      getDeliveryStatus: async () => ({ status: 'delivered' as const, messageId: 'delivered-reminder' }) });
    expect(await processDueReminders(f.db, f.tenantA.id, 'system', { provider })).toEqual({ sent: 0, canceled: 0, failed: 1 });
    expect(await processDueReminders(f.db, f.tenantA.id, 'system', { provider })).toEqual({ sent: 0, canceled: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    await reconcileReviewDelivery(f.db, f.tenantA.id, 'system', request.id, provider, reminder.id);
    const saved = await f.db.selectFrom('reviews_reminders').selectAll().where('tenant_id', '=', f.tenantA.id).where('id', '=', reminder.id).executeTakeFirstOrThrow();
    expect(saved.delivery_status).toBe('delivered'); expect(saved.delivery_message_id).toBe('delivered-reminder'); expect(saved.status).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
