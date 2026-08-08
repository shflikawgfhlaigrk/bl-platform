import type { Kysely } from 'kysely';
import {
  ApiError,
  asCoreDb,
  audit,
  id,
  nowIso,
  type EventBus,
  type Pagination,
} from '@blacklabel/core';
import { DateTime } from 'luxon';
import type {
  AutomationApprovalRow,
  AutomationDatabase,
  AutomationExecutionRow,
  AutomationRuleRow,
  ExecutionOutcome,
  RuleCondition,
  RulePolicy,
  RuleSchedule,
} from './schema';
import { evaluateConditions } from './conditions';
import { isWithinSchedule } from './schedule';
import { renderTemplate, stableStringify } from './template';
import { validateEvent } from './events-registry';
import { OutboxService } from './outbox';

type Db = Kysely<AutomationDatabase>;

/* --------------------------- Input shapes ------------------------------ */

export interface CreateRuleInput {
  name: string;
  triggerEvent: string;
  conditions?: RuleCondition[];
  actionKind: string;
  actionTemplate?: unknown;
  policy: RulePolicy;
  schedule?: RuleSchedule | null;
  idempotencyWindowSeconds?: number;
  enabled?: boolean;
}

export type UpdateRuleInput = Partial<CreateRuleInput>;

export interface EvaluateOptions {
  dryRun?: boolean;
  /** Override the evaluation instant (ISO UTC); defaults to nowIso(). */
  now?: string;
  actor?: string;
}

export interface EvaluatePreview {
  ruleId: string;
  ruleKey: string;
  ruleVersion: number;
  matched: boolean;
  outcome: ExecutionOutcome;
  outboxId: string | null;
  /** Rendered action payload when the rule matched (preview for dry-run). */
  renderedPayload: unknown;
  executionId: string;
}

/* ------------------------ Row (de)serialization ------------------------ */

function parseConditions(row: AutomationRuleRow): RuleCondition[] {
  try {
    const v = JSON.parse(row.conditions);
    return Array.isArray(v) ? (v as RuleCondition[]) : [];
  } catch {
    return [];
  }
}

function parseSchedule(row: AutomationRuleRow): RuleSchedule | null {
  if (!row.schedule) return null;
  try {
    return JSON.parse(row.schedule) as RuleSchedule;
  } catch {
    return null;
  }
}

/* ------------------------------ Service -------------------------------- */

export class RulesService {
  private readonly outbox: OutboxService;

  constructor(
    private readonly db: Db,
    private readonly events?: EventBus,
  ) {
    this.outbox = new OutboxService(db, events);
  }

  /* ---- CRUD (edits append a new version row) ---- */

  async create(tenantId: string, input: CreateRuleInput, actor = 'system'): Promise<AutomationRuleRow> {
    this.validateInput(input);
    const now = nowIso();
    const row: AutomationRuleRow = {
      id: id(),
      tenant_id: tenantId,
      rule_key: id(),
      name: input.name,
      version: 1,
      trigger_event: input.triggerEvent,
      conditions: JSON.stringify(input.conditions ?? []),
      action_kind: input.actionKind,
      action_template: JSON.stringify(input.actionTemplate ?? {}),
      policy: input.policy,
      schedule: input.schedule ? JSON.stringify(input.schedule) : null,
      idempotency_window_seconds: input.idempotencyWindowSeconds ?? 0,
      enabled: input.enabled === false ? 0 : 1,
      created_at: now,
      updated_at: now,
    };
    await this.db.insertInto('automation_rules').values(row).execute();
    await audit(asCoreDb(this.db), tenantId, actor, 'automation.rule.created', 'automation.rule', row.rule_key, {
      version: 1,
      trigger_event: row.trigger_event,
      policy: row.policy,
    });
    return row;
  }

  /** Append a new version merging `patch` over the current version. */
  async update(
    tenantId: string,
    ruleKey: string,
    patch: UpdateRuleInput,
    actor = 'system',
  ): Promise<AutomationRuleRow> {
    const current = await this.getCurrent(tenantId, ruleKey);
    if (!current) throw ApiError.notFound(`rule "${ruleKey}" not found`);
    const merged: CreateRuleInput = {
      name: patch.name ?? current.name,
      triggerEvent: patch.triggerEvent ?? current.trigger_event,
      conditions: patch.conditions ?? parseConditions(current),
      actionKind: patch.actionKind ?? current.action_kind,
      actionTemplate:
        patch.actionTemplate ?? JSON.parse(current.action_template),
      policy: patch.policy ?? current.policy,
      schedule: patch.schedule !== undefined ? patch.schedule : parseSchedule(current),
      idempotencyWindowSeconds:
        patch.idempotencyWindowSeconds ?? current.idempotency_window_seconds,
      enabled: patch.enabled !== undefined ? patch.enabled : current.enabled === 1,
    };
    this.validateInput(merged);
    const now = nowIso();
    const row: AutomationRuleRow = {
      id: id(),
      tenant_id: tenantId,
      rule_key: ruleKey,
      name: merged.name,
      version: current.version + 1,
      trigger_event: merged.triggerEvent,
      conditions: JSON.stringify(merged.conditions ?? []),
      action_kind: merged.actionKind,
      action_template: JSON.stringify(merged.actionTemplate ?? {}),
      policy: merged.policy,
      schedule: merged.schedule ? JSON.stringify(merged.schedule) : null,
      idempotency_window_seconds: merged.idempotencyWindowSeconds ?? 0,
      enabled: merged.enabled === false ? 0 : 1,
      created_at: now,
      updated_at: now,
    };
    await this.db.insertInto('automation_rules').values(row).execute();
    await audit(asCoreDb(this.db), tenantId, actor, 'automation.rule.updated', 'automation.rule', ruleKey, {
      version: row.version,
    });
    return row;
  }

  /** Soft-delete = append a disabled version (history preserved, never fires). */
  async disable(tenantId: string, ruleKey: string, actor = 'system'): Promise<AutomationRuleRow> {
    return this.update(tenantId, ruleKey, { enabled: false, policy: 'disabled' }, actor);
  }

  /** Current (highest-version) row for a rule_key. */
  async getCurrent(tenantId: string, ruleKey: string): Promise<AutomationRuleRow | undefined> {
    return this.db
      .selectFrom('automation_rules')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('rule_key', '=', ruleKey)
      .orderBy('version', 'desc')
      .orderBy('id')
      .limit(1)
      .executeTakeFirst();
  }

  /** All versions of a rule, oldest first. */
  async listVersions(tenantId: string, ruleKey: string): Promise<AutomationRuleRow[]> {
    return this.db
      .selectFrom('automation_rules')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('rule_key', '=', ruleKey)
      .orderBy('version')
      .orderBy('id')
      .execute();
  }

  /** Current version of every rule (one row per rule_key). */
  async listCurrent(
    tenantId: string,
    page: Pagination = { limit: 50, offset: 0 },
  ): Promise<AutomationRuleRow[]> {
    const rows = await this.db
      .selectFrom('automation_rules')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where((eb) =>
        eb(
          'version',
          '=',
          eb
            .selectFrom('automation_rules as r2')
            .select((e2) => e2.fn.max('r2.version').as('m'))
            .whereRef('r2.tenant_id', '=', 'automation_rules.tenant_id')
            .whereRef('r2.rule_key', '=', 'automation_rules.rule_key'),
        ),
      )
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .limit(page.limit)
      .offset(page.offset)
      .execute();
    return rows;
  }

  /* ---- Evaluate ---- */

  /**
   * Evaluate every current-version rule whose trigger_event matches the event.
   * For each rule, in order: validate payload → disabled gate → conditions →
   * schedule window → idempotency window → policy (automatic enqueues; approval
   * creates an approval row; disabled records a skip). Every outcome is recorded
   * in automation_executions. Dry-run records outcomes and returns previews but
   * performs NO side effects (no outbox, no approval, no audit).
   */
  async evaluate(
    tenantId: string,
    eventType: string,
    payload: unknown,
    opts: EvaluateOptions = {},
  ): Promise<EvaluatePreview[]> {
    const now = opts.now ?? nowIso();
    const dryRun = opts.dryRun === true;
    const actor = opts.actor ?? 'system';

    const rules = await this.matchingRules(tenantId, eventType);
    const validation = validateEvent(eventType, payload);
    const previews: EvaluatePreview[] = [];

    for (const rule of rules) {
      const record = async (
        outcome: ExecutionOutcome,
        matched: boolean,
        outboxId: string | null,
        dedupeKey: string | null,
        renderedPayload: unknown,
      ): Promise<void> => {
        const exec = await this.recordExecution(
          tenantId,
          rule,
          eventType,
          payload,
          matched,
          outcome,
          outboxId,
          dedupeKey,
        );
        previews.push({
          ruleId: rule.id,
          ruleKey: rule.rule_key,
          ruleVersion: rule.version,
          matched,
          outcome,
          outboxId,
          renderedPayload,
          executionId: exec.id,
        });
      };

      // 1. Payload validation.
      if (!validation.ok) {
        await record('invalid_event', false, null, null, null);
        continue;
      }
      // 2. Disabled gate.
      if (rule.enabled === 0 || rule.policy === 'disabled') {
        await record('skipped_disabled', false, null, null, null);
        continue;
      }
      // 3. Conditions.
      const conditions = parseConditions(rule);
      if (!evaluateConditions(payload, conditions)) {
        await record('skipped_condition', false, null, null, null);
        continue;
      }
      // Matched from here on.
      const rendered = renderTemplate(JSON.parse(rule.action_template), payload);
      const dedupeKey = `${rule.rule_key}:${stableStringify(rendered)}`;

      // 4. Schedule window.
      const schedule = parseSchedule(rule);
      if (schedule && !isWithinSchedule(schedule, now)) {
        await record('skipped_window', true, null, dedupeKey, rendered);
        continue;
      }
      // 5. Idempotency window (skipped for dry-run — no real effect to dedup).
      if (!dryRun && rule.idempotency_window_seconds > 0) {
        const duplicate = await this.recentDedup(
          tenantId,
          dedupeKey,
          rule.idempotency_window_seconds,
          now,
        );
        if (duplicate) {
          await record('skipped_idempotent', true, null, dedupeKey, rendered);
          continue;
        }
      }
      // 6. Dry-run stops here — record intent, no side effect.
      if (dryRun) {
        await record('dry_run', true, null, dedupeKey, rendered);
        continue;
      }
      // 7. Policy side effects.
      if (rule.policy === 'automatic') {
        const { row } = await this.outbox.enqueue(
          tenantId,
          { kind: rule.action_kind, payload: rendered, idempotencyKey: dedupeKey },
          actor,
        );
        await record('enqueued', true, row.id, dedupeKey, rendered);
      } else {
        // approval_required
        const exec = await this.recordExecution(
          tenantId,
          rule,
          eventType,
          payload,
          true,
          'pending_approval',
          null,
          dedupeKey,
        );
        const approval = await this.createApproval(tenantId, rule, exec.id, dedupeKey, rendered, actor);
        previews.push({
          ruleId: rule.id,
          ruleKey: rule.rule_key,
          ruleVersion: rule.version,
          matched: true,
          outcome: 'pending_approval',
          outboxId: null,
          renderedPayload: rendered,
          executionId: exec.id,
        });
        void approval;
      }
    }
    return previews;
  }

  /* ---- Executions history ---- */

  async listExecutions(
    tenantId: string,
    filters: { ruleId?: string; eventType?: string; outcome?: string } = {},
    page: Pagination = { limit: 50, offset: 0 },
  ): Promise<AutomationExecutionRow[]> {
    let q = this.db
      .selectFrom('automation_executions')
      .selectAll()
      .where('tenant_id', '=', tenantId);
    if (filters.ruleId) q = q.where('rule_id', '=', filters.ruleId);
    if (filters.eventType) q = q.where('event_type', '=', filters.eventType);
    if (filters.outcome) q = q.where('outcome', '=', filters.outcome as ExecutionOutcome);
    return q
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .limit(page.limit)
      .offset(page.offset)
      .execute();
  }

  /* ---- Approvals ---- */

  async listApprovals(
    tenantId: string,
    filters: { status?: string } = {},
    page: Pagination = { limit: 50, offset: 0 },
  ): Promise<AutomationApprovalRow[]> {
    let q = this.db
      .selectFrom('automation_approvals')
      .selectAll()
      .where('tenant_id', '=', tenantId);
    if (filters.status) q = q.where('status', '=', filters.status as AutomationApprovalRow['status']);
    return q
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .limit(page.limit)
      .offset(page.offset)
      .execute();
  }

  async getApproval(tenantId: string, approvalId: string): Promise<AutomationApprovalRow | undefined> {
    return this.db
      .selectFrom('automation_approvals')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', approvalId)
      .executeTakeFirst();
  }

  /** Approve a pending or held approval → enqueue its effect to the outbox. */
  async approve(tenantId: string, approvalId: string, actor = 'system'): Promise<AutomationApprovalRow> {
    const approval = await this.requireApproval(tenantId, approvalId);
    if (approval.status !== 'pending' && approval.status !== 'held') {
      throw ApiError.conflict(`approval "${approvalId}" is already ${approval.status}`);
    }
    const { row } = await this.outbox.enqueue(
      tenantId,
      {
        kind: approval.action_kind,
        payload: JSON.parse(approval.action_payload),
        idempotencyKey: approval.idempotency_key,
      },
      actor,
    );
    const now = nowIso();
    await this.db
      .updateTable('automation_approvals')
      .set({ status: 'approved', outbox_id: row.id, decided_by: actor, decided_at: now, updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', approvalId)
      .execute();
    await audit(asCoreDb(this.db), tenantId, actor, 'automation.approval.approved', 'automation.approval', approvalId, {
      outbox_id: row.id,
    });
    return this.requireApproval(tenantId, approvalId);
  }

  /** Put a pending or held approval on hold with a durable reason. */
  async hold(
    tenantId: string,
    approvalId: string,
    reason: string,
    actor = 'system',
  ): Promise<AutomationApprovalRow> {
    const normalizedReason = reason.trim();
    if (!normalizedReason) throw ApiError.badRequest('hold reason is required');

    const approval = await this.requireApproval(tenantId, approvalId);
    if (approval.status === 'approved' || approval.status === 'rejected') {
      throw ApiError.conflict(`approval "${approvalId}" is already ${approval.status}`);
    }

    const now = nowIso();
    await this.db
      .updateTable('automation_approvals')
      .set({ status: 'held', reason: normalizedReason, updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', approvalId)
      .execute();
    await audit(asCoreDb(this.db), tenantId, actor, 'automation.approval.held', 'automation.approval', approvalId, {
      reason: normalizedReason,
      previous_reason: approval.reason,
      previous_status: approval.status,
    });
    if (this.events) {
      await this.events.emit(tenantId, 'automation.approval.held', {
        v: 1,
        approvalId,
        reason: normalizedReason,
      });
    }
    return this.requireApproval(tenantId, approvalId);
  }

  /** Reject a pending or held approval with a reason (no effect is enqueued). */
  async reject(
    tenantId: string,
    approvalId: string,
    reason: string,
    actor = 'system',
  ): Promise<AutomationApprovalRow> {
    const approval = await this.requireApproval(tenantId, approvalId);
    if (approval.status !== 'pending' && approval.status !== 'held') {
      throw ApiError.conflict(`approval "${approvalId}" is already ${approval.status}`);
    }
    const now = nowIso();
    await this.db
      .updateTable('automation_approvals')
      .set({ status: 'rejected', reason, decided_by: actor, decided_at: now, updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', approvalId)
      .execute();
    await audit(asCoreDb(this.db), tenantId, actor, 'automation.approval.rejected', 'automation.approval', approvalId, {
      reason,
    });
    return this.requireApproval(tenantId, approvalId);
  }

  /* ---- internals ---- */

  private async matchingRules(tenantId: string, eventType: string): Promise<AutomationRuleRow[]> {
    return this.db
      .selectFrom('automation_rules')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('trigger_event', '=', eventType)
      .where((eb) =>
        eb(
          'version',
          '=',
          eb
            .selectFrom('automation_rules as r2')
            .select((e2) => e2.fn.max('r2.version').as('m'))
            .whereRef('r2.tenant_id', '=', 'automation_rules.tenant_id')
            .whereRef('r2.rule_key', '=', 'automation_rules.rule_key'),
        ),
      )
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  private async recentDedup(
    tenantId: string,
    dedupeKey: string,
    windowSeconds: number,
    now: string,
  ): Promise<boolean> {
    const since = DateTime.fromISO(now, { zone: 'utc' })
      .minus({ seconds: windowSeconds })
      .toUTC()
      .toISO()!;
    const hit = await this.db
      .selectFrom('automation_executions')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('dedupe_key', '=', dedupeKey)
      .where('outcome', 'in', ['enqueued', 'pending_approval'])
      .where('created_at', '>=', since)
      .limit(1)
      .executeTakeFirst();
    return hit !== undefined;
  }

  private async recordExecution(
    tenantId: string,
    rule: AutomationRuleRow,
    eventType: string,
    payload: unknown,
    matched: boolean,
    outcome: ExecutionOutcome,
    outboxId: string | null,
    dedupeKey: string | null,
  ): Promise<AutomationExecutionRow> {
    const row: AutomationExecutionRow = {
      id: id(),
      tenant_id: tenantId,
      rule_id: rule.id,
      rule_version: rule.version,
      event_type: eventType,
      event_payload: JSON.stringify(payload ?? null),
      matched: matched ? 1 : 0,
      outcome,
      outbox_id: outboxId,
      dedupe_key: dedupeKey,
      created_at: nowIso(),
    };
    await this.db.insertInto('automation_executions').values(row).execute();
    return row;
  }

  private async createApproval(
    tenantId: string,
    rule: AutomationRuleRow,
    executionId: string,
    idempotencyKey: string,
    rendered: unknown,
    actor: string,
  ): Promise<AutomationApprovalRow> {
    const now = nowIso();
    const row: AutomationApprovalRow = {
      id: id(),
      tenant_id: tenantId,
      rule_id: rule.id,
      rule_version: rule.version,
      execution_id: executionId,
      action_kind: rule.action_kind,
      action_payload: JSON.stringify(rendered ?? null),
      idempotency_key: idempotencyKey,
      status: 'pending',
      reason: null,
      outbox_id: null,
      decided_by: null,
      decided_at: null,
      created_at: now,
      updated_at: now,
    };
    await this.db.insertInto('automation_approvals').values(row).execute();
    await audit(asCoreDb(this.db), tenantId, actor, 'automation.approval.requested', 'automation.approval', row.id, {
      rule_key: rule.rule_key,
      action_kind: rule.action_kind,
    });
    if (this.events) {
      await this.events.emit(tenantId, 'automation.approval.requested', {
        v: 1,
        approvalId: row.id,
        ruleKey: rule.rule_key,
      });
    }
    return row;
  }

  private async requireApproval(tenantId: string, approvalId: string): Promise<AutomationApprovalRow> {
    const row = await this.getApproval(tenantId, approvalId);
    if (!row) throw ApiError.notFound(`approval "${approvalId}" not found`);
    return row;
  }

  private validateInput(input: CreateRuleInput): void {
    if (!input.name?.trim()) throw ApiError.badRequest('rule name is required');
    if (!input.triggerEvent?.trim()) throw ApiError.badRequest('triggerEvent is required');
    if (!input.actionKind?.trim()) throw ApiError.badRequest('actionKind is required');
    const policies: RulePolicy[] = ['automatic', 'approval_required', 'disabled'];
    if (!policies.includes(input.policy)) {
      throw ApiError.badRequest(`invalid policy "${input.policy}"`);
    }
    if (
      input.idempotencyWindowSeconds !== undefined &&
      (input.idempotencyWindowSeconds < 0 || !Number.isInteger(input.idempotencyWindowSeconds))
    ) {
      throw ApiError.badRequest('idempotencyWindowSeconds must be a non-negative integer');
    }
  }
}
