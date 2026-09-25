# Point-of-sale production and operator runbook

This runbook covers the local, single-tenant POS served by `@blacklabel/api`. The API and UI bind to loopback only. Prices, promotions, tax, inventory location, reader identity, order status, drawer totals, and refunds are server-authoritative; browser totals and hardware messages are not proof of payment.

Money values in the API are integer cents. Tax and percentage discounts are integer basis points (`725` = 7.25%).

## Provision the tenant database

Install the locked dependencies from the repository root:

```bash
cd /Users/michaelbarber/BlackLabelPlatform
npm ci
```

`PLATFORM_DEFAULT_TENANT_NAME` must exactly match a tenant already present in the database. Starting the server seeds that tenant's owner and built-in roles, but it does not create a missing tenant.

For the existing Mags Square-ledger provisioning path, use an explicit database and storage directory:

```bash
export POS_STORAGE_DIR=/absolute/path/to/mags-platform-storage
export POS_DB_PATH="$POS_STORAGE_DIR/platform.db"
export MAGS_LEDGER_PATH=/absolute/path/to/MagsTack/ledger.db

PLATFORM_STORAGE_DIR="$POS_STORAGE_DIR" PLATFORM_DB_PATH="$POS_DB_PATH" \
  npm --workspace @blacklabel/api run import-square -- \
  --ledger "$MAGS_LEDGER_PATH" --tenant "Mags Tack" --industry tack-retail

PLATFORM_DB_PATH="$POS_DB_PATH" LEDGER_DB_PATH="$MAGS_LEDGER_PATH" \
  npm --workspace @blacklabel/api run seed-mags
```

Both imports are replay-safe. Keep the source ledger read-only and preserve the resulting SQLite database, storage directory, and admin key together in backups.

## Runtime environment

Core single-tenant settings:

| Variable | Production use |
| --- | --- |
| `PLATFORM_STORAGE_DIR` | Persistent directory for the database default, files, and generated admin key. Default is `./.storage`; set an explicit persistent path. |
| `PLATFORM_DB_PATH` | Persistent SQLite database. Default is `<storage>/platform.db`; `DB_PATH` is the legacy fallback. |
| `PLATFORM_DEFAULT_TENANT_NAME` | Exact existing tenant name, for example `Mags Tack`. Enables server-side tenant selection for the owner UI and webhooks. |
| `UI_DIR` | Static UI directory; use `/Users/michaelbarber/BlackLabelPlatform/apps/ui/public`. |
| `PORT` | Loopback port; default `8460`. |
| `ADMIN_MASTER_KEY_FILE` | Recommended stable 32-byte master-key file. `ADMIN_MASTER_KEY` may instead contain a base64-encoded 32-byte key. If neither is set, the server generates `<storage>/admin.key` once with mode `0600`. |
| `DEFAULT_LOCATION_ID` | Optional process fallback. Prefer saving the tenant's active location in **Settings → Point of sale**. |
| `OWNER_USER_ID` | Optional acting-owner override for trusted, non-browser loopback tools. Browser traffic must use a valid register session and cannot inherit this identity. |

Stripe Terminal is cold unless all three required values are nonblank:

| Variable | Requirement |
| --- | --- |
| `STRIPE_SECRET_KEY` | Required server-side Stripe secret key. Never place it in browser code or logs. |
| `STRIPE_WEBHOOK_SECRET` | Required signing secret for the webhook source that forwards to this instance. |
| `STRIPE_TERMINAL_READER_ID` | Required server-owned physical reader ID. The browser cannot select or assert a reader. |
| `STRIPE_API_VERSION` | Optional explicit `Stripe-Version`; otherwise none is guessed. |
| `STRIPE_API_BASE_URL` | Optional API base; defaults to Stripe production. Use overrides only for controlled testing. |
| `STRIPE_REQUEST_TIMEOUT_MS` | Optional request timeout, clamped to 100–30,000 ms; default 10,000 ms. |
| `STRIPE_WEBHOOK_TOLERANCE_SECONDS` | Optional non-negative signature age tolerance; default 300 seconds. |
| `STRIPE_CURRENCY` | Optional adapter currency; default `usd`. The only accepted value is `usd` (case-insensitive). Any other value leaves the Stripe provider/card lane unconfigured; direct reader verification returns `unsupported_currency`, with no reader or payment I/O. |

Start the product from the repository root with the persistent paths and secrets already exported:

```bash
PLATFORM_STORAGE_DIR="$POS_STORAGE_DIR" \
PLATFORM_DB_PATH="$POS_DB_PATH" \
PLATFORM_DEFAULT_TENANT_NAME="Mags Tack" \
UI_DIR=/Users/michaelbarber/BlackLabelPlatform/apps/ui/public \
ADMIN_MASTER_KEY_FILE=/absolute/path/to/admin.key \
npm --workspace @blacklabel/api run start
```

The server listens only on `http://127.0.0.1:8460`. Open the UI at `http://127.0.0.1:8460/#/register` and settings at `http://127.0.0.1:8460/#/settings`. The first browser load requires the seeded owner to create a register PIN; every later browser session requires an operator PIN before any business API is available.

Migrations run during application construction. A database-scoped startup lock next to `PLATFORM_DB_PATH` serializes migrations, startup reconciliation, and tenant seeding across local processes; a crashed owner's lock is reclaimed automatically, while a live owner is allowed up to two minutes to finish. Do not delete the `.startup-lock` directory to force a second process through. The same startup performs a bounded reconciliation pass over up to 200 missing or pending POS effects across tenants. Subsequent POS requests continue draining anything left behind.

## Stripe webhook delivery

Stripe must deliver callbacks to:

```text
POST /api/orders/webhooks/stripe_terminal
```

The service is loopback-only, so Stripe cannot call it directly. Use an authenticated ingress or a Stripe CLI listener that forwards to the exact loopback URL. The forwarder must preserve the raw request body byte-for-byte and pass the `Stripe-Signature` header unchanged; parsing and re-serializing JSON breaks signature verification.

Development forwarding example:

```bash
stripe listen \
  --events payment_intent.succeeded,payment_intent.payment_failed,payment_intent.canceled,refund.created,refund.updated,refund.failed,charge.refund.updated \
  --forward-to http://127.0.0.1:8460/api/orders/webhooks/stripe_terminal
```

Use the `whsec_...` printed by that listener as `STRIPE_WEBHOOK_SECRET` for the server receiving those forwarded events. A dashboard webhook endpoint has its own signing secret. Start or restart the API after changing the secret.

A card attempt idempotently prepares a `card_present` PaymentIntent, persists its identity locally, and only then instructs the configured reader to process it. Retrying after a crash recovers the same Stripe identity instead of starting an untracked charge. The order stays unpaid until a valid `payment_intent.succeeded` callback reconciles the exact provider session and amount.

Stripe refunds use the same callback endpoint. The server creates the local pending refund and returned-line facts before provider I/O. A valid signed refund callback can report `refund_pending`, `refund_completed`, `refund_failed`, `refund_canceled`, or `refund_mismatch`; only `refund_completed` changes tender balances, order/return state, inventory, finance, and drawer projections. An invalid signature returns HTTP 400. Valid duplicate events return their recorded outcome without replaying side effects.

## Secure the register and manage operators

The browser uses an opaque `mags_pos_session` cookie issued after PIN verification. It is `HttpOnly`, `SameSite=Strict`, scoped to `/`, and marked `Secure` when the request uses HTTPS. The database stores only a SHA-256 token digest and a salted scrypt PIN verifier. A browser-supplied `x-user-id` never overrides the authenticated session.

On the first browser load:

1. Select the seeded owner shown by the setup screen.
2. Create a 4-digit owner PIN. Successful bootstrap signs the owner in.
3. Select the signed-in operator in the header to change the current PIN or, with `workforce.admin`, add a cashier or manager with a distinct name, email, role, and PIN.

Five incorrect PIN attempts lock that operator for five minutes. Session lifetime comes from the tenant workforce session policy and defaults to 720 hours when no usable policy value exists. A workforce **invalidate all sessions** action revokes sessions created before its cut-line. Changing a PIN revokes that operator's other sessions; changing your own PIN preserves only the current session.

The signed-in operator is the authoritative actor for RBAC, drawer ownership and movements, POS order `cashier_id`, payments, cancellations, and refunds. Supplying a different `cashierId` on POS order creation is rejected. Non-browser loopback tools retain the explicit `x-user-id`/seeded-owner compatibility lane, but it is not a browser authentication mechanism.

Before choosing **Switch operator**, finish or review every unsynced mutation. The shipped UI refuses to switch while its offline queue is non-empty. Each queued mutation also records its originating operator and sends `x-pos-expected-user-id`; the server returns HTTP 409 if a different operator is signed in, so a queued sale or drawer action cannot silently replay under the wrong person. Resolve it while signed in as the original operator rather than recreating it.

## Readiness gate

1. Confirm `GET /api/health` returns `data.status: "ok"`.
2. Complete owner-PIN bootstrap or sign in as a configured operator. Except for health and register-auth routes, browser API traffic without a valid session returns HTTP 401.
3. In **Settings → Point of sale**, select an active inventory location.
4. Set sales tax explicitly, including `0.00%` where appropriate.
5. Optionally set the receipt footer and save.
6. Confirm `GET /api/pos/readiness` reports `operational: true` with no blocking notices.
7. As an operator with `admin.read`, confirm `GET /api/pos/reconciliation` reports `healthy: true`, `pendingCount: 0`, and `errorCount: 0`.
8. If taking cards, also require `tenders.cardPresent.enabled: true`, `physicalReaderVerified: true`, the exact configured reader ID, `readerStatus: "online"`, and configured currency `usd`.

Cash and manually verified external tenders can be operational without Stripe. Stripe credentials alone do not prove a connected reader or a successful payment.

## Open and operate the register

### Open the drawer

1. Open **Register** and choose **Open shift**.
2. Enter a stable drawer ID, the counted opening float, and an optional note.
3. Confirm the drawer panel shows **Shift open** and the expected cash equals the opening float.

The server opens a ledger-backed drawer at the configured inventory location. Reuse the same physical drawer ID and register ID for that workstation. Only one open session is permitted for a drawer scope.

Use **Cash movement** for a paid-in, paid-out, or drop. Every movement needs a positive amount, a reason, and a unique idempotency key. The drawer panel recomputes expected cash from the immutable ledger.

### Build the cart

1. Scan or search by barcode, SKU, or product name.
2. Verify the server-returned promoted price and available quantity at the configured location, then add the item.
3. Adjust quantity and cart discounts as needed. The tax field is read-only at the register.
4. Optionally attach a real customer profile.
5. Use **Hold cart** and **Resume** for interrupted customers. Held carts live on that browser/device.

Catalog products must be active and have an active price. Inventory-tracked quantities must be positive whole numbers. Custom lines require an explicit description and integer-cent price and do not invent a catalog or stock record. At order creation the server resolves current price, promotion, tax, location, customer, and inventory reservation again. If the authoritative total changed, inspect and explicitly accept it before tender capture.

### Take payment

- **Cash:** An open drawer is required. Enter cash received, verify the displayed change, and confirm. The tender records both cash received and change due.
- **External:** Use only after independently verifying the payment in its real source system. Enter a truthful source such as check or bank transfer and its transaction/check reference. This lane records the operator's assertion; it does not contact or verify that provider. Card-like source names are rejected here.
- **Split:** Choose **Split cash + card** or **Split across cards**, enter the portion, and process the first card. The register displays approved payments and the remaining balance. Choose **Take next payment** for another card or the cash/external remainder. Cash plus external remains supported. Each portion uses its own durable idempotency key; only the full captured total completes the sale. **Cancel split & refund** reverses the approved cards if the customer abandons the sale. Reload preserves refund recovery until the server confirms cancellation.
- **Card present:** Available only when the server verifies that the exact configured Stripe Terminal reader is online. Keep the cart locked while the attempt is pending. A reader message is not completion: require a succeeded attempt, a paid server order, and a fetchable receipt after the signed webhook.

Each cart maps to one durable POS order, and every tender or card attempt has a stable idempotency key. Retrying the same operation must reuse those facts; do not create a second cart to work around an uncertain result.

### Receipt

After payment, require **Sale complete**, the paid order, and the receipt projection. Verify the receipt number, items, tax, discounts, tenders, cash/change when applicable, refunds, and net paid amount before printing. Reopen it from **Orders** when needed.

### Refund or return

1. Open the paid POS order in **Orders** and choose **Refund / return**.
2. Select the original captured tender and an amount within its remaining refundable balance.
3. Select at least one order line, its quantity, and `restock`, `quarantine`, `damaged`, or `none` disposition.
4. For cash, open the applicable location's drawer first; the cash refund is posted to that session.
5. For Stripe Terminal, submit the refund to the original processor. HTTP 201/200 with refund status `completed` is complete; HTTP 202 with status `pending` means submitted, not refunded. Preserve the returned refund ID and keep the tender blocked from another refund while it is pending.
6. For a manually recorded external tender, independently complete and verify the reversal in that source system before recording it here.
7. For a pending processor refund, wait for its signed webhook outcome and reload the order/refunds. `refund_completed` is the only successful terminal outcome; investigate `refund_failed`, `refund_canceled`, `refund_mismatch`, or a pending result that does not advance.
8. After completion, reload the receipt and verify the refund, tender balance, returned lines, inventory disposition, and net paid amount.

Idempotency keys are bound to the original refund facts. Do not reuse one for a different amount, tender, reason, or line disposition. Only one pending processor refund may exist per tender. On an uncertain timeout or HTTP 502, inspect the durable refund and webhook records and replay the exact same request with the same idempotency key; do not invent a new refund.

### Close the drawer

1. Resolve every pending checkout for this register before closing.
2. Record any final paid-in, paid-out, or drop.
3. Confirm POS reconciliation is healthy. If needed, drain it as described below.
4. Physically count the drawer, then choose **Close shift** and enter counted cash.
5. Verify the server-derived expected amount and final variance.

Before closing, the server reconciles every authoritative cash sale/refund fact for that session. It returns HTTP 409 and leaves the shift open unless both `missingCashFacts` and `pendingCashEffects` are zero. Retry reconciliation and close only after the cause is resolved. Closed sessions and their movements are immutable. Investigate and document a non-zero variance; do not rewrite the ledger.

## Crash and pending-payment recovery

The Register persists its active cart, held carts, drawer reference, cash-session ID, pending order, tender plan, and card-attempt identifiers in the same browser profile under `blacklabel.pos.register.v1`. The offline mutation queue separately binds every queued write to the operator who initiated it.

After a browser reload, UI crash, or API restart:

1. Reopen the same browser profile and the same persistent platform database.
2. Return to **Register**. It automatically starts recovery; use **Recover payment** or **Refresh status** if shown.
3. For cash/external/split, recovery first reads the existing order. A paid order finishes the sale; a draft or reserved order replays the same tender plan and idempotency keys.
4. For card present, recovery locates the durable attempt by its saved ID or idempotency key, then polls it. Keep the cart locked while status is `pending` or `processing`.
5. Use **Cancel card attempt** only for the exact active attempt. The server requests provider cancellation first. If cancellation is not confirmed, keep the cart locked and refresh; do not assume it failed and do not start another charge.
6. Unlock and retry only after the attempt is definitively `failed` or `canceled`. On `succeeded`, require the associated order to be `paid` before completing the cart.
7. If browser storage is unavailable, find the order under **Orders**, inspect its receipt and `GET /api/pos/orders/:orderId/payment-attempts`, and resolve that order before accepting another payment from the customer.

Never use a reader screen, network timeout, closed browser, or missing local cart as proof that no charge occurred.

### Durable projection repair

Orders, tenders, and completed refunds are the authoritative facts. A durable reconciliation ledger repairs derived effects that may have been missed after a process crash or in-memory handler failure:

- sold inventory and returned inventory dispositions;
- POS payment/refund finance entries;
- cash-sale and cash-refund drawer movements.

The server runs a bounded 200-effect sweep at startup and drains the current tenant before and after every `/api/pos/*` request. A startup-pass failure is logged but does not prevent the process from binding, so `/api/health` alone is not a reconciliation check. Successful POS responses include post-request counts in `x-pos-reconciliation-pending` and `x-pos-reconciliation-errors`.

Operator recovery sequence:

1. Read `GET /api/pos/reconciliation`.
2. Call `POST /api/pos/reconciliation/drain?limit=200` using an authorized operator.
3. Repeat the drain until it returns `result.discovered: 0`, `result.attempted: 0`, and `result.failed: 0`; then require `status.pendingCount: 0`, `status.errorCount: 0`, and `status.healthy: true`. The idle pass matters because discovery is intentionally bounded.
4. If an error remains, preserve the database, capture the API response and server log error, and resolve the named source fact or location problem before closing a drawer or modifying inventory manually.
5. Verify `GET /api/pos/finance/summary`, relevant rows from `GET /api/pos/finance/entries`, the receipt, inventory, and drawer reconciliation against the same order/refund IDs.

In single-tenant owner mode, a trusted non-browser loopback tool can trigger a manual drain with the seeded-owner fallback:

```bash
curl -fsS -X POST \
  -H 'x-mags-csrf: 1' \
  'http://127.0.0.1:8460/api/pos/reconciliation/drain?limit=200'
```

Reconciliation is replay-safe and records failures as pending with bounded error evidence. Do not delete its effects or create offsetting inventory/cash movements merely to clear a count.

## Permissions

Browser requests authenticate with the register cookie. The resolved session user wins over any supplied `x-user-id`, and all browser `/api/*` traffic except `/api/health` and `/api/pos/auth/*` fails closed without a valid session. Trusted non-browser loopback tools may send the real `x-user-id`; when they omit it in single-tenant mode, the configured or seeded owner is selected. The permission guard uses the first matching rule:

| Operation | Permission |
| --- | --- |
| Read POS settings/readiness/catalog/drawer/receipts/payment attempts | `orders.read` |
| Save POS settings | `admin.admin` |
| Read POS finance projections | `finance.read` |
| Mutate POS finance projections, if a write route is added | `finance.write` |
| Read POS reconciliation | `admin.read` |
| Manually drain POS reconciliation | `admin.admin` |
| Create/reserve/cancel POS orders; take cash/external/card payments; open/move/close drawers; cancel card attempts | `orders.write` |
| Create POS refunds | `orders.refund` |
| Use generic raw order creation/repricing or generic payment-capture routes | `finance.write` |

Cashiers should use `/api/pos/*`, not generic raw order or payment endpoints. A user operating the register needs both `orders.read` and `orders.write`; refund, finance, reconciliation visibility, and manual repair authority are separate. Built-in cashiers cannot refund or view finance/reconciliation. Built-in managers can refund and read POS finance/reconciliation (`orders.refund`, `finance.read`, `admin.read`) but cannot manually drain reconciliation (`admin.admin`) or use generic finance mutations (`finance.write`). The built-in owner has all of these permissions. Claimed POS orders must be refunded through `/api/pos/orders/:orderId/refunds` even when the operator has generic refund permission.

JSON-bearing browser API mutations use `Content-Type: application/json`, and browser mutations carry the CSRF marker `x-mags-csrf: 1`; the shipped same-origin UI supplies them. Non-browser loopback requests with no `Origin` header, including Stripe's signed callback, may omit the marker. In single-tenant mode the server injects `x-tenant-id`; outside that mode API clients must provide the real tenant ID.

## Truthful operating limits

- Card present is disabled unless all Stripe settings are present and the server verifies the exact configured physical reader as `online`.
- A card sale is not captured from browser input or a manual external tender; only the signed provider completion can pay it.
- External tenders and their reversals are manually verified operator records. The platform does not call their source systems.
- Card present supports an explicit partial amount or the remaining balance. Cash + card processes the card first, then records counted cash. Multiple cards are supported. A partially paid order stays locked against edits. Use **Cancel split & refund** to reverse all approved cards and cancel an incomplete split, or finish the balance. Cancellation blocks new payments immediately and releases reservations only after every refund succeeds; pending refunds keep the cart locked and can be checked or retried using the durable original requests.
- Provider processing fees and net settlement may be unknown until provider balance/settlement data is retrieved and reconciled. Unknown fees must remain unknown/null, never be represented as zero.
- The POS finance summary reports gross tendered sales, completed refunds, and net sales before fees from native POS entries. It deliberately returns `processorFeesCents: null` and `settlementNetCents: null` while fees are unknown; it is not a payout/settlement report.
- Native POS finance entries are separate from the historical/imported `finance_payments` and `finance_refunds` tables. Use `/api/pos/finance/*` for new register activity until an explicit combined report is implemented.
- The POS is USD end to end today. Stripe configuration fails closed before reader or payment I/O when `STRIPE_CURRENCY` is anything other than `usd` (case-insensitive).
- Held carts and the pending-checkout pointer are local to one browser profile. Orders, tenders, attempts, refunds, drawer movements, and receipts are durable in SQLite.
- A green readiness response proves configuration and, for cards, a live reader check at that time. It does not prove a real card charge, refund, receipt printer, cash drawer actuator, or external-provider settlement.

## Route reference

All routes below are relative to the loopback origin.

| Method | Route | Purpose / key input |
| --- | --- | --- |
| `GET` | `/api/health` | Process health and mounted-module list. |
| `GET` | `/api/pos/auth/operators` | List register-eligible operators and whether first-run owner bootstrap is required. No active session is required. |
| `POST` | `/api/pos/auth/bootstrap` | One-time owner PIN setup; fails once any POS credential exists and returns a signed-in session. |
| `POST` | `/api/pos/auth/session` | Sign in with `userId` and a 4-digit PIN; returns the operator identity and sets the opaque session cookie. |
| `GET` | `/api/pos/auth/session` | Read the current session identity, permissions, management flag, and expiry. |
| `DELETE` | `/api/pos/auth/session` | Revoke the presented session and clear its cookie. |
| `PUT` | `/api/pos/auth/operators/:userId/pin` | Change your PIN, or another eligible operator's PIN with `workforce.admin`; revokes that operator's other sessions. |
| `POST` | `/api/pos/auth/operators` | With `workforce.admin`, create a cashier or manager and initial PIN. |
| `GET` | `/api/pos/settings` | Current location, tax, receipt footer, and USD currency. |
| `PUT` | `/api/pos/settings` | Save `defaultLocationId`, `taxBps`, and/or nullable `receiptFooter`. |
| `GET` | `/api/pos/readiness` | Operational blockers and tender/reader state. |
| `GET` | `/api/pos/catalog?code=...` | Barcode/SKU/name lookup with promoted price and location stock. |
| `GET` | `/api/pos/drawer?drawerRef=...` | Open session, reconciliation, and recent movements, or `data: null`. |
| `POST` | `/api/pos/drawer/open` | Open with `drawerRef`, optional `registerRef`, `openingFloatCents`, optional note. |
| `POST` | `/api/pos/drawer/:sessionId/movements` | Record `paid_in`, `paid_out`, or `drop` with amount, note, and idempotency key. |
| `POST` | `/api/pos/drawer/:sessionId/close` | Close with physical `countedCents` and optional note. |
| `POST` | `/api/pos/orders` | Create/replay a server-priced order by unique `cartId`; accepts customer, register, session, discounts, tip, note, and lines. |
| `POST` | `/api/pos/orders/:orderId/pay` | Atomically capture a complete cash/external tender plan. |
| `POST` | `/api/pos/orders/:orderId/cancel` | Cancel an unpaid claimed POS order and release its reservation. |
| `POST` | `/api/pos/orders/:orderId/card-payments` | Start/replay the configured reader attempt with `idempotencyKey` and optional positive `amountCents` bounded by the remaining balance. |
| `GET` | `/api/pos/orders/:orderId/balance` | Read total, captured and remaining cents plus original tender facts. |
| `GET` | `/api/pos/processor` | Owner/admin read-only Stripe connection and reader compatibility check. |
| `GET` | `/api/pos/orders/:orderId/payment-attempts` | List durable attempts for one claimed POS order. |
| `GET` | `/api/pos/payment-attempts/:attemptId` | Read exact attempt state and trigger paid-inventory reconciliation on success. |
| `POST` | `/api/pos/payment-attempts/:attemptId/cancel` | Request and verify cancellation through the original provider. |
| `POST` | `/api/pos/orders/:orderId/cancel-split` | Cancel an incomplete card split by refunding every original card. HTTP 202 while pending; HTTP 200 once canceled. |
| `POST` | `/api/pos/orders/:orderId/refunds` | Refund original tender with amount, idempotency key, returned lines/dispositions, and cash session when applicable. A pending processor refund returns HTTP 202. |
| `GET` | `/api/pos/receipts/:orderId` | Printable merchant/order/tender/refund/net-paid projection. |
| `GET` | `/api/pos/reconciliation` | Counts of total, completed, pending, and errored effects plus `healthy`. |
| `POST` | `/api/pos/reconciliation/drain?limit=...` | Discover and execute a bounded tenant repair pass; limit is constrained to 1–500. |
| `GET` | `/api/pos/finance/entries?limit=...&offset=...` | Native POS payment/refund facts; fee and settlement net stay nullable when unknown. |
| `GET` | `/api/pos/finance/summary` | Gross tenders, completed refunds, pre-fee net, unknown-fee count, and pending reconciliation count. |
| `POST` | `/api/orders/webhooks/stripe_terminal` | Raw signed Stripe PaymentIntent and refund updates. |
| `GET` | `/api/orders/webhooks` | Inspect tenant-scoped provider callback outcomes and replay records. |
| `GET` | `/api/orders/orders/:orderId` | Inspect the durable order and lines during recovery. |
| `GET` | `/api/orders/orders/:orderId/tenders` | Inspect captured/refunded tender facts during recovery. |

## Validation and release gate

Run source validation from `/Users/michaelbarber/BlackLabelPlatform`:

```bash
npm run typecheck

./node_modules/.bin/vitest run \
  apps/api/test/pos.test.ts \
  apps/api/test/pos-auth.test.ts \
  apps/api/test/pos-payment-facade.test.ts \
  apps/api/test/pos-journey.acceptance.test.ts \
  apps/api/test/pos-reconciliation.test.ts \
  apps/api/test/security.test.ts \
  apps/api/test/stripe-terminal-wiring.test.ts \
  apps/ui/test/pos-cart.test.ts \
  apps/ui/test/pos-register-contract.test.ts \
  apps/ui/test/pos-card-present-contract.test.ts \
  apps/ui/test/pos-settings-contract.test.ts \
  apps/ui/test/queue.test.ts \
  packages/inventory/test/reservations.test.ts \
  packages/finance/test/pos-cash-drawer.test.ts \
  packages/orders/test/payment-attempts.test.ts \
  packages/orders/test/provider-refunds.test.ts \
  packages/orders/test/stripe-terminal.test.ts

npm test
git diff --check
```

`npm run test:acceptance` is the broader Mags 20-journey gate and requires the real read-only ledger at `LEDGER_DB_PATH` (or its default location). It supplements, rather than replaces, the POS journey tests above.

Before production use, visibly run at least these paths against a disposable copy of the intended database:

1. First load → create owner PIN → add a cashier → switch and sign in as that cashier → verify the header identity and cashier-attributed drawer/order records → verify a queued mutation blocks switching and receives HTTP 409 under a different operator.
2. Configure POS → open drawer → catalog lookup → cash and split sales → verify change and receipts → cash refund with an inventory disposition → close drawer and verify variance.
3. With a configured test-mode reader: readiness verification → card attempt → signed webhook → paid receipt → processor refund. If the processor returns pending, verify HTTP 202 leaves the sale/tender/inventory unchanged, then deliver the signed completion and verify the completed projections exactly once.

Passing tests or seeing an online reader is not live-payment evidence. Record the exact database/build, tenant, reader/test mode, resulting order and receipt, webhook outcome, refund result, drawer reconciliation, and observed UI postconditions used for acceptance.

## iPad preview and processor connection (2026-09-06)

The register is verified in connected Chrome at 1180×820 and 820×1180 CSS pixels. These are iPad-sized browser checks; physical iPad Safari and real reader acceptance remain separate. Screenshots and transaction evidence are in `docs/pos-ipad-preview/`.

`node --import tsx scripts/pos-ui-preview.ts` starts a disposable, in-memory test store on 127.0.0.1:8469 with prominently labeled simulated payments. Test PIN: `2468`. It never calls Stripe. Its test data resets on process restart.

`node scripts/start-pos.mjs` starts the actual app. Set `POS_STRIPE_ENV_FILE` to an explicit private environment file, or export the existing `STRIPE_*` variables. The launcher only reads the three allowed secret/reader fields, keeps them in the server environment, and does not echo them. Set persistent storage and tenant variables as documented above.

Settings → Point of sale → Payment processor displays the real Stripe API connection independently from payment readiness. A successful reader-list API call establishes connectivity only. A compatible online smart reader (WisePOS E/S700), a signed webhook route to the exact instance, and merchant confirmation are required to activate and verify card acceptance. Phone readers require a native SDK flow and are rejected by this server-driven register.

The final cancellation API is covered by immediate, delayed, replayed, and interrupted-refund acceptance tests. Its visible browser check is pending Mac unlock. Full merchandise returns distributed across multiple original tenders still need a combined-return workflow; the current return screen handles one selected tender and returnable line quantities.

## ONE Club theme (2026-09-06)

The local POS now uses the ONE Club Gulf Shores crest, navy/ivory/gold palette, branded operator sign-in and receipts, guest/event navigation, and ONE Club PWA metadata. Source provenance, iPad-sized screenshots, and final validation are in `docs/one-club-theme/`. The demo is explicitly labeled simulated and uses sample golf-shop items. The actual merchant/account and payment activation remain separate from the visual theme.

## Private encrypted database backups

POST /api/admin/backups/run accepts only an optional encrypted:true field. Destinations are server controlled; encrypted:false and destDir are rejected. The server writes AES-256-GCM artifacts under STORAGE_DIR/backups (directory 0700, files 0600), outside configured UI roots. Main and Business servers supply their installation master key. The artifact header is BLBKP01 followed by a newline, a 12-byte nonce, ciphertext and a 16-byte authentication tag. The backup key is SHA-256 of the domain string `BlackLabel database backup v1` plus a NUL byte followed by the normalized 32-byte admin key. Keep that admin key separately from the artifact.

Raw database backup actions and GET /api/admin/backups/:id/download require admin.admin and a verified server session; implicit local-owner headers cannot authorize them. The provider must declare a single-tenant database scope. A second tenant disables raw snapshot creation, verification, pruning and download; this endpoint does not export other tenants or provide a multi-tenant export. The snapshot independently checks its tenant ID. Shared deployments need a separate tenant-filtered export implementation. Metadata responses omit filesystem paths and verification internals. Downloads are attachments with no-store, and must match the recorded byte length and SHA-256.

UI delivery permits known public asset formats only, bypasses /api, and rejects database/backup/key extensions, dotfiles, escaping symlinks and database/encrypted-backup magic even when renamed as images. Existing legacy plaintext artifacts are not moved or deleted by this source change.

For an explicitly requested recovery, decrypt a downloaded artifact to a NEW file using the matching installation key:

```sh
node --import tsx scripts/decrypt-private-backup.ts /private/path/blacklabel-backup.blbackup /private/path/admin.key /private/path/recovered.sqlite
```

This command verifies GCM authentication and SQLite integrity, creates an exclusive 0600 output file, and never replaces a running database. Existing output files are preserved. Source code tests prove this round trip; stopping a deployed app and replacing its database are separate recovery steps.
