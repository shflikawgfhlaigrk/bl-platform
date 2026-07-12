/**
 * Reviews service — tenant-scoped business logic.
 *
 * INTEGRITY RULE: this module NEVER fabricates reviews. It only requests,
 * tracks, and organizes genuine feedback from real customers. Nothing here
 * writes a review on a customer's behalf, auto-posts to a platform, or
 * synthesizes ratings.
 */
import { DateTime } from 'luxon';
import type { Kysely } from 'kysely';
import {
  ApiError,
  asCoreDb,
  audit,
  id,
  nowIso,
  type EventBus,
  type Pagination,
  type SendMessageContract,
  type Sort,
} from '@blacklabel/core';
import type {
  ReviewCampaignRow,
  ReviewPlatformRow,
  ReviewReminderRow,
  ReviewRequestRow,
  ReviewResponseRow,
  ReviewSentiment,
  ReviewTestimonialRow,
  ReviewsDatabase,
} from './schema';

type Db = Kysely<ReviewsDatabase>;

export const DEFAULT_RATING_THRESHOLD = 4;
export const DEFAULT_THROTTLE_PER_DAY = 25;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Canonical public path for a tokenized review-request link (apps/api mounts
 * this router at /api/reviews). The token is the only credential.
 */
export function reviewRequestPublicPath(token: string): string {
  return `/api/reviews/public/requests/${token}`;
}

/** ~42 chars of nanoid entropy — the token IS the credential for the public link. */
function newToken(): string {
  return `${id()}${id()}`;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Start of the UTC day containing `iso`, as an ISO string (for throttle windows). */
function utcDayStart(iso: string): string {
  const start = DateTime.fromISO(iso, { zone: 'utc' }).startOf('day').toISO();
  if (!start) throw ApiError.badRequest(`invalid timestamp: ${iso}`);
  return start;
}

/* ------------------------------------------------------------------ *
 * Boundary DTOs (integer 0/1 -> boolean)
 * ------------------------------------------------------------------ */

export interface ReviewPlatform extends Omit<ReviewPlatformRow, 'enabled'> {
  enabled: boolean;
}

export interface ReviewResponse extends Omit<ReviewResponseRow, 'flagged_for_followup'> {
  flagged_for_followup: boolean;
}

export interface ReviewTestimonial extends Omit<ReviewTestimonialRow, 'consent'> {
  consent: boolean;
}

function toPlatform(row: ReviewPlatformRow): ReviewPlatform {
  return { ...row, enabled: row.enabled === 1 };
}

function toResponse(row: ReviewResponseRow): ReviewResponse {
  return { ...row, flagged_for_followup: row.flagged_for_followup === 1 };
}

function toTestimonial(row: ReviewTestimonialRow): ReviewTestimonial {
  return { ...row, consent: row.consent === 1 };
}

/* ------------------------------------------------------------------ *
 * Provider interface (Google-Business-ready; stubs are strict no-ops)
 * ------------------------------------------------------------------ */

export interface ReviewProviderSendContext {
  tenantId: string;
  requestId: string;
  customerId: string;
  /** Public tokenized link the customer should receive. */
  link: string;
}

export interface ReviewProviderReminderContext extends ReviewProviderSendContext {
  reminderId: string;
}

export interface ReviewProviderSyncContext {
  tenantId: string;
  platformId: string;
  targetUrl: string;
}

/**
 * Outbound delivery + platform integration seam. A real implementation would
 * deliver the request/reminder (email/SMS via the messaging module or an
 * external API) and read back PUBLIC review stats from the platform.
 * Providers must never post, edit, or fabricate reviews.
 */
export interface ReviewProvider {
  readonly key: string;
  sendReviewRequest(ctx: ReviewProviderSendContext): Promise<{ delivered: boolean }>;
  sendReminder(ctx: ReviewProviderReminderContext): Promise<{ delivered: boolean }>;
  syncExternalReviews(ctx: ReviewProviderSyncContext): Promise<{ imported: number }>;
}

/**
 * Google-Business-ready provider — a deliberate no-op stub. It satisfies the
 * interface so apps/api can wire a real implementation later without touching
 * this module. It performs NO network calls and imports NO reviews.
 */
export class GoogleBusinessProvider implements ReviewProvider {
  readonly key = 'google_business';

  async sendReviewRequest(_ctx: ReviewProviderSendContext): Promise<{ delivered: boolean }> {
    return { delivered: true }; // stub: nothing actually leaves the process
  }

  async sendReminder(_ctx: ReviewProviderReminderContext): Promise<{ delivered: boolean }> {
    return { delivered: true }; // stub: nothing actually leaves the process
  }

  async syncExternalReviews(_ctx: ReviewProviderSyncContext): Promise<{ imported: number }> {
    return { imported: 0 }; // stub: never invents external reviews
  }
}

/* ------------------------------------------------------------------ *
 * Platforms
 * ------------------------------------------------------------------ */

export interface CreatePlatformInput {
  key: string;
  name: string;
  targetUrl: string;
  provider?: string;
  enabled?: boolean;
}

export async function createPlatform(
  db: Db,
  tenantId: string,
  actor: string,
  input: CreatePlatformInput,
): Promise<ReviewPlatform> {
  const existing = await db
    .selectFrom('reviews_platforms')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('key', '=', input.key)
    .executeTakeFirst();
  if (existing) {
    throw ApiError.conflict(`platform key already exists: ${input.key}`);
  }
  const now = nowIso();
  const row: ReviewPlatformRow = {
    id: id(),
    tenant_id: tenantId,
    key: input.key,
    name: input.name,
    target_url: input.targetUrl,
    provider: input.provider ?? 'generic',
    enabled: (input.enabled ?? true) ? 1 : 0,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('reviews_platforms').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'reviews.platform.created', 'reviews.platform', row.id, {
    key: row.key,
    name: row.name,
  });
  return toPlatform(row);
}

export async function listPlatforms(
  db: Db,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
  sort: Sort = { column: 'created_at', direction: 'asc' },
): Promise<ReviewPlatform[]> {
  const rows = await db
    .selectFrom('reviews_platforms')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy(sort.column as 'created_at' | 'name' | 'key', sort.direction)
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
  return rows.map(toPlatform);
}

export async function getPlatform(db: Db, tenantId: string, platformId: string): Promise<ReviewPlatform> {
  const row = await db
    .selectFrom('reviews_platforms')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', platformId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`platform not found: ${platformId}`);
  return toPlatform(row);
}

export interface UpdatePlatformInput {
  name?: string;
  targetUrl?: string;
  provider?: string;
  enabled?: boolean;
}

export async function updatePlatform(
  db: Db,
  tenantId: string,
  actor: string,
  platformId: string,
  patch: UpdatePlatformInput,
): Promise<ReviewPlatform> {
  const set: Partial<ReviewPlatformRow> = { updated_at: nowIso() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.targetUrl !== undefined) set.target_url = patch.targetUrl;
  if (patch.provider !== undefined) set.provider = patch.provider;
  if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0;

  const result = await db
    .updateTable('reviews_platforms')
    .set(set)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', platformId)
    .executeTakeFirst();
  if (result.numUpdatedRows === 0n) {
    throw ApiError.notFound(`platform not found: ${platformId}`);
  }
  await audit(asCoreDb(db), tenantId, actor, 'reviews.platform.updated', 'reviews.platform', platformId, patch);
  return getPlatform(db, tenantId, platformId);
}

export async function deletePlatform(
  db: Db,
  tenantId: string,
  actor: string,
  platformId: string,
): Promise<void> {
  const result = await db
    .deleteFrom('reviews_platforms')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', platformId)
    .executeTakeFirst();
  if (result.numDeletedRows === 0n) {
    throw ApiError.notFound(`platform not found: ${platformId}`);
  }
  await audit(asCoreDb(db), tenantId, actor, 'reviews.platform.deleted', 'reviews.platform', platformId);
}

/** Enabled platforms only — what a positively-gated customer is offered. */
async function enabledPlatformLinks(
  db: Db,
  tenantId: string,
): Promise<Array<{ id: string; key: string; name: string; url: string }>> {
  const rows = await db
    .selectFrom('reviews_platforms')
    .select(['id', 'key', 'name', 'target_url'])
    .where('tenant_id', '=', tenantId)
    .where('enabled', '=', 1)
    .orderBy('name')
    .orderBy('id')
    .execute();
  return rows.map((r) => ({ id: r.id, key: r.key, name: r.name, url: r.target_url }));
}

/* ------------------------------------------------------------------ *
 * Campaigns
 * ------------------------------------------------------------------ */

export interface CreateCampaignInput {
  name: string;
  /** Audience — CRM customer ids (deduplicated). One request row per customer. */
  customerIds: string[];
  ratingThreshold?: number;
  throttlePerDay?: number;
  scheduleStartAt?: string;
}

export async function createCampaign(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  input: CreateCampaignInput,
): Promise<{ campaign: ReviewCampaignRow; requests: ReviewRequestRow[] }> {
  const customerIds = [...new Set(input.customerIds)];
  const now = nowIso();
  const campaign: ReviewCampaignRow = {
    id: id(),
    tenant_id: tenantId,
    name: input.name,
    status: 'active',
    rating_threshold: input.ratingThreshold ?? DEFAULT_RATING_THRESHOLD,
    throttle_per_day: input.throttlePerDay ?? DEFAULT_THROTTLE_PER_DAY,
    schedule_start_at: input.scheduleStartAt ?? null,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('reviews_campaigns').values(campaign).execute();

  const requests: ReviewRequestRow[] = customerIds.map((customerId) => ({
    id: id(),
    tenant_id: tenantId,
    campaign_id: campaign.id,
    customer_id: customerId,
    token: newToken(),
    status: 'pending',
    rating_threshold: campaign.rating_threshold,
    sent_at: null,
    clicked_at: null,
    completed_at: null,
    opted_out_at: null,
    created_at: now,
    updated_at: now,
  }));
  if (requests.length > 0) {
    await db.insertInto('reviews_requests').values(requests).execute();
  }

  await audit(asCoreDb(db), tenantId, actor, 'reviews.campaign.created', 'reviews.campaign', campaign.id, {
    name: campaign.name,
    requestCount: requests.length,
  });
  await events.emit(tenantId, 'reviews.campaign.created', {
    campaignId: campaign.id,
    requestCount: requests.length,
  });
  for (const request of requests) {
    await events.emit(tenantId, 'reviews.request.created', {
      requestId: request.id,
      customerId: request.customer_id,
      campaignId: campaign.id,
    });
  }
  return { campaign, requests };
}

export async function listCampaigns(
  db: Db,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
): Promise<ReviewCampaignRow[]> {
  return db
    .selectFrom('reviews_campaigns')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export async function getCampaign(db: Db, tenantId: string, campaignId: string): Promise<ReviewCampaignRow> {
  const row = await db
    .selectFrom('reviews_campaigns')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', campaignId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`campaign not found: ${campaignId}`);
  return row;
}

export interface CampaignRequestStats {
  total: number;
  pending: number;
  clicked: number;
  completed: number;
  opted_out: number;
}

export async function getCampaignWithStats(
  db: Db,
  tenantId: string,
  campaignId: string,
): Promise<ReviewCampaignRow & { requests: CampaignRequestStats }> {
  const campaign = await getCampaign(db, tenantId, campaignId);
  const rows = await db
    .selectFrom('reviews_requests')
    .select('status')
    .select((eb) => eb.fn.countAll().as('c'))
    .where('tenant_id', '=', tenantId)
    .where('campaign_id', '=', campaignId)
    .groupBy('status')
    .execute();
  const stats: CampaignRequestStats = { total: 0, pending: 0, clicked: 0, completed: 0, opted_out: 0 };
  for (const row of rows) {
    const count = Number(row.c);
    stats.total += count;
    if (row.status in stats) {
      stats[row.status as keyof CampaignRequestStats] += count;
    }
  }
  return { ...campaign, requests: stats };
}

export interface UpdateCampaignInput {
  name?: string;
  status?: 'active' | 'paused' | 'completed';
}

export async function updateCampaign(
  db: Db,
  tenantId: string,
  actor: string,
  campaignId: string,
  patch: UpdateCampaignInput,
): Promise<ReviewCampaignRow> {
  const set: Partial<ReviewCampaignRow> = { updated_at: nowIso() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.status !== undefined) set.status = patch.status;
  const result = await db
    .updateTable('reviews_campaigns')
    .set(set)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', campaignId)
    .executeTakeFirst();
  if (result.numUpdatedRows === 0n) {
    throw ApiError.notFound(`campaign not found: ${campaignId}`);
  }
  await audit(asCoreDb(db), tenantId, actor, 'reviews.campaign.updated', 'reviews.campaign', campaignId, patch);
  return getCampaign(db, tenantId, campaignId);
}

export interface DispatchResult {
  dispatched: number;
  reason: 'not_started' | 'throttled' | 'no_pending' | null;
}

export interface DispatchOptions {
  /** Override "now" (ISO-8601 UTC) — used by schedulers/tests. */
  now?: string;
  provider?: ReviewProvider;
  /** Optional messaging contract; dispatch degrades gracefully without it. */
  sendMessage?: SendMessageContract;
}

/**
 * Send the next batch of a campaign's pending requests, respecting the
 * schedule (no-op before schedule_start_at) and the per-UTC-day throttle.
 * Delivery goes through the provider stub and, when wired, the messaging
 * contract. Requests keep status "pending" until the customer clicks; sent_at
 * records the dispatch.
 */
export async function dispatchCampaign(
  db: Db,
  tenantId: string,
  actor: string,
  campaignId: string,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const campaign = await getCampaign(db, tenantId, campaignId);
  if (campaign.status !== 'active') {
    throw ApiError.conflict(`campaign is not active: ${campaign.status}`);
  }
  const now = options.now ?? nowIso();
  const provider = options.provider ?? new GoogleBusinessProvider();

  if (campaign.schedule_start_at && now < campaign.schedule_start_at) {
    return { dispatched: 0, reason: 'not_started' };
  }

  const dayStart = utcDayStart(now);
  const sentTodayRow = await db
    .selectFrom('reviews_requests')
    .select((eb) => eb.fn.countAll().as('c'))
    .where('tenant_id', '=', tenantId)
    .where('campaign_id', '=', campaignId)
    .where('sent_at', 'is not', null)
    .where('sent_at', '>=', dayStart)
    .executeTakeFirst();
  const sentToday = Number(sentTodayRow?.c ?? 0);
  const quota = Math.max(0, campaign.throttle_per_day - sentToday);
  if (quota === 0) {
    return { dispatched: 0, reason: 'throttled' };
  }

  const batch = await db
    .selectFrom('reviews_requests')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('campaign_id', '=', campaignId)
    .where('status', '=', 'pending')
    .where('sent_at', 'is', null)
    .orderBy('created_at')
    .orderBy('id')
    .limit(quota)
    .execute();
  if (batch.length === 0) {
    return { dispatched: 0, reason: 'no_pending' };
  }

  for (const request of batch) {
    await db
      .updateTable('reviews_requests')
      .set({ sent_at: now, updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', request.id)
      .execute();
    const link = reviewRequestPublicPath(request.token);
    await provider.sendReviewRequest({
      tenantId,
      requestId: request.id,
      customerId: request.customer_id,
      link,
    });
    if (options.sendMessage) {
      try {
        await options.sendMessage.sendMessage({
          tenantId,
          channel: 'portal',
          to: request.customer_id,
          subject: 'We would love your feedback',
          body: `Please share your honest feedback: ${link}`,
          relatedEntityType: 'reviews.request',
          relatedEntityId: request.id,
        });
      } catch {
        // Messaging is best-effort; dispatch state is already recorded.
      }
    }
  }

  await audit(asCoreDb(db), tenantId, actor, 'reviews.campaign.dispatched', 'reviews.campaign', campaignId, {
    dispatched: batch.length,
    at: now,
  });
  return { dispatched: batch.length, reason: null };
}

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

export interface CreateRequestInput {
  customerId: string;
  campaignId?: string;
  ratingThreshold?: number;
}

export async function createRequest(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  input: CreateRequestInput,
): Promise<ReviewRequestRow> {
  let threshold = input.ratingThreshold ?? DEFAULT_RATING_THRESHOLD;
  if (input.campaignId) {
    const campaign = await getCampaign(db, tenantId, input.campaignId); // 404s cross-tenant
    threshold = input.ratingThreshold ?? campaign.rating_threshold;
  }
  const now = nowIso();
  const row: ReviewRequestRow = {
    id: id(),
    tenant_id: tenantId,
    campaign_id: input.campaignId ?? null,
    customer_id: input.customerId,
    token: newToken(),
    status: 'pending',
    rating_threshold: threshold,
    sent_at: null,
    clicked_at: null,
    completed_at: null,
    opted_out_at: null,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('reviews_requests').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'reviews.request.created', 'reviews.request', row.id, {
    customerId: row.customer_id,
    campaignId: row.campaign_id,
  });
  await events.emit(tenantId, 'reviews.request.created', {
    requestId: row.id,
    customerId: row.customer_id,
    campaignId: row.campaign_id,
  });
  return row;
}

export interface RequestFilters {
  status?: string;
  campaignId?: string;
  customerId?: string;
}

export async function listRequests(
  db: Db,
  tenantId: string,
  filters: RequestFilters = {},
  page: Pagination = { limit: 50, offset: 0 },
  sort: Sort = { column: 'created_at', direction: 'asc' },
): Promise<ReviewRequestRow[]> {
  let qb = db.selectFrom('reviews_requests').selectAll().where('tenant_id', '=', tenantId);
  if (filters.status !== undefined) qb = qb.where('status', '=', filters.status);
  if (filters.campaignId !== undefined) qb = qb.where('campaign_id', '=', filters.campaignId);
  if (filters.customerId !== undefined) qb = qb.where('customer_id', '=', filters.customerId);
  return qb
    .orderBy(sort.column as 'created_at' | 'status', sort.direction)
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export async function getRequest(db: Db, tenantId: string, requestId: string): Promise<ReviewRequestRow> {
  const row = await db
    .selectFrom('reviews_requests')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', requestId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`review request not found: ${requestId}`);
  return row;
}

export interface RequestLink {
  requestId: string;
  token: string;
  url: string;
  /** QR generation is stubbed per spec — clients render the QR from `url`. */
  qr: 'placeholder';
}

/** Shareable link + QR-code placeholder contract for one request. */
export async function getRequestLink(db: Db, tenantId: string, requestId: string): Promise<RequestLink> {
  const request = await getRequest(db, tenantId, requestId);
  return {
    requestId: request.id,
    token: request.token,
    url: reviewRequestPublicPath(request.token),
    qr: 'placeholder',
  };
}

/* ------------------------------------------------------------------ *
 * Reminders (follow-ups)
 * ------------------------------------------------------------------ */

export async function scheduleReminder(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  requestId: string,
  sendAt: string,
): Promise<ReviewReminderRow> {
  const request = await getRequest(db, tenantId, requestId);
  if (request.status === 'completed' || request.status === 'opted_out') {
    throw ApiError.conflict(`cannot schedule a reminder for a ${request.status} request`);
  }
  const row: ReviewReminderRow = {
    id: id(),
    tenant_id: tenantId,
    request_id: requestId,
    send_at: sendAt,
    status: 'scheduled',
    sent_at: null,
    created_at: nowIso(),
  };
  await db.insertInto('reviews_reminders').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'reviews.reminder.scheduled', 'reviews.reminder', row.id, {
    requestId,
    sendAt,
  });
  await events.emit(tenantId, 'reviews.reminder.scheduled', {
    reminderId: row.id,
    requestId,
    sendAt,
  });
  return row;
}

export interface ReminderFilters {
  status?: string;
  requestId?: string;
}

export async function listReminders(
  db: Db,
  tenantId: string,
  filters: ReminderFilters = {},
  page: Pagination = { limit: 50, offset: 0 },
): Promise<ReviewReminderRow[]> {
  let qb = db.selectFrom('reviews_reminders').selectAll().where('tenant_id', '=', tenantId);
  if (filters.status !== undefined) qb = qb.where('status', '=', filters.status);
  if (filters.requestId !== undefined) qb = qb.where('request_id', '=', filters.requestId);
  return qb.orderBy('send_at').orderBy('id').limit(page.limit).offset(page.offset).execute();
}

/** Cancel every still-scheduled reminder for a request (completed/opted-out). */
async function cancelScheduledReminders(db: Db, tenantId: string, requestId: string): Promise<void> {
  await db
    .updateTable('reviews_reminders')
    .set({ status: 'canceled' })
    .where('tenant_id', '=', tenantId)
    .where('request_id', '=', requestId)
    .where('status', '=', 'scheduled')
    .execute();
}

export interface ProcessRemindersOptions {
  now?: string;
  provider?: ReviewProvider;
  sendMessage?: SendMessageContract;
}

/**
 * Deliver every due reminder (send_at <= now) through the provider stub.
 * Reminders whose request has since completed or opted out are canceled
 * instead of sent.
 */
export async function processDueReminders(
  db: Db,
  tenantId: string,
  actor: string,
  options: ProcessRemindersOptions = {},
): Promise<{ sent: number; canceled: number }> {
  const now = options.now ?? nowIso();
  const provider = options.provider ?? new GoogleBusinessProvider();
  const due = await db
    .selectFrom('reviews_reminders')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'scheduled')
    .where('send_at', '<=', now)
    .orderBy('send_at')
    .orderBy('id')
    .execute();

  let sent = 0;
  let canceled = 0;
  for (const reminder of due) {
    const request = await db
      .selectFrom('reviews_requests')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', reminder.request_id)
      .executeTakeFirst();

    if (!request || request.status === 'completed' || request.status === 'opted_out') {
      await db
        .updateTable('reviews_reminders')
        .set({ status: 'canceled' })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', reminder.id)
        .execute();
      await audit(asCoreDb(db), tenantId, actor, 'reviews.reminder.canceled', 'reviews.reminder', reminder.id, {
        requestId: reminder.request_id,
        requestStatus: request?.status ?? 'missing',
      });
      canceled += 1;
      continue;
    }

    const link = reviewRequestPublicPath(request.token);
    await provider.sendReminder({
      tenantId,
      reminderId: reminder.id,
      requestId: request.id,
      customerId: request.customer_id,
      link,
    });
    if (options.sendMessage) {
      try {
        await options.sendMessage.sendMessage({
          tenantId,
          channel: 'portal',
          to: request.customer_id,
          subject: 'A gentle reminder — we would love your feedback',
          body: `Please share your honest feedback: ${link}`,
          relatedEntityType: 'reviews.request',
          relatedEntityId: request.id,
        });
      } catch {
        // best-effort
      }
    }
    await db
      .updateTable('reviews_reminders')
      .set({ status: 'sent', sent_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', reminder.id)
      .execute();
    await audit(asCoreDb(db), tenantId, actor, 'reviews.reminder.sent', 'reviews.reminder', reminder.id, {
      requestId: request.id,
    });
    sent += 1;
  }
  return { sent, canceled };
}

/* ------------------------------------------------------------------ *
 * Public tokenized flow (customer-facing, no tenant header)
 * ------------------------------------------------------------------ */

/**
 * Resolve a request by its secret token. This is the ONLY query in the module
 * without an up-front tenant filter: the public endpoint has no tenant
 * context by design, and the globally-unique token is itself the credential.
 * Every subsequent read/write is scoped to the resolved row's tenant_id.
 */
async function findRequestByToken(db: Db, token: string): Promise<ReviewRequestRow> {
  const row = await db
    .selectFrom('reviews_requests')
    .selectAll()
    .where('token', '=', token)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound('invalid or expired review link');
  return row;
}

export interface PublicRequestView {
  status: string;
  submitted: boolean;
}

/** Landing view: marks a pending request as clicked. */
export async function getPublicRequest(db: Db, token: string): Promise<PublicRequestView> {
  const request = await findRequestByToken(db, token);
  let status = request.status;
  if (request.status === 'pending') {
    const now = nowIso();
    await db
      .updateTable('reviews_requests')
      .set({ status: 'clicked', clicked_at: now, updated_at: now })
      .where('tenant_id', '=', request.tenant_id)
      .where('id', '=', request.id)
      .execute();
    await audit(
      asCoreDb(db),
      request.tenant_id,
      `customer:${request.customer_id}`,
      'reviews.request.clicked',
      'reviews.request',
      request.id,
    );
    status = 'clicked';
  }
  return { status, submitted: status === 'completed' };
}

export interface SubmitReviewInput {
  rating: number;
  comment?: string;
}

/**
 * Public-safe view of a submitted response. The public endpoint is
 * unauthenticated (token-only), so it must NEVER expose internal ids —
 * especially `tenant_id`, which tenant-scoped routes accept as a header
 * credential. Leaking it here would let any review recipient read the
 * whole tenant.
 */
export type PublicReviewResponse = Omit<
  ReviewResponse,
  'tenant_id' | 'request_id' | 'customer_id' | 'resolved_at'
>;

function toPublicResponse(row: ReviewResponseRow): PublicReviewResponse {
  return {
    id: row.id,
    rating: row.rating,
    comment: row.comment,
    sentiment: row.sentiment,
    flagged_for_followup: row.flagged_for_followup === 1,
    created_at: row.created_at,
  };
}

export interface GatedSubmitResult {
  gate: ReviewSentiment;
  response: PublicReviewResponse;
  /** Only populated on the positive path — where to leave a public review. */
  platforms: Array<{ id: string; key: string; name: string; url: string }>;
  message: string;
}

/**
 * Positive/negative gating flow.
 * - rating >= the request's threshold → record the response and offer the
 *   tenant's enabled platform links (the customer chooses to post — we never
 *   post for them).
 * - rating below threshold → capture the private feedback form as a
 *   ReviewResponse flagged for follow-up. No platform links.
 * Both paths emit `reviews.review.submitted`.
 */
export async function submitPublicReview(
  db: Db,
  events: EventBus,
  token: string,
  input: SubmitReviewInput,
): Promise<GatedSubmitResult> {
  const request = await findRequestByToken(db, token);
  if (request.status === 'opted_out') {
    throw ApiError.conflict('this review request has been opted out');
  }
  if (request.status === 'completed') {
    throw ApiError.conflict('a review was already submitted for this request');
  }

  const now = nowIso();
  const sentiment: ReviewSentiment = input.rating >= request.rating_threshold ? 'positive' : 'negative';
  const response: ReviewResponseRow = {
    id: id(),
    tenant_id: request.tenant_id,
    request_id: request.id,
    customer_id: request.customer_id,
    rating: input.rating,
    comment: input.comment ?? null,
    sentiment,
    flagged_for_followup: sentiment === 'negative' ? 1 : 0,
    resolved_at: null,
    created_at: now,
  };
  await db.insertInto('reviews_responses').values(response).execute();
  await db
    .updateTable('reviews_requests')
    .set({
      status: 'completed',
      completed_at: now,
      clicked_at: request.clicked_at ?? now,
      updated_at: now,
    })
    .where('tenant_id', '=', request.tenant_id)
    .where('id', '=', request.id)
    .execute();
  await cancelScheduledReminders(db, request.tenant_id, request.id);

  await audit(
    asCoreDb(db),
    request.tenant_id,
    `customer:${request.customer_id}`,
    'reviews.review.submitted',
    'reviews.response',
    response.id,
    { rating: input.rating, sentiment },
  );
  await events.emit(request.tenant_id, 'reviews.review.submitted', {
    reviewId: response.id,
    requestId: request.id,
    customerId: request.customer_id,
    rating: input.rating,
    sentiment,
  });

  if (sentiment === 'positive') {
    return {
      gate: 'positive',
      response: toPublicResponse(response),
      platforms: await enabledPlatformLinks(db, request.tenant_id),
      message: 'Thank you! If you have a moment, sharing your experience publicly means the world to us.',
    };
  }
  return {
    gate: 'negative',
    response: toPublicResponse(response),
    platforms: [],
    message: 'Thank you for the honest feedback — someone from the team will follow up with you.',
  };
}

export interface OptOutResult {
  status: string;
}

/** Opt the customer out: no more requests or reminders for this link. Idempotent. */
export async function optOutPublic(db: Db, events: EventBus, token: string): Promise<OptOutResult> {
  const request = await findRequestByToken(db, token);
  if (request.status === 'opted_out') {
    return { status: 'opted_out' };
  }
  if (request.status === 'completed') {
    throw ApiError.conflict('a review was already submitted for this request');
  }
  const now = nowIso();
  await db
    .updateTable('reviews_requests')
    .set({ status: 'opted_out', opted_out_at: now, updated_at: now })
    .where('tenant_id', '=', request.tenant_id)
    .where('id', '=', request.id)
    .execute();
  await cancelScheduledReminders(db, request.tenant_id, request.id);
  await audit(
    asCoreDb(db),
    request.tenant_id,
    `customer:${request.customer_id}`,
    'reviews.request.opted_out',
    'reviews.request',
    request.id,
  );
  await events.emit(request.tenant_id, 'reviews.request.opted_out', {
    requestId: request.id,
    customerId: request.customer_id,
  });
  return { status: 'opted_out' };
}

/* ------------------------------------------------------------------ *
 * Responses
 * ------------------------------------------------------------------ */

export interface ResponseFilters {
  flagged?: boolean;
  requestId?: string;
}

export async function listResponses(
  db: Db,
  tenantId: string,
  filters: ResponseFilters = {},
  page: Pagination = { limit: 50, offset: 0 },
): Promise<ReviewResponse[]> {
  let qb = db.selectFrom('reviews_responses').selectAll().where('tenant_id', '=', tenantId);
  if (filters.flagged !== undefined) {
    qb = qb.where('flagged_for_followup', '=', filters.flagged ? 1 : 0);
  }
  if (filters.requestId !== undefined) {
    qb = qb.where('request_id', '=', filters.requestId);
  }
  const rows = await qb.orderBy('created_at').orderBy('id').limit(page.limit).offset(page.offset).execute();
  return rows.map(toResponse);
}

/** Mark a flagged (negative) response as followed-up. */
export async function resolveResponse(
  db: Db,
  tenantId: string,
  actor: string,
  responseId: string,
): Promise<ReviewResponse> {
  const now = nowIso();
  const result = await db
    .updateTable('reviews_responses')
    .set({ resolved_at: now })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', responseId)
    .executeTakeFirst();
  if (result.numUpdatedRows === 0n) {
    throw ApiError.notFound(`response not found: ${responseId}`);
  }
  await audit(asCoreDb(db), tenantId, actor, 'reviews.response.resolved', 'reviews.response', responseId);
  const row = await db
    .selectFrom('reviews_responses')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', responseId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`response not found: ${responseId}`);
  return toResponse(row);
}

/* ------------------------------------------------------------------ *
 * Testimonials
 * ------------------------------------------------------------------ */

export interface CreateTestimonialInput {
  customerId: string;
  quote: string;
  authorName?: string;
  responseId?: string;
  /** Must be explicitly true — capturing a testimonial without consent is rejected. */
  consent: boolean;
}

export async function createTestimonial(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  input: CreateTestimonialInput,
): Promise<ReviewTestimonial> {
  if (input.consent !== true) {
    throw ApiError.badRequest('explicit customer consent is required to capture a testimonial');
  }
  if (input.responseId) {
    const response = await db
      .selectFrom('reviews_responses')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('id', '=', input.responseId)
      .executeTakeFirst();
    if (!response) throw ApiError.notFound(`response not found: ${input.responseId}`);
  }
  const row: ReviewTestimonialRow = {
    id: id(),
    tenant_id: tenantId,
    customer_id: input.customerId,
    response_id: input.responseId ?? null,
    quote: input.quote,
    author_name: input.authorName ?? null,
    consent: 1,
    created_at: nowIso(),
  };
  await db.insertInto('reviews_testimonials').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'reviews.testimonial.captured', 'reviews.testimonial', row.id, {
    customerId: row.customer_id,
    consent: true,
  });
  await events.emit(tenantId, 'reviews.testimonial.captured', {
    testimonialId: row.id,
    customerId: row.customer_id,
  });
  return toTestimonial(row);
}

export async function listTestimonials(
  db: Db,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
): Promise<ReviewTestimonial[]> {
  const rows = await db
    .selectFrom('reviews_testimonials')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
  return rows.map(toTestimonial);
}

/* ------------------------------------------------------------------ *
 * Dashboard aggregation
 * ------------------------------------------------------------------ */

export interface ReviewDashboard {
  requests: {
    total: number;
    pending: number;
    clicked: number;
    completed: number;
    opted_out: number;
  };
  reviews: {
    volume: number;
    /** Mean of submitted ratings, 2dp; null when there are no reviews. */
    averageRating: number | null;
    positive: number;
    negative: number;
    /** Negative responses still awaiting follow-up. */
    flaggedOpen: number;
  };
  /** completed requests / total requests, 4dp (0 when there are no requests). */
  responseRate: number;
  testimonials: number;
}

export async function getReviewDashboard(db: Db, tenantId: string): Promise<ReviewDashboard> {
  const statusRows = await db
    .selectFrom('reviews_requests')
    .select('status')
    .select((eb) => eb.fn.countAll().as('c'))
    .where('tenant_id', '=', tenantId)
    .groupBy('status')
    .execute();
  const requests = { total: 0, pending: 0, clicked: 0, completed: 0, opted_out: 0 };
  for (const row of statusRows) {
    const count = Number(row.c);
    requests.total += count;
    if (row.status in requests) {
      requests[row.status as keyof typeof requests] += count;
    }
  }

  const agg = await db
    .selectFrom('reviews_responses')
    .select((eb) => [eb.fn.countAll().as('volume'), eb.fn.avg('rating').as('avg_rating')])
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
  const volume = Number(agg?.volume ?? 0);
  const averageRating = volume > 0 && agg?.avg_rating != null ? round(Number(agg.avg_rating), 2) : null;

  const sentimentRows = await db
    .selectFrom('reviews_responses')
    .select('sentiment')
    .select((eb) => eb.fn.countAll().as('c'))
    .where('tenant_id', '=', tenantId)
    .groupBy('sentiment')
    .execute();
  let positive = 0;
  let negative = 0;
  for (const row of sentimentRows) {
    if (row.sentiment === 'positive') positive = Number(row.c);
    if (row.sentiment === 'negative') negative = Number(row.c);
  }

  const flaggedRow = await db
    .selectFrom('reviews_responses')
    .select((eb) => eb.fn.countAll().as('c'))
    .where('tenant_id', '=', tenantId)
    .where('flagged_for_followup', '=', 1)
    .where('resolved_at', 'is', null)
    .executeTakeFirst();

  const testimonialsRow = await db
    .selectFrom('reviews_testimonials')
    .select((eb) => eb.fn.countAll().as('c'))
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();

  return {
    requests,
    reviews: {
      volume,
      averageRating,
      positive,
      negative,
      flaggedOpen: Number(flaggedRow?.c ?? 0),
    },
    responseRate: requests.total > 0 ? round(requests.completed / requests.total, 4) : 0,
    testimonials: Number(testimonialsRow?.c ?? 0),
  };
}
