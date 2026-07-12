# @blacklabel/workforce

RBAC-as-data (roles + permissions), scheduling, the payroll time-export lane,
and shift handoffs for Mags Commerce OS.

**Boundary:** `portal-employee` already owns employees, shifts, time entries,
and checklists. Workforce adds the ROLE/PERMISSION layer + scheduling + the
export lane, referencing portal-employee entities and core `users` **by id
string only** (no cross-module SQL/joins/imports). It **never** computes pay,
overtime, or legal rules.

## Tables (`workforce_` prefix)

| Table | Purpose |
|---|---|
| `workforce_roles` | roles; `key` unique per tenant; `builtin` roles are not deletable |
| `workforce_role_permissions` | role → permission grant rows |
| `workforce_user_roles` | core-user id → role assignments |
| `workforce_invitations` | email + role invites; sha256 token hash at rest; single-use, expiry, revoke |
| `workforce_session_policies` | per-tenant `max_age_hours` + `sessions_invalidated_after` cut-line |
| `workforce_schedules` | shifts (`shop\|show\|receiving\|fulfillment\|admin`), publish + conflict + override |
| `workforce_time_exports` | rendered payroll-adapter CSV of APPROVED rows (no pay math) |
| `workforce_handoffs` | shift handoffs with open-items JSON + acknowledge |

## Permission catalog (stable strings — route guards)

`catalog.read/write` · `inventory.read/write/count/transfer` ·
`shows.read/write/close` · `purchasing.read/write/approve` ·
`orders.read/write/refund` · `customers.read/write/export` ·
`outreach.read/write/approve/arm` · `finance.read/write/close` ·
`workforce.read/admin` · `admin.read/admin` · `actions.read/write` ·
`automation.read/admin` · `storefront.publish`

Each string is documented inline in `src/permissions.ts`. **Never rename one**
once shipped — a route guard depends on the literal. Add new permissions to the
END of `WORKFORCE_PERMISSIONS`.

## Built-in role → permission matrix (least-privilege)

Seeded by `seedBuiltinRoles(db, tenantId)` (idempotent; backfills missing
grants; never removes).

| Role | Permissions |
|---|---|
| **owner** | **everything** (all catalog strings) |
| **manager** | catalog.read/write · inventory.read/write/count/transfer · shows.read/write/close · purchasing.read/write/approve · orders.read/write/refund · customers.read/write/export · outreach.read/write/approve · finance.read · workforce.read · admin.read · actions.read/write · automation.read · storefront.publish |
| **cashier** | orders.read · orders.write · inventory.read · customers.read |
| **inventory** | inventory.read/write/count/transfer · catalog.read |
| **purchasing** | purchasing.read/write/approve · catalog.read · inventory.read |
| **fulfillment** | orders.read · orders.write · shows.read · inventory.read |
| **accountant_readonly** | every `.read` permission and **nothing else** — finance exports run behind `finance.read`. **No** write/count/transfer/close/approve/refund/export/arm/admin/publish anywhere. |

Owner-only privileges NOT granted to manager: `finance.write`, `finance.close`,
`outreach.arm`, `workforce.admin`, `admin.admin`, `automation.admin`.

## Permission checker + enforcement middleware

`can(db, tenantId, userId, permission)` unions permissions over all of a user's
roles → boolean (unknown permission strings never resolve true).

Enforcement is **built + tested here but wired by the integrator** per route
group (these back-office routes are trusted like every other module router):

```ts
import { requirePermission } from '@blacklabel/workforce';

const guard = requirePermission(deps.db);          // factory bound to the db
// getUserId resolves the acting user from the request (session, header, ...)
app.use('/purchasing/*', guard(getSessionUserId, 'purchasing.approve'));
app.use('/customers/export', guard(getSessionUserId, 'customers.export'));
```

- `401 unauthorized` when no acting user resolves.
- `403 forbidden` (canonical envelope `{ error: { message, code, details } }`)
  when the user's roles do not union to the permission.

## Time export lane (no pay math)

`exportApprovedTime(db, tenantId, actor, { adapter?, rows })` reshapes APPROVED
time rows (fed by the integrator from portal-employee) into an adapter CSV and
persists a `workforce_time_exports` record. The `generic_csv` adapter emits raw
fields only — `break_count` is an array length, **not** a duration. Register
future adapters (ADP/Gusto/…) via `registerPayrollAdapter`. **Pay, overtime,
worked-minutes, and legal rules are the downstream payroll system's job.**

## Router endpoints

`/roles` CRUD · `/roles/:id/permissions` grant/revoke · `/users/:id/roles`
assign/unassign · `/users/:id/permissions` · `GET /can` · `/invitations`
create/accept/revoke · `/session-policy` get/put + `/invalidate-all` ·
`/schedules` CRUD + `/publish` · `/time-exports` create/list + `/download` ·
`/handoffs` CRUD + `/acknowledge`.

Every mutation is audited (`audit(...)`, namespaced `entityType`, before/after
diffs on edits/grants). Every query is tenant-scoped.
