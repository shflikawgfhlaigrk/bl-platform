import { DateTime } from 'luxon';
import { z } from 'zod';
import {
  asCoreDb,
  id,
  listTenants,
  nowIso,
  type Contracts,
  EventBus,
  type ModuleDeps,
  type PlatformEvent,
} from '@blacklabel/core';
import type { Kysely } from 'kysely';
import type {
  WorkflowActionRow,
  WorkflowExecutionActionRow,
  WorkflowExecutionRow,
  WorkflowRow,
  WorkflowsDatabase,
} from './schema';
import {
  ACTION_TYPES,
  TRIGGER_EVENTS,
  addTag,
  createNotification,
  createTask,
  markOverdueTasks,
  type ActionType,
  type WorkflowCondition,
} from './service';

type Db = Kysely<WorkflowsDatabase>;

/* ------------------------------------------------------------------ *
 * Safe helpers: dot-path lookup, {{template}} rendering, conditions.
 * No eval, no Function, no dynamic code — plain data traversal only.
 * ------------------------------------------------------------------ */

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Replace {{path.to.value}} placeholders from the template context. */
export function renderTemplate(template: string, ctx: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, path: string) => {
    const value = getPath(ctx, path);
    if (value === undefined || value === null) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

/** Deep-render every string value of an action config. */
function renderConfig(value: unknown, ctx: Record<string, unknown>): unknown {
  if (typeof value === 'string') return renderTemplate(value, ctx);
  if (Array.isArray(value)) return value.map((v) => renderConfig(v, ctx));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = renderConfig(v, ctx);
    }
    return out;
  }
  return value;
}

function comparable(a: unknown, b: unknown): boolean {
  return (
    (typeof a === 'number' && typeof b === 'number') ||
    (typeof a === 'string' && typeof b === 'string')
  );
}

/** Evaluate a {field, op, value} condition against the trigger payload. */
export function evaluateCondition(condition: WorkflowCondition | null, payload: unknown): boolean {
  if (!condition) return true;
  const actual = getPath(payload, condition.field);
  const expected = condition.value;
  switch (condition.op) {
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'gt':
      return comparable(actual, expected) && (actual as never) > (expected as never);
    case 'gte':
      return comparable(actual, expected) && (actual as never) >= (expected as never);
    case 'lt':
      return comparable(actual, expected) && (actual as never) < (expected as never);
    case 'lte':
      return comparable(actual, expected) && (actual as never) <= (expected as never);
    case 'contains':
      if (typeof actual === 'string') return actual.includes(String(expected));
      if (Array.isArray(actual)) return actual.includes(expected as never);
      return false;
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'not_exists':
      return actual === undefined || actual === null;
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ *
 * Action registry — FIXED map of action type -> zod config schema + runner.
 * Configs are validated AFTER template rendering; every runner is executed
 * inside a per-action try/catch by the engine.
 * ------------------------------------------------------------------ */

/** Minimal structural fetch so tests can stub the webhook transport. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

export interface WorkflowEngineOptions {
  /** Composition-owned CRM mutation, with destination readback before return. */
  leadStages?: { update(input: { tenantId: string; leadId: string; stage: string; actor: string; operationId: string }): Promise<{ leadId: string; stage: string }> };
  /** Base delay for exponential retry backoff (delay = base * 2^(attempt-1)). */
  baseBackoffMs?: number;
  /** Injectable clock, ISO-8601 UTC. Defaults to nowIso. */
  clock?: () => string;
  /** Injectable fetch for the webhook action. Defaults to globalThis.fetch. */
  fetchImpl?: FetchLike;
}

interface ActionContext {
  db: Db;
  events: EventBus;
  contracts: Contracts;
  tenantId: string;
  workflowId: string;
  executionId: string;
  actionId: string;
  leadStages?: WorkflowEngineOptions['leadStages'];
  payload: unknown;
  triggerEvent: string;
  occurredAt: string;
  fetchImpl: FetchLike;
  now: () => string;
}

interface ActionOutcome {
  status: 'succeeded' | 'skipped';
  output: unknown;
}

interface ActionDefinition {
  configSchema: z.ZodTypeAny;
  run(config: never, ctx: ActionContext): Promise<ActionOutcome>;
}

const sendEmailConfig = z.object({
  to: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
});

const sendSmsConfig = z.object({
  to: z.string().min(1),
  body: z.string().min(1),
});

const createTaskConfig = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  assigneeUserId: z.string().optional(),
  /** Relative due date; resolved against the engine clock. */
  dueInHours: z.number().positive().optional(),
  /** Absolute ISO-8601 due date; wins over dueInHours. */
  dueAt: z.string().optional(),
  relatedEntityType: z.string().optional(),
  relatedEntityId: z.string().optional(),
});

const updateLeadStageConfig = z.object({
  leadId: z.string().min(1),
  stage: z.string().min(1),
});

const addTagConfig = z.object({
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  tag: z.string().min(1),
});

const notifyUserConfig = z.object({
  userId: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
});

const createAppointmentConfig = z.object({
  customerId: z.string().min(1),
  startsAt: z.string().optional(),
  startsInHours: z.number().positive().optional(),
  durationMinutes: z.number().int().positive().default(60),
  assigneeUserId: z.string().optional(),
  serviceKey: z.string().optional(),
  notes: z.string().optional(),
});

const createInvoiceConfig = z.object({
  customerId: z.string().min(1),
  lines: z
    .array(
      z.object({
        description: z.string().min(1),
        quantity: z.number().positive(),
        unitPriceCents: z.number().int().nonnegative(),
        discountBps: z.number().int().min(0).max(10000).optional(),
        discountFixedCents: z.number().int().nonnegative().optional(),
      }),
    )
    .min(1),
  discountBps: z.number().int().min(0).max(10000).optional(),
  discountFixedCents: z.number().int().nonnegative().optional(),
  taxBps: z.number().int().min(0).optional(),
  dueAt: z.string().optional(),
  memo: z.string().optional(),
});

const webhookConfig = z.object({
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  timeoutMs: z.number().int().positive().max(30000).default(5000),
  includePayload: z.boolean().default(true),
  /** Extra JSON merged into the POST body. */
  body: z.record(z.unknown()).optional(),
});

const workflowActor = (ctx: ActionContext) => `workflow:${ctx.workflowId}`;

/**
 * THE registry. Actions run only by exact key lookup in this map — user data
 * never selects code beyond these fixed entries.
 */
const ACTION_REGISTRY: Record<ActionType, ActionDefinition> = {
  /** Submit the exact operation through the connected messaging contract. */
  send_email: {
    configSchema: sendEmailConfig,
    run: async (config: z.infer<typeof sendEmailConfig>, ctx) => {
      if (ctx.contracts.sendMessage) {
        const message = {
          idempotencyKey: `workflow:${ctx.executionId}:${ctx.actionId}`,
          tenantId: ctx.tenantId,
          channel: 'email' as const,
          to: config.to,
          subject: config.subject,
          body: config.body,
          relatedEntityType: 'workflows.execution',
          relatedEntityId: ctx.executionId,
        };
        const result = await ctx.contracts.sendMessage.sendMessage(message);
        return { status: 'succeeded', output: { messageId: result.id, via: 'contract' } };
      }
      throw new Error('Email messaging is not connected.');
    },
  },

  /** Submit the exact operation through the connected messaging contract. */
  send_sms: {
    configSchema: sendSmsConfig,
    run: async (config: z.infer<typeof sendSmsConfig>, ctx) => {
      if (ctx.contracts.sendMessage) {
        const message = {
          idempotencyKey: `workflow:${ctx.executionId}:${ctx.actionId}`,
          tenantId: ctx.tenantId,
          channel: 'sms' as const,
          to: config.to,
          body: config.body,
          relatedEntityType: 'workflows.execution',
          relatedEntityId: ctx.executionId,
        };
        const result = await ctx.contracts.sendMessage.sendMessage(message);
        return { status: 'succeeded', output: { messageId: result.id, via: 'contract' } };
      }
      throw new Error('SMS messaging is not connected.');
    },
  },

  /** Creates a task in this module (workflows implements CreateTaskContract). */
  create_task: {
    configSchema: createTaskConfig,
    run: async (config: z.infer<typeof createTaskConfig>, ctx) => {
      let dueAt = config.dueAt;
      if (!dueAt && config.dueInHours !== undefined) {
        dueAt = DateTime.fromISO(ctx.occurredAt, { zone: 'utc' })
          .plus({ hours: config.dueInHours })
          .toISO()!;
      }
      const task = await createTask(
        ctx.db,
        ctx.events,
        ctx.tenantId,
        {
          title: config.title,
          description: config.description,
          assigneeUserId: config.assigneeUserId,
          dueAt,
          relatedEntityType: config.relatedEntityType,
          relatedEntityId: config.relatedEntityId,
        },
        workflowActor(ctx),
      );
      return { status: 'succeeded', output: { taskId: task.id, dueAt: task.dueAt } };
    },
  },

  /** CRM owns its mutation; composition injects its verified operation. */
  update_lead_stage: {
    configSchema: updateLeadStageConfig,
    run: async (config: z.infer<typeof updateLeadStageConfig>, ctx) => {
      if (!ctx.leadStages) throw new Error('CRM lead updates are not connected.');
      const result = await ctx.leadStages.update({ tenantId: ctx.tenantId, leadId: config.leadId, stage: config.stage,
        actor: workflowActor(ctx), operationId: `workflow:${ctx.executionId}:${ctx.actionId}` });
      if (result.leadId !== config.leadId || result.stage !== config.stage) throw new Error('CRM lead update readback differs from the requested change.');
      return { status: 'succeeded', output: result };
    },
  },

  /** Real: writes a workflows_tags row (entities referenced by id string only). */
  add_tag: {
    configSchema: addTagConfig,
    run: async (config: z.infer<typeof addTagConfig>, ctx) => {
      const { row, created } = await addTag(
        ctx.db,
        ctx.tenantId,
        { entityType: config.entityType, entityId: config.entityId, tag: config.tag },
        workflowActor(ctx),
      );
      return { status: 'succeeded', output: { tagId: row.id, created } };
    },
  },

  /** Real: writes a workflows_notifications row. */
  notify_user: {
    configSchema: notifyUserConfig,
    run: async (config: z.infer<typeof notifyUserConfig>, ctx) => {
      const row = await createNotification(
        ctx.db,
        ctx.events,
        ctx.tenantId,
        { userId: config.userId, title: config.title, body: config.body },
        workflowActor(ctx),
      );
      return { status: 'succeeded', output: { notificationId: row.id } };
    },
  },

  /** Via the scheduling contract; skipped gracefully when not wired. */
  create_appointment: {
    configSchema: createAppointmentConfig,
    run: async (config: z.infer<typeof createAppointmentConfig>, ctx) => {
      if (!ctx.contracts.createAppointment) {
        return {
          status: 'skipped',
          output: { reason: 'createAppointment contract not wired' },
        };
      }
      const start = config.startsAt
        ? DateTime.fromISO(config.startsAt, { zone: 'utc' })
        : DateTime.fromISO(ctx.occurredAt, { zone: 'utc' }).plus({ hours: config.startsInHours ?? 24 });
      const end = start.plus({ minutes: config.durationMinutes });
      const result = await ctx.contracts.createAppointment.createAppointment({
        tenantId: ctx.tenantId,
        idempotencyKey: `workflow:${ctx.executionId}:${ctx.actionId}`,
        customerId: config.customerId,
        startsAt: start.toISO()!,
        endsAt: end.toISO()!,
        assigneeUserId: config.assigneeUserId,
        serviceKey: config.serviceKey,
        notes: config.notes,
      });
      return { status: 'succeeded', output: { appointmentId: result.id } };
    },
  },

  /** Placeholder via the billing contract; skipped gracefully when not wired. */
  create_invoice: {
    configSchema: createInvoiceConfig,
    run: async (config: z.infer<typeof createInvoiceConfig>, ctx) => {
      if (!ctx.contracts.createInvoice) {
        return {
          status: 'skipped',
          output: { reason: 'createInvoice contract not wired' },
        };
      }
      const result = await ctx.contracts.createInvoice.createInvoice({
        tenantId: ctx.tenantId,
        customerId: config.customerId,
        lines: config.lines,
        discountBps: config.discountBps,
        discountFixedCents: config.discountFixedCents,
        taxBps: config.taxBps,
        dueAt: config.dueAt,
        memo: config.memo,
        // Core exposes a source seam, not a processor idempotency guarantee.
        sourceEntityType: 'workflows.action',
        sourceEntityId: `workflow:${ctx.executionId}:${ctx.actionId}`,
      });
      return { status: 'succeeded', output: { invoiceId: result.id } };
    },
  },

  /** Real HTTP POST with timeout + response capture. Non-2xx throws (retryable). */
  webhook: {
    configSchema: webhookConfig,
    run: async (config: z.infer<typeof webhookConfig>, ctx) => {
      const body: Record<string, unknown> = {
        workflowId: ctx.workflowId,
        executionId: ctx.executionId,
        event: { type: ctx.triggerEvent, occurredAt: ctx.occurredAt },
        ...(config.includePayload ? { payload: ctx.payload } : {}),
        ...(config.body ?? {}),
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const res = await ctx.fetchImpl(config.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(config.headers ?? {}) },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await res.text().catch(() => '');
        if (!res.ok) {
          throw new Error(`webhook responded ${res.status}: ${text.slice(0, 500)}`);
        }
        return {
          status: 'succeeded',
          output: { status: res.status, responseBody: text.slice(0, 2000) },
        };
      } catch (err) {
        if (controller.signal.aborted) {
          throw new Error(`webhook timed out after ${config.timeoutMs}ms`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  },
};

/* ------------------------------------------------------------------ *
 * Engine
 * ------------------------------------------------------------------ */

export interface RunPendingResult {
  /** Executions retried this tick (by id). */
  retried: string[];
  /** Tasks flipped to overdue this tick (by id). */
  overdueTasks: string[];
}

export interface WorkflowEngine {
  /** Run all matching enabled workflows for one platform event. */
  handleEvent(event: PlatformEvent): Promise<void>;
  /**
   * The tick: marks due tasks overdue (emitting workflows.task.overdue) and
   * processes executions whose next_retry_at is due. Pass tenantId to scope
   * to one tenant (the router always does); omit it to sweep every tenant.
   */
  runPending(opts?: { tenantId?: string; now?: string }): Promise<RunPendingResult>;
  /** Subscribe handleEvent to every TRIGGER_EVENT on the bus. Returns detach. */
  attach(): () => void;
}

interface ActionRunReport {
  failedActionIds: string[];
}

export function createWorkflowEngine(
  deps: ModuleDeps<WorkflowsDatabase>,
  options: WorkflowEngineOptions = {},
): WorkflowEngine {
  const db = deps.db;
  const events = deps.events;
  const contracts = deps.contracts;
  const baseBackoffMs = options.baseBackoffMs ?? 60_000;
  const clock = options.clock ?? nowIso;
  const leaseUntil = (at = clock()) => DateTime.fromISO(at, { zone: 'utc' }).plus({ minutes: 1 }).toISO()!;
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((globalThis as { fetch?: unknown }).fetch as FetchLike);

  function backoffAt(fromIso: string, attempts: number): string {
    return DateTime.fromISO(fromIso, { zone: 'utc' })
      .plus({ milliseconds: baseBackoffMs * 2 ** (attempts - 1) })
      .toISO()!;
  }

  async function logActionRow(
    row: Omit<WorkflowExecutionActionRow, 'id' | 'created_at'>,
  ): Promise<void> {
    await db
      .insertInto('workflows_execution_actions')
      .values({ ...row, id: id(), created_at: clock() })
      .execute();
  }

  /**
   * Run a set of actions for an execution (attempt N). Every action gets its
   * own try/catch: one failure never stops later actions ("failure isolation").
   */
  async function runActions(
    workflow: WorkflowRow,
    execution: { id: string; trigger_event: string; started_at: string },
    actions: WorkflowActionRow[],
    payload: unknown,
    attempt: number,
    onlyActionIds: Set<string> | null,
    claimToken: string,
    claimTime: string,
  ): Promise<ActionRunReport> {
    const failedActionIds: string[] = [];
    const templateCtx: Record<string, unknown> = {
      payload,
      event: { type: execution.trigger_event, occurredAt: execution.started_at },
      workflow: { id: workflow.id, name: workflow.name },
    };
    const ctx: ActionContext = {
      db,
      events,
      contracts,
      tenantId: workflow.tenant_id,
      workflowId: workflow.id,
      executionId: execution.id,
      actionId: '',
      leadStages: options.leadStages,
      payload,
      triggerEvent: execution.trigger_event,
      occurredAt: execution.started_at,
      fetchImpl,
      now: clock,
    };

    for (const action of actions) {
      if (onlyActionIds && !onlyActionIds.has(action.id)) continue;
      const renewed = await db.updateTable('workflows_executions').set({ claim_expires_at: leaseUntil(clock() > claimTime ? clock() : claimTime) })
        .where('tenant_id', '=', workflow.tenant_id).where('id', '=', execution.id)
        .where('status', '=', 'retrying')
        .where('claim_token', '=', claimToken).executeTakeFirst();
      if (!renewed.numUpdatedRows) throw new Error('Workflow execution ownership changed; recovery will resume its saved receipts.');
      const base = {
        tenant_id: workflow.tenant_id,
        execution_id: execution.id,
        action_id: action.id,
        attempt,
        position: action.position,
        type: action.type,
      };
      try {
        const definition = ACTION_REGISTRY[action.type as ActionType];
        if (!definition) {
          throw new Error(`unknown action type "${action.type}"`);
        }
        const rawConfig = JSON.parse(action.config_json) as unknown;
        const rendered = renderConfig(rawConfig, templateCtx);
        const config = definition.configSchema.parse(rendered);
        // A success log can survive a crash before header finalization. Never
        // repeat a destination operation whose committed success is already known.
        const completed = await db.selectFrom('workflows_execution_actions').selectAll()
          .where('tenant_id', '=', workflow.tenant_id).where('execution_id', '=', execution.id)
          .where('action_id', '=', action.id).where('status', 'in', ['succeeded', 'skipped'])
          .orderBy('attempt', 'desc').orderBy('id').executeTakeFirst();
        let outcome: ActionOutcome;
        if (completed) {
          outcome = { status: completed.status as ActionOutcome['status'], output: completed.output_json ? JSON.parse(completed.output_json) : null };
        } else if (['create_task', 'notify_user', 'add_tag'].includes(action.type)) {
          const buffered = new EventBus(), emitted: PlatformEvent[] = [];
          buffered.on('*', event => { emitted.push(event); });
          const operationKey = `workflow:${execution.id}:${action.id}`;
          const request = JSON.stringify({ type: action.type, config });
          // The local business write, audit and result receipt commit together.
          // If the process stops before the attempt log, the next worker reads
          // this receipt rather than creating a second task/notification/tag.
          outcome = await db.transaction().execute(async trx => {
            const receipt = await trx.selectFrom('workflows_action_receipts').selectAll()
              .where('tenant_id', '=', workflow.tenant_id).where('operation_key', '=', operationKey).executeTakeFirst();
            if (receipt) {
              if (receipt.request_json !== request) throw new Error('Saved action identity belongs to different input.');
              return { status: receipt.status, output: receipt.output_json ? JSON.parse(receipt.output_json) : null };
            }
            const result = await definition.run(config as never, { ...ctx, db: trx, events: buffered, actionId: action.id });
            await trx.insertInto('workflows_action_receipts').values({ id: id(), tenant_id: workflow.tenant_id,
              execution_id: execution.id, action_id: action.id, operation_key: operationKey, request_json: request,
              status: result.status, output_json: JSON.stringify(result.output ?? null), created_at: clock() }).execute();
            return result;
          });
          for (const event of emitted) await events.emit(event.tenantId, event.type, event.payload);
        } else {
          outcome = await definition.run(config as never, { ...ctx, actionId: action.id });
        }
        await logActionRow({
          ...base,
          status: outcome.status,
          output_json: outcome.output === undefined ? null : JSON.stringify(outcome.output),
          error: null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failedActionIds.push(action.id);
        await logActionRow({ ...base, status: 'failed', output_json: null, error: message });
      }
    }
    return { failedActionIds };
  }

  async function finalizeRun(
    workflow: WorkflowRow,
    executionId: string,
    attempt: number,
    failedActionIds: string[],
    claimToken: string,
    runTime: string,
  ): Promise<void> {
    const now = clock() > runTime ? clock() : runTime;
    if (failedActionIds.length === 0) {
      const updated = await db
        .updateTable('workflows_executions')
        .set({
          status: 'succeeded',
          attempts: attempt,
          next_retry_at: null,
          failed_action_ids_json: null,
          finished_at: now,
          claim_token: null,
          claim_expires_at: null,
        })
        .where('tenant_id', '=', workflow.tenant_id)
        .where('id', '=', executionId)
        .where('claim_token', '=', claimToken)
        .where('status', '=', 'retrying')
        .executeTakeFirst();
      if (!updated.numUpdatedRows) return;
      await events.emit(workflow.tenant_id, 'workflows.execution.succeeded', {
        executionId,
        workflowId: workflow.id,
      });
      return;
    }
    if (attempt >= workflow.max_attempts) {
      const updated = await db
        .updateTable('workflows_executions')
        .set({
          status: 'failed',
          attempts: attempt,
          next_retry_at: null,
          failed_action_ids_json: JSON.stringify(failedActionIds),
          finished_at: now,
          claim_token: null,
          claim_expires_at: null,
        })
        .where('tenant_id', '=', workflow.tenant_id)
        .where('id', '=', executionId)
        .where('claim_token', '=', claimToken)
        .where('status', '=', 'retrying')
        .executeTakeFirst();
      if (!updated.numUpdatedRows) return;
      await events.emit(workflow.tenant_id, 'workflows.execution.failed', {
        executionId,
        workflowId: workflow.id,
        attempts: attempt,
      });
      return;
    }
    await db
      .updateTable('workflows_executions')
      .set({
        status: 'retrying',
        attempts: attempt,
        next_retry_at: backoffAt(now, attempt),
        failed_action_ids_json: JSON.stringify(failedActionIds),
        finished_at: null,
        claim_token: null,
        claim_expires_at: null,
      })
      .where('tenant_id', '=', workflow.tenant_id)
      .where('id', '=', executionId)
      .where('claim_token', '=', claimToken)
      .where('status', '=', 'retrying')
      .execute();
  }

  async function executeWorkflow(workflow: WorkflowRow, event: PlatformEvent): Promise<void> {
    const condition: WorkflowCondition | null = workflow.condition_json
      ? (JSON.parse(workflow.condition_json) as WorkflowCondition)
      : null;
    if (!evaluateCondition(condition, event.payload)) return;

    const existing = await db.selectFrom('workflows_executions').selectAll().where('tenant_id', '=', workflow.tenant_id)
      .where('workflow_id', '=', workflow.id).where('trigger_event_id', '=', event.id).executeTakeFirst();
    if (existing) return; // A new bus event ID is a new occurrence; replay retains the original ID.
    const actions = await db.selectFrom('workflows_workflow_actions').selectAll()
      .where('tenant_id', '=', workflow.tenant_id).where('workflow_id', '=', workflow.id)
      .orderBy('position').orderBy('id').execute();

    const now = clock();
    const execution: WorkflowExecutionRow = {
      id: id(),
      tenant_id: workflow.tenant_id,
      workflow_id: workflow.id,
      trigger_event: event.type,
      trigger_event_id: event.id,
      actions_snapshot_json: JSON.stringify({ actions, name: workflow.name }),
      retry_limit: workflow.max_attempts,
      claim_token: null,
      claim_expires_at: null,
      trigger_payload_json: JSON.stringify(event.payload ?? null),
      status: 'retrying', // provisional; finalizeRun sets the real status
      attempts: 0,
      next_retry_at: now,
      failed_action_ids_json: JSON.stringify(actions.map(action => action.id)),
      started_at: now,
      finished_at: null,
      created_at: now,
    };
    try { await db.insertInto('workflows_executions').values(execution).execute(); }
    catch (error) {
      const winner = await db.selectFrom('workflows_executions').select('id').where('tenant_id', '=', workflow.tenant_id)
        .where('workflow_id', '=', workflow.id).where('trigger_event_id', '=', event.id).executeTakeFirst();
      if (winner) return; throw error;
    }
    await retryExecution(execution);
  }

  async function handleEvent(event: PlatformEvent): Promise<void> {
    const workflows = await db
      .selectFrom('workflows_workflows')
      .selectAll()
      .where('tenant_id', '=', event.tenantId)
      .where('trigger_event', '=', event.type)
      .where('enabled', '=', 1)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    for (const workflow of workflows) {
      try {
        await executeWorkflow(workflow, event);
      } catch {
        // One broken workflow must never stop the others (failure isolation).
      }
    }
  }

  /** Returns true when the execution was processed (retried or closed out). */
  async function retryExecution(execution: WorkflowExecutionRow, claimTime = clock()): Promise<boolean> {
    const workflow = await db
      .selectFrom('workflows_workflows')
      .selectAll()
      .where('tenant_id', '=', execution.tenant_id)
      .where('id', '=', execution.workflow_id)
      .executeTakeFirst();
    if (!workflow) {
      // Workflow deleted since the failure — close the execution out.
      await db
        .updateTable('workflows_executions')
        .set({ status: 'failed', next_retry_at: null, finished_at: claimTime, claim_token: null, claim_expires_at: null })
        .where('tenant_id', '=', execution.tenant_id)
        .where('id', '=', execution.id)
        .execute();
      return true;
    }
    if (workflow.enabled !== 1) {
      // Disabled = paused: run NOTHING (no webhooks, no writes). The execution
      // stays 'retrying' and resumes on a later tick if the workflow is
      // re-enabled.
      return false;
    }
    const claimToken = id();
    const claim = await db.updateTable('workflows_executions').set({ claim_token: claimToken, claim_expires_at: leaseUntil(claimTime) })
      .where('tenant_id', '=', execution.tenant_id).where('id', '=', execution.id).where('status', '=', 'retrying')
      .where(eb => eb.or([eb('next_retry_at', 'is', null), eb('next_retry_at', '<=', claimTime)]))
      .where(eb => eb.or([eb('claim_token', 'is', null), eb('claim_expires_at', '<=', claimTime)]))
      .executeTakeFirst();
    if (!claim.numUpdatedRows) return false;
    // Reload after claiming: another worker may have completed an earlier
    // attempt between the sweep's read and this atomic claim.
    const claimed = await db.selectFrom('workflows_executions').selectAll().where('tenant_id', '=', execution.tenant_id)
      .where('id', '=', execution.id).where('claim_token', '=', claimToken).executeTakeFirstOrThrow();
    execution = claimed;
    workflow.max_attempts = execution.retry_limit ?? workflow.max_attempts;
    if (execution.attempts >= workflow.max_attempts) {
      await db.updateTable('workflows_executions').set({ status: 'failed', next_retry_at: null,
        claim_token: null, claim_expires_at: null, finished_at: clock() }).where('tenant_id', '=', execution.tenant_id)
        .where('id', '=', execution.id).where('claim_token', '=', claimToken).execute();
      return true;
    }
    const failedIds = new Set<string>(
      execution.failed_action_ids_json
        ? (JSON.parse(execution.failed_action_ids_json) as string[])
        : [],
    );
    const currentActions = await db
      .selectFrom('workflows_workflow_actions')
      .selectAll()
      .where('tenant_id', '=', execution.tenant_id)
      .where('workflow_id', '=', workflow.id)
      .orderBy('position')
      .orderBy('id')
      .execute();
    const snapshot = execution.actions_snapshot_json ? JSON.parse(execution.actions_snapshot_json) : null;
    const actions: WorkflowActionRow[] = snapshot ? Array.isArray(snapshot) ? snapshot : snapshot.actions : currentActions;
    if (snapshot && !Array.isArray(snapshot)) workflow.name = snapshot.name;
    const payload = JSON.parse(execution.trigger_payload_json) as unknown;
    const attempt = execution.attempts + 1;
    // Count the attempt before any action can commit. A process death after a
    // write must consume the retry budget even when header finalization is lost.
    await db.updateTable('workflows_executions').set({ attempts: attempt }).where('tenant_id', '=', execution.tenant_id)
      .where('id', '=', execution.id).where('claim_token', '=', claimToken).where('status', '=', 'retrying').execute();
    const report = await runActions(workflow, execution, actions, payload, attempt, failedIds.size ? failedIds : null, claimToken, claimTime);
    await finalizeRun(workflow, execution.id, attempt, report.failedActionIds, claimToken, claimTime);
    return true;
  }

  async function runPendingForTenant(tenantId: string, now: string): Promise<RunPendingResult> {
    const overdue = await markOverdueTasks(db, events, tenantId, now);

    const due = await db
      .selectFrom('workflows_executions')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'retrying')
      .where(eb => eb.or([eb('next_retry_at', 'is', null), eb('next_retry_at', '<=', now)]))
      .orderBy('next_retry_at')
      .orderBy('id')
      .execute();
    const retried: string[] = [];
    for (const execution of due) {
      try {
        if (await retryExecution(execution, now)) retried.push(execution.id);
      } catch {
        // Isolation: a broken retry must not stop the rest of the tick.
      }
    }
    return { retried, overdueTasks: overdue.map((t) => t.id) };
  }

  async function runPending(
    opts: { tenantId?: string; now?: string } = {},
  ): Promise<RunPendingResult> {
    const now = opts.now ?? clock();
    if (opts.tenantId) {
      return runPendingForTenant(opts.tenantId, now);
    }
    // System-wide sweep: iterate tenants via core so every module-table query
    // stays tenant-filtered (the tenancy iron rule has no exceptions).
    const tenants = await listTenants(asCoreDb(db));
    const combined: RunPendingResult = { retried: [], overdueTasks: [] };
    for (const tenant of tenants) {
      const result = await runPendingForTenant(tenant.id, now);
      combined.retried.push(...result.retried);
      combined.overdueTasks.push(...result.overdueTasks);
    }
    return combined;
  }

  function attach(): () => void {
    const unsubscribes = TRIGGER_EVENTS.map((type) =>
      events.on(type, (event) => handleEvent(event)),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }

  return { handleEvent, runPending, attach };
}

/**
 * Convenience for apps/api: build an engine and subscribe it to the bus.
 * Returns the engine plus a detach function.
 */
export function attachWorkflowEngine(
  deps: ModuleDeps<WorkflowsDatabase>,
  options: WorkflowEngineOptions = {},
): { engine: WorkflowEngine; detach: () => void } {
  const engine = createWorkflowEngine(deps, options);
  const detach = engine.attach();
  return { engine, detach };
}

/** The complete, fixed set of runnable action type keys. */
export const ACTION_REGISTRY_KEYS: readonly string[] = ACTION_TYPES;
