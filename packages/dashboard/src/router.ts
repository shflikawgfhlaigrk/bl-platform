import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  ApiError,
  asCoreDb,
  errorHandler,
  parsePagination,
  serializeCsv,
  tenantMiddleware,
  type ModuleDeps,
  type TenantEnv,
} from '@blacklabel/core';
import type { DashboardDatabase } from './schema';
import {
  KPI_DEFINITIONS,
  METRIC_KEYS,
  WIDGET_CATALOG,
  appointmentsSummary,
  jobsSummary,
  campaignPerformancePlaceholder,
  collectDashboardData,
  createAlertRule,
  deleteAlertRule,
  employeeActivity,
  evaluateAlertRules,
  exportSummary,
  getWidgetConfiguration,
  leadsBySource,
  listAlertRules,
  openTasksSummary,
  parseDateRange,
  quoteConversion,
  recentActivity,
  resetWidgetConfiguration,
  reviewsSummary,
  revenueSummary,
  setWidgetConfiguration,
  updateAlertRule,
  websiteTrafficPlaceholder,
} from './service';
import { renderDashboardPage } from './html';
import { collectOwnerDashboardData } from './owner';
import { renderOwnerDashboardPage } from './owner-html';

/* ------------------------------------------------------------------ *
 * Request schemas
 * ------------------------------------------------------------------ */

const widgetConfigPutSchema = z.object({
  widgets: z
    .array(
      z.object({
        widgetKey: z.string().min(1),
        enabled: z.boolean().optional(),
        settings: z.record(z.unknown()).optional(),
      }),
    )
    .min(1)
    .max(100),
});

const alertCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  metric: z.string().refine((m) => METRIC_KEYS.includes(m), {
    message: `metric must be one of: ${METRIC_KEYS.join(', ')}`,
  }),
  threshold: z.number().finite(),
  direction: z.enum(['above', 'below']),
  enabled: z.boolean().optional(),
});

const alertPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    metric: z.string().refine((m) => METRIC_KEYS.includes(m), {
      message: `metric must be one of: ${METRIC_KEYS.join(', ')}`,
    }),
    threshold: z.number().finite(),
    direction: z.enum(['above', 'below']),
    enabled: z.boolean(),
  })
  .partial();

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

/* ------------------------------------------------------------------ *
 * Router factory
 * ------------------------------------------------------------------ */

export function dashboardRouter(deps: ModuleDeps<DashboardDatabase>): Hono<TenantEnv> {
  const { db, events } = deps;
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(db)));

  /* ---- server-rendered HTML dashboard ---- */
  app.get('/', async (c) => {
    const range = parseDateRange(c.req.query());
    const data = await collectDashboardData(db, c.get('tenantId'), range);
    return c.html(renderDashboardPage(data));
  });

  /* ---- owner dashboard (retail sales analytics, server-rendered) ---- */
  app.get('/owner', async (c) => {
    const data = await collectOwnerDashboardData(db, c.get('tenantId'));
    return c.html(renderOwnerDashboardPage(data));
  });

  /* Same numbers as JSON, so every tile can be re-derived and verified. */
  app.get('/owner.json', async (c) => {
    const data = await collectOwnerDashboardData(db, c.get('tenantId'));
    return c.json({ data });
  });

  /* ---- KPI definitions (machine-readable, so the UI can explain numbers) ---- */
  app.get('/kpis', (c) => c.json({ data: KPI_DEFINITIONS }));

  /* ---- widget catalog ---- */
  app.get('/widgets', (c) => c.json({ data: WIDGET_CATALOG }));

  /* ---- per-tenant widget configuration ---- */
  app.get('/config', async (c) => {
    const config = await getWidgetConfiguration(db, c.get('tenantId'));
    return c.json({ data: config });
  });

  app.put('/config', async (c) => {
    const body = widgetConfigPutSchema.parse(await jsonBody(c));
    const config = await setWidgetConfiguration(
      db,
      events,
      c.get('tenantId'),
      actorOf(c),
      body.widgets,
    );
    return c.json({ data: config });
  });

  app.delete('/config', async (c) => {
    const config = await resetWidgetConfiguration(db, events, c.get('tenantId'), actorOf(c));
    return c.json({ data: config });
  });

  /* ---- aggregation widgets (all accept ?from=&to= ISO params) ---- */

  app.get('/widgets/jobs', async (c) => c.json({ data: await jobsSummary(db, c.get('tenantId'), parseDateRange(c.req.query())) }));
  app.get('/widgets/revenue', async (c) => {
    const range = parseDateRange(c.req.query());
    const summary = await revenueSummary(db, c.get('tenantId'), range);
    return c.json({ data: { key: 'revenue', range, ...summary } });
  });

  app.get('/widgets/leads-by-source', async (c) => {
    const range = parseDateRange(c.req.query());
    const summary = await leadsBySource(db, c.get('tenantId'), range);
    return c.json({ data: { key: 'leads_by_source', range, ...summary } });
  });

  app.get('/widgets/appointments', async (c) => {
    const range = parseDateRange(c.req.query());
    const summary = await appointmentsSummary(db, c.get('tenantId'), range);
    return c.json({ data: { key: 'appointments', range, ...summary } });
  });

  app.get('/widgets/quote-conversion', async (c) => {
    const range = parseDateRange(c.req.query());
    const summary = await quoteConversion(db, c.get('tenantId'), range);
    return c.json({ data: { key: 'quote_conversion', range, ...summary } });
  });

  app.get('/widgets/open-tasks', async (c) => {
    const range = parseDateRange(c.req.query());
    const summary = await openTasksSummary(db, c.get('tenantId'), range);
    return c.json({ data: { key: 'open_tasks', range, ...summary } });
  });

  app.get('/widgets/employee-activity', async (c) => {
    const range = parseDateRange(c.req.query());
    const summary = await employeeActivity(db, c.get('tenantId'), range);
    return c.json({ data: { key: 'employee_activity', range, ...summary } });
  });

  app.get('/widgets/reviews', async (c) => {
    const range = parseDateRange(c.req.query());
    const summary = await reviewsSummary(db, c.get('tenantId'), range);
    return c.json({ data: { key: 'reviews', range, ...summary } });
  });

  app.get('/widgets/website-traffic', (c) => {
    const range = parseDateRange(c.req.query());
    return c.json({ data: { key: 'website_traffic', range, ...websiteTrafficPlaceholder() } });
  });

  app.get('/widgets/campaign-performance', (c) => {
    const range = parseDateRange(c.req.query());
    return c.json({ data: { key: 'campaign_performance', range, ...campaignPerformancePlaceholder() } });
  });

  app.get('/widgets/recent-activity', async (c) => {
    const range = parseDateRange(c.req.query());
    const { limit } = parsePagination(c.req.query(), { defaultLimit: 20, maxLimit: 100 });
    const entries = await recentActivity(db, c.get('tenantId'), range, limit);
    return c.json({ data: { key: 'recent_activity', range, entries } });
  });

  /* ---- alert rules ---- */
  app.get('/alerts', async (c) => {
    const page = parsePagination(c.req.query());
    const rules = await listAlertRules(db, c.get('tenantId'), page);
    return c.json({ data: rules, limit: page.limit, offset: page.offset });
  });

  app.post('/alerts', async (c) => {
    const body = alertCreateSchema.parse(await jsonBody(c));
    const rule = await createAlertRule(db, events, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: rule }, 201);
  });

  app.get('/alerts/evaluate', async (c) => {
    const range = parseDateRange(c.req.query());
    const evaluations = await evaluateAlertRules(db, c.get('tenantId'), range, events);
    return c.json({ data: { range, evaluations } });
  });

  app.patch('/alerts/:id', async (c) => {
    const body = alertPatchSchema.parse(await jsonBody(c));
    const rule = await updateAlertRule(db, events, c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: rule });
  });

  app.delete('/alerts/:id', async (c) => {
    await deleteAlertRule(db, events, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: { deleted: true } });
  });

  /* ---- export summary (single JSON/CSV rollup) ---- */
  app.get('/export', async (c) => {
    const range = parseDateRange(c.req.query());
    const format = c.req.query('format') ?? 'json';
    if (format !== 'json' && format !== 'csv') {
      throw ApiError.badRequest(`unknown format: "${format}"`, { allowed: ['json', 'csv'] });
    }
    const summary = await exportSummary(db, c.get('tenantId'), range);
    if (format === 'csv') {
      const csv = serializeCsv(summary.metrics, ['key', 'name', 'unit', 'value', 'available']);
      return c.text(csv, 200, { 'content-type': 'text/csv; charset=utf-8' });
    }
    return c.json({ data: summary });
  });

  return app;
}
