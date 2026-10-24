import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  ApiError,
  audit,
  asCoreDb,
  id,
  nowIso,
  type EventBus,
  type Pagination,
} from '@blacklabel/core';
import type {
  TaskStatus,
  WorkflowActionRow,
  WorkflowExecutionActionRow,
  WorkflowExecutionRow,
  WorkflowNotificationRow,
  WorkflowRow,
  WorkflowsDatabase,
  WorkflowTagRow,
  WorkflowTaskRow,
} from './schema';

type Db = Kysely<WorkflowsDatabase>;

const DEFAULT_PAGE: Pagination = { limit: 50, offset: 0 };

/* ------------------------------------------------------------------ *
 * Trigger + condition + action vocabulary
 * ------------------------------------------------------------------ */

/** Platform events a workflow may be triggered by. */
export const TRIGGER_EVENTS = [
  'crm.job.completed',
  'crm.lead.created',
  'quoting.quote.approved',
  'scheduling.appointment.scheduled',
  'scheduling.appointment.completed',
  'billing.invoice.paid',
  'reviews.review.submitted',
  'workflows.task.overdue',
  'messaging.message.received',
] as const;

export type TriggerEvent = (typeof TRIGGER_EVENTS)[number];

/** Fixed action registry keys — the ONLY runnable action types (no eval, ever). */
export const ACTION_TYPES = [
  'send_email',
  'send_sms',
  'create_task',
  'update_lead_stage',
  'add_tag',
  'notify_user',
  'create_appointment',
  'create_invoice',
  'webhook',
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

export const CONDITION_OPS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'exists',
  'not_exists',
] as const;

export type ConditionOp = (typeof CONDITION_OPS)[number];

export const conditionSchema = z.object({
  /** Dot-path into the trigger payload, e.g. "totalCents" or "lead.source". */
  field: z.string().min(1),
  op: z.enum(CONDITION_OPS),
  value: z.unknown().optional(),
});

export type WorkflowCondition = z.infer<typeof conditionSchema>;

export const actionInputSchema = z.object({
  type: z.enum(ACTION_TYPES),
  /** Per-action JSON config; string values may use {{payload.x}} templates. */
  config: z.record(z.unknown()).default({}),
});

export type WorkflowActionInput = z.infer<typeof actionInputSchema>;

/* ------------------------------------------------------------------ *
 * DTOs
 * ------------------------------------------------------------------ */

export interface WorkflowDto {
  id: string;
  name: string;
  triggerEvent: string;
  condition: WorkflowCondition | null;
  enabled: boolean;
  maxAttempts: number;
  recipeKey?: string;
  actions: { id: string; position: number; type: string; config: Record<string, unknown> }[];
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionDto {
  id: string;
  workflowId: string;
  triggerEvent: string;
  triggerEventId: string | null;
  triggerPayload: unknown;
  status: string;
  attempts: number;
  nextRetryAt: string | null;
  failedActionIds: string[];
  startedAt: string;
  finishedAt: string | null;
  actions?: ExecutionActionDto[];
  receipts?: { actionId: string; operationKey: string; status: string; output: unknown; createdAt: string }[];
}

export interface ExecutionActionDto {
  id: string;
  actionId: string;
  attempt: number;
  position: number;
  type: string;
  status: string;
  output: unknown;
  error: string | null;
  createdAt: string;
}

export interface TaskDto {
  id: string;
  title: string;
  description: string | null;
  assigneeUserId: string | null;
  dueAt: string | null;
  status: TaskStatus;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toWorkflowDto(row: WorkflowRow, actions: WorkflowActionRow[]): WorkflowDto {
  return {
    id: row.id,
    name: row.name,
    triggerEvent: row.trigger_event,
    condition: row.condition_json ? (JSON.parse(row.condition_json) as WorkflowCondition) : null,
    enabled: row.enabled === 1,
    maxAttempts: row.max_attempts,
    ...(row.recipe_key ? { recipeKey: row.recipe_key } : {}),
    actions: actions.map((a) => ({
      id: a.id,
      position: a.position,
      type: a.type,
      config: JSON.parse(a.config_json) as Record<string, unknown>,
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toExecutionDto(
  row: WorkflowExecutionRow,
  actions?: WorkflowExecutionActionRow[],
): ExecutionDto {
  const dto: ExecutionDto = {
    id: row.id,
    workflowId: row.workflow_id,
    triggerEvent: row.trigger_event,
    triggerPayload: JSON.parse(row.trigger_payload_json),
    triggerEventId: row.trigger_event_id ?? null,
    status: row.status,
    attempts: row.attempts,
    nextRetryAt: row.next_retry_at,
    failedActionIds: row.failed_action_ids_json
      ? (JSON.parse(row.failed_action_ids_json) as string[])
      : [],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
  if (actions) {
    dto.actions = actions.map((a) => ({
      id: a.id,
      actionId: a.action_id,
      attempt: a.attempt,
      position: a.position,
      type: a.type,
      status: a.status,
      output: a.output_json ? JSON.parse(a.output_json) : null,
      error: a.error,
      createdAt: a.created_at,
    }));
  }
  return dto;
}

function toTaskDto(row: WorkflowTaskRow): TaskDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    assigneeUserId: row.assignee_user_id,
    dueAt: row.due_at,
    status: row.status,
    relatedEntityType: row.related_entity_type,
    relatedEntityId: row.related_entity_id,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ------------------------------------------------------------------ *
 * Workflow CRUD
 * ------------------------------------------------------------------ */

export interface CreateWorkflowInput {
  name: string;
  triggerEvent: TriggerEvent;
  condition?: WorkflowCondition | null;
  actions: WorkflowActionInput[];
  enabled?: boolean;
  maxAttempts?: number;
  /** Composition-owned stable installation identity; repeat installs preserve owner edits. */
  recipeKey?: string;
}

export async function createWorkflow(
  db: Db,
  events: EventBus,
  tenantId: string,
  input: CreateWorkflowInput,
  actor = 'system',
): Promise<WorkflowDto> {
  if (!TRIGGER_EVENTS.includes(input.triggerEvent)) {
    throw ApiError.badRequest(`unknown trigger event "${input.triggerEvent}"`, {
      allowed: TRIGGER_EVENTS,
    });
  }
  if (!input.actions || input.actions.length === 0) {
    throw ApiError.badRequest('a workflow needs at least one action');
  }
  if (!input.name?.trim() || input.name.length > 200 || input.actions.length > 20) throw ApiError.badRequest('Use a workflow name up to 200 characters and at most 20 actions.');
  if (input.maxAttempts !== undefined && (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 10)) {
    throw ApiError.badRequest('Workflow attempts must be an integer from 1 to 10.');
  }
  if (input.recipeKey !== undefined && !/^[a-zA-Z0-9:_-]{1,200}$/.test(input.recipeKey)) throw ApiError.badRequest('Invalid recipe installation key.');
  if (input.recipeKey) {
    const installed = await db.selectFrom('workflows_workflows').select('id').where('tenant_id', '=', tenantId)
      .where('recipe_key', '=', input.recipeKey).executeTakeFirst();
    if (installed) return getWorkflow(db, tenantId, installed.id);
  }
  for (const action of input.actions) {
    if (!ACTION_TYPES.includes(action.type)) {
      throw ApiError.badRequest(`unknown action type "${action.type}"`, { allowed: ACTION_TYPES });
    }
  }
  const now = nowIso();
  const row: WorkflowRow = {
    id: id(),
    tenant_id: tenantId,
    name: input.name.trim(),
    trigger_event: input.triggerEvent,
    condition_json: input.condition ? JSON.stringify(conditionSchema.parse(input.condition)) : null,
    enabled: input.enabled === false ? 0 : 1,
    max_attempts: input.maxAttempts ?? 3,
    recipe_key: input.recipeKey ?? null,
    created_at: now,
    updated_at: now,
  };
  const actionRows: WorkflowActionRow[] = input.actions.map((a, i) => ({
    id: id(),
    tenant_id: tenantId,
    workflow_id: row.id,
    position: i,
    type: a.type,
    config_json: JSON.stringify(a.config ?? {}),
    created_at: now,
  }));
  try {
    await db.transaction().execute(async trx => {
      await trx.insertInto('workflows_workflows').values(row).execute();
      for (const actionRow of actionRows) await trx.insertInto('workflows_workflow_actions').values(actionRow).execute();
      await audit(asCoreDb(trx), tenantId, actor, 'workflows.workflow.created', 'workflows.workflow', row.id, {
        name: row.name, triggerEvent: row.trigger_event, actionCount: actionRows.length,
      });
    });
  } catch (error) {
    if (input.recipeKey) {
      const winner = await db.selectFrom('workflows_workflows').select('id').where('tenant_id', '=', tenantId)
        .where('recipe_key', '=', input.recipeKey).executeTakeFirst();
      if (winner) return getWorkflow(db, tenantId, winner.id);
    }
    throw error;
  }
  await events.emit(tenantId, 'workflows.workflow.created', { workflowId: row.id });
  return toWorkflowDto(row, actionRows);
}

async function loadWorkflowRow(db: Db, tenantId: string, workflowId: string): Promise<WorkflowRow> {
  const row = await db
    .selectFrom('workflows_workflows')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', workflowId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`workflow not found: ${workflowId}`);
  return row;
}

export async function listWorkflowActions(
  db: Db,
  tenantId: string,
  workflowId: string,
): Promise<WorkflowActionRow[]> {
  return db
    .selectFrom('workflows_workflow_actions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('workflow_id', '=', workflowId)
    .orderBy('position')
    .orderBy('id')
    .execute();
}

export async function getWorkflow(db: Db, tenantId: string, workflowId: string): Promise<WorkflowDto> {
  const row = await loadWorkflowRow(db, tenantId, workflowId);
  const actions = await listWorkflowActions(db, tenantId, workflowId);
  return toWorkflowDto(row, actions);
}

export async function listWorkflows(
  db: Db,
  tenantId: string,
  page: Pagination = DEFAULT_PAGE,
): Promise<WorkflowDto[]> {
  const rows = await db
    .selectFrom('workflows_workflows')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
  const out: WorkflowDto[] = [];
  for (const row of rows) {
    out.push(toWorkflowDto(row, await listWorkflowActions(db, tenantId, row.id)));
  }
  return out;
}

export interface UpdateWorkflowInput {
  name?: string;
  triggerEvent?: TriggerEvent;
  /** null clears the condition. */
  condition?: WorkflowCondition | null;
  /** Replaces the full ordered action list when present. */
  actions?: WorkflowActionInput[];
  enabled?: boolean;
  maxAttempts?: number;
}

export async function updateWorkflow(
  db: Db,
  events: EventBus,
  tenantId: string,
  workflowId: string,
  patch: UpdateWorkflowInput,
  actor = 'system',
): Promise<WorkflowDto> {
  const existing = await loadWorkflowRow(db, tenantId, workflowId);
  const set: Partial<WorkflowRow> = { updated_at: nowIso() };
  if (patch.name !== undefined) {
    if (patch.name.trim() === '' || patch.name.length > 200) throw ApiError.badRequest('Use a workflow name from 1 to 200 characters.');
    set.name = patch.name.trim();
  }
  if (patch.triggerEvent !== undefined) {
    if (!TRIGGER_EVENTS.includes(patch.triggerEvent)) {
      throw ApiError.badRequest(`unknown trigger event "${patch.triggerEvent}"`, {
        allowed: TRIGGER_EVENTS,
      });
    }
    set.trigger_event = patch.triggerEvent;
  }
  if (patch.condition !== undefined) {
    set.condition_json =
      patch.condition === null ? null : JSON.stringify(conditionSchema.parse(patch.condition));
  }
  if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0;
  if (patch.maxAttempts !== undefined) {
    if (!Number.isInteger(patch.maxAttempts) || patch.maxAttempts < 1 || patch.maxAttempts > 10) {
      throw ApiError.badRequest('maxAttempts must be an integer from 1 to 10');
    }
    set.max_attempts = patch.maxAttempts;
  }
  if (patch.actions && (patch.actions.length < 1 || patch.actions.length > 20)) throw ApiError.badRequest('Use between 1 and 20 workflow actions.');

  await db
    .updateTable('workflows_workflows')
    .set(set)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', workflowId)
    .execute();

  if (patch.actions !== undefined) {
    if (patch.actions.length === 0) throw ApiError.badRequest('a workflow needs at least one action');
    for (const action of patch.actions) {
      if (!ACTION_TYPES.includes(action.type)) {
        throw ApiError.badRequest(`unknown action type "${action.type}"`, { allowed: ACTION_TYPES });
      }
    }
    await db
      .deleteFrom('workflows_workflow_actions')
      .where('tenant_id', '=', tenantId)
      .where('workflow_id', '=', workflowId)
      .execute();
    const now = nowIso();
    for (const [i, a] of patch.actions.entries()) {
      const actionRow: WorkflowActionRow = {
        id: id(),
        tenant_id: tenantId,
        workflow_id: workflowId,
        position: i,
        type: a.type,
        config_json: JSON.stringify(a.config ?? {}),
        created_at: now,
      };
      await db.insertInto('workflows_workflow_actions').values(actionRow).execute();
    }
  }

  await audit(asCoreDb(db), tenantId, actor, 'workflows.workflow.updated', 'workflows.workflow', workflowId, {
    before: { name: existing.name, enabled: existing.enabled === 1 },
    patch: Object.keys(patch),
  });
  await events.emit(tenantId, 'workflows.workflow.updated', { workflowId });
  return getWorkflow(db, tenantId, workflowId);
}

export async function setWorkflowEnabled(
  db: Db,
  events: EventBus,
  tenantId: string,
  workflowId: string,
  enabled: boolean,
  actor = 'system',
): Promise<WorkflowDto> {
  await loadWorkflowRow(db, tenantId, workflowId);
  await db
    .updateTable('workflows_workflows')
    .set({ enabled: enabled ? 1 : 0, updated_at: nowIso() })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', workflowId)
    .execute();
  const verb = enabled ? 'enabled' : 'disabled';
  await audit(asCoreDb(db), tenantId, actor, `workflows.workflow.${verb}`, 'workflows.workflow', workflowId);
  await events.emit(tenantId, `workflows.workflow.${verb}`, { workflowId });
  return getWorkflow(db, tenantId, workflowId);
}

export async function deleteWorkflow(
  db: Db,
  events: EventBus,
  tenantId: string,
  workflowId: string,
  actor = 'system',
): Promise<void> {
  const result = await db
    .deleteFrom('workflows_workflows')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', workflowId)
    .executeTakeFirst();
  if (result.numDeletedRows === 0n) {
    throw ApiError.notFound(`workflow not found: ${workflowId}`);
  }
  await db
    .deleteFrom('workflows_workflow_actions')
    .where('tenant_id', '=', tenantId)
    .where('workflow_id', '=', workflowId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'workflows.workflow.deleted', 'workflows.workflow', workflowId);
  await events.emit(tenantId, 'workflows.workflow.deleted', { workflowId });
}

/* ------------------------------------------------------------------ *
 * Executions (read side — the engine writes them)
 * ------------------------------------------------------------------ */

export async function listExecutions(
  db: Db,
  tenantId: string,
  page: Pagination = DEFAULT_PAGE,
  filters: { workflow_id?: string; status?: string } = {},
): Promise<ExecutionDto[]> {
  let q = db
    .selectFrom('workflows_executions')
    .selectAll()
    .where('tenant_id', '=', tenantId);
  if (filters.workflow_id) q = q.where('workflow_id', '=', filters.workflow_id);
  if (filters.status) q = q.where('status', '=', filters.status as WorkflowExecutionRow['status']);
  const rows = await q
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
  return rows.map((r) => toExecutionDto(r));
}

export async function getExecution(db: Db, tenantId: string, executionId: string): Promise<ExecutionDto> {
  const row = await db
    .selectFrom('workflows_executions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', executionId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`execution not found: ${executionId}`);
  const actions = await db
    .selectFrom('workflows_execution_actions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('execution_id', '=', executionId)
    .orderBy('attempt')
    .orderBy('position')
    .orderBy('id')
    .execute();
  const receipts = await db.selectFrom('workflows_action_receipts').selectAll().where('tenant_id', '=', tenantId)
    .where('execution_id', '=', executionId).orderBy('created_at').orderBy('id').execute();
  return { ...toExecutionDto(row, actions), receipts: receipts.map(receipt => ({ actionId: receipt.action_id,
    operationKey: receipt.operation_key, status: receipt.status,
    output: receipt.output_json ? JSON.parse(receipt.output_json) : null, createdAt: receipt.created_at })) };
}

/* ------------------------------------------------------------------ *
 * Tasks (owned here; workflows implements CreateTaskContract)
 * ------------------------------------------------------------------ */

export interface CreateTaskServiceInput {
  title: string;
  description?: string;
  assigneeUserId?: string;
  dueAt?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
}

export async function createTask(
  db: Db,
  events: EventBus,
  tenantId: string,
  input: CreateTaskServiceInput,
  actor = 'system',
): Promise<TaskDto> {
  if (!input.title || input.title.trim() === '') throw ApiError.badRequest('task title is required');
  const now = nowIso();
  const row: WorkflowTaskRow = {
    id: id(),
    tenant_id: tenantId,
    title: input.title.trim(),
    description: input.description ?? null,
    assignee_user_id: input.assigneeUserId ?? null,
    due_at: input.dueAt ?? null,
    status: 'open',
    related_entity_type: input.relatedEntityType ?? null,
    related_entity_id: input.relatedEntityId ?? null,
    completed_at: null,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('workflows_tasks').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'workflows.task.created', 'workflows.task', row.id, {
    title: row.title,
  });
  await events.emit(tenantId, 'workflows.task.created', { taskId: row.id });
  return toTaskDto(row);
}

export async function getTask(db: Db, tenantId: string, taskId: string): Promise<TaskDto> {
  const row = await db
    .selectFrom('workflows_tasks')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', taskId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`task not found: ${taskId}`);
  return toTaskDto(row);
}

export async function listTasks(
  db: Db,
  tenantId: string,
  page: Pagination = DEFAULT_PAGE,
  filters: { status?: string; assignee_user_id?: string } = {},
): Promise<TaskDto[]> {
  let q = db.selectFrom('workflows_tasks').selectAll().where('tenant_id', '=', tenantId);
  if (filters.status) q = q.where('status', '=', filters.status as TaskStatus);
  if (filters.assignee_user_id) q = q.where('assignee_user_id', '=', filters.assignee_user_id);
  const rows = await q
    .orderBy('created_at')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
  return rows.map(toTaskDto);
}

export async function completeTask(
  db: Db,
  events: EventBus,
  tenantId: string,
  taskId: string,
  actor = 'system',
): Promise<TaskDto> {
  const existing = await getTask(db, tenantId, taskId);
  if (existing.status === 'completed') {
    throw ApiError.conflict(`task already completed: ${taskId}`);
  }
  const now = nowIso();
  await db
    .updateTable('workflows_tasks')
    .set({ status: 'completed', completed_at: now, updated_at: now })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', taskId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'workflows.task.completed', 'workflows.task', taskId);
  await events.emit(tenantId, 'workflows.task.completed', { taskId });
  return getTask(db, tenantId, taskId);
}

/**
 * Flip due open tasks to 'overdue' and emit workflows.task.overdue for each.
 * Called from the engine tick (runPending) — no timers involved.
 */
export async function markOverdueTasks(
  db: Db,
  events: EventBus,
  tenantId: string,
  now: string = nowIso(),
): Promise<TaskDto[]> {
  const due = await db
    .selectFrom('workflows_tasks')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'open')
    .where('due_at', 'is not', null)
    .where('due_at', '<=', now)
    .orderBy('due_at')
    .orderBy('id')
    .execute();
  const marked: TaskDto[] = [];
  for (const task of due) {
    await db
      .updateTable('workflows_tasks')
      .set({ status: 'overdue', updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', task.id)
      .execute();
    await audit(asCoreDb(db), tenantId, 'system', 'workflows.task.overdue', 'workflows.task', task.id, {
      dueAt: task.due_at,
    });
    await events.emit(tenantId, 'workflows.task.overdue', { taskId: task.id, dueAt: task.due_at });
    marked.push(toTaskDto({ ...task, status: 'overdue', updated_at: now }));
  }
  return marked;
}

/* ------------------------------------------------------------------ *
 * Notifications
 * ------------------------------------------------------------------ */

export async function createNotification(
  db: Db,
  events: EventBus,
  tenantId: string,
  input: { userId: string; title: string; body?: string },
  actor = 'system',
): Promise<WorkflowNotificationRow> {
  const row: WorkflowNotificationRow = {
    id: id(),
    tenant_id: tenantId,
    user_id: input.userId,
    title: input.title,
    body: input.body ?? null,
    read: 0,
    created_at: nowIso(),
  };
  await db.insertInto('workflows_notifications').values(row).execute();
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'workflows.notification.created',
    'workflows.notification',
    row.id,
    { userId: row.user_id },
  );
  await events.emit(tenantId, 'workflows.notification.created', {
    notificationId: row.id,
    userId: row.user_id,
  });
  return row;
}

export async function listNotifications(
  db: Db,
  tenantId: string,
  page: Pagination = DEFAULT_PAGE,
  filters: { user_id?: string } = {},
): Promise<WorkflowNotificationRow[]> {
  let q = db.selectFrom('workflows_notifications').selectAll().where('tenant_id', '=', tenantId);
  if (filters.user_id) q = q.where('user_id', '=', filters.user_id);
  return q
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export async function markNotificationRead(
  db: Db,
  tenantId: string,
  notificationId: string,
  actor = 'system',
): Promise<WorkflowNotificationRow> {
  const result = await db
    .updateTable('workflows_notifications')
    .set({ read: 1 })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', notificationId)
    .executeTakeFirst();
  if (result.numUpdatedRows === 0n) {
    throw ApiError.notFound(`notification not found: ${notificationId}`);
  }
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'workflows.notification.read',
    'workflows.notification',
    notificationId,
  );
  const row = await db
    .selectFrom('workflows_notifications')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', notificationId)
    .executeTakeFirst();
  return row!;
}

/* ------------------------------------------------------------------ *
 * Tags (generic, entities referenced by id string only)
 * ------------------------------------------------------------------ */

/** Idempotent check-then-insert (no ON CONFLICT — portable SQL only). */
export async function addTag(
  db: Db,
  tenantId: string,
  input: { entityType: string; entityId: string; tag: string },
  actor = 'system',
): Promise<{ row: WorkflowTagRow; created: boolean }> {
  const existing = await db
    .selectFrom('workflows_tags')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('entity_type', '=', input.entityType)
    .where('entity_id', '=', input.entityId)
    .where('tag', '=', input.tag)
    .executeTakeFirst();
  if (existing) return { row: existing, created: false };
  const row: WorkflowTagRow = {
    id: id(),
    tenant_id: tenantId,
    entity_type: input.entityType,
    entity_id: input.entityId,
    tag: input.tag,
    created_at: nowIso(),
  };
  await db.insertInto('workflows_tags').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'workflows.tag.added', 'workflows.tag', row.id, {
    entityType: row.entity_type,
    entityId: row.entity_id,
    tag: row.tag,
  });
  return { row, created: true };
}

export async function listTags(
  db: Db,
  tenantId: string,
  filters: { entity_type?: string; entity_id?: string } = {},
): Promise<WorkflowTagRow[]> {
  let q = db.selectFrom('workflows_tags').selectAll().where('tenant_id', '=', tenantId);
  if (filters.entity_type) q = q.where('entity_type', '=', filters.entity_type);
  if (filters.entity_id) q = q.where('entity_id', '=', filters.entity_id);
  return q.orderBy('created_at').orderBy('id').execute();
}
