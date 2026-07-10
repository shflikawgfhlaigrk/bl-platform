# BlackLabel Platform — CONVENTIONS

**Read this whole file before writing any code.** Every module agent builds against
these rules; the orchestrator rejects work that violates them. When this file and
your instincts disagree, this file wins.

The scaffold already ships `@blacklabel/db` (SQLite + Kysely + migration runner)
and `@blacklabel/core` (tenancy, users, audit, event bus, errors, query/csv/money
helpers, contracts, custom fields) — **fully tested**. Build on them; never fork
or re-implement what core provides.

---

## 1. Repo layout & dependencies

```
packages/db        @blacklabel/db      database layer (DONE — do not modify)
packages/core      @blacklabel/core    shared kernel (DONE — do not modify)
packages/<module>  @blacklabel/<module>  one package per module (yours)
apps/api           @blacklabel/api     composition root (owned by the integrator)
```

Modules: `crm, scheduling, quoting, portal-customer, portal-employee, dashboard,
messaging, reviews, workflows, billing, files, industries`.

- **ALL third-party dependencies are declared at the ROOT `package.json` and are
  already installed**: `kysely, better-sqlite3, hono, @hono/node-server, zod,
  nanoid, luxon` (+ dev: `typescript, vitest, tsx, @types/*`).
  **NEVER run `npm install`, never add a dependency anywhere.** If you think you
  need a new package, you don't — write it or use core helpers.
- Import from workspace packages by bare name only: `@blacklabel/core`,
  `@blacklabel/db`. **No subpath imports** (`@blacklabel/core/src/...` is banned).
- Import `Kysely`/`sql` types **via `@blacklabel/db`** (it re-exports kysely), or
  `import type { Kysely } from 'kysely'` for type-only use.
- Run everything from the repo root: `npm test` (vitest), `npm run typecheck` (tsc -b).

## 2. File layout per module package

```
packages/<module>/
  package.json        already scaffolded — do not add dependencies
  src/
    schema.ts         row interfaces + `export interface <Module>Database extends CoreDatabase { ... }`
    migrations.ts     export const <module>Migrations: Migration[]
    service.ts        tenant-scoped business logic; audits every mutation; emits events
    router.ts         export function <module>Router(deps: ModuleDeps<<Module>Database>): Hono<TenantEnv>
    seed.ts           optional demo data helper: seed<Module>(db, tenantId)
    index.ts          re-export ONLY: migrations, router factory, public types, contract impls
  test/
    *.test.ts         vitest; REQUIRED coverage listed in §10
```

Multi-word module keys use camelCase in identifiers: `portal-customer` →
`portalCustomerMigrations`, `portalCustomerRouter`, `PortalCustomerDatabase`.

## 3. Database & migrations

- Get a db in tests with `createTestDb<YourDatabase>()`; the api app owns the
  real file db via `createDb(path)`.
- Register migrations by exporting a `Migration[]`:

```ts
import type { Migration } from '@blacklabel/db';

export const crmMigrations: Migration[] = [
  {
    name: 'crm.0001_leads',              // <module>.<NNNN>_<description> — globally unique
    up: async (db) => {
      await db.schema.createTable('crm_leads')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        // ...
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema.createIndex('crm_leads_tenant_id_idx')
        .on('crm_leads').column('tenant_id').execute();
    },
  },
];
```

- **Table names are prefixed with the module key** (`crm_leads`,
  `billing_invoices`, `portal_employee_shifts`). Only `core` owns unprefixed
  tables (`tenants`, `users`, `audit_log`, `custom_field_definitions`).
- Migrations are **append-only**: never edit, rename, or reorder a migration
  after it exists. New change = new migration appended to the array.
- Every test sets up with: `await runMigrations(db, [...coreMigrations, ...<module>Migrations])`.
  The runner is idempotent and keeps bookkeeping in `_migrations` — don't touch
  that table.
- **Every table with `tenant_id` gets an index on `tenant_id`** (compound
  indexes starting with `tenant_id` also satisfy this).

## 4. Portable SQL rules

Target is SQLite today, Postgres someday. Stay portable:

- ids: `text` primary keys generated in code by `id()` — **never AUTOINCREMENT,
  never rowid, never DB-generated ids**.
- timestamps: `text`, ISO-8601 UTC from `nowIso()` (`2026-07-10T18:04:05.123Z`).
  Never epoch integers, never `CURRENT_TIMESTAMP` defaults, never local time.
  Use `luxon` for date math in code; store the `.toISO()` UTC string.
- booleans: `integer` 0/1 in the DB; convert at the service boundary.
- money: `integer` cents (§7). Never REAL/float for money.
- JSON: serialized to `text` in code (`JSON.stringify`/`JSON.parse`).
- Use the Kysely query builder. Raw `sql` template fragments only when the
  builder genuinely can't express it, and then ANSI-portable SQL only — no
  SQLite-specific functions/pragmas in module code, no `ON CONFLICT` upserts
  (check-then-insert like core's custom-fields service), no triggers, no views.
- Deterministic ordering: every list query has an `orderBy`, with a final
  `.orderBy('id')` tiebreaker.

## 5. Tenancy — the iron rule

Every module table carries `tenant_id text not null`. Every query — select,
update, delete, count — filters `where('tenant_id', '=', tenantId)`. No
exceptions, ever, including "internal" lookups.

Router usage (already provided by core):

```ts
import { tenantMiddleware, errorHandler, asCoreDb, type TenantEnv } from '@blacklabel/core';

export function crmRouter(deps: ModuleDeps<CrmDatabase>): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(deps.db)));
  app.get('/leads', async (c) => {
    const tenantId = c.get('tenantId');   // THE ONLY SOURCE OF TENANT
    // ...
  });
  return app;
}
```

- The middleware reads the `x-tenant-id` header → 400 if missing, 404 if the
  tenant doesn't exist, else `c.set('tenantId', ...)`.
- **Never** accept a tenant id from the body, query string, or path. Never let
  a client-supplied `tenant_id` field pass through into a row.
- **Required denial tests** (§10): create data in tenant A, then prove tenant B
  gets `404`/empty on read, `404` on update/delete, and that A's data is
  untouched. Core's `service.test.ts` shows the pattern.

## 6. Router factories & composition

- Signature (types from core):
  `export function <module>Router(deps: ModuleDeps<YourDatabase>): Hono<TenantEnv>`
  where `ModuleDeps = { db: Kysely<DB>; events: EventBus; contracts: Contracts }`.
- Routers **receive** their dependencies. They never create databases, never
  `new EventBus()` (outside tests), never import another module.
- `apps/api` (integrator-owned) mounts each router at `/api/<module-key>` and
  wires real contract implementations. You don't edit `apps/api`.
- Validation: parse request bodies with `zod` schemas; thrown `ZodError` is
  converted by `errorHandler` to 400.
- Errors: throw `ApiError` (`ApiError.notFound()`, `.badRequest()`,
  `.conflict()`, ...) from services; register `app.onError(errorHandler)`.
  Canonical error envelope: `{ "error": { "message", "code", "details" } }`.
- Success envelopes: single entity → `{ "data": {...} }`; lists →
  `{ "data": [...], "limit": n, "offset": n }`.
- Pagination/sort/filter: use core's `parsePagination`, `parseSort` (whitelist
  columns!), `parseFilters` on `c.req.query()`.

## 7. Money

- All amounts are **integer cents** stored in `integer` columns named `*_cents`.
- Percentages are **basis points** (`bps`, 10000 = 100%) in columns named `*_bps`.
- A discount is `{ bps?, fixedCents? }` — percent applied first, then fixed.
- **Order of application: line discounts → quote/order-level discount → tax.**
- Rounding: `Math.round` at each money-producing step; totals never go below 0.
- **Use core's `applyDiscount` / `computeTotals`** — quoting, billing, and
  dashboard must all agree to the cent, so nobody re-implements this math.

## 8. Events

- The `EventBus` (from core, injected via `ModuleDeps.events`) is in-process
  and typed: `emit(tenantId, type, payload)`, `on(type, handler)` (`'*'` =
  everything), `on` returns an unsubscribe function.
- **Naming: `module.entity.verb`** — lowercase, dot-separated, exactly three
  segments, past-tense verb, underscores allowed inside segments
  (`portal_employee.shift.clocked_in`). `emit` throws on malformed names.
- Emit **after** the DB write succeeds, from the service layer.
- Handler failures are isolated: a throwing handler can't break `emit` or other
  handlers; failures come back in the `EmitResult`. Handlers must therefore be
  safe to be the "surviving" handler — keep them idempotent.
- The workflows module is the primary subscriber (automations run off these).

### Planned events catalog

| Event | Emitted by | Payload (minimum) |
|---|---|---|
| `crm.lead.created` | crm | `{ leadId }` |
| `quoting.quote.approved` | quoting | `{ quoteId, customerId, totalCents }` |
| `quoting.quote.converted` | quoting | `{ quoteId, invoiceId }` |
| `scheduling.appointment.scheduled` | scheduling | `{ appointmentId, customerId, startsAt }` |
| `scheduling.appointment.completed` | scheduling | `{ appointmentId }` |
| `scheduling.appointment.canceled` | scheduling | `{ appointmentId, reason? }` |
| `billing.invoice.paid` | billing | `{ invoiceId, customerId, totalCents }` |
| `reviews.review.submitted` | reviews | `{ reviewId, rating }` |
| `workflows.task.completed` | workflows | `{ taskId }` |
| `workflows.task.overdue` | workflows | `{ taskId, dueAt }` |
| `messaging.message.received` | messaging | `{ messageId, channel, from }` |
| `portal_employee.shift.clocked_in` | portal-employee | `{ shiftId, userId, at }` |
| `portal_employee.shift.clocked_out` | portal-employee | `{ shiftId, userId, at }` |

Payloads are plain JSON: id strings, ISO timestamps, integer cents. Add module-
internal events freely under the same naming rules; list them in your package's
index.ts doc comment.

## 9. Cross-module rules

- **Reference other modules' entities by id string only.** No cross-module SQL
  foreign keys, no joins into another module's tables, no importing another
  module's services, schema, or types.
- Cross-module **actions** go through the contract interfaces in core
  (`CreateTaskContract`, `CreateAppointmentContract`, `CreateInvoiceContract`,
  `SendMessageContract`), received via `deps.contracts` — always optional:
  if a contract is absent, degrade gracefully (skip or 501), never import the
  module directly. If you IMPLEMENT one of these (workflows→tasks,
  scheduling→appointments, billing→invoices, messaging→messages), export the
  implementation from your index.ts so apps/api can wire it.
- Cross-module **reactions** go through events (§8).
- **`dashboard` is the ONLY package allowed to read across module tables**, and
  it is strictly read-only (aggregation queries). Every other module touches
  only its own `<module>_*` tables plus core tables via core services.
- Audit (`audit(db, tenantId, actor, action, entityType, entityId, diff)`) on
  every mutating service operation. `entityType` is namespaced:
  `"crm.lead"`, `"billing.invoice"`, etc. `actor` is a user id or `"system"`.
- Custom fields: definitions live in core (`defineCustomField` /
  `listCustomFields`, entity types like `"crm.lead"`). Modules store the values
  themselves — recommended: a `custom text` JSON column on the entity row, keys
  = definition keys.

## 10. Testing requirements (ship gate)

Vitest from the repo root picks up `packages/**/test/**/*.test.ts` and
`apps/**/test/**/*.test.ts`. A module is DONE only when `npm test` and
`npm run typecheck` are green from the root, and its suite includes at least:

1. Migrations apply on a fresh `createTestDb()` (with `coreMigrations` first)
   and are idempotent on re-run.
2. CRUD happy paths through the ROUTER (`app.request(...)` — no server needed),
   with the `x-tenant-id` header.
3. **Tenant-isolation denial tests** for every entity (see §5).
4. Event emission asserted for every catalog event you own (subscribe in the
   test, assert payload).
5. Contract implementations (if any) exercised directly.
6. Money math asserted to the cent (if your module touches money) — via core's
   `computeTotals`.

Test dbs are in-memory; never write files in tests. Never test against
`.storage/` or a shared db.

## 11. ids & time (recap)

- `id()` → nanoid string. All ids everywhere. Never expose rowids.
- `nowIso()` → ISO-8601 UTC text. All timestamps everywhere.
- Columns: `created_at` required on every table; `updated_at` optional but
  update it if you have it.

---

*Scaffold committed 2026-07-10. db + core are tested and frozen; direct
questions about changing them to the orchestrator instead of editing.*
