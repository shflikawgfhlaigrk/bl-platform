import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  ApiError,
  asCoreDb,
  errorHandler,
  parsePagination,
  tenantMiddleware,
  type ModuleDeps,
  type TenantEnv,
} from '@blacklabel/core';
import type { OutreachDatabase } from './schema';
import type { OutreachAdapters } from './adapters';
import {
  approveCampaign,
  cancelCampaign,
  checkReplies,
  createCampaign,
  createTemplate,
  deleteTemplate,
  gateReport,
  getCampaign,
  getOrCreateSettings,
  getTemplate,
  getThread,
  listCampaigns,
  listInbox,
  listSends,
  listTemplates,
  pauseCampaign,
  processUnsubscribe,
  queueCampaign,
  queueSend,
  resumeCampaign,
  sendPending,
  setAudience,
  updateSettings,
  updateTemplate,
} from './service';

const quietHoursSchema = z.object({
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(0).max(23),
  timezone: z.string().min(1),
});

const settingsPatchSchema = z.object({
  armed: z.boolean().optional(),
  postalAddress: z.string().nullable().optional(),
  fromName: z.string().nullable().optional(),
  fromEmail: z.string().nullable().optional(),
  replyTo: z.string().nullable().optional(),
  providerCredentialRef: z.string().nullable().optional(),
  quietHours: quietHoursSchema.optional(),
  dailyCapOverride: z.number().int().min(0).nullable().optional(),
});

const varsSchema = z.record(z.union([z.string(), z.number(), z.null()]));

const templateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(['transactional', 'promotional']),
  subjectTemplate: z.string().min(1),
  bodyTemplate: z.string().min(1),
  requiredPlaceholders: z.array(z.string()).optional(),
  unsubscribeFooterRequired: z.boolean().optional(),
});

const audienceEntrySchema = z.object({
  email: z.string().min(3),
  vars: varsSchema.optional(),
  profileId: z.string().optional(),
  consent: z.boolean().optional(),
});

const campaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  templateId: z.string().min(1),
  audience: z.array(audienceEntrySchema).optional(),
  scheduledAt: z.string().nullable().optional(),
});

const sendSchema = z.object({
  templateId: z.string().min(1),
  to: z.string().min(3),
  vars: varsSchema.optional(),
  consent: z.boolean().optional(),
  campaignId: z.string().nullable().optional(),
});

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw ApiError.badRequest('invalid JSON body');
  }
}

function actorOf(c: Context): string {
  const header = c.req.header('x-user-id');
  return header && header.trim() !== '' ? header.trim() : 'system';
}

/**
 * Outreach router. `adapters` (transport/reader/suppress/isSuppressed/
 * unsubscribeBaseUrl) are injected by apps/api at wiring time; with none the
 * send-pending drain honestly blocks every queued row as `no_provider`.
 */
export function outreachRouter(
  deps: ModuleDeps<OutreachDatabase>,
  adapters: OutreachAdapters = {},
): Hono<TenantEnv> {
  const { db, events } = deps;
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);

  // Public, token-validated — mounted before tenant middleware needs a tenant
  // header too (integrator passes x-tenant-id for the tenant projection).
  app.use('*', tenantMiddleware(asCoreDb(db)));

  // ── settings + gates ────────────────────────────────────────────────
  app.get('/settings', async (c) => {
    const s = await getOrCreateSettings(db, c.get('tenantId'), actorOf(c));
    return c.json({ data: s });
  });

  app.put('/settings', async (c) => {
    const patch = settingsPatchSchema.parse(await jsonBody(c));
    const s = await updateSettings(db, c.get('tenantId'), actorOf(c), patch);
    return c.json({ data: s });
  });

  app.get('/settings/gates', async (c) => {
    return c.json({ data: await gateReport(db, c.get('tenantId')) });
  });

  // ── templates ───────────────────────────────────────────────────────
  app.post('/templates', async (c) => {
    const input = templateSchema.parse(await jsonBody(c));
    const t = await createTemplate(db, c.get('tenantId'), actorOf(c), input);
    return c.json({ data: t }, 201);
  });

  app.get('/templates', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await listTemplates(db, c.get('tenantId'), page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });

  app.get('/templates/:id', async (c) => {
    const t = await getTemplate(db, c.get('tenantId'), c.req.param('id'));
    if (!t) throw ApiError.notFound('template not found');
    return c.json({ data: t });
  });

  app.put('/templates/:id', async (c) => {
    const input = templateSchema.parse(await jsonBody(c));
    const t = await updateTemplate(db, c.get('tenantId'), actorOf(c), c.req.param('id'), input);
    return c.json({ data: t });
  });

  app.delete('/templates/:id', async (c) => {
    await deleteTemplate(db, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: { ok: true } });
  });

  // ── campaigns ───────────────────────────────────────────────────────
  app.post('/campaigns', async (c) => {
    const input = campaignSchema.parse(await jsonBody(c));
    const cm = await createCampaign(db, c.get('tenantId'), actorOf(c), input);
    return c.json({ data: cm }, 201);
  });

  app.get('/campaigns', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await listCampaigns(db, c.get('tenantId'), page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });

  app.get('/campaigns/:id', async (c) => {
    const cm = await getCampaign(db, c.get('tenantId'), c.req.param('id'));
    if (!cm) throw ApiError.notFound('campaign not found');
    return c.json({ data: cm });
  });

  app.post('/campaigns/:id/audience', async (c) => {
    const body = z.object({ audience: z.array(audienceEntrySchema) }).parse(await jsonBody(c));
    const cm = await setAudience(db, c.get('tenantId'), actorOf(c), c.req.param('id'), body.audience);
    return c.json({ data: cm });
  });

  app.post('/campaigns/:id/approve', async (c) => {
    const cm = await approveCampaign(db, events, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: cm });
  });

  app.post('/campaigns/:id/cancel', async (c) => {
    const cm = await cancelCampaign(db, events, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: cm });
  });

  app.post('/campaigns/:id/pause', async (c) => {
    const cm = await pauseCampaign(db, events, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: cm });
  });

  app.post('/campaigns/:id/resume', async (c) => {
    const cm = await resumeCampaign(db, events, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: cm });
  });

  app.post('/campaigns/:id/queue', async (c) => {
    const result = await queueCampaign(db, events, c.get('tenantId'), actorOf(c), c.req.param('id'), {
      unsubscribeBaseUrl: adapters.unsubscribeBaseUrl,
    });
    return c.json({ data: result }, 201);
  });

  // ── single transactional send ───────────────────────────────────────
  app.post('/sends', async (c) => {
    const input = sendSchema.parse(await jsonBody(c));
    const row = await queueSend(db, events, c.get('tenantId'), actorOf(c), input, {
      unsubscribeBaseUrl: adapters.unsubscribeBaseUrl,
    });
    return c.json({ data: row }, 201);
  });

  app.get('/sends', async (c) => {
    const page = parsePagination(c.req.query());
    const { status, campaign_id } = c.req.query();
    const rows = await listSends(db, c.get('tenantId'), page, { status, campaign_id });
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });

  // ── drain ────────────────────────────────────────────────────────────
  app.post('/send-pending', async (c) => {
    const now = c.req.query('now') ?? new Date().toISOString();
    const result = await sendPending(db, events, c.get('tenantId'), now, adapters);
    return c.json({ data: result });
  });

  // ── replies ──────────────────────────────────────────────────────────
  app.post('/check-replies', async (c) => {
    if (!adapters.reader) throw ApiError.badRequest('no mailbox reader configured');
    const result = await checkReplies(db, events, c.get('tenantId'), adapters.reader);
    return c.json({ data: result });
  });

  app.get('/inbox', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await listInbox(db, c.get('tenantId'), page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });

  app.get('/thread', async (c) => {
    const recipient = c.req.query('recipient');
    if (!recipient) throw ApiError.badRequest('recipient query param is required');
    const view = await getThread(db, c.get('tenantId'), recipient);
    return c.json({ data: view });
  });

  // ── public unsubscribe (token-validated) ─────────────────────────────
  app.get('/unsubscribe', async (c) => {
    const sendId = c.req.query('send');
    const token = c.req.query('token');
    if (!sendId || !token) throw ApiError.badRequest('send and token are required');
    const result = await processUnsubscribe(db, events, c.get('tenantId'), sendId, token, adapters);
    return c.json({ data: result });
  });

  return app;
}
