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
| `send_email` | Routes through the connected messaging contract with a stable execution/action operation key; missing messaging fails visibly. | `to, subject, body` |
| `send_sms` | Same messaging contract operation with `channel: "sms"`; a real SMS adapter is required. | `to, body` |
| `create_task` | Real: creates a `workflows_tasks` row (this module owns tasks and implements core's `CreateTaskContract`). | `title, description?, assigneeUserId?, dueAt? \| dueInHours?, relatedEntityType?, relatedEntityId?` |
| `update_lead_stage` | Uses the composition-owned CRM operation and verifies the resulting lead/stage. Missing binding fails visibly. | `leadId, stage` |
| `add_tag` | Real: idempotent `workflows_tags` row keyed by (entityType, entityId, tag); entities referenced by id string only. | `entityType, entityId, tag` |
| `notify_user` | Real: writes a `workflows_notifications` row (surfaced at `GET /notifications`). | `userId, title, body?` |
| `create_appointment` | Via the injected scheduling contract; **skipped** gracefully when the contract isn't wired. | `customerId, startsAt? \| startsInHours?, durationMinutes?, assigneeUserId?, serviceKey?, notes?` |
| `create_invoice` | Uses the injected billing contract and a stable `workflows.action` source reference; skipped when absent. The current Billing source receipt preserves the invoice across same-input retry. | `customerId, lines[], discountBps?, discountFixedCents?, taxBps?, dueAt?, memo?` |
| `webhook` | **Real HTTP POST** with timeout (`AbortController`) and response capture (status + first 2 KB of body). Non-2xx responses throw and are retried. | `url, headers?, timeoutMs? (default 5000), includePayload? (default true), body?` |

## Execution, logging, retries

- Platform `event.id` is retained and unique per company/workflow. Concurrent or
  later replay of that **same event ID** produces one execution. A new event ID
  is a new occurrence; the engine does not infer business identity from a payload.
- Each execution freezes its actions, workflow template name and retry limit.
  Editing the recipe affects future occurrences while existing work retains its
  original inputs. Relative task/appointment dates remain anchored to its start.
- A database claim admits one worker. Claims expire after one minute and renew
  before each action; abandoned work can resume on the next due tick. Attempts
  are counted before effects so a lost finalization cannot reset the retry budget.
- Local task/tag/notification effects, audits and their result receipt commit in
  one transaction. Recovery after the effect but before the attempt log returns
  that receipt instead of duplicating the business record. Known successful
  attempt logs also prevent replay of completed actions.

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
GET    /recipes                  three bounded local business recipes
POST   /recipes/:key/install     install once with a company user and due window
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

## Included recipe presets and recovery limits

The owner workspace offers **Respond to a new lead**, **Prepare approved work**
and **Check completed job closeout**. Each creates an assigned task, an in-app
notification and a record tag, with three attempts and a due window of 1–168
hours. They do not send messages, book appointments or charge customers. A
repeat install returns the existing workflow and preserves owner edits. Company
user validation prevents assignment to another tenant. The same stable
`recipeKey` service seam lets industry composition install its own local recipes.

`GET /executions/:id` exposes committed local receipts separately from attempt
logs. This is local recovery evidence, not provider delivery evidence. Events
lost before the in-process bus reaches this engine are not captured by a durable
outbox. Appointment actions pass a stable execution/action key to Scheduling's
atomic local booking receipt: an identical retry returns the saved appointment,
and conflicting instructions using that key return a conflict. This preserves
the booking after a crash between its commit and Workflow's attempt log, even
when the owner edits the recipe for future bookings. Appointment event delivery
and calendar-provider delivery still need separate recovery proof. Arbitrary
webhooks can have an ambiguous remote outcome after interruption; their repeated
remote writes are not covered by local receipts. Only use them after the
destination's recovery contract is proved. Essential module
handoffs/notifications must remain included in their standalone purchase.

Focused verification: `npx vitest run packages/workflows --maxWorkers=1 --fileParallelism=false`.

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
