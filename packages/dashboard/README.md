# @blacklabel/dashboard — Owner Dashboard / Analytics

Aggregation endpoints plus a configurable widget layer for the BlackLabel
Platform. Mounted by `apps/api` at `/api/dashboard`.

## The one cross-table reader

Per `/CONVENTIONS.md` §9, **dashboard is the ONLY package allowed to read
across other modules' tables**, and it is **strictly read-only** over them:
aggregation `SELECT`s only — never a write, never a migration against a
foreign table. Everything else references entities by id string.

The minimum column contracts the dashboard reads are documented in
`src/schema.ts` (`*ReadRow` interfaces):

| Table | Columns read | Used for |
|---|---|---|
| `billing_invoices` | `id, tenant_id, status, total_cents, created_at` | revenue summary |
| `crm_leads` | `id, tenant_id, source, created_at` | leads by source |
| `scheduling_appointments` | `id, tenant_id, status, created_at` | appointment counts |
| `quoting_quotes` | `id, tenant_id, status, created_at` | quote conversion |
| `workflows_tasks` | `id, tenant_id, status, created_at` | open tasks |
| `portal_employee_time_entries` | `id, tenant_id, employee_id, clock_in_at, clock_out_at, created_at` | employee activity |
| `portal_employee_work_logs` | `id, tenant_id, employee_id, created_at` | employee activity |
| `reviews_responses` | `id, tenant_id, rating, created_at` | reviews summary |
| `audit_log` (core) | `id, tenant_id, actor, action, entity_type, entity_id, created_at` | recent activity |
| `tenants` (core) | `id, name` | HTML page header |

**Graceful degradation:** if a source table/column does not exist yet (the
owning module is not migrated/installed), the aggregation returns
`available: false` with zeroed data instead of erroring. Alert rules on
unavailable metrics never trigger. Owned tables (`dashboard_*`) are created
by `dashboardMigrations`.

Every query filters `tenant_id` — no exceptions.

## Endpoints

All endpoints require the `x-tenant-id` header (core tenant middleware).
Every **aggregation** endpoint accepts `?from=&to=` ISO-8601 params —
inclusive bounds on the row's `created_at`. Date-only values expand:
`from` → start of day UTC, `to` → end of day UTC. Invalid or inverted
ranges → 400.

| Method & path | Purpose |
|---|---|
| `GET /` | Server-rendered HTML dashboard (no framework, responsive; renders the tenant's enabled widgets in configured order with live numbers) |
| `GET /kpis` | Machine-readable KPI definitions (key, name, description, formula, unit) |
| `GET /widgets` | Widget catalog |
| `GET /config` | Effective per-tenant widget configuration |
| `PUT /config` | Replace configuration: `{ widgets: [{ widgetKey, enabled?, settings? }] }` — array order = display order |
| `DELETE /config` | Reset to catalog defaults |
| `GET /widgets/revenue` | Revenue summary |
| `GET /widgets/leads-by-source` | Leads by source |
| `GET /widgets/appointments` | Appointment/job counts by status |
| `GET /widgets/quote-conversion` | Quote conversion (sent → approved) |
| `GET /widgets/open-tasks` | Open tasks |
| `GET /widgets/employee-activity` | Time entries + work logs per employee |
| `GET /widgets/reviews` | Reviews summary |
| `GET /widgets/website-traffic` | **Placeholder** (documented contract below) |
| `GET /widgets/campaign-performance` | **Placeholder** (documented contract below) |
| `GET /widgets/recent-activity` | Latest timeline events (`?limit=`, default 20, max 100) |
| `GET /alerts` | List alert rules (paginated) |
| `POST /alerts` | Create rule: `{ name, metric, threshold, direction, enabled? }` |
| `PATCH /alerts/:id` | Update rule |
| `DELETE /alerts/:id` | Delete rule |
| `GET /alerts/evaluate` | Evaluate all enabled rules on demand (range-aware) |
| `GET /export` | Single rollup of every KPI; `?format=json` (default) or `csv` |

Envelopes follow the platform standard: `{ data: ... }`, lists add
`limit`/`offset`, errors are `{ error: { message, code, details } }`.

## Widget configuration semantics

- **Unconfigured tenant** (no saved rows): every catalog widget is enabled
  in default order (`configured: false`).
- **Configured tenant**: exactly the saved rows apply — a widget absent from
  the saved set is not shown; `enabled: false` keeps it in the layout but
  hidden. `settings` is a free-form JSON object per widget.
- `PUT /config` validates widget keys against the catalog and rejects
  duplicates; `DELETE /config` returns to defaults.

## KPI definitions (canonical formulas)

"In range" always means `created_at` within `[from, to]` (inclusive).
Money is integer cents; rates are basis points (10000 bps = 100%).

| Key | Unit | Formula |
|---|---|---|
| `revenue_cents` | cents | `SUM(billing_invoices.total_cents) WHERE status = 'paid'` in range |
| `invoices_paid` | count | `COUNT(billing_invoices) WHERE status = 'paid'` in range |
| `leads_created` | count | `COUNT(crm_leads)` in range |
| `appointments_total` | count | `COUNT(scheduling_appointments)` in range (any status) |
| `appointments_completed` | count | `COUNT(scheduling_appointments) WHERE status = 'completed'` in range |
| `quotes_sent` | count | `COUNT(quoting_quotes) WHERE status != 'draft'` in range (a quote counts as "sent" once it leaves draft) |
| `quotes_approved` | count | `COUNT(quoting_quotes) WHERE status IN ('approved','converted')` in range |
| `quote_conversion_bps` | bps | `ROUND(quotes_approved / quotes_sent * 10000)`; `0` when `quotes_sent = 0` |
| `open_tasks` | count | `COUNT(workflows_tasks) WHERE status NOT IN ('completed','done','canceled','cancelled','archived')` in range |
| `time_entry_minutes` | minutes | `SUM(ROUND((clock_out_at − clock_in_at) in minutes))` over clocked-out time entries in range; per-entry rounding, negatives clamped to 0; open entries (no `clock_out_at`) excluded |
| `worklogs_count` | count | `COUNT(portal_employee_work_logs)` in range |
| `reviews_count` | count | `COUNT(reviews_responses)` in range |
| `reviews_avg_rating` | rating | `ROUND(AVG(reviews_responses.rating), 2)`; `null` in widget payloads / `0` as an alert-metric value when there are no reviews |

Invoice totals are produced upstream by core's `computeTotals` (billing and
quoting must agree to the cent); the dashboard only sums the stored
`total_cents` — it never re-implements money math. Tests assert the revenue
sum against `computeTotals`-derived fixtures to the cent.

## Placeholder widget contracts

Both placeholders return HTTP 200 with `placeholder: true` today and keep a
**stable shape** so UIs can bind now and light up later:

**`GET /widgets/website-traffic`**
```json
{ "data": { "key": "website_traffic", "range": {}, "placeholder": true,
  "available": false,
  "metrics": { "visits": null, "uniqueVisitors": null, "topPages": [] },
  "contract": "..." } }
```
Once a traffic integration lands: `placeholder: false`, `available: true`,
`metrics: { visits: number, uniqueVisitors: number, topPages: [{ path, visits }] }`
over the requested range.

**`GET /widgets/campaign-performance`**
```json
{ "data": { "key": "campaign_performance", "range": {}, "placeholder": true,
  "available": false,
  "metrics": { "totalSpendCents": null, "totalLeads": null, "campaigns": [] },
  "contract": "..." } }
```
Once integrated: `metrics: { totalSpendCents: number, totalLeads: number,
campaigns: [{ campaignId, name, spendCents, leads }] }`.

## Alerts

Rule rows: `metric` (any KPI key) + `threshold` + `direction`
(`above`/`below`) + `enabled`. Evaluation happens **on demand** via
`GET /alerts/evaluate` against the live aggregations (strict inequalities:
`above` ⇒ `value > threshold`, `below` ⇒ `value < threshold`). Disabled
rules are skipped; unavailable metrics report `available: false` and never
trigger. Each triggered rule emits `dashboard.alert.triggered`.

## Events emitted

| Event | Payload |
|---|---|
| `dashboard.config.updated` | `{ widgetKeys: string[] \| null, reset?: true }` |
| `dashboard.alert.created` | `{ alertId, metric }` |
| `dashboard.alert.updated` | `{ alertId }` |
| `dashboard.alert.deleted` | `{ alertId }` |
| `dashboard.alert.triggered` | `{ alertId, metric, value, threshold, direction }` |

All mutations are audited (`dashboard.widget_config`, `dashboard.alert_rule`
entity types), actor = `x-user-id` header when present, else `system`.

## Owned tables

- `dashboard_widget_configs` — `(tenant_id, widget_key)` unique; position,
  enabled (0/1), settings JSON.
- `dashboard_alert_rules` — name, metric, threshold (REAL), direction,
  enabled (0/1).

## Testing

```
cd <repo root> && npx vitest run packages/dashboard
```

Fixtures create minimal versions of the cross-module tables matching the
documented read contracts (plus extra columns, proving wider real schemas
are fine) — see `test/fixtures.ts`. Coverage: migrations (fresh +
idempotent), every aggregation against seeded data, date filtering, tenant
isolation/denial, graceful degradation, event emission, config + alert CRUD
through the router, export (JSON + CSV), KPI endpoint, HTML rendering and
escaping.
