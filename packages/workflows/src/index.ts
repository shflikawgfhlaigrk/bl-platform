/**
 * @blacklabel/workflows — Workflow Automation Engine ("internal Zapier").
 *
 * When a platform event fires, run a workflow's ordered actions with an
 * optional payload condition, per-action logging, and exponential-backoff
 * retries driven by an explicit runPending() tick (no timers).
 *
 * Catalog events emitted by this module:
 *   workflows.task.completed        { taskId }
 *   workflows.task.overdue          { taskId, dueAt }
 * Module-internal events (same naming rules):
 *   workflows.workflow.created      { workflowId }
 *   workflows.workflow.updated      { workflowId }
 *   workflows.workflow.enabled      { workflowId }
 *   workflows.workflow.disabled     { workflowId }
 *   workflows.workflow.deleted      { workflowId }
 *   workflows.task.created          { taskId }
 *   workflows.notification.created  { notificationId, userId }
 *   workflows.execution.succeeded   { executionId, workflowId }
 *   workflows.execution.failed      { executionId, workflowId, attempts }
 */

export const MODULE_KEY = 'workflows' as const;

// Schema
export type {
  WorkflowsDatabase,
  WorkflowRow,
  WorkflowActionRow,
  WorkflowExecutionRow,
  WorkflowExecutionActionRow,
  WorkflowTaskRow,
  WorkflowNotificationRow,
  WorkflowTagRow,
  ExecutionStatus,
  ExecutionActionStatus,
  TaskStatus,
} from './schema';

// Migrations
export { workflowsMigrations } from './migrations';
export { installWorkflowRecipe, listWorkflowRecipes } from './recipes';

// Router factory
export { workflowsRouter } from './router';

// Engine
export {
  createWorkflowEngine,
  attachWorkflowEngine,
  evaluateCondition,
  renderTemplate,
  ACTION_REGISTRY_KEYS,
} from './engine';
export type { WorkflowEngine, WorkflowEngineOptions, RunPendingResult, FetchLike } from './engine';

// Contract implementation (workflows -> tasks), wired by apps/api
export { workflowsCreateTaskContract } from './contract';

// Public service surface + vocabulary
export {
  TRIGGER_EVENTS,
  ACTION_TYPES,
  CONDITION_OPS,
  conditionSchema,
  actionInputSchema,
  createWorkflow,
  getWorkflow,
  listWorkflows,
  updateWorkflow,
  setWorkflowEnabled,
  deleteWorkflow,
  listExecutions,
  getExecution,
  createTask,
  getTask,
  listTasks,
  completeTask,
  markOverdueTasks,
  createNotification,
  listNotifications,
  markNotificationRead,
  addTag,
  listTags,
} from './service';
export type {
  TriggerEvent,
  ActionType,
  ConditionOp,
  WorkflowCondition,
  WorkflowActionInput,
  CreateWorkflowInput,
  UpdateWorkflowInput,
  CreateTaskServiceInput,
  WorkflowDto,
  ExecutionDto,
  ExecutionActionDto,
  TaskDto,
} from './service';

// Seed
export { seedWorkflows } from './seed';
