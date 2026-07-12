# @blacklabel/billing

Invoices, payments, subscriptions, and memberships for the BlackLabel
Platform. Industry-neutral, multi-tenant, built on `@blacklabel/core` +
`@blacklabel/db` per `/CONVENTIONS.md`.

## Objects

| Object | Table | Notes |
|---|---|---|
| BillingAccount | `billing_accounts` | A customer's billing profile (`customer_id` is an id-string reference to crm) |
| Invoice | `billing_invoices` | Numbered `INV-{seq}` per tenant; stores computed totals + `paid_cents` |
| InvoiceLineItem | `billing_invoice_lines` | Ordered lines with per-line discounts |
| Payment | `billing_payments` | Recorded payments; only `succeeded` rows count toward the invoice |
| Subscription | `billing_subscriptions` | Recurring-invoice placeholder: plan line + `interval` + `next_invoice_at` |
| Membership | `billing_memberships` | Customer ↔ plan link with a status |
| — | `billing_invoice_counters` | Per-tenant `INV-{seq}` sequence |
| — | `billing_webhook_events` | Raw provider webhook events + normalized outcome |

## Money math — shared with quoting

Billing does **not** implement its own discount/tax math. Both quoting and
billing call core's `computeTotals` / `applyDiscount`, so a quote and the
invoice it converts into agree **to the cent**:

- all amounts are integer cents; percentages are basis points (10000 = 100%)
- a discount is `{ bps?, fixedCents? }` — percent applied first, then fixed
- order of application: **line discounts → invoice-level discount → tax**
- `Math.round` at each money-producing step; totals never go below 0

Stored on the invoice: `subtotal_cents` (after line discounts),
`discount_cents` (removed by the invoice-level discount), `tax_cents`
(on the discounted subtotal), `total_cents`.

## Invoice status lifecycle

Status is **computed from recorded Payment rows vs the total**
(`computeInvoiceStatus`, exported):

```
draft ──send──> sent ──payment──> partial ──payment──> paid
                  │                  │
                  └──past due_at─────┴──> overdue  (still payable)
void: manual, terminal, only while unpaid
```

Precedence: `void > paid > draft > overdue > partial > sent`. "Overdue" is
time-dependent, so it lands on rows during mutations and via
`POST /invoices/refresh-overdue` (service: `markOverdueInvoices`), which a
scheduler should call periodically. Payments are rejected on `draft`, `void`,
and fully `paid` invoices; partial payments and overpayments are recorded
as-is. On the transition to `paid` the module emits the catalog event
`billing.invoice.paid { invoiceId, customerId, totalCents }` exactly once.

## Payment providers — Stripe-shaped, not Stripe-hardcoded

`src/providers.ts` defines the seam:

```ts
interface PaymentProvider {
  readonly key: string; // "manual" | "stub" | "stripe" | ...
  createPaymentIntent(input: CreatePaymentIntentInput): Promise<PaymentIntent>;
  recordWebhookEvent(event: ProviderWebhookEvent): Promise<WebhookOutcome>;
}
```

Shipped adapters:

- **manual** (offline): intents are "collect out-of-band, then record via
  `POST /invoices/:id/payments`"; webhooks are always ignored.
- **stub** (test double): Stripe-shaped intents (`pi_*` + `clientSecret`) and
  webhooks (`{ type: "payment_intent.succeeded", data: { object: { id,
  amount_received, metadata: { invoiceId } } } }`).

**Where a Stripe adapter slots in:** implement `PaymentProvider` with
`key: "stripe"` (createPaymentIntent → `stripe.paymentIntents.create`,
recordWebhookEvent → signature verification + event normalization to
`WebhookOutcome`) and pass it from `apps/api`:

```ts
billingRouter(deps, { providers: [...defaultPaymentProviders, stripeAdapter] });
```

No billing code changes needed. The service persists every raw webhook event
in `billing_webhook_events` and applies `payment_succeeded` outcomes as
recorded payments (actor `system`), which drives the normal status lifecycle
and `billing.invoice.paid`. Redelivered events are deduplicated by provider
ref: a `payment_succeeded` outcome whose `externalRef` already matches a
recorded payment (same tenant + provider) is stored as `ignored` instead of
double-counting the payment.

## Subscriptions (recurring-invoice placeholder)

A Subscription is one plan line (`plan_name`, `amount_cents`, `tax_bps`) plus
a schedule (`interval`: daily/weekly/monthly/quarterly/yearly,
`next_invoice_at`). `generateDueInvoices()` (router: `POST
/subscriptions/tick`) creates a **draft** invoice for every active
subscription with `next_invoice_at <= now` and advances `next_invoice_at` by
one interval **from its old value** (a lapsed schedule catches up one period
per tick, deterministically). Wire the tick to a scheduler in `apps/api`.

## Memberships

`billing_memberships` links a customer to a `plan_key` with a status
(`active | paused | canceled | expired`), optional `ends_at`, and an optional
link to the Subscription that bills it.

## Routes (mounted by apps/api at `/api/billing`)

| Method + path | Purpose |
|---|---|
| `POST /invoices` | Create draft invoice with line items (discounts/tax per shared math) |
| `GET /invoices` | List; filters `status`, `customer_id`, `portal_visible`; `?sort=` whitelist; paginated |
| `GET /invoices/export.csv` | CSV export of the tenant's invoices |
| `POST /invoices/from-quote` | Convert a quote payload (`quoteId`, `customerId`, lines, discounts, tax) into a draft invoice with `source_entity_type = "quoting.quote"` |
| `POST /invoices/refresh-overdue` | Flip past-due sent/partial invoices to `overdue` |
| `GET /invoices/:id` | Invoice + lines |
| `PUT /invoices/:id` | Edit a **draft** (replacing lines recomputes totals) |
| `DELETE /invoices/:id` | Delete a **draft** |
| `POST /invoices/:id/send` | draft → sent |
| `POST /invoices/:id/void` | Void an unpaid invoice |
| `POST /invoices/:id/payments` | Record a payment (drives partial/paid) |
| `GET /invoices/:id/payments` | Payments for one invoice |
| `POST /invoices/:id/payment-intents` | Create a provider intent for the remaining balance (`{ provider }`, default `manual`; unknown provider → 501) |
| `GET /payments` | All payments; filter `invoice_id` |
| `POST /payments/webhooks/:provider` | Ingest a provider webhook event |
| `POST /subscriptions` · `GET /subscriptions` · `GET/PUT /subscriptions/:id` | Subscription CRUD |
| `POST /subscriptions/tick` | `generateDueInvoices()` |
| `POST /memberships` · `GET /memberships` · `GET/PUT /memberships/:id` | Membership CRUD |
| `POST /accounts` · `GET /accounts` · `GET/PUT/DELETE /accounts/:id` | BillingAccount CRUD |

Tenancy comes exclusively from the `x-tenant-id` header via core's
`tenantMiddleware`; the optional `x-user-id` header sets the audit actor
(default `system`). Envelopes, pagination, and errors follow core.

### Customer-portal visibility

Invoices carry a `portal_visible` boolean (stored 0/1, converted at the
service boundary). The customer portal module should list only
`GET /invoices?portal_visible=1` for its customer.

## Events emitted

| Event | Payload |
|---|---|
| `billing.invoice.paid` *(catalog)* | `{ invoiceId, customerId, totalCents }` |
| `billing.invoice.created` | `{ invoiceId, customerId, totalCents }` |
| `billing.invoice.sent` | `{ invoiceId, customerId, totalCents }` |
| `billing.invoice.voided` | `{ invoiceId, customerId }` |
| `billing.invoice.generated` | `{ invoiceId, subscriptionId, customerId, totalCents }` |
| `billing.invoice.converted` | `{ invoiceId, quoteId }` |
| `billing.payment.recorded` | `{ paymentId, invoiceId, amountCents }` |
| `billing.subscription.created` | `{ subscriptionId, customerId }` |
| `billing.membership.created` | `{ membershipId, customerId, planKey }` |

## Contract implementation

`billingCreateInvoiceContract(db, events)` implements core's
`CreateInvoiceContract`; `apps/api` wires it into other modules'
`deps.contracts.createInvoice` (e.g. quoting's convert action).

## Seed & tests

- `seedBilling(db, tenantId, events?)` — demo account, draft/partial/paid
  invoices, an active due subscription, a membership.
- `npx vitest run packages/billing` — 46 tests: migrations idempotency,
  status math, money math to the cent vs core `computeTotals`, per-tenant
  numbering, lifecycle + `billing.invoice.paid` emission, overdue tick,
  subscription tick, quote conversion mapping, CSV export, provider adapters
  + webhooks (incl. duplicate-delivery dedup), contract impl, and
  tenant-isolation denials for every entity.
