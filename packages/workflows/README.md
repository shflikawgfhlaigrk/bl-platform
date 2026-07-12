# @blacklabel/workflows — Workflow Automation Engine

The platform's internal Zapier: **when an event happens, run actions.** Workflow
definitions live in the database; the engine subscribes to the core event bus,
matches events to enabled workflows, evaluates an optional payload condition,
and runs the workflow's ordered actions through a **fixed action registry**
(no `eval`, no dynamic code — user data can only *select* one of the entries
below, never define behavior).

The module is industry-neutral: triggers, conditions, and action configs are
plain data, so the same engine powers any vertical.

## Triggers

A workflow subscribes to exactly one of these platform events:

| Trigger | Emitted by |
|---|---|
| `crm.lead.created` | crm |
| `quoting.quote.approved` | quoting |
| `scheduling.appointment.scheduled` | scheduling |
| `scheduling.appointment.completed` | scheduling |
| `billing.invoice.paid` | billing |
| `reviews.review.submitted` | reviews |
| `workflows.task.overdue` | workflows (the `runPending` tick) |
| `messaging.message.received` | messaging |

## Conditions

Optional single condition evaluated against the trigger payload:
`{ "field": "totalCents", "op": "gte", "value": 50000 }`.
`field` is a dot-path into the payload. Ops: `eq, neq, gt, gte, lt, lte,
contains, exists, not_exists`. No condition = always run.

## Actions

Each action is `{ "type": "...", "config": { ... } }`. String config values
support safe `{{path}}` templating against `payload.*`, `event.type`,
`event.occurredAt`, and `workflow.id`/`workflow.name` (missing paths render
as empty string — nothing is ever executed).

| Type | What it does | Config (after templating) |
|---|---|---|
| `send_email` | Provider stub. Routes through the messaging `sendMessage` contract when wired; otherwise records the composed email in the execution log. | `to, subject, body` |
| `send_sms` | Provider stub, same contract fallback as above with `channel: "sms"`. | `to, body` |
| `create_task` | Real: creates a `workflows_tasks` row (this module owns tasks and implements core's `CreateTaskContract`). | `title, description?, assigneeUserId?, dueAt? \| dueInHours?, relatedEntityType?, relatedEntityId?` |
| `update_lead_stage` | **Stub per spec**: core defines no lead-stage contract and cross-module writes are banned, so it records `{ stub: true, leadId, stage }` for the CRM module to consume once a contract exists. | `leadId, stage` |
| `add_tag` | Real: idempotent `workflows_tags` row keyed by (entityType, entityId, tag); entities referenced by id string only. | `entityType, entityId, tag` |
| `notify_user` | Real: writes a `workflows_notifications` row (surfaced at `GET /notifications`). | `userId, title, body?` |
| `create_appointment` | Via the injected scheduling contract; **skipped** gracefully when the contract isn't wired. | `customerId, startsAt? \| startsInHours?, durationMinutes?, assigneeUserId?, serviceKey?, notes?` |
| `create_invoice` | Placeholder via the injected billing contract; skipped when absent. | `customerId, lines[], discountBps?, discountFixedCents?, taxBps?, dueAt?, memo?` |
| `webhook` | **Real HTTP POST** with timeout (`AbortController`) and response capture (status + first 2 KB of body). Non-2xx responses throw and are retried. | `url, headers?, timeoutMs? (default 5000), includePayload? (default true), body?` |

## Execution, logging, retries

- Every trigger match writes a `workflows_executions` row (trigger payload
  snapshot, status, attempts) plus one `workflows_execution_actions` row per
  action **per attempt** with `status` (`succeeded | failed | skipped`),
  JSON `output`, and `error`.
- **Failure isolation**: every action runs in its own try/catch — a failing
  action never stops later actions, a broken workflow never stops other
  workflows on the same event, and the engine never throws into the bus.
- **Retry with exponential backoff**: if any action fails, the execution goes
  to `retrying` with `attempts` and `next_retry_at = now + base * 2^(attempts-1)`
  persisted (base 60 s by default, injectable). `runPending()` — an explicit
  tick, no timers — re-runs **only the failed actions** of due executions.
  After `maxAttempts` (default 3, per workflow) the execution is `failed` and
  `workflows.execution.failed` is emitted.
- `runPending()` also flips due open tasks to `overdue` and emits
  `workflows.task.overdue`, which can itself trigger workflows.
- Skipped actions (missing contract) do **not** cause retries.
- **Disabling a workflow pauses its due retries** — nothing runs while it is
  disabled; pending executions stay `retrying` and resume on the first tick
  after re-enable.

## Tenancy

Every table carries `tenant_id`; every query filters by it. The engine scopes
each event to `event.tenantId`, so tenant A's events can never run tenant B's
workflows. The tenant-less `runPending()` sweep iterates tenants via core's
`listTenants` and processes each one fully scoped.

## HTTP API (mounted at `/api/workflows`)

```
GET    /meta                     trigger + action vocabulary
POST   /                         create workflow
GET    /                         list workflows
GET    /:id                      get workflow (with actions)
PUT    /:id                      update (rename / condition / replace actions / enable)
POST   /:id/enable               enable
POST   /:id/disable              disable
DELETE /:id                      delete
GET    /executions               execution log (?workflow_id=&status=)
GET    /executions/:id           execution detail incl. per-action log
POST   /run-pending              tick: due retries + overdue tasks (this tenant)
POST   /tasks                    create task
GET    /tasks                    list tasks (?status=&assignee_user_id=)
GET    /tasks/:id                get task
POST   /tasks/:id/complete       complete task (emits workflows.task.completed)
GET    /notifications            list notifications (?user_id=)
POST   /notifications/:id/read   mark read
GET    /tags                     list tags (?entity_type=&entity_id=)
```

## Wiring (apps/api)

```ts
import {
  workflowsMigrations,
  workflowsRouter,
  attachWorkflowEngine,
  workflowsCreateTaskContract,
} from '@blacklabel/workflows';

await runMigrations(db, [...coreMigrations, ...workflowsMigrations]);
const deps = { db, events, contracts };           // contracts from other modules
const { engine } = attachWorkflowEngine(deps);    // subscribe to all triggers
app.route('/api/workflows', workflowsRouter(deps));
contracts.createTask = workflowsCreateTaskContract(db, events); // workflows -> tasks
// call engine.runPending() from your scheduler (cron/interval) — it's timer-free.
```

---

## Worked examples

### 1. Spa: appointment reminder

When a booking is made, email a confirmation and text a reminder — plus a prep
task for the assigned therapist.

```json
POST /api/workflows
{
  "name": "Appointment reminder",
  "triggerEvent": "scheduling.appointment.scheduled",
  "actions": [
    {
      "type": "send_email",
      "config": {
        "to": "{{payload.customerId}}",
        "subject": "Your visit is confirmed",
        "body": "We look forward to seeing you at {{payload.startsAt}}. Arrive 10 minutes early to unwind."
      }
    },
    {
      "type": "send_sms",
      "config": {
        "to": "{{payload.customerId}}",
        "body": "Reminder: your appointment starts at {{payload.startsAt}}. Reply R to reschedule."
      }
    },
    {
      "type": "create_task",
      "config": {
        "title": "Prep room for appointment {{payload.appointmentId}}",
        "dueInHours": 1,
        "relatedEntityType": "scheduling.appointment",
        "relatedEntityId": "{{payload.appointmentId}}"
      }
    }
  ]
}
```

### 2. Window cleaning: quote follow-up

When a quote worth $200+ is approved, book the crew, tag the customer, and
ping the operations channel via webhook.

```json
POST /api/workflows
{
  "name": "Quote follow-up",
  "triggerEvent": "quoting.quote.approved",
  "condition": { "field": "totalCents", "op": "gte", "value": 20000 },
  "actions": [
    {
      "type": "create_appointment",
      "config": {
        "customerId": "{{payload.customerId}}",
        "startsInHours": 72,
        "durationMinutes": 120,
        "notes": "Approved quote {{payload.quoteId}} — bring the water-fed pole rig."
      }
    },
    {
      "type": "add_tag",
      "config": {
        "entityType": "crm.lead",
        "entityId": "{{payload.customerId}}",
        "tag": "approved-customer"
      }
    },
    {
      "type": "webhook",
      "config": {
        "url": "https://hooks.example.com/ops-channel",
        "timeoutMs": 4000,
        "body": { "text": "Quote {{payload.quoteId}} approved — crew booked." }
      }
    }
  ]
}
```

### 3. Marketing agency: lead notification

The instant a lead lands, notify the account owner, open a first-touch task
due in 30 minutes, and move the lead's stage.

```json
POST /api/workflows
{
  "name": "Lead notification",
  "triggerEvent": "crm.lead.created",
  "actions": [
    {
      "type": "notify_user",
      "config": {
        "userId": "USER_ACCOUNT_OWNER",
        "title": "New lead {{payload.leadId}}",
        "body": "Speed-to-lead clock is running."
      }
    },
    {
      "type": "create_task",
      "config": {
        "title": "First touch: call lead {{payload.leadId}}",
        "dueInHours": 0.5,
        "relatedEntityType": "crm.lead",
        "relatedEntityId": "{{payload.leadId}}"
      }
    },
    {
      "type": "update_lead_stage",
      "config": { "leadId": "{{payload.leadId}}", "stage": "contacted" }
    }
  ]
}
```

If the first-touch task isn't completed in time, the `runPending()` tick marks
it overdue and emits `workflows.task.overdue` — which you can catch with a
second workflow (trigger `workflows.task.overdue`) that escalates to a manager
with `notify_user`.

## Events emitted by this module

Catalog: `workflows.task.completed { taskId }`,
`workflows.task.overdue { taskId, dueAt }`.
Internal: `workflows.workflow.created|updated|enabled|disabled|deleted`,
`workflows.task.created`, `workflows.notification.created`,
`workflows.execution.succeeded|failed`.

## Tests

```
cd <repo root> && npx vitest run packages/workflows
```

42 tests: migrations (fresh + idempotent), trigger matching, condition
filtering, every action type, webhook POST/timeout/response capture,
retry/backoff persistence and exact exponential schedule, partial-retry
(only failed actions re-run), retry pause on disable/resume on re-enable,
failure isolation (action-level, workflow-level, bus-level), execution
logging, full router CRUD, `runPending` tick, and tenant-isolation denial
tests for workflows, executions, retries, tasks, notifications, and tags.
