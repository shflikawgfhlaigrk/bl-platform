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
import type { AutomationDatabase, OutboxStatus } from './schema';
import { OutboxService } from './outbox';
import { RulesService } from './rules';
import { DispatcherRegistry, runOnce } from './dispatcher';

/* ------------------------------ Zod --------------------------------- */

const conditionSchema = z.object({
  path: z.string().min(1),
  op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists']),
  value: z.unknown().optional(),
});

const scheduleSchema = z.object({
  timezone: z.string().min(1),
  windows: z
    .array(
      z.object({
        days: z.array(z.number().int().min(1).max(7)).optional(),
        start: z.string().regex(/^\d{1,2}:\d{2}$/),
        end: z.string().regex(/^\d{1,2}:\d{2}$/),
      }),
    )
    .default([]),
});

const createRuleSchema = z.object({
  name: z.string().trim().min(1).max(200),
  triggerEvent: z.string().trim().min(1).max(200),
  conditions: z.array(conditionSchema).default([]),
  actionKind: z.string().trim().min(1).max(200),
  actionTemplate: z.unknown().default({}),
  policy: z.enum(['automatic', 'approval_required', 'disabled']),
  schedule: scheduleSchema.nullable().optional(),
  idempotencyWindowSeconds: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
});

const updateRuleSchema = createRuleSchema.partial();

const evaluateSchema = z.object({
  eventType: z.string().min(1),
  payload: z.unknown(),
  dryRun: z.boolean().optional(),
});

const rejectSchema = z.object({ reason: z.string().trim().min(1).max(1000) });
const runOnceSchema = z.object({ limit: z.number().int().min(1).max(500).optional() });

const OUTBOX_STATUSES: OutboxStatus[] = [
  'pending',
  'delivering',
  'delivered',
  'failed',
  'dead',
  'canceled',
];

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
 * Automation router. Standard `ModuleDeps` signature; an optional
 * DispatcherRegistry (2nd arg) enables `POST /outbox/run-once` — the integrator
 * passes the registry it wired handlers into. Without it, run-once returns 501.
 */
export function automationRouter(
  deps: ModuleDeps<AutomationDatabase>,
  registry?: DispatcherRegistry,
): Hono<TenantEnv> {
  const { db, events } = deps;
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(db)));

  const outbox = new OutboxService(db, events);
  const rules = new RulesService(db, events);

  /* -------------------------- Rules CRUD -------------------------- */

  app.post('/rules', async (c) => {
    const body = createRuleSchema.parse(await jsonBody(c));
    const row = await rules.create(c.get('tenantId'), body, actorOf(c));
    return c.json({ data: row }, 201);
  });

  app.get('/rules', async (c) => {
    const page = parsePagination(c.req.query());
    const list = await rules.listCurrent(c.get('tenantId'), page);
    return c.json({ data: list, limit: page.limit, offset: page.offset });
  });

  app.get('/rules/:ruleKey', async (c) => {
    const row = await rules.getCurrent(c.get('tenantId'), c.req.param('ruleKey'));
    if (!row) throw ApiError.notFound('rule not found');
    return c.json({ data: row });
  });

  app.get('/rules/:ruleKey/versions', async (c) => {
    const list = await rules.listVersions(c.get('tenantId'), c.req.param('ruleKey'));
    if (list.length === 0) throw ApiError.notFound('rule not found');
    return c.json({ data: list });
  });

  app.put('/rules/:ruleKey', async (c) => {
    const body = updateRuleSchema.parse(await jsonBody(c));
    const row = await rules.update(c.get('tenantId'), c.req.param('ruleKey'), body, actorOf(c));
    return c.json({ data: row });
  });

  app.delete('/rules/:ruleKey', async (c) => {
    const row = await rules.disable(c.get('tenantId'), c.req.param('ruleKey'), actorOf(c));
    return c.json({ data: row });
  });

  /* -------- Evaluate (manual trigger / dry-run preview) -------- */

  app.post('/evaluate', async (c) => {
    const body = evaluateSchema.parse(await jsonBody(c));
    const previews = await rules.evaluate(c.get('tenantId'), body.eventType, body.payload, {
      dryRun: body.dryRun,
      actor: actorOf(c),
    });
    return c.json({ data: previews });
  });

  /* ------------------------- Executions ------------------------- */

  app.get('/executions', async (c) => {
    const page = parsePagination(c.req.query());
    const { rule_id, event_type, outcome } = c.req.query();
    const list = await rules.listExecutions(
      c.get('tenantId'),
      { ruleId: rule_id, eventType: event_type, outcome },
      page,
    );
    return c.json({ data: list, limit: page.limit, offset: page.offset });
  });

  /* ------------------------- Approvals -------------------------- */

  app.get('/approvals', async (c) => {
    const page = parsePagination(c.req.query());
    const list = await rules.listApprovals(c.get('tenantId'), { status: c.req.query('status') }, page);
    return c.json({ data: list, limit: page.limit, offset: page.offset });
  });

  app.post('/approvals/:id/approve', async (c) => {
    const row = await rules.approve(c.get('tenantId'), c.req.param('id'), actorOf(c));
    return c.json({ data: row });
  });

  app.post('/approvals/:id/reject', async (c) => {
    const body = rejectSchema.parse(await jsonBody(c));
    const row = await rules.reject(c.get('tenantId'), c.req.param('id'), body.reason, actorOf(c));
    return c.json({ data: row });
  });

  /* --------------------------- Outbox --------------------------- */

  app.get('/outbox', async (c) => {
    const page = parsePagination(c.req.query());
    const status = c.req.query('status');
    if (status !== undefined && !OUTBOX_STATUSES.includes(status as OutboxStatus)) {
      throw ApiError.badRequest(`invalid status "${status}"`, { allowed: OUTBOX_STATUSES });
    }
    const list = await outbox.list(
      c.get('tenantId'),
      { status: status as OutboxStatus | undefined },
      page,
    );
    return c.json({ data: list, limit: page.limit, offset: page.offset });
  });

  app.get('/outbox/dead', async (c) => {
    const page = parsePagination(c.req.query());
    const list = await outbox.listDead(c.get('tenantId'), page);
    return c.json({ data: list, limit: page.limit, offset: page.offset });
  });

  app.get('/outbox/:id', async (c) => {
    const row = await outbox.get(c.get('tenantId'), c.req.param('id'));
    if (!row) throw ApiError.notFound('outbox row not found');
    return c.json({ data: row });
  });

  app.post('/outbox/:id/replay', async (c) => {
    const row = await outbox.replay(c.get('tenantId'), c.req.param('id'), actorOf(c));
    return c.json({ data: row });
  });

  app.post('/outbox/:id/cancel', async (c) => {
    const row = await outbox.cancel(c.get('tenantId'), c.req.param('id'), actorOf(c));
    return c.json({ data: row });
  });

  /* Drain due rows through registered handlers (integrator-supplied registry). */
  app.post('/outbox/run-once', async (c) => {
    if (!registry) {
      throw new ApiError(501, 'no dispatcher registry wired', 'not_implemented');
    }
    const body = runOnceSchema.parse(await jsonBody(c).catch(() => ({})));
    const result = await runOnce(
      db,
      registry,
      c.get('tenantId'),
      new Date().toISOString(),
      body.limit ?? 50,
      events,
    );
    return c.json({ data: result });
  });

  return app;
}

/**
 * Convenience factory for integrators who prefer a dedicated dispatcher router
 * (mounts only `POST /run-once`). Equivalent to passing the registry to
 * `automationRouter`.
 */
export function automationDispatcherRouter(
  deps: ModuleDeps<AutomationDatabase>,
  registry: DispatcherRegistry,
): Hono<TenantEnv> {
  const { db, events } = deps;
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(db)));
  app.post('/run-once', async (c) => {
    const body = runOnceSchema.parse(await jsonBody(c).catch(() => ({})));
    const result = await runOnce(
      db,
      registry,
      c.get('tenantId'),
      new Date().toISOString(),
      body.limit ?? 50,
      events,
    );
    return c.json({ data: result });
  });
  return app;
}
