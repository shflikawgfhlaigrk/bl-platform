import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  ApiError,
  asCoreDb,
  errorHandler,
  parseFilters,
  parsePagination,
  parseSort,
  tenantMiddleware,
  type ModuleDeps,
  type TenantEnv,
} from '@blacklabel/core';
import type { ReviewsDatabase } from './schema';
import {
  GoogleBusinessProvider,
  createCampaign,
  createPlatform,
  createRequest,
  createTestimonial,
  deletePlatform,
  dispatchCampaign,
  getCampaignWithStats,
  getPlatform,
  getPublicRequest,
  getRequest,
  getRequestLink,
  getReviewDashboard,
  listCampaigns,
  listPlatforms,
  listReminders,
  listRequests,
  listResponses,
  listTestimonials,
  optOutPublic,
  processDueReminders,
  resolveResponse,
  scheduleReminder,
  submitPublicReview,
  updateCampaign,
  updatePlatform,
  type ReviewProvider,
} from './service';

/* ------------------------------------------------------------------ *
 * Request schemas (zod) — thrown ZodError becomes a 400 via errorHandler.
 * Note: no schema accepts tenant_id; tenancy comes ONLY from the middleware.
 * ------------------------------------------------------------------ */

const isoTimestamp = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'must be an ISO-8601 timestamp' });

const machineKey = z.string().regex(/^[a-z][a-z0-9_]*$/, 'must match /^[a-z][a-z0-9_]*$/');

const createPlatformSchema = z.object({
  key: machineKey,
  name: z.string().min(1),
  targetUrl: z.string().url(),
  provider: machineKey.optional(),
  enabled: z.boolean().optional(),
});

const updatePlatformSchema = z.object({
  name: z.string().min(1).optional(),
  targetUrl: z.string().url().optional(),
  provider: machineKey.optional(),
  enabled: z.boolean().optional(),
});

const createCampaignSchema = z.object({
  name: z.string().min(1),
  customerIds: z.array(z.string().min(1)).min(1),
  ratingThreshold: z.number().int().min(1).max(5).optional(),
  throttlePerDay: z.number().int().min(1).max(1000).optional(),
  scheduleStartAt: isoTimestamp.optional(),
});

const updateCampaignSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(['active', 'paused', 'completed']).optional(),
});

const createRequestSchema = z.object({
  customerId: z.string().min(1),
  campaignId: z.string().min(1).optional(),
  ratingThreshold: z.number().int().min(1).max(5).optional(),
});

const scheduleReminderSchema = z.object({
  sendAt: isoTimestamp,
});

const submitReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(5000).optional(),
});

const createTestimonialSchema = z.object({
  customerId: z.string().min(1),
  quote: z.string().min(1).max(5000),
  authorName: z.string().min(1).optional(),
  responseId: z.string().min(1).optional(),
  consent: z.boolean(),
});

/* ------------------------------------------------------------------ */

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw ApiError.badRequest('invalid JSON body');
  }
}

/**
 * Reviews router factory. Mounted by apps/api at /api/reviews.
 *
 * Routes under /public/* are token-authenticated customer endpoints and are
 * registered BEFORE the tenant middleware — the secret request token is the
 * credential there. Every other route requires the x-tenant-id header.
 */
export function reviewsRouter(
  deps: ModuleDeps<ReviewsDatabase>,
  provider: ReviewProvider = new GoogleBusinessProvider(),
): Hono<TenantEnv> {
  const { db, events, contracts } = deps;
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);

  const actorOf = (c: Context<TenantEnv>): string => c.req.header('x-user-id') ?? 'system';

  /* ---------------- public tokenized endpoints (no tenant header) -------- */

  app.get('/public/requests/:token', async (c) => {
    const view = await getPublicRequest(db, c.req.param('token'));
    return c.json({ data: view });
  });

  app.post('/public/requests/:token/submit', async (c) => {
    const body = submitReviewSchema.parse(await readJson(c));
    const result = await submitPublicReview(db, events, c.req.param('token'), body);
    return c.json({ data: result }, 201);
  });

  app.post('/public/requests/:token/opt-out', async (c) => {
    const result = await optOutPublic(db, events, c.req.param('token'));
    return c.json({ data: result });
  });

  /* ---------------- tenant-scoped endpoints ------------------------------ */

  app.use('*', tenantMiddleware(asCoreDb(db)));

  // Platforms
  app.post('/platforms', async (c) => {
    const body = createPlatformSchema.parse(await readJson(c));
    const platform = await createPlatform(db, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: platform }, 201);
  });

  app.get('/platforms', async (c) => {
    const q = c.req.query();
    const page = parsePagination(q);
    const sort = parseSort(q, ['created_at', 'name', 'key'], { column: 'created_at', direction: 'asc' })!;
    const platforms = await listPlatforms(db, c.get('tenantId'), page, sort);
    return c.json({ data: platforms, limit: page.limit, offset: page.offset });
  });

  app.get('/platforms/:id', async (c) => {
    const platform = await getPlatform(db, c.get('tenantId'), c.req.param('id'));
    return c.json({ data: platform });
  });

  app.patch('/platforms/:id', async (c) => {
    const body = updatePlatformSchema.parse(await readJson(c));
    const platform = await updatePlatform(db, c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: platform });
  });

  app.delete('/platforms/:id', async (c) => {
    await deletePlatform(db, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: { id: c.req.param('id'), deleted: true } });
  });

  // Campaigns
  app.post('/campaigns', async (c) => {
    const body = createCampaignSchema.parse(await readJson(c));
    const result = await createCampaign(db, events, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: result }, 201);
  });

  app.get('/campaigns', async (c) => {
    const q = c.req.query();
    const page = parsePagination(q);
    const campaigns = await listCampaigns(db, c.get('tenantId'), page);
    return c.json({ data: campaigns, limit: page.limit, offset: page.offset });
  });

  app.get('/campaigns/:id', async (c) => {
    const campaign = await getCampaignWithStats(db, c.get('tenantId'), c.req.param('id'));
    return c.json({ data: campaign });
  });

  app.patch('/campaigns/:id', async (c) => {
    const body = updateCampaignSchema.parse(await readJson(c));
    const campaign = await updateCampaign(db, c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: campaign });
  });

  app.post('/campaigns/:id/dispatch', async (c) => {
    const result = await dispatchCampaign(db, c.get('tenantId'), actorOf(c), c.req.param('id'), {
      provider,
      sendMessage: contracts.sendMessage,
    });
    return c.json({ data: result });
  });

  // Requests
  app.post('/requests', async (c) => {
    const body = createRequestSchema.parse(await readJson(c));
    const request = await createRequest(db, events, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: request }, 201);
  });

  app.get('/requests', async (c) => {
    const q = c.req.query();
    const page = parsePagination(q);
    const sort = parseSort(q, ['created_at', 'status'], { column: 'created_at', direction: 'asc' })!;
    const filters = parseFilters(q, ['status', 'campaign_id', 'customer_id']);
    const requests = await listRequests(
      db,
      c.get('tenantId'),
      { status: filters.status, campaignId: filters.campaign_id, customerId: filters.customer_id },
      page,
      sort,
    );
    return c.json({ data: requests, limit: page.limit, offset: page.offset });
  });

  app.get('/requests/:id', async (c) => {
    const request = await getRequest(db, c.get('tenantId'), c.req.param('id'));
    return c.json({ data: request });
  });

  // Shareable link + QR placeholder contract: { url, token, qr: "placeholder" }
  app.get('/requests/:id/link', async (c) => {
    const link = await getRequestLink(db, c.get('tenantId'), c.req.param('id'));
    return c.json({ data: link });
  });

  app.post('/requests/:id/reminders', async (c) => {
    const body = scheduleReminderSchema.parse(await readJson(c));
    const reminder = await scheduleReminder(
      db,
      events,
      c.get('tenantId'),
      actorOf(c),
      c.req.param('id'),
      body.sendAt,
    );
    return c.json({ data: reminder }, 201);
  });

  // Reminders
  app.get('/reminders', async (c) => {
    const q = c.req.query();
    const page = parsePagination(q);
    const filters = parseFilters(q, ['status', 'request_id']);
    const reminders = await listReminders(
      db,
      c.get('tenantId'),
      { status: filters.status, requestId: filters.request_id },
      page,
    );
    return c.json({ data: reminders, limit: page.limit, offset: page.offset });
  });

  app.post('/reminders/process', async (c) => {
    const result = await processDueReminders(db, c.get('tenantId'), actorOf(c), {
      provider,
      sendMessage: contracts.sendMessage,
    });
    return c.json({ data: result });
  });

  // Responses (private feedback + gated review records)
  app.get('/responses', async (c) => {
    const q = c.req.query();
    const page = parsePagination(q);
    const filters = parseFilters(q, ['flagged', 'request_id']);
    const flagged =
      filters.flagged === undefined ? undefined : filters.flagged === 'true' || filters.flagged === '1';
    const responses = await listResponses(
      db,
      c.get('tenantId'),
      { flagged, requestId: filters.request_id },
      page,
    );
    return c.json({ data: responses, limit: page.limit, offset: page.offset });
  });

  app.post('/responses/:id/resolve', async (c) => {
    const response = await resolveResponse(db, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: response });
  });

  // Testimonials
  app.post('/testimonials', async (c) => {
    const body = createTestimonialSchema.parse(await readJson(c));
    const testimonial = await createTestimonial(db, events, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: testimonial }, 201);
  });

  app.get('/testimonials', async (c) => {
    const q = c.req.query();
    const page = parsePagination(q);
    const testimonials = await listTestimonials(db, c.get('tenantId'), page);
    return c.json({ data: testimonials, limit: page.limit, offset: page.offset });
  });

  // Dashboard aggregation
  app.get('/dashboard', async (c) => {
    const dashboard = await getReviewDashboard(db, c.get('tenantId'));
    return c.json({ data: dashboard });
  });

  return app;
}
