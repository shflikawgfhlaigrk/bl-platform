# Mags Commerce OS — Contract Registry (binding)

**v1.0 · 2026-07-12 · Owned by the orchestrator. Every module agent builds against this
file + CONVENTIONS.md + the relevant section of ~/MagsTack/MAGS-COMPLETE-BUILD-PROMPT.md.
When this file and the build prompt use different event names, THIS file's canonical
names ship (the EventBus enforces exactly 3 dot-segments).**

## 1. Package map

| Package (new) | Table prefix | Owns |
|---|---|---|
| `automation` | `automation_` | transactional outbox, idempotency registry, retries/backoff, dead letters, replay; typed rules (trigger/conditions/actions), policies `automatic\|approval_required\|disabled`, schedules, dry-run, execution history; event schema registry |
| `actions` | `actions_` | unified owner/staff action queue; derives actions from domain events; auto-resolve |
| `catalog` | `catalog_` | departments/categories/brands, products/variations (source ids preserved), barcodes (multi, normalized), price books, scheduled prices, promotions, kits/bundles, publication state, channel exclusions, CSV bulk lanes, label data |
| `inventory` | `inventory_` | locations, append-only movements, reservations, count sessions, transfers, damage/shrink, kit assembly, oversell policy, velocity/aging |
| `shows` | `shows_` | venues, show events, packing templates, manifests, load-out/scan-back, closeout |
| `vendors` | `vendors_` | suppliers, contacts, terms, vendor SKUs/costs/case packs/lead times, price-list import |
| `purchasing` | `purchasing_` | reorder policies + suggestions (printed formulas), POs, approvals, receiving, discrepancies, vendor bills, invoice matching |
| `orders` | `orders_` | unified orders/lines/tenders, checkout adapters (+simulator), fulfillment, pickup, shipping, returns/exchanges/refunds, gift-card tenders |
| `customers` | `customers_` | identity resolution over crm customer ids (merge evidence + undo), consent evidence, preferences, deterministic segments, restock requests, service cases |
| `loyalty` | `loyalty_` | deterministic earn/redeem, rewards, gift/store-credit liability ledgers, expiry, fraud controls |
| `outreach` | `outreach_` | SMTP/IMAP + provider adapters (+simulator), fixed templates, campaigns, transactional sends, suppressions, bounces, replies/threads, send-of-record, warmup caps, quiet hours, CAN-SPAM + armed gates |
| `finance` | `finance_` | fees, payout matching (coverage windows), cash close, COGS/margin (unknown stays unknown), vendor-bill matching, tax evidence, accountant exports |
| `workforce` | `workforce_` | roles/permissions (RBAC data), schedules, time clock, checklists, handoffs (reuse portal-employee where it already fits; reference by id only) |
| `admin` | `admin_` | integrations + credentials (AES-GCM at rest via node:crypto), import/export orchestration, health checks, diagnostics bundle, backup/restore orchestration |
| `storefront` | `storefront_` | public catalog/availability projection tables, publish pipeline, storefront server routes (public, read-only, no private-table reads) |

Existing packages: `retail` (Square historical import lane — extend, don't fork),
`crm` (customer rows of record — reference by id only), `portal-employee`,
`messaging`, `billing`, `dashboard`, etc. **Never edit `packages/core` or `packages/db`.**

## 2. Canonical event catalog (versioned; every payload includes `v: 1`)

Emit AFTER the DB write, from services. Names are exactly 3 segments.

| Canonical event | Build-prompt alias | Minimum payload (plus `v:1`) |
|---|---|---|
| `catalog.variation.changed` | same | `{ variationId }` |
| `catalog.publication.changed` | — | `{ itemIds: string[] }` |
| `inventory.count.completed` | same | `{ countSessionId, locationId }` |
| `inventory.stock.changed` | same | `{ variationId, locationId, delta, onHand, movementId, reason }` |
| `inventory.stock.below_reorder_point` | same | `{ variationId, locationId, onHand, reorderPoint }` |
| `inventory.transfer.closed` | same | `{ transferId, fromLocationId, toLocationId, discrepancyCount }` |
| `shows.show.scheduled` | `show.scheduled` | `{ showId, startsAt }` |
| `shows.packing.required` | `show.packing.required` | `{ showId }` |
| `shows.show.closed` | `show.closed` | `{ showId }` |
| `purchasing.purchase_order.approved` | `purchase_order.approved` | `{ purchaseOrderId, vendorId, totalCents }` |
| `purchasing.purchase_order.received` | `purchase_order.received` | `{ purchaseOrderId, receiptId }` |
| `orders.order.reserved` | `order.reserved` | `{ orderId }` |
| `orders.order.paid` | `order.paid` | `{ orderId, totalCents }` |
| `orders.order.fulfilled` | `order.fulfilled` | `{ orderId }` |
| `orders.order.returned` | `order.returned` | `{ orderId, returnId }` |
| `customers.consent.changed` | `customer.consent.changed` | `{ customerId, channel, state }` |
| `customers.restock.requested` | `customer.restock_requested` | `{ variationId, customerId? }` |
| `outreach.delivery.changed` | `message.delivery.changed` | `{ sendId, state }` |
| `finance.payout.reconciliation_failed` | `payout.reconciliation.failed` | `{ payoutId, deltaCents }` |
| `actions.action.created` | `action.created` | `{ actionId, kind }` |
| `actions.action.resolved` | `action.resolved` | `{ actionId }` |

Modules may add internal events under the same rules; document them in your
`index.ts` doc comment. Consumers MUST tolerate replay and duplicates
(idempotent handlers — see §4).

## 3. Cross-module integration (the only three lanes)

1. **Ids as strings.** Reference another module's entities by id string. No cross-module
   SQL, joins, imports, or FKs. (`dashboard` alone may read across tables, read-only.)
2. **Events.** Reactions to other modules = subscribe via `deps.events` in your router
   factory / a subscription-registration export the integrator wires. `actions` and
   `automation` are the primary '*' subscribers.
3. **Core contracts** (`deps.contracts`) where one of the four core contracts fits;
   absent contract → degrade gracefully (skip or 501).

`apps/api` is integrator-owned: module agents NEVER edit it. Export from your
`index.ts`: migrations, router factory, public types, and (if you have one) a
`register<Module>Subscriptions(deps)` function the integrator calls.

## 4. Idempotency & outbox patterns

- External/ repeatable inputs: dedicate a unique-keyed table
  (`<module>_idempotency` or a natural UNIQUE like outreach's `(recipient, subject)`),
  check-then-insert inside the same transaction as the effect. No `ON CONFLICT`.
- Event handlers: derive a deterministic idempotency key from the event payload
  (e.g. `movementId`), check-then-act.
- External side effects (email, provider calls, webhooks out): NEVER fire inline.
  Write an `automation_outbox` row (or your module's own delivery ledger for
  module-owned effects like outreach sends) with an idempotency key; a dispatcher
  with retry/backoff + dead-letter delivers. Policy (`automatic|approval_required|disabled`)
  gates the final side effect, not the feature's construction.

## 5. Hard rules (from the build prompt — enforced at review)

- Integer cents; `*_cents`. Basis points `*_bps`. `Math.round` per step. Core `computeTotals`.
- UTC ISO timestamps via `nowIso()`; business grouping `America/New_York` (luxon).
- Tenant-scope every query; denial tests per entity.
- `audit(...)` on every mutation with namespaced entityType (`"inventory.movement"`).
- Append-only operational ledgers (movements, sends, imports); no destructive business-history deletes — archive/void/cancel/compensate.
- No new npm deps. No AI anything at runtime. No network calls in module code
  (adapters expose interfaces; real transports live behind admin-configured
  credentials and are exercised in tests via simulators).
- Never fabricate stock/cost/venue/consent/identity/payment/tax/delivery data —
  missing data = explicit exception or setup state.
- Public storefront surfaces: no PII, no exact stock counts, no vendor costs,
  no credentials, no internal notes, no cross-brand references.
- Every list query ordered with `.orderBy('id')` tiebreaker. `id()` for ids.
- TDD; suite green from root (`npm test`, `npm run typecheck`) before returning.

## 6. New-package recipe

```
packages/<name>/package.json     (copy retail's, rename)
packages/<name>/src/{schema,migrations,service,router,index}.ts
packages/<name>/test/*.test.ts
ln -s ../../packages/<name> node_modules/@blacklabel/<name>   # runtime resolution
```
No root-file edits. tsconfig paths + vitest alias pick up `packages/*` by glob.

## 7. Dependency graph (build order)

```
core/db (frozen) → automation, actions, catalog, inventory   (wave 1 — parallel)
  → shows, vendors, purchasing, orders, customers, loyalty, outreach,
    finance, workforce, admin                                  (wave 2 — parallel)
  → storefront projection + import lane                        (wave 3)
  → apps/api integration + UI + PWA                            (wave 4)
  → real-tenant migration + 20 acceptance journeys             (wave 5)
```
