# @blacklabel/industries

Configuration-first industry support for the BlackLabel Platform.
**A new industry is ONE config file — zero forked code.**

The platform core is industry-neutral. Everything industry-specific (lead
stages, quote templates, appointment types, dashboard widgets, workflow
automations, terminology) lives in a plain-data config in `src/configs/`.
Applying a config seeds a tenant with those defaults; UIs and other layers
read the applied state back through this module's REST API.

## Shipped industries (10)

`construction`, `hvac`, `law-firm`, `medical-dental`, `music-audio`,
`real-estate`, `restaurant`, `smart-home-security`, `spa-wellness`,
`window-cleaning`

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

A flat map `core-term -> display-term` consumed by UIs: wherever a UI would
render a core term, it renders `terminology[coreTerm]` instead
(e.g. `job` → "Job" / "Matter" / "Project" / "Session").

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

48 tests: loader validation (every violation reported), all 10 shipped
configs validated, money asserted to the cent via core's `computeTotals`,
apply idempotency + industry switching, terminology lookup, event emission,
audit, migration idempotency, and tenant-isolation denial tests at both the
service and router layers.
