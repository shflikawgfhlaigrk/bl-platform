import type { CoreDatabase } from '@blacklabel/core';

/**
 * Actions module schema — the unified owner/staff action queue. Every row of
 * record is a single "thing that needs attention", derived either directly
 * (POST /open) or from a canonical domain event (see subscriptions.ts). The
 * queue is deduped by `dedupe_key`: the same underlying condition never opens
 * a second live action, and resolving the underlying exception resolves the
 * action (auto or manual).
 */

/** Typed action kinds (const array → zod enum). Extend by appending only. */
export const ACTION_KINDS = [
  'stock_below_reorder_point',
  'stockout',
  'oversell',
  'count_variance_recount',
  'unassigned_custom_sale',
  'transfer_not_received',
  'show_packing_incomplete',
  'show_closeout_incomplete',
  'po_awaiting_approval',
  'vendor_shipment_overdue',
  'receipt_invoice_mismatch',
  'order_awaiting_fulfillment',
  'pickup_overdue',
  'return_awaiting_disposition',
  'restock_demand_available',
  'campaign_paused_bounce',
  'payout_mismatch',
  'cash_close_variance',
  'missing_item_cost',
  'import_stale',
  'import_failed',
  'credential_expiring',
  'backup_overdue',
  'restore_verification_overdue',
  'setup_required',
  'quarantined_import_record',
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

/** Priorities, most-urgent first (p1). Lexical order matches urgency order. */
export const ACTION_PRIORITIES = ['p1', 'p2', 'p3', 'p4'] as const;
export type ActionPriority = (typeof ACTION_PRIORITIES)[number];

/** Lifecycle states. Everything except `resolved` is "active" (attention-needing). */
export const ACTION_STATUSES = [
  'open',
  'snoozed',
  'in_progress',
  'resolved',
  'escalated',
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

/** Active = anything not yet resolved. Dedupe & the default queue operate on these. */
export const ACTIVE_STATUSES: readonly ActionStatus[] = [
  'open',
  'snoozed',
  'in_progress',
  'escalated',
];

export const RESOLUTION_KINDS = ['auto', 'manual'] as const;
export type ResolutionKind = (typeof RESOLUTION_KINDS)[number];

/** One action row. `evidence`/`resolution_proof` are JSON serialized to text. */
export interface ActionRow {
  id: string;
  tenant_id: string;
  kind: ActionKind;
  title: string;
  body: string | null;
  owner_user_id: string | null;
  priority: ActionPriority;
  due_at: string | null;
  /** JSON text: arbitrary structured evidence. */
  evidence: string | null;
  /** App-internal deep link path, e.g. "/inventory/variations/var_1". */
  deep_link: string | null;
  status: ActionStatus;
  snoozed_until: string | null;
  snooze_reason: string | null;
  source_module: string | null;
  source_entity_type: string | null;
  source_entity_id: string | null;
  /** Dedupe key — unique per tenant among ACTIVE actions (check-then-insert). */
  dedupe_key: string;
  resolution_kind: ResolutionKind | null;
  /** JSON text proof of resolution. */
  resolution_proof: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Comment on an action. */
export interface ActionCommentRow {
  id: string;
  tenant_id: string;
  action_id: string;
  author: string;
  body: string;
  created_at: string;
}

/** One priority escalation of an action (append-only history). */
export interface ActionEscalationRow {
  id: string;
  tenant_id: string;
  action_id: string;
  from_priority: ActionPriority;
  to_priority: ActionPriority;
  reason: string;
  created_at: string;
}

/**
 * Hydrated action (JSON columns parsed) — what the service returns and the
 * router emits. Column names stay snake_case to match the rest of the fleet.
 */
export interface Action extends Omit<ActionRow, 'evidence' | 'resolution_proof'> {
  evidence: unknown | null;
  resolution_proof: unknown | null;
}

export interface ActionsDatabase extends CoreDatabase {
  actions_actions: ActionRow;
  actions_comments: ActionCommentRow;
  actions_escalations: ActionEscalationRow;
}
