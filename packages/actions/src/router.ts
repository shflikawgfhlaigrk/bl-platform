import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  ApiError,
  asCoreDb,
  errorHandler,
  nowIso,
  parsePagination,
  tenantMiddleware,
  type ModuleDeps,
  type TenantEnv,
} from '@blacklabel/core';
import {
  ACTION_KINDS,
  ACTION_PRIORITIES,
  ACTION_STATUSES,
  RESOLUTION_KINDS,
  type ActionsDatabase,
} from './schema';
import {
  addComment,
  assign,
  countsSummary,
  escalate,
  getAction,
  listOverdue,
  listQueue,
  open,
  resolve,
  snooze,
  unsnooze,
  wakeDueSnoozes,
} from './service';

const kindEnum = z.enum(ACTION_KINDS);
const priorityEnum = z.enum(ACTION_PRIORITIES);
const statusEnum = z.enum(ACTION_STATUSES);

const openSchema = z.object({
  kind: kindEnum,
  title: z.string().trim().min(1).max(500),
  priority: priorityEnum,
  dedupeKey: z.string().trim().min(1).max(500),
  body: z.string().nullable().optional(),
  ownerUserId: z.string().nullable().optional(),
  dueAt: z.string().nullable().optional(),
  evidence: z.unknown().optional(),
  deepLink: z.string().nullable().optional(),
  sourceModule: z.string().nullable().optional(),
  sourceEntityType: z.string().nullable().optional(),
  sourceEntityId: z.string().nullable().optional(),
});

const resolveSchema = z.object({
  kind: z.enum(RESOLUTION_KINDS).default('manual'),
  proof: z.unknown().optional(),
});

const snoozeSchema = z.object({
  until: z.string().min(1),
  reason: z.string().trim().min(1).max(500),
});

const escalateSchema = z.object({
  toPriority: priorityEnum,
  reason: z.string().trim().min(1).max(500),
});

const assignSchema = z.object({ ownerUserId: z.string().trim().min(1) });

const commentSchema = z.object({
  author: z.string().trim().min(1).optional(),
  body: z.string().trim().min(1).max(5000),
});

const wakeSchema = z.object({ now: z.string().min(1).optional() }).default({});

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

export function actionsRouter(deps: ModuleDeps<ActionsDatabase>): Hono<TenantEnv> {
  const { db, events } = deps;
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(db)));

  /** Home-screen counts (active actions by kind + priority). */
  app.get('/counts', async (c) => {
    const summary = await countsSummary(db, c.get('tenantId'));
    return c.json({ data: summary });
  });

  /** Overdue active actions (?now= optional ISO, defaults to server now). */
  app.get('/overdue', async (c) => {
    const page = parsePagination(c.req.query());
    const now = c.req.query('now') ?? nowIso();
    const rows = await listOverdue(db, c.get('tenantId'), now, page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });

  /** The queue: filter by status/kind/priority/owner; default = active only. */
  app.get('/', async (c) => {
    const page = parsePagination(c.req.query());
    const q = c.req.query();
    const filters = {
      status: q.status ? statusEnum.parse(q.status) : undefined,
      kind: q.kind ? kindEnum.parse(q.kind) : undefined,
      priority: q.priority ? priorityEnum.parse(q.priority) : undefined,
      ownerUserId: q.ownerUserId && q.ownerUserId !== '' ? q.ownerUserId : undefined,
    };
    const rows = await listQueue(db, c.get('tenantId'), filters, page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });

  /** One action with its comments + escalation history. */
  app.get('/:id', async (c) => {
    const detail = await getAction(db, c.get('tenantId'), c.req.param('id'));
    return c.json({ data: detail });
  });

  /** Open (or dedupe-update) an action. */
  app.post('/', async (c) => {
    const body = openSchema.parse(await jsonBody(c));
    const result = await open(db, events, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: result.action, deduped: result.deduped }, result.deduped ? 200 : 201);
  });

  app.post('/:id/resolve', async (c) => {
    const body = resolveSchema.parse(await jsonBody(c));
    const action = await resolve(db, events, c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: action });
  });

  app.post('/:id/snooze', async (c) => {
    const body = snoozeSchema.parse(await jsonBody(c));
    const action = await snooze(
      db,
      c.get('tenantId'),
      actorOf(c),
      c.req.param('id'),
      body.until,
      body.reason,
    );
    return c.json({ data: action });
  });

  app.post('/:id/unsnooze', async (c) => {
    const action = await unsnooze(db, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: action });
  });

  app.post('/:id/escalate', async (c) => {
    const body = escalateSchema.parse(await jsonBody(c));
    const action = await escalate(
      db,
      c.get('tenantId'),
      actorOf(c),
      c.req.param('id'),
      body.toPriority,
      body.reason,
    );
    return c.json({ data: action });
  });

  app.post('/:id/assign', async (c) => {
    const body = assignSchema.parse(await jsonBody(c));
    const action = await assign(
      db,
      c.get('tenantId'),
      actorOf(c),
      c.req.param('id'),
      body.ownerUserId,
    );
    return c.json({ data: action });
  });

  app.post('/:id/comments', async (c) => {
    const body = commentSchema.parse(await jsonBody(c));
    const author = body.author ?? actorOf(c);
    const comment = await addComment(
      db,
      c.get('tenantId'),
      actorOf(c),
      c.req.param('id'),
      author,
      body.body,
    );
    return c.json({ data: comment }, 201);
  });

  /** Process due snoozes (?now via body). Returns the woken actions. */
  app.post('/wake-due', async (c) => {
    const body = wakeSchema.parse(await jsonBody(c).catch(() => ({})));
    const now = body.now ?? nowIso();
    const woken = await wakeDueSnoozes(db, c.get('tenantId'), actorOf(c), now);
    return c.json({ data: woken, count: woken.length });
  });

  return app;
}
