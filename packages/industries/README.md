# @blacklabel/industries

Configuration-first industry support for the BlackLabel Platform.
**A new industry is ONE config file — zero forked code.**

The platform core is industry-neutral. Everything industry-specific (lead
stages, quote templates, appointment types, dashboard widgets, workflow
automations, terminology) lives in a plain-data config in `src/configs/`.
Applying a config seeds a tenant with those defaults; UIs and other layers
read the applied state back through this module's REST API.

## Shipped configurations (12)

`construction`, `hvac`, `law-firm`, `medical-dental`, `music-audio`,
`real-estate`, `restaurant`, `service-delivery`, `smart-home-security`, `spa-wellness`,
`tack-retail`, `window-cleaning`

## Adding a new industry (no code, one file)

1. Create `src/configs/<your-industry>.ts` exporting a plain object
   (`satisfies IndustryConfig`).
2. Add one entry to the list in `src/configs/index.ts`.

That's it. The Zod loader validates the config on first use; if it's invalid
you get an `IndustryConfigError` listing **every** violation (dotted path +
message), and the module refuses to serve it.

## Config file format

```ts
import type { IndustryConfig } from '../config';

export const petGroomingConfig = {
  key: 'pet-grooming',              // kebab-case, unique
  label: 'Pet Grooming',
  description: 'Mobile and salon pet grooming.',

  // Flat map: core-term -> display-term. MUST cover every CORE_TERM:
  // lead, customer, quote, job, appointment, invoice, team_member.
  // Extra terms are allowed.
  terminology: {
    lead: 'Inquiry',
    customer: 'Pet Parent',
    quote: 'Quote',
    job: 'Groom',
    appointment: 'Grooming Appointment',
    invoice: 'Invoice',
    team_member: 'Groomer',
  },

  // Default CRM pipeline, in order (min 2, unique snake_case keys).
  leadStages: [
    { key: 'new', label: 'New Inquiry' },
    { key: 'booked', label: 'Booked' },
  ],

  // Default quote/service templates. Money is INTEGER CENTS, always.
  quoteTemplates: [
    {
      key: 'full_groom',
      name: 'Full Groom',
      description: 'Bath, cut, nails.',        // optional
      lines: [
        { description: 'Full groom (per pet)', quantity: 1, unitPriceCents: 8500 },
      ],
    },
  ],

  // Default appointment types (whole minutes).
  appointmentTypes: [
    { key: 'groom', label: 'Grooming Session', durationMinutes: 90 },
  ],

  // Default dashboard widget set, in display order.
  // type: 'metric' | 'list' | 'chart' | 'feed'; config is free-form JSON.
  dashboardWidgets: [
    { key: 'bookings_today', title: 'Bookings Today', type: 'list',
      config: { source: 'appointments', range: 'day' } },
  ],

  // Default workflow automations (workflow-definition JSON).
  // trigger MUST be a valid platform event name (module.entity.verb).
  workflows: [
    {
      key: 'inquiry_reply',
      name: 'Reply to new inquiries',
      trigger: 'crm.lead.created',
      actions: [
        { type: 'send_message', params: { channel: 'sms', template: 'inquiry_ack' } },
      ],
    },
  ],
} satisfies IndustryConfig;
```

### Loader & validation

- `validateIndustryConfig(raw)` → `{ ok: true, config }` or
  `{ ok: false, violations }` — never throws.
- `parseIndustryConfig(raw, source?)` → typed config, or throws
  `IndustryConfigError` whose `.violations` is `[{ path, message }, ...]`
  covering **all** problems (structural Zod issues *and* semantic checks:
  core-term coverage, duplicate keys) in one pass.
- `industryConfigSchema` — the Zod schema itself, exported.

## Terminology mapping

A flat map `core-term -> display-term` available to UIs (e.g. `job` →
"Job" / "Matter" / "Project" / "Session"). The current business workspace
displays this configured map in Industry setup; other screens retain their
generic record labels until they explicitly consume this mapping.

- Core terms (must all be mapped): `lead`, `customer`, `quote`, `job`,
  `appointment`, `invoice`, `team_member` (exported as `CORE_TERMS`).
- Helper: `termFor(terminology, coreTerm)` — falls back to the core term
  itself when unmapped, so UIs never render `undefined`.
- At runtime, a tenant's map is served by `GET /terminology` and stored in
  `industries_tenant_settings.terminology` (JSON).

## Applying an industry

```ts
await applyIndustry(db, tenantId, 'window-cleaning', { events, actor: userId });
```

- Validates the industry key (404 for unknown keys).
- Seeds the tenant's defaults into this module's tables (below) inside a
  transaction.
- **Idempotent:** rows are keyed by `(tenant_id, key)` — re-applying the same
  industry updates rows in place (stable ids); switching industries updates
  matching keys and deletes stale defaults from the previous industry.
- Audits every application (`industries.industry.applied`, actor defaults to
  `"system"`).
- Emits the `industries.industry.applied` event (payload `{ industryKey }`)
  when an `EventBus` is provided — the router always provides `deps.events`.

## Table contracts (what apply writes)

All tables carry `tenant_id` and every query filters by it. Money is integer
cents; booleans are 0/1 integers; JSON is serialized text; timestamps are
ISO-8601 UTC. Consumers outside this package read this state through the
REST API — never via cross-module SQL.

| Table | Contents | Notable columns |
|---|---|---|
| `industries_tenant_settings` | One row per tenant: applied industry + terminology | `industry_key`, `terminology` (JSON map), `applied_at` |
| `industries_lead_stages` | Default CRM pipeline stages, ordered | `key`, `label`, `sort_order` |
| `industries_quote_templates` | Default quote/service templates | `key`, `name`, `description`, `lines` (JSON `[{description, quantity, unitPriceCents}]`) |
| `industries_appointment_types` | Default appointment types | `key`, `label`, `duration_minutes`, `description` |
| `industries_dashboard_widgets` | Default dashboard widget set, ordered | `key`, `title`, `widget_type`, `config` (JSON), `sort_order` |
| `industries_workflow_definitions` | Default workflow automations | `key`, `name`, `trigger` (event name), `definition` (full workflow JSON), `enabled` (0/1) |

Each `(tenant_id, key)` pair is unique per table.

## REST API (mounted at `/api/industries`)

Every request needs the `x-tenant-id` header (core tenant middleware).

| Method & path | Purpose |
|---|---|
| `GET /` | List available industries — `{ data: [summary...], limit, offset }` |
| `GET /applied` | This tenant's applied state (404 if none applied) |
| `GET /terminology` | This tenant's terminology map (404 if none applied) |
| `GET /:key` | Full config of one available industry (404 unknown) |
| `POST /:key/apply` | Apply defaults to this tenant. Optional JSON body `{ "actor": "<userId>" }` |

Success envelopes: `{ data: ... }` (single) / `{ data, limit, offset }`
(lists). Errors: `{ error: { message, code, details } }`.

## Events

| Event | When | Payload |
|---|---|---|
| `industries.industry.applied` | After an industry's defaults are (re)applied to a tenant | `{ industryKey }` |

## Module surface

- `industriesMigrations` — register after `coreMigrations`.
- `industriesRouter(deps)` — Hono router factory (`ModuleDeps<IndustriesDatabase>`).
- `listIndustries()`, `getIndustryConfig(key)` — validated config registry.
- `applyIndustry`, `getAppliedIndustry`, `getTerminology` — services.
- `seedIndustries(db, tenantId, industryKey?, events?)` — demo seed helper.
- Config tooling: `industryConfigSchema`, `parseIndustryConfig`,
  `validateIndustryConfig`, `IndustryConfigError`, `CORE_TERMS`, `termFor`.

## Tests

```
cd <repo root> && npx vitest run packages/industries
```

Focused checks cover loader validation (every violation reported), all shipped
configs validated, integer-cent money through core's `computeTotals`,
apply idempotency + industry switching, terminology lookup, event emission,
audit, migration idempotency, and tenant-isolation denial tests at both the
service and router layers.

## Runtime provisioning in the business composition

The business API composes `industriesRouter(deps, {installRuntime})` with
`businessIndustryRuntime`. An explicit apply creates real CRM stages, real Quoting
templates, and supported Workflows recipes, then saves source IDs/readback receipts in
`industries_runtime_receipts`. `GET /applied` includes `runtime.available`, the last
checked time, and per-component outcomes. A configuration-only installation reports
that runtime targets have not been verified. The existing appointment-type contract
continues to provision bookable Scheduling types.

Reapplying never overwrites owner stage, template, or workflow edits. An owner-deleted
target remains missing. Concurrent applies to one company return an explicit conflict.
Quote creation and its provenance receipt share a transaction; workflow installation uses
a stable tenant recipe key. Switching setups pauses untouched earlier task recipes and
retains edited owner recipes without installing a second handler for the same event.
Runtime receipts describe preserved custom configuration separately from installed defaults.
Previously paused targets stay paused when returning to a setup; review and explicitly
enable the desired recipe in Workflows. Reapplying setup never infers authorization to
reactivate a paused owner target.

Only bounded `create_task` recipes with supported event triggers are provisioned by this
bridge. External message, webhook, and unsupported definitions stay disabled and are
reported as `unsupported`. Applying setup does not send messages, collect payments, or
automatically convert a quote to billable work. Arbitrary dashboard definitions remain a
read model; the working Overview action queue/basic reports are supplied by Dashboard.

`service-delivery` is a domain-neutral inquiry → scope → job → closeout starting flow.
It installs source-linked follow-up tasks. Its zero-price placeholder template is saved
inactive and explicitly requires an owner to enter agreed quantities/rates and enable it.
Appointment durations/resources also require company-specific review. Existing vertical
template rates are configuration examples, not validated market prices or promised gains.

Focused verification: `npm test -- packages/industries/test apps/api/test/business-industry-wiring.test.ts`.
The composition test boots `createApp({businessPortals:true})`, applies the neutral setup,
reads actual module routes, and exercises the real lead event → linked task path. Separate
browser, independent buyer/device, willingness-to-pay, and founder acceptance evidence
are still required before treating the module as a released product.
