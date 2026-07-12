import { Hono } from 'hono';
import { z } from 'zod';
import {
  asCoreDb,
  errorHandler,
  parseFilters,
  parsePagination,
  tenantMiddleware,
  type ModuleDeps,
  type TenantEnv,
} from '@blacklabel/core';
import { createWorkflowEngine, type WorkflowEngineOptions } from './engine';
import type { WorkflowsDatabase } from './schema';
import {
  ACTION_TYPES,
  TRIGGER_EVENTS,
  actionInputSchema,
  completeTask,
  conditionSchema,
  createTask,
  createWorkflow,
  deleteWorkflow,
  getExecution,
  getTask,
  getWorkflow,
  listExecutions,
  listNotifications,
  listTags,
  listTasks,
  listWorkflows,
  markNotificationRead,
  setWorkflowEnabled,
  updateWorkflow,
} from './service';

const createWorkflowSchema = z.object({
  name: z.string().min(1),
  triggerEvent: z.enum(TRIGGER_EVENTS),
  condition: conditionSchema.nullish(),
  actions: z.array(actionInputSchema).min(1),
  enabled: z.boolean().optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
});

const updateWorkflowSchema = z.object({
  name: z.string().min(1).optional(),
  triggerEvent: z.enum(TRIGGER_EVENTS).optional(),
  condition: conditionSchema.nullable().optional(),
  actions: z.array(actionInputSchema).min(1).optional(),
  enabled: z.boolean().optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
});

const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  assigneeUserId: z.string().optional(),
  dueAt: z.string().optional(),
  relatedEntityType: z.string().optional(),
  relatedEntityId: z.string().optional(),
});

/**
 * Router factory for the workflows module. Mounted by apps/api at
 * /api/workflows. All routes are tenant-scoped via the core middleware.
 */
export function workflowsRouter(
  deps: ModuleDeps<WorkflowsDatabase>,
  engineOptions: WorkflowEngineOptions = {},
): Hono<TenantEnv> {
  const { db, events } = deps;
  const engine = createWorkflowEngine(deps, engineOptions);
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(db)));

  const actor = (headerUserId: string | undefined) => headerUserId ?? 'system';

  /* ---------------- meta ---------------- */

  app.get('/meta', (c) =>
    c.json({ data: { triggerEvents: TRIGGER_EVENTS, actionTypes: ACTION_TYPES } }),
  );

  /* ---------------- engine tick ---------------- */

  app.post('/run-pending', async (c) => {
    const tenantId = c.get('tenantId');
    const result = await engine.runPending({ tenantId });
    return c.json({
      data: {
        retriedExecutionIds: result.retried,
        overdueTaskIds: result.overdueTasks,
      },
    });
  });

  /* ---------------- executions ---------------- */

  app.get('/executions', async (c) => {
    const tenantId = c.get('tenantId');
    const query = c.req.query();
    const page = parsePagination(query);
    const filters = parseFilters(query, ['workflow_id', 'status']);
    const data = await listExecutions(db, tenantId, page, filters);
    return c.json({ data, limit: page.limit, offset: page.offset });
  });

  app.get('/executions/:id', async (c) => {
    const tenantId = c.get('tenantId');
    const data = await getExecution(db, tenantId, c.req.param('id'));
    return c.json({ data });
  });

  /* ---------------- tasks ---------------- */

  app.post('/tasks', async (c) => {
    const tenantId = c.get('tenantId');
    const body = createTaskSchema.parse(await c.req.json());
    const data = await createTask(db, events, tenantId, body, actor(c.req.header('x-user-id')));
    return c.json({ data }, 201);
  });

  app.get('/tasks', async (c) => {
    const tenantId = c.get('tenantId');
    const query = c.req.query();
    const page = parsePagination(query);
    const filters = parseFilters(query, ['status', 'assignee_user_id']);
    const data = await listTasks(db, tenantId, page, filters);
    return c.json({ data, limit: page.limit, offset: page.offset });
  });

  app.get('/tasks/:id', async (c) => {
    const tenantId = c.get('tenantId');
    const data = await getTask(db, tenantId, c.req.param('id'));
    return c.json({ data });
  });

  app.post('/tasks/:id/complete', async (c) => {
    const tenantId = c.get('tenantId');
    const data = await completeTask(
      db,
      events,
      tenantId,
      c.req.param('id'),
      actor(c.req.header('x-user-id')),
    );
    return c.json({ data });
  });

  /* ---------------- notifications ---------------- */

  app.get('/notifications', async (c) => {
    const tenantId = c.get('tenantId');
    const query = c.req.query();
    const page = parsePagination(query);
    const filters = parseFilters(query, ['user_id']);
    const rows = await listNotifications(db, tenantId, page, filters);
    const data = rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      title: r.title,
      body: r.body,
      read: r.read === 1,
      createdAt: r.created_at,
    }));
    return c.json({ data, limit: page.limit, offset: page.offset });
  });

  app.post('/notifications/:id/read', async (c) => {
    const tenantId = c.get('tenantId');
    const row = await markNotificationRead(
      db,
      tenantId,
      c.req.param('id'),
      actor(c.req.header('x-user-id')),
    );
    return c.json({
      data: {
        id: row.id,
        userId: row.user_id,
        title: row.title,
        body: row.body,
        read: row.read === 1,
        createdAt: row.created_at,
      },
    });
  });

  /* ---------------- tags ---------------- */

  app.get('/tags', async (c) => {
    const query = c.req.query();
    const tenantId = c.get('tenantId');
    const filters = parseFilters(query, ['entity_type', 'entity_id']);
    const rows = await listTags(db, tenantId, filters);
    const data = rows.map((r) => ({
      id: r.id,
      entityType: r.entity_type,
      entityId: r.entity_id,
      tag: r.tag,
      createdAt: r.created_at,
    }));
    return c.json({ data });
  });

  /* ---------------- workflow definitions ---------------- */

  app.post('/', async (c) => {
    const tenantId = c.get('tenantId');
    const body = createWorkflowSchema.parse(await c.req.json());
    const data = await createWorkflow(
      db,
      events,
      tenantId,
      {
        name: body.name,
        triggerEvent: body.triggerEvent,
        condition: body.condition ?? null,
        actions: body.actions,
        enabled: body.enabled,
        maxAttempts: body.maxAttempts,
      },
      actor(c.req.header('x-user-id')),
    );
    return c.json({ data }, 201);
  });

  app.get('/', async (c) => {
    const tenantId = c.get('tenantId');
    const page = parsePagination(c.req.query());
    const data = await listWorkflows(db, tenantId, page);
    return c.json({ data, limit: page.limit, offset: page.offset });
  });

  app.get('/:id', async (c) => {
    const tenantId = c.get('tenantId');
    const data = await getWorkflow(db, tenantId, c.req.param('id'));
    return c.json({ data });
  });

  app.put('/:id', async (c) => {
    const tenantId = c.get('tenantId');
    const body = updateWorkflowSchema.parse(await c.req.json());
    const data = await updateWorkflow(
      db,
      events,
      tenantId,
      c.req.param('id'),
      body,
      actor(c.req.header('x-user-id')),
    );
    return c.json({ data });
  });

  app.post('/:id/enable', async (c) => {
    const tenantId = c.get('tenantId');
    const data = await setWorkflowEnabled(
      db,
      events,
      tenantId,
      c.req.param('id'),
      true,
      actor(c.req.header('x-user-id')),
    );
    return c.json({ data });
  });

  app.post('/:id/disable', async (c) => {
    const tenantId = c.get('tenantId');
    const data = await setWorkflowEnabled(
      db,
      events,
      tenantId,
      c.req.param('id'),
      false,
      actor(c.req.header('x-user-id')),
    );
    return c.json({ data });
  });

  app.delete('/:id', async (c) => {
    const tenantId = c.get('tenantId');
    await deleteWorkflow(db, events, tenantId, c.req.param('id'), actor(c.req.header('x-user-id')));
    return c.json({ data: { deleted: true } });
  });

  return app;
}
