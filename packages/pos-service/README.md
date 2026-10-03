# @blacklabel/pos-service

Done-for-you point of sale on Stripe Connect. A merchant buys the service, and this module takes them
from purchase to a live card reader:

1. Creates the merchant's own Stripe account and a Stripe-hosted verification link.
2. Follows Stripe's review, and creates the store location once card payments are active.
3. Tracks the card reader order to the merchant's door.
4. Registers the reader, so only a Stripe Reader S700 or BBPOS WisePOS E is kept.
5. Runs a $1 test sale on the real reader, captures it, refunds it, and marks the merchant live.

Every step is recorded, audited, and emitted as an event. Customer messages are **prepared, never sent**.
Whoever owns the customer relationship sends them and marks them sent.

## How the money works

Black Label is the Connect platform. Every figure below was checked on the source page on 2026-09-15.

| Item | Setting or figure | Source |
|---|---|---|
| Account owner | The merchant owns payments, refunds, disputes, and readers (direct charges) | [Direct charges](https://docs.stripe.com/connect/direct-charges) |
| Card processing | Stripe charges the merchant directly: 2.7% + 5¢ in person | [Stripe pricing](https://stripe.com/pricing) |
| Platform cost | "No fees for your platform" when Stripe handles pricing | [Connect pricing](https://stripe.com/connect/pricing) |
| Negative balances | Stripe carries losses (`losses_collector: stripe`) | [Accounts v2 create](https://docs.stripe.com/api/v2/core/accounts/create) |
| Merchant dashboard | Full Stripe Dashboard | [Accounts v2](https://docs.stripe.com/connect/accounts-v2) |
| Card reader | Stripe Reader S700, $299 | [S700](https://stripe.com/terminal/s700) |
| Our processing fee | Off by default (`platformFee` 0). When set, it is a Connect application fee and is refunded with the test sale | `src/service.ts` |

The TEC catalog already lists the point-of-sale package at $39 per installation per month. That is 20%
below Square Plus at $49, and the sources are in `blacklabel-systems/src/data/pricing.json`. Square
advertises "No setup charges, monthly subscription, hidden fees, or long-term contracts required" for its
free plan, so a setup fee 20% below Square's is $0
([Square, Dec 19 2025](https://squareup.com/us/en/the-bottom-line/operating-your-business/free-pos-software)).
The done-for-you service is **not listed for sale** until the founder-gated steps below are done and a
real reader has passed a live test sale.

## Lifecycle

| Stage | Who acts | What moves it |
|---|---|---|
| `purchased` | Customer | `POST /merchants` (idempotent per purchase reference) |
| `account_created`, `onboarding` | Automatic | `POST /merchants/:id/onboarding` creates the v2 account and a hosted link |
| `verified` | Stripe | Account webhook or `POST /merchants/:id/sync` sees `card_payments` active |
| `location_ready` | Automatic | Terminal location created on the merchant account |
| `reader_ordered`, `reader_shipped`, `reader_delivered` | Stripe | Hardware order webhook, or an operator posts the Dashboard order to `/hardware-orders` |
| `reader_registered` | Customer | `POST /merchants/:id/readers` with the code shown on the reader |
| `test_sale` | Customer | `POST /merchants/:id/test-sale` puts $1 on the reader |
| `live` | Automatic | Approved card is captured and refunded (reader webhook, payment webhook, or `/test-sale/advance`) |

Blocks never move a stage backwards. These codes block a merchant: `requirements_due`, `stripe_review`,
`card_payments_unsupported`, `incompatible_reader`, `hardware_order_canceled`, `hardware_undeliverable`,
and `test_sale_refund_incomplete`.

The test sale follows Stripe's server-driven reader guidance
([collect card payments](https://docs.stripe.com/terminal/payments/collect-card-payment?terminal-sdk-platform=server-driven)):

- A reader waiting for a tap is `requires_payment_method` and is not a failure. Only `last_payment_error` or a reader failure marks the sale failed.
- A retry cancels the failed PaymentIntent before creating a new one, so the declined one can never be charged.
- A card approved after a reader connection error is captured and refunded instead of charged again.
- `POST /test-sale/cancel` calls the reader's `cancel_action`. A reader busy authorizing a card is never interrupted.
- If the refund does not complete, the merchant is blocked. After a hand refund in the Stripe Dashboard, `/test-sale/advance` finishes go-live without refunding twice.

## API

Mounted at `/api/pos-service`. Every route needs `x-tenant-id`, and bodies are validated strictly.

| Method and path | Purpose |
|---|---|
| `GET /config` | Whether Stripe and webhooks are configured, mode, fee, test amount, supported readers |
| `GET /merchants` | Paginated summaries, without contact details or messages |
| `POST /merchants` | Record a purchase: 201 new, 200 replay |
| `GET /merchants/:id` | Full record plus the customer checklist |
| `POST /merchants/:id/onboarding` | Create the Stripe account once and issue a fresh verification link |
| `POST /merchants/:id/sync` | Re-read the Stripe account |
| `POST /merchants/:id/hardware-orders` | Record a Terminal hardware order snapshot |
| `POST /merchants/:id/readers` | Register a reader by registration code |
| `POST /merchants/:id/test-sale` | Start the go-live test sale |
| `POST /merchants/:id/test-sale/advance` | Re-check the test sale with Stripe |
| `POST /merchants/:id/test-sale/cancel` | Stop a test sale the reader is still waiting on |
| `POST /merchants/:id/messages/:messageId/sent` | Record that a prepared message was sent |
| `POST /webhooks/stripe` | Stripe events. Signature-verified against every configured destination secret |

Errors use the platform envelope. Stripe refusals return 502 `stripe_error` with Stripe's status, code,
message, and request id. Without a Stripe client, Stripe routes return 501 `stripe_not_configured` and
reads still work.

## Events

Payloads carry ids, stages, and codes only. They never carry names, emails, addresses, links, or message bodies.

- `pos_service.merchant.created` `{ v, merchantId, livemode }`
- `pos_service.merchant.stage_changed` `{ v, merchantId, from, to }`, one per lifecycle step
- `pos_service.merchant.blocked` `{ v, merchantId, code }`
- `pos_service.message.prepared` `{ v, merchantId, messageId, kind }`

## Stripe event destinations

Point each destination at `POST /api/pos-service/webhooks/stripe` and pass every signing secret in
`webhookSecrets` ([event destinations](https://docs.stripe.com/event-destinations),
[Connect webhooks](https://docs.stripe.com/connect/webhooks)).

| Destination | Events | Notes |
|---|---|---|
| Thin, platform | `v2.core.account[configuration.merchant].capability_status_updated` and other `v2.core.account*` events | Every `v2.core.account*` event triggers an account sync |
| Snapshot, connected accounts | `account.updated`, `payment_intent.amount_capturable_updated`, `payment_intent.payment_failed`, `terminal.reader.action_succeeded`, `terminal.reader.action_failed` | Events carry `account` and are matched to the merchant's Stripe account |
| Snapshot, platform | `terminal.hardware_order.*` | Only with Hardware Orders API access. Orders must carry `metadata.merchant_id` ([hardware orders](https://docs.stripe.com/api/terminal/hardware_orders)) |

Without Hardware Orders API access, order readers in the Stripe Dashboard
([order readers](https://docs.stripe.com/terminal/fleet/order-and-return-readers)) and post each order
snapshot to `/hardware-orders`.

## Wiring (integrator-owned, not applied)

`apps/api` is actively being changed by another session, and it serves the live bar register. Run the POS
service as its **own API instance** with its own database file and a dedicated tenant
(`PLATFORM_DEFAULT_TENANT_NAME`), so Stripe's webhook requests get the tenant header from single-tenant
mode. In `createApp`:

```ts
import { createStripeClient, posServiceMigrations, posServiceRouter, type PosServiceDatabase } from '@blacklabel/pos-service';

// migrations: [...coreMigrations, /* other modules */, ...posServiceMigrations]
app.route('/api/pos-service', posServiceRouter(deps<PosServiceDatabase>(), {
  stripe: options.posService?.secretKey
    ? createStripeClient({ secretKey: options.posService.secretKey, fetch: (url, init) => fetch(url, init) })
    : null,
  webhookSecrets: options.posService?.webhookSecrets ?? [],
  onboarding: { returnUrl: options.posService.returnUrl, refreshUrl: options.posService.refreshUrl },
}));
```

`server.ts` reads the key and secrets from the environment, because `createApp` stays env-free. The webhook
path authenticates by signature, so it must skip the browser, CSRF, and RBAC guards, the same way
`/api/orders/webhooks/*` does. Every other route belongs behind owner or admin RBAC.

## Founder-gated before the first real merchant

Nothing here can be done by code:

1. Enable Connect on the platform account with the settings above, complete the platform questionnaire, and accept Stripe's Connect platform terms. Until then, Stripe's Accounts v2 reference documents these refusals for account creation:
   - `platform_registration_required`: the account has not signed up for Connect.
   - `connect_profile_not_submitted`: the platform questionnaire is not complete.
   - `account_create_activation_required`: the platform is not activated.
2. Create the event destinations, and put the key and secrets in the POS service instance's environment.
3. Buy one Stripe Reader S700 for the internal live test, or ask Stripe for Hardware Orders API access.
4. Pick the pilot merchant. The customer relationship and every customer message stay with the founder.

## Verify

```bash
npx vitest run packages/pos-service
```

```bash
npx tsc -p tsconfig.json --noEmit --incremental false
```
