# @blacklabel/quoting

Universal, industry-neutral quoting/estimate engine for the BlackLabel
Platform. Window cleaning, HVAC, roofing, plumbing, construction, spa
packages, custom services — the engine has no industry knowledge; industry
flavor lives entirely in seed/tenant data.

## Objects

| Object | Table | Notes |
|---|---|---|
| Quote | `quoting_quotes` | status, quote-level discount/tax snapshots, stored totals, margin, attachments, conversion linkage |
| QuoteLineItem | `quoting_quote_lines` | quantity (fractional OK), customer unit price, internal unit cost, per-line discount, effective (rule-adjusted) price |
| PricingRule | `quoting_pricing_rules` | data-driven conditional pricing (see below) |
| ServiceTemplate | `quoting_service_templates` | default line items + child template ids (bundles = template composed of templates) |
| Discount | `quoting_discounts` | named, reusable `{bps, fixed_cents}`; applied to a quote as a snapshot |
| Tax | `quoting_taxes` | named rate in bps; applied to a quote as a snapshot |
| ApprovalEvent | `quoting_approval_events` | e-signature-ready audit trail: signer name, ip, sha256 payload hash, per-quote sequence |

All tables carry `tenant_id`; every query filters by it.

## Pricing math

All money math delegates to core's `applyDiscount` / `computeTotals`
(integer cents, bps percentages, `Math.round` per step, clamped at 0):

1. **Line-scope pricing rules** compute an *effective unit price* per line
   (entered `unit_price_cents` is never mutated).
2. **`computeTotals`**: line totals + line discounts → subtotal →
   quote-level discount → tax.
3. **Quote-scope rule discounts** are folded into the quote-level discount as
   fixed cents, computed against the post-line-discount subtotal (percent
   part of the quote's own discount applies first, then all fixed cents).
4. **Margin**: `revenue = subtotal - discount` (pre-tax);
   `cost = Σ round(qty × unit_cost_cents)`;
   `margin_cents = revenue - cost`; `margin_bps = margin/revenue` (0 when
   revenue is 0). Margin may be negative — it's reporting, not a guard.

Totals are recomputed and stored on every quote mutation and once more on
`send`, so the sent/approved snapshot reflects the rules at that moment.

## Pricing rules (safe interpreter — no eval)

Rules are pure data: `conditions` (ALL must match) + one `action`.

```json
{
  "name": "5% off quotes over $500",
  "scope": "quote",
  "conditions": [{ "field": "subtotal_cents", "op": "gte", "value": 50000 }],
  "action": { "type": "percent_discount", "amount": 500 },
  "priority": 10
}
```

- Ops: `eq neq gt gte lt lte contains in`. Type-mismatched comparisons,
  unknown fields (`__proto__` included — own-property lookup only) and
  unknown ops simply don't match; malformed stored rules are skipped. A bad
  rule can never throw during pricing.
- `scope: "line"` fields: `description, quantity, unit_price_cents,
  unit_cost_cents, line_total_cents, service_template_id`. Actions:
  `percent_adjust` (signed bps), `fixed_adjust` (signed cents — surcharges
  live here), `set_price` (cents).
- `scope: "quote"` fields: `subtotal_cents, line_count, total_quantity,
  customer_id, status`. Actions: `percent_discount`, `fixed_discount`
  (discount-only by design; quote-level surcharges are modeled as lines).
- Rules run in `priority` (asc, ties by created_at) order and chain.

## Approval flow

`draft → sent → viewed → approved | declined | expired`

- Only `draft` quotes are editable (409 otherwise).
- Every transition writes an `ApprovalEvent` with a sha256 hash of the
  canonical quote payload (id, totals, lines, discount/tax setup) —
  `quotePayloadHash(quote, lines)` re-derives it for verification.
- `approve` requires `signerName`; `signerIp`/`note` optional.
- Quotes with `valid_until` in the past auto-expire on view/approve attempts
  (409 + `expired` status + event); `POST /quotes/:id/expire` expires manually.

## Convert quote → job

`POST /quotes/:id/convert` (approved quotes only, once):

- Returns a **job payload** (plain JSON API contract: customer id, title,
  lines at effective prices, discount as fixed cents equal to the approved
  quote's `discount_cents`, tax bps, totals, `sourceEntityType/Id`).
- If the `createInvoice` contract (billing module) is wired via
  `deps.contracts`, an invoice is created and its id stored on the quote;
  otherwise conversion still succeeds with `invoiceId: null` (graceful
  degradation, no cross-module import).
- Emits `quoting.quote.converted { quoteId, invoiceId }`.

## PDF generation — honest status

`QuoteDocumentProvider` is the pluggable rendering interface. This package
ships **only** the `HtmlQuoteDocumentAdapter` stub, which produces a
self-contained, print-ready HTML document (`GET /quotes/:id/document`,
`@page`/print CSS included — "print to PDF" works from any browser). A real
PDF-bytes adapter is **intentionally not implemented** here (would need a
headless browser or PDF library); implement the interface in `apps/api` or
an infra package and pass it in:

```ts
quotingRouter(deps, { documentProvider: myRealPdfAdapter });
```

## Attachments

`attachments` on a quote is a JSON array of **file id strings** referencing
the files module. This package never stores bytes; add/remove via
`POST /quotes/:id/attachments {fileId}` / `DELETE .../attachments/:fileId`.

## Events emitted

| Event | Payload |
|---|---|
| `quoting.quote.created` | `{ quoteId, customerId }` |
| `quoting.quote.sent` | `{ quoteId, customerId, totalCents }` |
| `quoting.quote.viewed` | `{ quoteId }` |
| `quoting.quote.approved` (catalog) | `{ quoteId, customerId, totalCents }` |
| `quoting.quote.declined` | `{ quoteId, customerId }` |
| `quoting.quote.expired` | `{ quoteId }` |
| `quoting.quote.converted` (catalog) | `{ quoteId, invoiceId }` |

## Endpoints (mounted at `/api/quoting` by apps/api)

```
POST   /quotes                       create (optionally from templateId and/or inline lines)
GET    /quotes                       list (?status= ?customer_id= ?limit= ?offset= ?sort=)
GET    /quotes/:id                   quote + lines + approval events
PATCH  /quotes/:id                   edit (draft only)
DELETE /quotes/:id                   delete (draft only)
POST   /quotes/:id/lines             add line
PATCH  /quotes/:id/lines/:lineId     edit line
DELETE /quotes/:id/lines/:lineId     remove line
POST   /quotes/:id/apply-template    append expanded template/bundle lines
POST   /quotes/:id/apply-discount    snapshot a named discount
POST   /quotes/:id/apply-tax         snapshot a named tax
POST   /quotes/:id/attachments       add file reference
DELETE /quotes/:id/attachments/:fileId
POST   /quotes/:id/send|view|approve|decline|expire
POST   /quotes/:id/convert           quote -> job (+ invoice via contract)
GET    /quotes/:id/document          print-ready HTML (document provider)
POST/GET/PATCH/DELETE /templates[/:id]
POST/GET/PATCH/DELETE /pricing-rules[/:id]
POST/GET/DELETE       /discounts[/:id]
POST/GET/DELETE       /taxes[/:id]
```

Tenancy: `x-tenant-id` header via core middleware (the only tenant source);
optional `x-user-id` header sets the audit actor (defaults to `system`).

## Seed data

`seedQuoting(db, tenantId)` creates example **data** (the engine stays
neutral): window-cleaning templates + a bundle, spa templates + a bundle
("Deluxe Spa Day Package" = own line + massage + facial), a quote-scope
volume-discount rule, a line-scope high-quantity rule, a reusable "new
customer" discount and a standard tax rate.

## Tests

`npx vitest run packages/quoting` — 40 tests: migrations (idempotency),
pricing math to the cent (line/quote discounts, tax, rounding, clamping,
fractional quantities, margin incl. negative), rule interpreter (ops, type
guards, prototype-key safety, priority chaining, malformed-rule tolerance),
approval flow (transitions, signer/hash capture, auto-expiry, event
payloads), full router CRUD, template bundles (incl. cycle tolerance),
conversion with/without the billing contract, and tenant-isolation denial
tests for every entity.

## Scope, versions and handoff integrity

`GET /quotes/:id` returns `payloadHash`; customers submit that value as
`expectedPayloadHash` when approving or declining. The connected customer portal
requires it and displays work lines, scope notes, tax, discounts, expiry and
version before acceptance. Outdated scope returns 409; absent portal preconditions
return 400. An offered quote cannot change price, work, notes or attachment ids.
New approval events retain an immutable full-scope JSON snapshot and SHA-256 hash.
Legacy evidence keeps its original pricing-only hash and a null full-scope
snapshot; old notes/files cannot be retroactively proved from that evidence.

`POST /quotes/:id/revise` creates a separate editable draft version from an
unaccepted offer, keeps the prior offer and evidence, and closes the prior offer.
A repeated revision request returns the same replacement. Accepted or converted
work cannot be revised through this route; it needs a separately approved change
quote. Sharing needs at least one positive-quantity work line. Expiry is checked
at the UTC instant, including the exact deadline.

The business composition converts an accepted quote into one CRM job and one
exact draft invoice in a single transaction. A failed local write rolls back the
invoice, invoice number, job and receipt. Retries read the saved ids and verify
invoice work lines, discounts, tax, amount and source linkage. The job retains a
readable accepted-work summary linked to the original quote. Subscriber errors
are returned as `eventDeliveryNeedsReview`; this is a review flag, not a durable
outbox or proof of external delivery.

The low-level module contract path claims a quote before invoking an opaque
invoice provider, preventing duplicate concurrent calls. An ambiguous failure
stays claimed for reconciliation instead of automatically issuing another
invoice. The business composition owns transactional local recovery. No real
payment or notification delivery is implied by these synthetic checks.
