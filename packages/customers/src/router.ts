/**
 * Customers REST router. Mounted by apps/api at /api/customers.
 * Tenant comes ONLY from core tenant middleware (x-tenant-id header).
 * Optional x-user-id header identifies the acting user for audit ("system" default).
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  errorHandler,
  parsePagination,
  tenantMiddleware,
  asCoreDb,
  type ModuleDeps,
  type TenantEnv,
} from '@blacklabel/core';
import type {
  CustomersDatabase,
  RestockStatus,
  ServiceCaseKind,
  ServiceCaseStatus,
  SuppressionReason,
} from './schema';
import {
  CONSENT_CHANNELS,
  CONSENT_STATES,
  CUSTOMER_SOURCES,
  RESTOCK_STATUSES,
  SERVICE_CASE_KINDS,
  SERVICE_CASE_STATUSES,
  SUPPRESSION_REASONS,
  SUPPRESSION_SCOPES,
} from './schema';
import type { SegmentRules, StatsInputMap } from './segments';
import * as svc from './service';

const actorOf = (c: Context<TenantEnv>): string => c.req.header('x-user-id') ?? 'system';

const sourceEnum = z.enum(CUSTOMER_SOURCES as [string, ...string[]]);
const channelEnum = z.enum(CONSENT_CHANNELS as [string, ...string[]]);
const scopeEnum = z.enum(SUPPRESSION_SCOPES as [string, ...string[]]);

const predicateSchema = z
  .object({
    field: z.string().min(1),
    op: z.enum([
      'eq',
      'ne',
      'gt',
      'gte',
      'lt',
      'lte',
      'in',
      'within_days',
      'older_than_days',
      'is_null',
      'not_null',
    ]),
    value: z.unknown().optional(),
  })
  .strict();
const rulesSchema = z.object({ all: z.array(predicateSchema) }).strict();

export function customersRouter(deps: ModuleDeps<CustomersDatabase>): Hono<TenantEnv> {
  const db = deps.db;
  const events = deps.events;
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(db)));

  const T = (c: Context<TenantEnv>) => c.get('tenantId');

  /* ---------------- profiles ---------------- */
  const profileCreate = z
    .object({
      crm_customer_id: z.string().nullish(),
      email: z.string().nullish(),
      phone: z.string().nullish(),
      first_name: z.string().nullish(),
      last_name: z.string().nullish(),
      source: sourceEnum.optional(),
    })
    .strict();

  app.post('/profiles', async (c) => {
    const b = profileCreate.parse(await c.req.json());
    const row = await svc.createProfile(db, T(c), actorOf(c), {
      crmCustomerId: b.crm_customer_id ?? null,
      email: b.email ?? null,
      phone: b.phone ?? null,
      firstName: b.first_name ?? null,
      lastName: b.last_name ?? null,
      source: b.source as svc.ProfileInput['source'],
    });
    return c.json({ data: row }, 201);
  });

  app.get('/profiles', async (c) => {
    const q = c.req.query();
    const page = parsePagination(q);
    const rows = await svc.searchProfiles(db, T(c), {
      page,
      email: q.email,
      phone: q.phone,
      name: q.name,
      includeMerged: q.include_merged === 'true',
    });
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });

  app.get('/profiles/:id', async (c) => {
    const row = await svc.mustGetProfile(db, T(c), c.req.param('id'));
    return c.json({ data: row });
  });

  app.patch('/profiles/:id', async (c) => {
    const b = profileCreate.partial().parse(await c.req.json());
    const row = await svc.updateProfile(db, T(c), actorOf(c), c.req.param('id'), {
      crmCustomerId: b.crm_customer_id ?? undefined,
      email: b.email ?? undefined,
      phone: b.phone ?? undefined,
      firstName: b.first_name ?? undefined,
      lastName: b.last_name ?? undefined,
    });
    return c.json({ data: row });
  });

  const importSchema = z
    .object({
      rows: z.array(
        z
          .object({
            crm_customer_id: z.string().min(1),
            email: z.string().nullish(),
            phone: z.string().nullish(),
            first_name: z.string().nullish(),
            last_name: z.string().nullish(),
          })
          .strict(),
      ),
    })
    .strict();

  app.post('/profiles/import', async (c) => {
    const b = importSchema.parse(await c.req.json());
    const summary = await svc.importProfiles(
      db,
      T(c),
      b.rows.map((r) => ({
        crmCustomerId: r.crm_customer_id,
        email: r.email ?? null,
        phone: r.phone ?? null,
        firstName: r.first_name ?? null,
        lastName: r.last_name ?? null,
      })),
    );
    return c.json({ data: summary }, 201);
  });

  /* ---------------- identity resolution / merges ---------------- */
  const resolveSchema = z.object({ zips: z.record(z.string()).optional() }).strict();

  app.post('/merges/resolve', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const b = resolveSchema.parse(body ?? {});
    const created = await svc.resolveIdentities(db, T(c), actorOf(c), { zips: b.zips });
    return c.json({ data: created }, 201);
  });

  app.get('/merges', async (c) => {
    const rows = await svc.listMerges(db, T(c), c.req.query('status'));
    return c.json({ data: rows });
  });

  app.get('/merges/:id', async (c) => {
    const row = await svc.getMerge(db, T(c), c.req.param('id'));
    if (!row) return c.json({ error: { message: 'merge not found', code: 'not_found', details: null } }, 404);
    return c.json({ data: row });
  });

  app.post('/merges/:id/apply', async (c) => {
    const row = await svc.applyMerge(db, T(c), actorOf(c), c.req.param('id'));
    return c.json({ data: row });
  });

  app.post('/merges/:id/undo', async (c) => {
    const row = await svc.undoMerge(db, T(c), actorOf(c), c.req.param('id'));
    return c.json({ data: row });
  });

  /* ---------------- consents ---------------- */
  const consentSchema = z
    .object({
      channel: channelEnum,
      state: z.enum(CONSENT_STATES as [string, ...string[]]),
      text_shown: z.string().nullish(),
      source: sourceEnum.nullish(),
      ip: z.string().nullish(),
      user_agent: z.string().nullish(),
      evidence: z.unknown().optional(),
    })
    .strict();

  app.post('/profiles/:id/consents', async (c) => {
    const b = consentSchema.parse(await c.req.json());
    const row = await svc.recordConsent(db, T(c), actorOf(c), events, c.req.param('id'), {
      channel: b.channel as 'email' | 'sms',
      state: b.state as svc.ConsentInput['state'],
      textShown: b.text_shown ?? null,
      source: (b.source as svc.ConsentInput['source']) ?? null,
      ip: b.ip ?? null,
      userAgent: b.user_agent ?? null,
      evidence: b.evidence,
    });
    return c.json({ data: row }, 201);
  });

  app.get('/profiles/:id/consents', async (c) => {
    const channel = c.req.query('channel') as 'email' | 'sms' | undefined;
    const rows = await svc.consentHistory(db, T(c), c.req.param('id'), channel);
    return c.json({ data: rows });
  });

  app.get('/profiles/:id/consents/current', async (c) => {
    const channel = (c.req.query('channel') ?? 'email') as 'email' | 'sms';
    const state = await svc.currentConsent(db, T(c), c.req.param('id'), channel);
    return c.json({ data: { channel, state } });
  });

  const dupSchema = z
    .object({
      channel: channelEnum,
      text_shown: z.string().nullish(),
      source: sourceEnum.nullish(),
      ttl_minutes: z.number().int().positive().optional(),
      ip: z.string().nullish(),
      user_agent: z.string().nullish(),
    })
    .strict();

  app.post('/profiles/:id/consents/double-opt-in/start', async (c) => {
    const b = dupSchema.parse(await c.req.json());
    const result = await svc.startDoubleOptIn(db, T(c), actorOf(c), events, c.req.param('id'), {
      channel: b.channel as 'email' | 'sms',
      textShown: b.text_shown ?? null,
      source: (b.source as svc.ConsentInput['source']) ?? null,
      ttlMinutes: b.ttl_minutes,
      ip: b.ip ?? null,
      userAgent: b.user_agent ?? null,
    });
    return c.json({ data: result }, 201);
  });

  app.post('/consents/double-opt-in/confirm', async (c) => {
    const b = z.object({ token: z.string().min(1) }).strict().parse(await c.req.json());
    const row = await svc.confirmDoubleOptIn(db, T(c), actorOf(c), events, b.token);
    return c.json({ data: row });
  });

  /* ---------------- preferences ---------------- */
  app.put('/profiles/:id/preferences/:key', async (c) => {
    const b = z.object({ value: z.unknown() }).strict().parse(await c.req.json());
    const row = await svc.setPreference(db, T(c), actorOf(c), c.req.param('id'), c.req.param('key'), b.value);
    return c.json({ data: { ...row, value: JSON.parse(row.value) } });
  });

  app.get('/profiles/:id/preferences', async (c) => {
    const rows = await svc.listPreferences(db, T(c), c.req.param('id'));
    return c.json({ data: rows.map((r) => ({ ...r, value: JSON.parse(r.value) })) });
  });

  /* ---------------- suppressions ---------------- */
  const suppressionSchema = z
    .object({
      scope: scopeEnum,
      value: z.string().min(1),
      reason: z.enum(SUPPRESSION_REASONS as [string, ...string[]]),
    })
    .strict();

  app.post('/suppressions', async (c) => {
    const b = suppressionSchema.parse(await c.req.json());
    const row = await svc.addSuppression(
      db,
      T(c),
      actorOf(c),
      b.scope as 'email' | 'phone',
      b.value,
      b.reason as SuppressionReason,
    );
    return c.json({ data: row }, 201);
  });

  app.get('/suppressions', async (c) => {
    const scope = c.req.query('scope') as 'email' | 'phone' | undefined;
    const rows = await svc.listSuppressions(db, T(c), scope);
    return c.json({ data: rows });
  });

  app.get('/suppressions/check', async (c) => {
    const scope = c.req.query('scope') as 'email' | 'phone' | undefined;
    const value = c.req.query('value');
    if (!scope || !value) {
      return c.json({ error: { message: 'scope and value required', code: 'bad_request', details: null } }, 400);
    }
    const suppressed = await svc.isSuppressed(db, T(c), scope, value);
    return c.json({ data: { scope, value, suppressed } });
  });

  app.delete('/suppressions', async (c) => {
    const scope = c.req.query('scope') as 'email' | 'phone' | undefined;
    const value = c.req.query('value');
    if (!scope || !value) {
      return c.json({ error: { message: 'scope and value required', code: 'bad_request', details: null } }, 400);
    }
    await svc.removeSuppression(db, T(c), actorOf(c), scope, value);
    return c.body(null, 204);
  });

  /* ---------------- segments ---------------- */
  app.post('/segments/seed-builtins', async (c) => {
    const b = z
      .object({ vip_threshold_cents: z.number().int().optional(), lapsed_lifetime_cents: z.number().int().optional() })
      .strict()
      .parse(await c.req.json().catch(() => ({})));
    const rows = await svc.seedBuiltinSegments(db, T(c), {
      vipThresholdCents: b.vip_threshold_cents,
      lapsedLifetimeCents: b.lapsed_lifetime_cents,
    });
    return c.json({ data: rows }, 201);
  });

  app.post('/segments', async (c) => {
    const b = z.object({ name: z.string().min(1), rules: rulesSchema }).strict().parse(await c.req.json());
    const row = await svc.createSegment(db, T(c), actorOf(c), b.name, b.rules as SegmentRules);
    return c.json({ data: row }, 201);
  });

  app.get('/segments', async (c) => {
    const rows = await svc.listSegments(db, T(c));
    return c.json({ data: rows });
  });

  app.get('/segments/:id', async (c) => {
    const row = await svc.getSegment(db, T(c), c.req.param('id'));
    return c.json({ data: row });
  });

  app.put('/segments/:id', async (c) => {
    const b = z.object({ rules: rulesSchema }).strict().parse(await c.req.json());
    const row = await svc.updateSegment(db, T(c), actorOf(c), c.req.param('id'), b.rules as SegmentRules);
    return c.json({ data: row });
  });

  app.delete('/segments/:id', async (c) => {
    await svc.deleteSegment(db, T(c), actorOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  app.post('/segments/:id/evaluate', async (c) => {
    const b = z
      .object({ stats: z.record(z.record(z.unknown())), now: z.string().optional() })
      .strict()
      .parse(await c.req.json());
    const result = await svc.evaluateSegmentAndPersist(
      db,
      T(c),
      c.req.param('id'),
      b.stats as StatsInputMap,
      b.now,
    );
    return c.json({ data: result });
  });

  app.get('/segments/:id/members', async (c) => {
    const rows = await svc.listSegmentMembers(db, T(c), c.req.param('id'));
    return c.json({ data: rows });
  });

  /* ---------------- restock requests ---------------- */
  app.post('/restock-requests', async (c) => {
    const b = z
      .object({ variation_id: z.string().min(1), profile_id: z.string().nullish(), source: sourceEnum.optional() })
      .strict()
      .parse(await c.req.json());
    const row = await svc.createRestockRequest(db, T(c), actorOf(c), events, {
      variationId: b.variation_id,
      profileId: b.profile_id ?? null,
      source: b.source as svc.ProfileInput['source'],
    });
    return c.json({ data: row }, 201);
  });

  app.get('/restock-requests', async (c) => {
    const rows = await svc.listRestockRequests(db, T(c), {
      variationId: c.req.query('variation_id'),
      status: c.req.query('status') as RestockStatus | undefined,
    });
    return c.json({ data: rows });
  });

  app.post('/restock-requests/:id/status', async (c) => {
    const b = z.object({ status: z.enum(RESTOCK_STATUSES as [string, ...string[]]) }).strict().parse(await c.req.json());
    const row = await svc.updateRestockStatus(db, T(c), actorOf(c), c.req.param('id'), b.status as RestockStatus);
    return c.json({ data: row });
  });

  /* ---------------- service cases ---------------- */
  app.post('/service-cases', async (c) => {
    const b = z
      .object({
        profile_id: z.string().min(1),
        kind: z.enum(SERVICE_CASE_KINDS as [string, ...string[]]),
        body: z.string().min(1),
        assigned_to: z.string().nullish(),
      })
      .strict()
      .parse(await c.req.json());
    const row = await svc.createServiceCase(db, T(c), actorOf(c), {
      profileId: b.profile_id,
      kind: b.kind as ServiceCaseKind,
      body: b.body,
      assignedTo: b.assigned_to ?? null,
    });
    return c.json({ data: row }, 201);
  });

  app.get('/service-cases', async (c) => {
    const rows = await svc.listServiceCases(db, T(c), {
      status: c.req.query('status') as ServiceCaseStatus | undefined,
      profileId: c.req.query('profile_id'),
    });
    return c.json({ data: rows });
  });

  app.patch('/service-cases/:id', async (c) => {
    const b = z
      .object({
        status: z.enum(SERVICE_CASE_STATUSES as [string, ...string[]]).optional(),
        assigned_to: z.string().nullish(),
      })
      .strict()
      .parse(await c.req.json());
    const row = await svc.updateServiceCase(db, T(c), actorOf(c), c.req.param('id'), {
      status: b.status as ServiceCaseStatus | undefined,
      assignedTo: b.assigned_to === undefined ? undefined : b.assigned_to ?? null,
    });
    return c.json({ data: row });
  });

  app.post('/service-cases/:id/notes', async (c) => {
    const b = z.object({ body: z.string().min(1) }).strict().parse(await c.req.json());
    const row = await svc.addCaseNote(db, T(c), actorOf(c), c.req.param('id'), b.body);
    return c.json({ data: row }, 201);
  });

  app.get('/service-cases/:id/notes', async (c) => {
    const rows = await svc.listCaseNotes(db, T(c), c.req.param('id'));
    return c.json({ data: rows });
  });

  return app;
}
