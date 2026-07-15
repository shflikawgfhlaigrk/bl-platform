import type { CoreDatabase } from '@blacklabel/core';

/**
 * Automation module schema — the outbox + rules spine for Mags Commerce OS.
 *
 * Three moving parts:
 *   1. `automation_outbox`      — transactional outbox with retry/backoff, dead
 *                                 letters and replay. The ONLY place external
 *                                 side effects (email, provider calls, webhooks)
 *                                 are staged; a dispatcher drains it.
 *   2. `automation_rules`       — versioned trigger/condition/action rules (data,
 *                                 not code). Editing a rule appends a new version
 *                                 row sharing a `rule_key`; prior versions stay.
 *   3. `automation_executions`  — append-only history of every evaluate() outcome.
 *   4. `automation_approvals`   — pending approvals for `approval_required` rules.
 *
 * Money is integer cents; timestamps are ISO-8601 UTC (nowIso); JSON is stored
 * as TEXT (JSON.stringify/parse at the service boundary); booleans are 0/1.
 */

/* ------------------------------- Enums --------------------------------- */

export type OutboxStatus =
  | 'pending'
  | 'delivering'
  | 'delivered'
  | 'failed'
  | 'dead'
  | 'canceled';

export type RulePolicy = 'automatic' | 'approval_required' | 'disabled';

export type ConditionOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'exists';

export type ExecutionOutcome =
  | 'enqueued'
  | 'pending_approval'
  | 'skipped_disabled'
  | 'skipped_window'
  | 'skipped_condition'
  | 'skipped_idempotent'
  | 'invalid_event'
  | 'dry_run';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/* ------------------------- Typed JSON payloads ------------------------- */

/** One deterministic condition evaluated against an event payload. */
export interface RuleCondition {
  /** Dot-path into the event payload, e.g. "onHand" or "line.totalCents". */
  path: string;
  op: ConditionOp;
  /** Comparison value. For `exists`, value=false means "must be absent". */
  value?: unknown;
}

/** Schedule gate — the rule only fires when `now` (in `timezone`) is in a window. */
export interface RuleSchedule {
  /** IANA zone, e.g. "America/New_York". */
  timezone: string;
  /** Any-of windows. Empty array = never fires. */
  windows: RuleScheduleWindow[];
}

export interface RuleScheduleWindow {
  /** Luxon weekday numbers 1..7 (Mon..Sun). Omitted = every day. */
  days?: number[];
  /** Inclusive local start "HH:mm" (24h). */
  start: string;
  /** Exclusive local end "HH:mm" (24h). */
  end: string;
}

/* -------------------------------- Rows --------------------------------- */

/** A staged effect awaiting delivery by a registered dispatcher handler. */
export interface AutomationOutboxRow {
  id: string;
  tenant_id: string;
  /** Idempotency key — UNIQUE per tenant. A duplicate enqueue returns this row. */
  idempotency_key: string;
  /** Typed effect kind; the dispatcher routes to a handler registered for it. */
  kind: string;
  /** Effect payload as JSON text. */
  payload: string;
  status: OutboxStatus;
  /** Attempts made so far (0 before first delivery). */
  attempts: number;
  max_attempts: number;
  /** Earliest ISO time this row may be claimed for delivery. */
  next_attempt_at: string;
  /** Dispatcher instance currently holding the delivery lease. */
  lease_owner: string | null;
  /** ISO deadline after which another dispatcher may reclaim this row. */
  lease_expires_at: string | null;
  /** Last successful lease heartbeat, for operator visibility. */
  lease_heartbeat_at: string | null;
  /** Monotonic fencing token. Incremented on every claim/reclaim. */
  lease_token: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  /** Set when status becomes 'delivered'. */
  delivered_at: string | null;
}

/** One version of a rule. Versions of the same rule share `rule_key`. */
export interface AutomationRuleRow {
  id: string;
  tenant_id: string;
  /** Stable across versions; the identity clients edit against. */
  rule_key: string;
  name: string;
  /** Bumped on every edit; the highest version per rule_key is current. */
  version: number;
  /** Canonical event name (CONTRACTS-MAGS §2) this rule triggers on. */
  trigger_event: string;
  /** JSON array of RuleCondition (AND-ed). */
  conditions: string;
  /** Outbox effect kind produced when the rule fires. */
  action_kind: string;
  /** JSON payload template with {{path}} substitutions from the event payload. */
  action_template: string;
  policy: RulePolicy;
  /** Nullable JSON RuleSchedule. */
  schedule: string | null;
  /** Dedup window: same rule + derived key within this many seconds → skip. 0 = off. */
  idempotency_window_seconds: number;
  /** 0/1. A rule can be disabled either by enabled=0 or policy='disabled'. */
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** Append-only history: one row per rule per evaluate() call. */
export interface AutomationExecutionRow {
  id: string;
  tenant_id: string;
  /** The rule VERSION row id that produced this execution. */
  rule_id: string;
  rule_version: number;
  event_type: string;
  event_payload: string;
  /** 1 when the rule's conditions matched the event. */
  matched: number;
  outcome: ExecutionOutcome;
  /** Set for enqueued outcomes. */
  outbox_id: string | null;
  /** Derived idempotency key used for window dedup + outbox key. */
  dedupe_key: string | null;
  created_at: string;
}

/** A pending owner approval for an `approval_required` rule that matched. */
export interface AutomationApprovalRow {
  id: string;
  tenant_id: string;
  rule_id: string;
  rule_version: number;
  execution_id: string;
  action_kind: string;
  /** Rendered effect payload (JSON) that will be enqueued on approve. */
  action_payload: string;
  /** Idempotency key carried to the outbox on approve. */
  idempotency_key: string;
  status: ApprovalStatus;
  reason: string | null;
  outbox_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutomationDatabase extends CoreDatabase {
  automation_outbox: AutomationOutboxRow;
  automation_rules: AutomationRuleRow;
  automation_executions: AutomationExecutionRow;
  automation_approvals: AutomationApprovalRow;
}
