/**
 * @blacklabel/actions — the unified owner/staff action queue. Actions are the
 * "what needs attention now" of the Mags Commerce OS home screen: each is a
 * single typed condition (stock below reorder point, PO awaiting approval,
 * payout mismatch, …) with owner, priority, due date, evidence, deep link,
 * comments, snooze-with-reason, escalation history, and resolution proof.
 *
 * Actions are opened directly (POST /) or derived from canonical domain events
 * (registerActionsSubscriptions). The queue is deduped by `dedupe_key`: the
 * same underlying condition never opens a second live action, and resolving the
 * underlying exception resolves the action (auto or manual).
 *
 * Events emitted (canonical, CONTRACTS-MAGS §2):
 *   - actions.action.created   { v:1, actionId, kind }
 *   - actions.action.resolved  { v:1, actionId }
 *
 * Events consumed (see subscriptions.ts): inventory.stock.below_reorder_point,
 * inventory.stock.changed, inventory.transfer.closed,
 * purchasing.purchase_order.approved, shows.packing.required,
 * finance.payout.reconciliation_failed, orders.order.fulfilled.
 */

export { actionsMigrations } from './migrations';
export { actionsRouter } from './router';
export { registerActionsSubscriptions } from './subscriptions';

export {
  open,
  resolve,
  autoResolveByDedupeKey,
  snooze,
  unsnooze,
  wakeDueSnoozes,
  escalate,
  assign,
  addComment,
  listQueue,
  listByKind,
  listBySourceEntity,
  listOverdue,
  countsSummary,
  getAction,
  hydrateAction,
} from './service';

export type {
  OpenActionInput,
  OpenActionResult,
  ResolveInput,
  QueueFilters,
  CountsSummary,
  ActionDetail,
} from './service';

export {
  ACTION_KINDS,
  ACTION_PRIORITIES,
  ACTION_STATUSES,
  ACTIVE_STATUSES,
  RESOLUTION_KINDS,
} from './schema';

export type {
  Action,
  ActionRow,
  ActionCommentRow,
  ActionEscalationRow,
  ActionKind,
  ActionPriority,
  ActionStatus,
  ResolutionKind,
  ActionsDatabase,
} from './schema';
