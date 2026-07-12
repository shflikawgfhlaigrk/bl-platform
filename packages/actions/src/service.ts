import type { Kysely, Transaction } from 'kysely';
import {
  ApiError,
  asCoreDb,
  audit,
  id,
  nowIso,
  type EventBus,
  type Pagination,
} from '@blacklabel/core';
import {
  ACTIVE_STATUSES,
  type Action,
  type ActionCommentRow,
  type ActionEscalationRow,
  type ActionKind,
  type ActionPriority,
  type ActionRow,
  type ActionStatus,
  type ActionsDatabase,
  type ResolutionKind,
} from './schema';

type Db = Kysely<ActionsDatabase>;
type Trx = Transaction<ActionsDatabase>;
type AnyDb = Db | Trx;

/* ------------------------------------------------------------------ *
 * Serialization helpers
 * ------------------------------------------------------------------ */

function toJsonText(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function fromJsonText(text: string | null): unknown | null {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Parse the JSON columns; column names stay snake_case (fleet convention). */
export function hydrateAction(row: ActionRow): Action {
  const { evidence, resolution_proof, ...rest } = row;
  return {
    ...rest,
    evidence: fromJsonText(evidence),
    resolution_proof: fromJsonText(resolution_proof),
  };
}

async function rowById(
  db: AnyDb,
  tenantId: string,
  actionId: string,
): Promise<ActionRow | undefined> {
  return db
    .selectFrom('actions_actions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', actionId)
    .executeTakeFirst();
}

async function requireRow(db: AnyDb, tenantId: string, actionId: string): Promise<ActionRow> {
  const row = await rowById(db, tenantId, actionId);
  if (!row) throw ApiError.notFound(`action "${actionId}" not found`);
  return row;
}

/* ------------------------------------------------------------------ *
 * open (create or dedupe-update)
 * ------------------------------------------------------------------ */

export interface OpenActionInput {
  kind: ActionKind;
  title: string;
  priority: ActionPriority;
  dedupeKey: string;
  body?: string | null;
  ownerUserId?: string | null;
  dueAt?: string | null;
  evidence?: unknown;
  deepLink?: string | null;
  sourceModule?: string | null;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
}

export interface OpenActionResult {
  action: Action;
  /** true when an existing active action was updated instead of a new one created. */
  deduped: boolean;
}

/**
 * Open an action. If an ACTIVE (non-resolved) action with the same dedupe_key
 * already exists for the tenant, its evidence + updated_at are refreshed and it
 * is returned flagged `deduped:true` (no second row, no duplicate event). A
 * previously *resolved* action with the same key never blocks a fresh one.
 */
export async function open(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  input: OpenActionInput,
): Promise<OpenActionResult> {
  if (!input.dedupeKey.trim()) throw ApiError.badRequest('dedupeKey is required');
  if (!input.title.trim()) throw ApiError.badRequest('title is required');

  const outcome = await db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('actions_actions')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('dedupe_key', '=', input.dedupeKey)
      .where('status', 'in', ACTIVE_STATUSES)
      .orderBy('created_at')
      .orderBy('id')
      .executeTakeFirst();

    if (existing) {
      const updatedAt = nowIso();
      await trx
        .updateTable('actions_actions')
        .set({ evidence: toJsonText(input.evidence), updated_at: updatedAt })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', existing.id)
        .execute();
      await audit(
        asCoreDb(trx),
        tenantId,
        actor,
        'actions.action.deduped',
        'actions.action',
        existing.id,
        { dedupeKey: input.dedupeKey },
      );
      const refreshed = await requireRow(trx, tenantId, existing.id);
      return { row: refreshed, deduped: true };
    }

    const now = nowIso();
    const row: ActionRow = {
      id: id(),
      tenant_id: tenantId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      owner_user_id: input.ownerUserId ?? null,
      priority: input.priority,
      due_at: input.dueAt ?? null,
      evidence: toJsonText(input.evidence),
      deep_link: input.deepLink ?? null,
      status: 'open',
      snoozed_until: null,
      snooze_reason: null,
      source_module: input.sourceModule ?? null,
      source_entity_type: input.sourceEntityType ?? null,
      source_entity_id: input.sourceEntityId ?? null,
      dedupe_key: input.dedupeKey,
      resolution_kind: null,
      resolution_proof: null,
      resolved_at: null,
      created_at: now,
      updated_at: now,
    };
    await trx.insertInto('actions_actions').values(row).execute();
    await audit(
      asCoreDb(trx),
      tenantId,
      actor,
      'actions.action.created',
      'actions.action',
      row.id,
      { kind: row.kind, priority: row.priority, dedupeKey: row.dedupe_key },
    );
    return { row, deduped: false };
  });

  if (!outcome.deduped) {
    await events.emit(tenantId, 'actions.action.created', {
      v: 1,
      actionId: outcome.row.id,
      kind: outcome.row.kind,
    });
  }

  return { action: hydrateAction(outcome.row), deduped: outcome.deduped };
}

/* ------------------------------------------------------------------ *
 * resolve
 * ------------------------------------------------------------------ */

export interface ResolveInput {
  kind: ResolutionKind;
  proof?: unknown;
}

async function markResolved(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  row: ActionRow,
  input: ResolveInput,
): Promise<Action> {
  const now = nowIso();
  await db
    .updateTable('actions_actions')
    .set({
      status: 'resolved',
      resolution_kind: input.kind,
      resolution_proof: toJsonText(input.proof),
      resolved_at: now,
      snoozed_until: null,
      updated_at: now,
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', row.id)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'actions.action.resolved', 'actions.action', row.id, {
    resolutionKind: input.kind,
  });
  await events.emit(tenantId, 'actions.action.resolved', { v: 1, actionId: row.id });
  return hydrateAction(await requireRow(db, tenantId, row.id));
}

/** Manually/explicitly resolve a single action by id. */
export async function resolve(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  actionId: string,
  input: ResolveInput,
): Promise<Action> {
  const row = await requireRow(db, tenantId, actionId);
  if (row.status === 'resolved') return hydrateAction(row);
  return markResolved(db, events, tenantId, actor, row, input);
}

/**
 * Event-driven resolution: resolve the (single) ACTIVE action with this
 * dedupe_key, if one exists. No-op (returns undefined) when nothing is open —
 * so replayed/duplicate events are safe.
 */
export async function autoResolveByDedupeKey(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  dedupeKey: string,
  proof?: unknown,
): Promise<Action | undefined> {
  const row = await db
    .selectFrom('actions_actions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('dedupe_key', '=', dedupeKey)
    .where('status', 'in', ACTIVE_STATUSES)
    .orderBy('created_at')
    .orderBy('id')
    .executeTakeFirst();
  if (!row) return undefined;
  return markResolved(db, events, tenantId, actor, row, { kind: 'auto', proof });
}

/* ------------------------------------------------------------------ *
 * snooze / unsnooze / wake
 * ------------------------------------------------------------------ */

export async function snooze(
  db: Db,
  tenantId: string,
  actor: string,
  actionId: string,
  until: string,
  reason: string,
): Promise<Action> {
  if (!until.trim()) throw ApiError.badRequest('snooze "until" is required');
  if (!reason.trim()) throw ApiError.badRequest('snooze reason is required');
  const row = await requireRow(db, tenantId, actionId);
  if (row.status === 'resolved') throw ApiError.conflict('cannot snooze a resolved action');
  const now = nowIso();
  await db
    .updateTable('actions_actions')
    .set({ status: 'snoozed', snoozed_until: until, snooze_reason: reason, updated_at: now })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', actionId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'actions.action.snoozed', 'actions.action', actionId, {
    until,
    reason,
  });
  return hydrateAction(await requireRow(db, tenantId, actionId));
}

export async function unsnooze(
  db: Db,
  tenantId: string,
  actor: string,
  actionId: string,
): Promise<Action> {
  const row = await requireRow(db, tenantId, actionId);
  if (row.status !== 'snoozed') throw ApiError.conflict('action is not snoozed');
  const now = nowIso();
  await db
    .updateTable('actions_actions')
    .set({ status: 'open', snoozed_until: null, snooze_reason: null, updated_at: now })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', actionId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'actions.action.unsnoozed', 'actions.action', actionId);
  return hydrateAction(await requireRow(db, tenantId, actionId));
}

/**
 * Wake every snoozed action whose snoozed_until is <= now back to open.
 * Returns the woken actions (deterministic order). Idempotent: re-running with
 * no newly-due snoozes wakes nothing.
 */
export async function wakeDueSnoozes(
  db: Db,
  tenantId: string,
  actor: string,
  now: string,
): Promise<Action[]> {
  const due = await db
    .selectFrom('actions_actions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'snoozed')
    .where('snoozed_until', 'is not', null)
    .where('snoozed_until', '<=', now)
    .orderBy('snoozed_until')
    .orderBy('id')
    .execute();

  const woken: Action[] = [];
  for (const row of due) {
    const ts = nowIso();
    await db
      .updateTable('actions_actions')
      .set({ status: 'open', snoozed_until: null, snooze_reason: null, updated_at: ts })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', row.id)
      .execute();
    await audit(asCoreDb(db), tenantId, actor, 'actions.action.woke', 'actions.action', row.id);
    woken.push(hydrateAction(await requireRow(db, tenantId, row.id)));
  }
  return woken;
}

/* ------------------------------------------------------------------ *
 * escalate / assign / comment
 * ------------------------------------------------------------------ */

export async function escalate(
  db: Db,
  tenantId: string,
  actor: string,
  actionId: string,
  toPriority: ActionPriority,
  reason: string,
): Promise<Action> {
  if (!reason.trim()) throw ApiError.badRequest('escalation reason is required');
  const row = await requireRow(db, tenantId, actionId);
  if (row.status === 'resolved') throw ApiError.conflict('cannot escalate a resolved action');
  const now = nowIso();
  const escalation: ActionEscalationRow = {
    id: id(),
    tenant_id: tenantId,
    action_id: actionId,
    from_priority: row.priority,
    to_priority: toPriority,
    reason,
    created_at: now,
  };
  await db.insertInto('actions_escalations').values(escalation).execute();
  await db
    .updateTable('actions_actions')
    .set({ priority: toPriority, status: 'escalated', updated_at: now })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', actionId)
    .execute();
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'actions.action.escalated',
    'actions.action',
    actionId,
    { from: row.priority, to: toPriority, reason },
  );
  return hydrateAction(await requireRow(db, tenantId, actionId));
}

export async function assign(
  db: Db,
  tenantId: string,
  actor: string,
  actionId: string,
  ownerUserId: string,
): Promise<Action> {
  await requireRow(db, tenantId, actionId);
  const now = nowIso();
  await db
    .updateTable('actions_actions')
    .set({ owner_user_id: ownerUserId, updated_at: now })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', actionId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'actions.action.assigned', 'actions.action', actionId, {
    ownerUserId,
  });
  return hydrateAction(await requireRow(db, tenantId, actionId));
}

export async function addComment(
  db: Db,
  tenantId: string,
  actor: string,
  actionId: string,
  author: string,
  body: string,
): Promise<ActionCommentRow> {
  if (!body.trim()) throw ApiError.badRequest('comment body is required');
  await requireRow(db, tenantId, actionId);
  const now = nowIso();
  const comment: ActionCommentRow = {
    id: id(),
    tenant_id: tenantId,
    action_id: actionId,
    author,
    body,
    created_at: now,
  };
  await db.insertInto('actions_comments').values(comment).execute();
  await db
    .updateTable('actions_actions')
    .set({ updated_at: now })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', actionId)
    .execute();
  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'actions.comment.created',
    'actions.comment',
    comment.id,
    { actionId },
  );
  return comment;
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

export interface QueueFilters {
  status?: ActionStatus;
  kind?: ActionKind;
  priority?: ActionPriority;
  ownerUserId?: string;
}

/** The action queue, ordered by (priority, due_at, created_at, id). Default = active only. */
export async function listQueue(
  db: Db,
  tenantId: string,
  filters: QueueFilters = {},
  page: Pagination = { limit: 50, offset: 0 },
): Promise<Action[]> {
  let q = db.selectFrom('actions_actions').selectAll().where('tenant_id', '=', tenantId);
  if (filters.status) {
    q = q.where('status', '=', filters.status);
  } else {
    q = q.where('status', 'in', ACTIVE_STATUSES);
  }
  if (filters.kind) q = q.where('kind', '=', filters.kind);
  if (filters.priority) q = q.where('priority', '=', filters.priority);
  if (filters.ownerUserId) q = q.where('owner_user_id', '=', filters.ownerUserId);
  const rows = await q
    .orderBy('priority')
    .orderBy('due_at')
    .orderBy('created_at')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
  return rows.map(hydrateAction);
}

export async function listByKind(
  db: Db,
  tenantId: string,
  kind: ActionKind,
  page: Pagination = { limit: 50, offset: 0 },
): Promise<Action[]> {
  return listQueue(db, tenantId, { kind }, page);
}

export async function listBySourceEntity(
  db: Db,
  tenantId: string,
  sourceEntityType: string,
  sourceEntityId: string,
  page: Pagination = { limit: 50, offset: 0 },
): Promise<Action[]> {
  const rows = await db
    .selectFrom('actions_actions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('source_entity_type', '=', sourceEntityType)
    .where('source_entity_id', '=', sourceEntityId)
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
  return rows.map(hydrateAction);
}

/** Active actions past their due date (deterministic queue order). */
export async function listOverdue(
  db: Db,
  tenantId: string,
  now: string,
  page: Pagination = { limit: 50, offset: 0 },
): Promise<Action[]> {
  const rows = await db
    .selectFrom('actions_actions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('status', 'in', ACTIVE_STATUSES)
    .where('due_at', 'is not', null)
    .where('due_at', '<', now)
    .orderBy('priority')
    .orderBy('due_at')
    .orderBy('created_at')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
  return rows.map(hydrateAction);
}

export interface CountsSummary {
  total: number;
  byKind: Record<string, number>;
  byPriority: Record<string, number>;
}

/** Active-action counts for the home screen (grouped by kind and by priority). */
export async function countsSummary(db: Db, tenantId: string): Promise<CountsSummary> {
  const byKindRows = await db
    .selectFrom('actions_actions')
    .select((eb) => ['kind', eb.fn.countAll<number>().as('n')])
    .where('tenant_id', '=', tenantId)
    .where('status', 'in', ACTIVE_STATUSES)
    .groupBy('kind')
    .orderBy('kind')
    .execute();
  const byPriorityRows = await db
    .selectFrom('actions_actions')
    .select((eb) => ['priority', eb.fn.countAll<number>().as('n')])
    .where('tenant_id', '=', tenantId)
    .where('status', 'in', ACTIVE_STATUSES)
    .groupBy('priority')
    .orderBy('priority')
    .execute();

  const byKind: Record<string, number> = {};
  let total = 0;
  for (const r of byKindRows) {
    const n = Number(r.n);
    byKind[r.kind] = n;
    total += n;
  }
  const byPriority: Record<string, number> = {};
  for (const r of byPriorityRows) byPriority[r.priority] = Number(r.n);
  return { total, byKind, byPriority };
}

export interface ActionDetail {
  action: Action;
  comments: ActionCommentRow[];
  escalations: ActionEscalationRow[];
}

export async function getAction(
  db: Db,
  tenantId: string,
  actionId: string,
): Promise<ActionDetail> {
  const row = await requireRow(db, tenantId, actionId);
  const comments = await db
    .selectFrom('actions_comments')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('action_id', '=', actionId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const escalations = await db
    .selectFrom('actions_escalations')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('action_id', '=', actionId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return { action: hydrateAction(row), comments, escalations };
}
