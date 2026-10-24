# @blacklabel/crm

Universal CRM core for the BlackLabel Platform — the shared customer / lead /
contact layer for **any** industry (field services, professional services,
health & wellness, hospitality, real estate, ...). Nothing in this module is
industry-specific.

## Objects

| Object | Table | Notes |
|---|---|---|
| Company | `crm_companies` | optional org a customer/contact belongs to |
| Customer | `crm_customers` | `status`: active / inactive / archived |
| Contact | `crm_contacts` | person; may link to a customer and/or company |
| Lead | `crm_leads` | `stage` from the tenant's configurable stage list |
| Lead stage | `crm_lead_stages` | per-tenant pipeline; defaults: new, contacted, qualified, quoted, won, lost |
| Deal / Opportunity | `crm_deals` | `status`: open / won / lost; `value_cents` integer cents |
| Job / Project | `crm_jobs` | planned / in_progress / completed / canceled |
| Note | `crm_notes` | polymorphic (`entity_type` + `entity_id`) |
| Task | `crm_tasks` | open / completed, optional entity link, assignee |
| Tag + taggable | `crm_tags`, `crm_taggables` | join table onto any CRM entity |
| TimelineEvent | `crm_timeline_events` | auto-appended on create/update/stage-change; child-entity activity is mirrored onto the linked customer |
| AttachmentReference | `crm_attachments` | references a files-module `file_id` (id string only) |
| SourceAttribution | `crm_source_attributions` | source / medium / campaign / detail |

Every major entity has an `owner_user_id` (assigned user, id string) and a
`custom_fields` JSON column whose keys are validated against the tenant's
core `custom_field_definitions` (entity types `crm.customer`, `crm.lead`, ...).

### Owned sales follow-up

`GET /sales-queue` is CRM's included action queue and pipeline report. It returns
`data.items`, full matching `data.summary` counts/value, and `data.generated_at`.
Use `bucket=all|overdue|unowned|no_next_action|no_due_date`, optional
`owner_user_id`, `q`, `limit`, and `offset`. Report totals cover every matching
active lead, independent of pagination. Items include exception reasons, the
company user's name, and `source_record.api_path` for drillthrough. Configured
closed stages are excluded. Counts are point-in-time reads; refresh to see changes.

Lead create/PATCH accepts `next_action` (1–500 characters or null),
`next_action_due_at` (ISO timestamp with timezone or null), and `owner_user_id`
(an existing company user or null). Dates normalize to UTC; a due date requires
an action. Clearing an action clears its due date. Owners are listed through
`GET /owners`. Assignment requires company setup to have provisioned users.
CRM also includes its existing customers, jobs, notes, tasks, CSV export and
activity history; this queue requires no Dashboard or Workflow purchase.

PATCH can include `expected_next_action_revision` from the lead read to reject
stale saves with 409. `POST /leads/:id/next-action/complete` requires
`{ "idempotency_key": "unique-operation-key", "revision": 1, "note": "Outcome" }`.
It records a receipt, audit and customer/lead timeline, then clears the action.
Retrying the same operation returns the same receipt without clearing a newer
action; a reused key with different input or a stale revision returns 409.
The UI shows the recorded completion and asks for the next action or closure.

`PUT /lead-stages` accepts optional `is_closed` per stage. Omission preserves the
existing flag; won/lost default to closed. Removing a stage still used by leads
returns 409 rather than stranding those leads. The UI marks closed stages with
`| closed`. Migration `crm.0004_owned_next_action_queue` preserves existing data.

This slice provides in-app due/ownership attention and completion receipts.
External reminder delivery, role-specific sales access, and independent clean
device validation remain product acceptance requirements outside this slice.

## Events emitted

```
crm.lead.created         { leadId }                        (catalog event)
crm.lead.stage_changed   { leadId, from, to }
crm.customer.created     { customerId }
crm.deal.created         { dealId }
crm.deal.stage_changed   { dealId, from, to, valueCents }
crm.job.created          { jobId }
crm.task.completed       { taskId }
crm.lead.next_action_completed { leadId, receiptId }
```

Every mutation is audited via core `audit()` with entity types like
`crm.customer`, `crm.lead`.

## Setup

```ts
import { createDb, runMigrations } from '@blacklabel/db';
import { coreMigrations, EventBus } from '@blacklabel/core';
import { crmMigrations, crmRouter, seedCrm, type CrmDatabase } from '@blacklabel/crm';

const db = createDb<CrmDatabase>('.storage/platform.db');
await runMigrations(db, [...coreMigrations, ...crmMigrations]);

const app = crmRouter({ db, events: new EventBus(), contracts: {} });
// apps/api mounts this at /api/crm

await seedCrm(db, tenantId); // optional demo data
```

Tests: `cd <repo root> && npx vitest run packages/crm`

## HTTP API

All routes require the `x-tenant-id` header (core tenant middleware). An
optional `x-user-id` header sets the audit actor (defaults to `system`).
Envelopes: single → `{ "data": {...} }`, lists → `{ "data": [...], "limit", "offset" }`,
errors → `{ "error": { "message", "code", "details" } }`.

List endpoints support `?limit=&offset=`, `?sort=col|-col|col:desc`
(whitelisted columns), whitelisted equality filters, and `?q=` substring
search. Examples below assume the router is mounted at `/api/crm`.

```sh
BASE=http://localhost:3000/api/crm
H=(-H "x-tenant-id: $TENANT" -H "content-type: application/json")
```

### Customers

```sh
curl "${H[@]}" -X POST $BASE/customers -d '{"name":"Avery Collins","email":"avery@example.com","phone":"+1-555-0100"}'
curl "${H[@]}" "$BASE/customers?q=avery&status=active&sort=-created_at&limit=20&offset=0"
curl "${H[@]}" $BASE/customers/$ID
curl "${H[@]}" -X PATCH $BASE/customers/$ID -d '{"phone":"+1-555-9999","status":"inactive"}'
curl "${H[@]}" -X DELETE $BASE/customers/$ID
curl "${H[@]}" $BASE/customers/$ID/timeline          # activity timeline (newest first)
```

### Companies

```sh
curl "${H[@]}" -X POST $BASE/companies -d '{"name":"Northside Property Group","domain":"northside.example"}'
curl "${H[@]}" "$BASE/companies?q=north&sort=name"
curl "${H[@]}" $BASE/companies/$ID
curl "${H[@]}" -X PATCH $BASE/companies/$ID -d '{"phone":"+1-555-0101"}'
curl "${H[@]}" -X DELETE $BASE/companies/$ID
```

### Contacts

```sh
curl "${H[@]}" -X POST $BASE/contacts -d '{"first_name":"Sam","last_name":"Reyes","customer_id":"'$CUSTOMER'"}'
curl "${H[@]}" "$BASE/contacts?customer_id=$CUSTOMER&sort=last_name"
curl "${H[@]}" $BASE/contacts/$ID
curl "${H[@]}" -X PATCH $BASE/contacts/$ID -d '{"title":"Operations Manager"}'
curl "${H[@]}" -X DELETE $BASE/contacts/$ID
```

### Leads & stages

```sh
curl "${H[@]}" $BASE/lead-stages                     # tenant stage list (defaults if unset)
curl "${H[@]}" -X PUT $BASE/lead-stages -d '{"stages":[{"key":"inquiry","label":"Inquiry"},{"key":"estimate"},{"key":"closed"}]}'

curl "${H[@]}" -X POST $BASE/leads -d '{"name":"Morgan Ellis","source":"website","value_cents":45000}'
curl "${H[@]}" "$BASE/leads?stage=qualified&q=morgan&sort=-value_cents"
curl "${H[@]}" $BASE/leads/$ID
curl "${H[@]}" -X PATCH $BASE/leads/$ID -d '{"stage":"qualified","owner_user_id":"'$USER'"}'
curl "${H[@]}" -X POST $BASE/leads/$ID/stage -d '{"stage":"won"}'   # emits crm.lead.stage_changed
curl "${H[@]}" $BASE/leads/$ID/timeline
curl "${H[@]}" -X DELETE $BASE/leads/$ID
```

### Deals

```sh
curl "${H[@]}" -X POST $BASE/deals -d '{"title":"Annual contract","value_cents":480000,"customer_id":"'$CUSTOMER'"}'
curl "${H[@]}" "$BASE/deals?status=open&sort=-value_cents"
curl "${H[@]}" $BASE/deals/$ID
curl "${H[@]}" -X PATCH $BASE/deals/$ID -d '{"status":"won"}'       # emits crm.deal.stage_changed
curl "${H[@]}" -X DELETE $BASE/deals/$ID
```

### Jobs / projects

```sh
curl "${H[@]}" -X POST $BASE/jobs -d '{"title":"Initial site visit","customer_id":"'$CUSTOMER'"}'
curl "${H[@]}" "$BASE/jobs?status=planned"
curl "${H[@]}" $BASE/jobs/$ID
curl "${H[@]}" -X PATCH $BASE/jobs/$ID -d '{"status":"completed"}'
curl "${H[@]}" -X DELETE $BASE/jobs/$ID
```

### Notes

```sh
curl "${H[@]}" -X POST $BASE/notes -d '{"entity_type":"crm.customer","entity_id":"'$CUSTOMER'","body":"Prefers mornings."}'
curl "${H[@]}" "$BASE/notes?entity_type=crm.customer&entity_id=$CUSTOMER"
curl "${H[@]}" $BASE/notes/$ID
curl "${H[@]}" -X PATCH $BASE/notes/$ID -d '{"body":"Updated."}'
curl "${H[@]}" -X DELETE $BASE/notes/$ID
```

### Tasks

```sh
curl "${H[@]}" -X POST $BASE/tasks -d '{"title":"Call back","entity_type":"crm.lead","entity_id":"'$LEAD'","due_at":"2026-07-15T09:00:00.000Z"}'
curl "${H[@]}" "$BASE/tasks?status=open&assignee_user_id=$USER"
curl "${H[@]}" $BASE/tasks/$ID
curl "${H[@]}" -X PATCH $BASE/tasks/$ID -d '{"due_at":"2026-07-16T09:00:00.000Z"}'
curl "${H[@]}" -X POST $BASE/tasks/$ID/complete                      # emits crm.task.completed
curl "${H[@]}" -X DELETE $BASE/tasks/$ID
```

### Tags

```sh
curl "${H[@]}" -X POST $BASE/tags -d '{"name":"vip","color":"#d4af37"}'
curl "${H[@]}" "$BASE/tags?q=vip"
curl "${H[@]}" $BASE/tags/$ID
curl "${H[@]}" -X PATCH $BASE/tags/$ID -d '{"color":"#gold"}'
curl "${H[@]}" -X POST $BASE/tags/$ID/attach -d '{"entity_type":"crm.customer","entity_id":"'$CUSTOMER'"}'
curl "${H[@]}" -X POST $BASE/tags/$ID/detach -d '{"entity_type":"crm.customer","entity_id":"'$CUSTOMER'"}'
curl "${H[@]}" "$BASE/taggings?entity_type=crm.customer&entity_id=$CUSTOMER"   # tags on an entity
curl "${H[@]}" -X DELETE $BASE/tags/$ID                              # also removes its taggings
```

### Attachment references

```sh
curl "${H[@]}" -X POST $BASE/attachments -d '{"entity_type":"crm.deal","entity_id":"'$DEAL'","file_id":"file_123","filename":"estimate.pdf","mime_type":"application/pdf","size_bytes":1024}'
curl "${H[@]}" "$BASE/attachments?entity_type=crm.deal&entity_id=$DEAL"
curl "${H[@]}" $BASE/attachments/$ID
curl "${H[@]}" -X PATCH $BASE/attachments/$ID -d '{"filename":"estimate-v2.pdf"}'
curl "${H[@]}" -X DELETE $BASE/attachments/$ID
```

### Source attributions

```sh
curl "${H[@]}" -X POST $BASE/source-attributions -d '{"entity_type":"crm.lead","entity_id":"'$LEAD'","source":"website","medium":"organic","detail":"contact form"}'
curl "${H[@]}" "$BASE/source-attributions?source=website"
curl "${H[@]}" $BASE/source-attributions/$ID
curl "${H[@]}" -X PATCH $BASE/source-attributions/$ID -d '{"campaign":"spring-promo"}'
curl "${H[@]}" -X DELETE $BASE/source-attributions/$ID
```

### Timeline (generic)

```sh
curl "${H[@]}" "$BASE/timeline?entity_type=crm.deal&entity_id=$DEAL&limit=50"
```

### Custom field definitions (backed by core)

```sh
curl "${H[@]}" -X POST $BASE/custom-fields -d '{"entity_type":"crm.customer","key":"referral_code","label":"Referral code","kind":"text"}'
curl "${H[@]}" "$BASE/custom-fields?entity_type=crm.customer"
curl "${H[@]}" -X DELETE $BASE/custom-fields/$ID
# then set values on the entity:
curl "${H[@]}" -X POST $BASE/customers -d '{"name":"X","custom_fields":{"referral_code":"FRIEND-22"}}'
```

Unknown custom-field keys are rejected with 400 and the allowed key list.
`DELETE /custom-fields/:id` only deletes `crm.*` definitions — other modules'
definitions (shared core table) are 404 from this router.

### CSV import / export (customers, contacts, leads)

Header-mapped: headers are trimmed, lowercased, spaces become underscores;
unknown columns are ignored; `id`/`created_at` are always generated. Invalid
rows are skipped and reported per-row; imported rows fire the same events /
audit / timeline as API creates.

```sh
curl "${H[@]}" $BASE/customers/export.csv -o customers.csv
curl -H "x-tenant-id: $TENANT" -H "content-type: text/csv" \
  --data-binary @customers.csv -X POST $BASE/customers/import.csv
# same for /contacts/{export,import}.csv and /leads/{export,import}.csv
# import response: { "data": { "imported": 2, "ids": [...], "errors": [{"row":3,"message":"..."}] } }
```

## Tenancy

Every table carries `tenant_id`; every query filters by it; the tenant comes
only from the `x-tenant-id` header via core middleware. Cross-tenant reads,
updates, and deletes return 404/empty — covered by per-entity denial tests in
`test/entities.test.ts`.
