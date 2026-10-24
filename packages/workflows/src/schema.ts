import type { CoreDatabase } from '@blacklabel/core';

/**
 * Row types for the workflows module tables. Conventions:
 * - ids: TEXT nanoid via id()
 * - timestamps: TEXT ISO-8601 UTC via nowIso()
 * - booleans: INTEGER 0/1
 * - JSON: serialized TEXT (columns suffixed _json)
 */

/** Workflow definition — the "when X happens, do Y" record. */
export interface WorkflowRow {
  id: string;
  tenant_id: string;
  name: string;
  /** One of TRIGGER_EVENTS (platform event names, e.g. "crm.lead.created"). */
  trigger_event: string;
  /** JSON {field, op, value} or null (= always run). */
  condition_json: string | null;
  /** 0/1 */
  enabled: number;
  /** Total runs allowed per execution (initial run + retries). */
  max_attempts: number;
  /** A built-in recipe may be installed once per tenant. Null for custom workflows. */
  recipe_key?: string | null;
  created_at: string;
  updated_at: string;
}

/** One ordered action inside a workflow. */
export interface WorkflowActionRow {
  id: string;
  tenant_id: string;
  workflow_id: string;
  /** 0-based order within the workflow. */
  position: number;
  /** Key into the fixed action registry (never eval'd). */
  type: string;
  /** JSON config for the action (template strings allowed). */
  config_json: string;
  created_at: string;
}

export type ExecutionStatus = 'succeeded' | 'retrying' | 'failed';

/** One triggered run of a workflow (execution log header). */
export interface WorkflowExecutionRow {
  id: string;
  tenant_id: string;
  workflow_id: string;
  trigger_event: string;
  trigger_event_id?: string | null;
  /** Frozen actions and retry limit: editing a workflow cannot change an in-flight job. */
  actions_snapshot_json?: string | null;
  retry_limit?: number | null;
  claim_token?: string | null;
  claim_expires_at?: string | null;
  /** JSON copy of the triggering event payload. */
  trigger_payload_json: string;
  status: ExecutionStatus;
  /** Number of runs performed so far (1 = initial run). */
  attempts: number;
  /** ISO-8601 UTC; set while status = 'retrying'. */
  next_retry_at: string | null;
  /** JSON string[] of action ids that still need a retry. */
  failed_action_ids_json: string | null;
  started_at: string;
  finished_at: string | null;
  created_at: string;
}

/** Committed in the same transaction as a local task, tag or notification. */
export interface WorkflowActionReceiptRow {
  id: string;
  tenant_id: string;
  execution_id: string;
  action_id: string;
  operation_key: string;
  request_json: string;
  status: 'succeeded' | 'skipped';
  output_json: string | null;
  created_at: string;
}

export type ExecutionActionStatus = 'succeeded' | 'failed' | 'skipped';

/** Per-action log line within an execution (one row per action per attempt). */
export interface WorkflowExecutionActionRow {
  id: string;
  tenant_id: string;
  execution_id: string;
  action_id: string;
  /** Which run of the execution produced this row (1 = initial). */
  attempt: number;
  position: number;
  type: string;
  status: ExecutionActionStatus;
  /** JSON output of the action, or null. */
  output_json: string | null;
  error: string | null;
  created_at: string;
}

export type TaskStatus = 'open' | 'completed' | 'overdue';

/** Tasks owned by this module (workflows implements CreateTaskContract). */
export interface WorkflowTaskRow {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  assignee_user_id: string | null;
  due_at: string | null;
  status: TaskStatus;
  related_entity_type: string | null;
  related_entity_id: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** In-app notification rows written by the notify_user action. */
export interface WorkflowNotificationRow {
  id: string;
  tenant_id: string;
  user_id: string;
  title: string;
  body: string | null;
  /** 0/1 */
  read: number;
  created_at: string;
}

/** Generic tags attached to any entity (referenced by id string only). */
export interface WorkflowTagRow {
  id: string;
  tenant_id: string;
  entity_type: string;
  entity_id: string;
  tag: string;
  created_at: string;
}

export interface WorkflowsDatabase extends CoreDatabase {
  workflows_workflows: WorkflowRow;
  workflows_workflow_actions: WorkflowActionRow;
  workflows_executions: WorkflowExecutionRow;
  workflows_execution_actions: WorkflowExecutionActionRow;
  workflows_action_receipts: WorkflowActionReceiptRow;
  workflows_tasks: WorkflowTaskRow;
  workflows_notifications: WorkflowNotificationRow;
  workflows_tags: WorkflowTagRow;
}
