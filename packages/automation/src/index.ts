/**
 * @blacklabel/automation — the outbox + rules spine for Mags Commerce OS.
 *
 * - Transactional OUTBOX: idempotent enqueue, deterministic exponential backoff,
 *   dead letters, replay, cancel. A DispatcherRegistry + runOnce() drains due
 *   rows through integrator-registered handlers (no timers/cron in the module).
 * - Typed automation RULES as versioned data: trigger event + conditions +
 *   action template + policy (automatic | approval_required | disabled) +
 *   schedule window + idempotency window. evaluate() records every outcome to
 *   an append-only execution history and honors dry-run (no side effects).
 * - Event schema REGISTRY (Zod) for every canonical CONTRACTS-MAGS §2 event.
 *
 * Internal events emitted (3-segment, module.entity.verb):
 *   - automation.outbox.enqueued    { v, outboxId, kind }
 *   - automation.outbox.dead        { v, outboxId, attempts }
 *   - automation.approval.requested { v, approvalId, ruleKey }
 *   - automation.approval.held      { v, approvalId, reason }
 *
 * Integrator wiring:
 *   - Call registerAutomationSubscriptions({ db, events, contracts }) once so
 *     real domain events drive evaluate(). It ignores 'automation.*' events to
 *     avoid feedback loops.
 *   - Build a DispatcherRegistry, register a handler per action_kind your rules
 *     use, and pass it to automationRouter(deps, registry) (enables
 *     POST /outbox/run-once) — or mount automationDispatcherRouter(deps, registry).
 *     The module ships NO handlers (no network in module code).
 */

import type { EventBus, ModuleDeps } from '@blacklabel/core';
import type { AutomationDatabase } from './schema';
import { RulesService } from './rules';

export { automationMigrations } from './migrations';
export { automationRouter, automationDispatcherRouter } from './router';

export {
  OutboxService,
  OutboxLeaseLostError,
  DEFAULT_OUTBOX_LEASE_SECONDS,
} from './outbox';
export type {
  EnqueueInput,
  EnqueueResult,
  OutboxLease,
  ClaimDueOptions,
  ClaimDueResult,
} from './outbox';

export { RulesService } from './rules';
export type {
  CreateRuleInput,
  UpdateRuleInput,
  EvaluateOptions,
  EvaluatePreview,
} from './rules';

export { DispatcherRegistry, runOnce } from './dispatcher';
export type {
  OutboxJob,
  OutboxHandler,
  RunOnceResult,
  RunOnceOptions,
} from './dispatcher';

export {
  backoffSeconds,
  BASE_BACKOFF_SECONDS,
  BACKOFF_FACTOR,
  MAX_BACKOFF_SECONDS,
} from './backoff';

export { evaluateCondition, evaluateConditions, getPath } from './conditions';
export { renderTemplate, stableStringify } from './template';
export { isWithinSchedule } from './schedule';
export {
  eventSchemas,
  validateEvent,
  KNOWN_MAGS_EVENTS,
} from './events-registry';
export type { ValidateEventResult } from './events-registry';

export type {
  AutomationDatabase,
  AutomationOutboxRow,
  AutomationRuleRow,
  AutomationExecutionRow,
  AutomationApprovalRow,
  OutboxStatus,
  RulePolicy,
  ConditionOp,
  ExecutionOutcome,
  ApprovalStatus,
  RuleCondition,
  RuleSchedule,
  RuleScheduleWindow,
} from './schema';

/**
 * Subscribe automation to the platform event stream. Every real domain event
 * (not automation's own) drives RulesService.evaluate for its tenant. Returns
 * the unsubscribe function. Handler failures are isolated by the EventBus.
 */
export function registerAutomationSubscriptions(deps: ModuleDeps<AutomationDatabase>): () => void {
  const rules = new RulesService(deps.db, deps.events);
  const events: EventBus = deps.events;
  return events.on('*', async (event) => {
    // Never react to our own internal events — avoids feedback loops.
    if (event.type.startsWith('automation.')) return;
    await rules.evaluate(event.tenantId, event.type, event.payload, { dryRun: false });
  });
}
