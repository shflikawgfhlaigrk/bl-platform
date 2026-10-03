# @blacklabel/portal-employee

Employee Portal module for the BlackLabel Platform — field workers,
technicians, salespeople, media staff, operators. Industry-neutral by design:
`assignment.kind` is free-form per tenant (`"service_visit"`,
`"content_shoot"`, `"install"`, ...), never an industry enum, so the same
module serves field-service crews and media/marketing staff.

## Objects

| Object | Table | Notes |
|---|---|---|
| Employee | `portal_employee_employees` | profile + `role` (`worker` / `manager` / `admin`), optional `user_id` link to core users (id string only), `custom` JSON column for core custom-field values |
| Token | `portal_employee_tokens` | portal auth tokens (revocable, optional expiry) |
| Assignment | `portal_employee_assignments` | tasks/jobs; free-form `kind`; optional `related_entity_type`/`related_entity_id` cross-module id reference |
| Shift | `portal_employee_shifts` | scheduled work windows |
| TimeEntry | `portal_employee_time_entries` | clock-in/out; open entry = `clock_out_at IS NULL` |
| ChecklistTemplate (+items) | `portal_employee_checklist_templates`, `..._template_items` | reusable templates |
| Checklist (+items) | `portal_employee_checklists`, `..._checklist_items` | per-assignment instance (copied from template or ad-hoc) |
| WorkLog | `portal_employee_work_logs` | internal notes, status updates, manager comments |
| JobPhoto | `portal_employee_job_photos` | `file_id` reference into the files module (id string only — no bytes here) |

Every table carries `tenant_id` (indexed); every query filters by it.

## Reviewed work closeout

Assignments include a closeout report (`GET /assignments/:id/closeout`, or
token-authenticated `GET /portal/assignments/:id/closeout`). It contains the
assignment, checklists, exception records, linked time entries and explicit
blockers. Completion requires every checklist item checked or specifically
waived by a manager, every exception resolved, and every linked time entry
clocked out and approved. An assignment with no linked time has no implied
approved hours. `completed_at` records the first successful completion;
retries and manager reopen/recompletion never duplicate the completed event.
Workers cannot reopen closed work. Closed checklists and approved linked time
stay fixed until a manager reopens the assignment.

`POST /portal/clock-in` accepts optional `assignmentId` alongside `shiftId`.
Only the assigned worker can record time against that assignment. An employee
has one open clock entry; simultaneous clock attempts are serialized. Existing
unlinked shift entries remain available and migrate to `pending` review rather
than being represented as historically approved.

Employees report an exception with
`POST /portal/assignments/:id/exceptions` and
`{ reason, checklist_item_id?, idempotency_key }`. The item must belong to that
work. Identical retries return the original report; key reuse with changed
input returns 409. A manager/admin uses
`POST /portal/exceptions/:id/resolve` with
`{ resolution_note, waive_item? }`. A waiver identifies one checklist item;
resolving a generic exception does not complete any checklist item. Reasons,
reviewers, decisions, timestamps, audit entries and work logs are retained.

Managers/admins use `GET /portal/time-entries` for the review queue and
`POST /portal/time-entries/:id/review` with
`{ status: "approved" | "rejected", note }`. Trusted company owners use the
equivalent `/time-entries` and `/exceptions/:id/resolve` back-office routes.
Workers get 403 on manager review routes. All entity lookups remain tenant
scoped. Review summary counts cover all company time entries; the item list
uses `limit`/`offset` and can filter by `status`. Closed-entry durations in the
queue are elapsed whole minutes. The worker `/team` UI shows closeout blockers,
job clock controls, exceptions and review decisions; the owner UI adds review
and closeout panels using `employee.js`. The owner review queue starts with
pending time, supports review-state filters and pagination, and reads linked
assignment names directly even when their work is beyond the current page.
Work closeout has its own status filter and pagination. Repeated time selection
replaces the current review form so its submission targets the selected entry.

Migration `portal_employee.0003_reviewed_job_closeout` appends fields/tables and
preserves existing records. Existing completed assignments keep their original
status and get their last update timestamp as first completion evidence.
Checks are in-memory router tests using synthetic employees and tokens.
Independent browser/device validation and purchase provisioning remain product
acceptance gates. Assignments can reference shared job IDs, but this slice does
not establish cross-module fulfillment synchronization or external payroll.

## Auth model

Two surfaces on one router (`portalEmployeeRouter(deps)`):

- **Back-office** (tenant header only, trusted like every other module
  router; staff auth is the integrator's concern): employee CRUD, token
  issue/revoke, assignment/shift/checklist-template administration.
- **`/portal/*`** — the employee-facing surface, authenticated by employee
  token (`x-employee-token` header, or `?token=` for the HTML pages), same
  pattern as the customer portal. Tokens are tenant-scoped, revocable, can
  expire, and stop working when the employee is deactivated.

### Permissions (middleware-enforced)

- `worker` — sees/touches only their own assignments, schedule, time
  entries, checklists, photos, notes.
- `manager` / `admin` — view everything in the tenant, can comment on any
  assignment (`requireRole('manager', 'admin')` middleware), and can view
  other employees' schedules.

## Endpoints

Back-office:

```
POST   /employees                          create profile
GET    /employees?role=&active=            list (paginated)
GET    /employees/:employeeId
PATCH  /employees/:employeeId
DELETE /employees/:employeeId
POST   /employees/:employeeId/tokens       issue portal token
DELETE /tokens/:tokenId                    revoke token
POST   /assignments                        assign a task/job (free-form kind)
GET    /assignments?employee_id=&status=&kind=
GET    /assignments/:id
GET    /assignments/:id/logs | /photos | /checklists
POST   /assignments/:id/checklists         instantiate (templateId | name+items)
POST   /shifts                             schedule a shift
GET    /shifts?employee_id=
POST   /checklist-templates                { name, items: [labels] }
GET    /checklist-templates
```

Portal (employee token):

```
GET  /portal/me
GET  /portal/my/assignments?status=&kind=
GET  /portal/my/schedule?date=YYYY-MM-DD[&employee_id=]   shifts + assignments + open clock state (UTC day)
GET  /portal/my/time-entries[?employee_id=]               own; managers/admins may target another employee
POST /portal/clock-in                      { shiftId? } — 409 if already clocked in
POST /portal/clock-out                     409 if not clocked in
GET  /portal/assignments                   manager/admin only (middleware)
GET  /portal/assignments/:id               own, or manager
POST /portal/assignments/:id/status        { status, note? } — logs a status_update WorkLog
POST /portal/assignments/:id/logs          { body } — internal note
POST /portal/assignments/:id/comments      { body } — manager/admin only (middleware)
GET  /portal/assignments/:id/logs | /checklists | /photos
POST /portal/assignments/:id/photos        { fileId, caption? } — file-id reference
POST /portal/checklist-items/:itemId/check { checked: boolean }
GET  /portal/day                           mobile-first HTML daily view + clock controls
GET  /portal/clock                         mobile-first HTML clock in/out page
```

Envelopes follow platform convention: `{ data }` / `{ data, limit, offset }`,
errors `{ error: { message, code, details } }`.

## Events

- `portal_employee.shift.clocked_in` `{ shiftId, timeEntryId, employeeId, userId, at }` (catalog)
- `portal_employee.shift.clocked_out` `{ shiftId, timeEntryId, employeeId, userId, at }` (catalog)
- `portal_employee.task.completed` `{ assignmentId, employeeId, kind }` — assignment status set to `completed`
- `portal_employee.assignment.created` `{ assignmentId, employeeId, kind }`
- `portal_employee.employee.created` `{ employeeId, role }`

All emitted after the DB write succeeds. `shiftId` is `null` on ad-hoc
clock-ins; `userId` falls back to the employee id when no core user is linked.

## Clock-in guard

An employee with an open time entry (no `clock_out_at`) gets `409 conflict`
on a second clock-in; clock-out with no open entry is also `409`. The guard
is tenant- and employee-scoped.

## Usage

```ts
import { runMigrations, createDb } from '@blacklabel/db';
import { coreMigrations, EventBus } from '@blacklabel/core';
import {
  portalEmployeeMigrations,
  portalEmployeeRouter,
  seedPortalEmployee,
  type PortalEmployeeDatabase,
} from '@blacklabel/portal-employee';

const db = createDb<PortalEmployeeDatabase>('.storage/platform.db');
await runMigrations(db, [...coreMigrations, ...portalEmployeeMigrations]);
const app = portalEmployeeRouter({ db, events: new EventBus(), contracts: {} });
// integrator mounts at /api/portal-employee

await seedPortalEmployee(db, tenantId); // demo data: manager + field worker + media worker
```

## Tests

`npx vitest run packages/portal-employee` — 41 tests: migrations (fresh +
idempotent), router CRUD, token auth (invalid/revoked/expired/deactivated/
cross-tenant), clock-in guard, role permissions (worker vs manager,
middleware-enforced), checklists, photos, daily schedule, HTML pages
(including escaping), seed, and tenant-isolation denial tests for every
entity.
