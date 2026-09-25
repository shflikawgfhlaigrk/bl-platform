# ONE Club bar POS — full build and iPad handoff

2026-09-06. Build specification and acceptance plan; not a production-readiness claim.

**Active payment direction:** Retain ONE Club's existing processor, merchant account and compatible hardware, and replace the departing supplier's POS software with our application. [ONE-CLUB-EXISTING-PROCESSOR-CUTOVER.md](ONE-CLUB-EXISTING-PROCESSOR-CUTOVER.md) is the current migration, cost and launch plan. The original build scope below remains a feature specification; earlier Stripe Connect/new-acquirer recommendations are superseded.

## Product decision

Black Label supplies the complete POS application, backend, operational database, manager reporting, deployment, updates, and support. ONE Club uses its existing iPad and a compatible card reader. An existing POS integration is optional for migration and historical reporting, not a dependency of the new register.

Use the existing BlackLabelPlatform checkout and accounting foundation. Deliver the app through secure hosting and Safari's Add to Home Screen flow where the selected hardware integration supports a web app. Connect directly to the existing processor's approved API/terminal interface independently of the departing POS supplier. The exact provider and terminal models must be identified before selecting that connector.

Black Label owns its application and charges for software/setup/support. Existing merchant settlement and processing fees continue. Any payment-margin share or rate change requires agreement with the retained processor; it is not created by replacing the POS screen.

## Current source assessment

| Area | Present foundation | Work needed for bar handoff |
| --- | --- | --- |
| iPad interface | ONE Club branding, standalone web-app manifest, responsive register | Bartender screens, real drinks menu, physical iPad Safari acceptance |
| Checkout | Server-priced orders, cash/card splits, payment attempts and reconciliation | Seat/item/equal check splits, shared tabs, round history, concurrent updates |
| Held orders | Device-local held carts | Durable server-side tabs shared across enrolled registers; a local held cart is not an authorized card tab |
| Card processing | Stripe Terminal adapter with automatic capture and signed callback verification | Connect account scoping, merchant onboarding, platform fees, authorization/capture lifecycle, supported tips, fee refunds, physical reader acceptance |
| Staff and money | PIN sessions, permissions, receipts, refunds, drawer accounting | Bar manager overrides, full multi-tender return workflow, tip allocation and closeout |
| Inventory | Product stock, reservations and adjustments | Drink recipes, spirit/mixer modifiers, bottle/pour units, waste, comps and stockout behavior |
| Printing | Browser print receipt | Verify the selected printer path from the physical iPad; reliable station routing requires a supported printer integration or print bridge |
| Hosting | Loopback-only local server and persistent SQLite support | A production entry point, strict authentication, persistent hosting, backup/restore, monitoring, deployment/rollback |
| Offline | Cached web shell and selected mutation replay machinery | Explicit bar outage behavior; this does not establish offline card acceptance |

Source inspected: `apps/ui/public/manifest.webmanifest`, `apps/ui/public/src/cart.mjs`, `apps/ui/public/src/queue.mjs`, `apps/ui/public/js/views/register.js`, `apps/api/src/server.ts`, `apps/api/src/pos.ts`, `packages/orders/src/providers.ts`, and `docs/POS-RUNBOOK.md`.

## Build sequence and exit conditions

### 1. Bartender workspace and shared tabs

- Drinks-first categories, favorites, search, item availability, and configured modifiers.
- Named guest/table tabs, seat assignment, successive rounds, repeat round, transfer and merge.
- Server-owned tab state and version checks prevent two bartenders overwriting each other.
- Persist the exact priced item/modifier/tax snapshot for each ordered round. Preserve sent and paid history.
- Separate equal-total splits, moving whole items, dividing a shared item, and multiple tenders on one check. Allocate cents deterministically so every child check reconciles to the original total.

**Exit:** two separate browser sessions open and update the same test tab, see the same result, and safely resolve a simultaneous edit. Reload recovers it. Split and merge preserve quantities and every cent, including discounts and tax.

### 2. Payments and Black Label revenue

- Connect onboarding associates the exact ONE Club legal merchant account with the correct venue and verifies payment/payout eligibility.
- Register the physical reader in the proper account/location. Bind each workstation to its configured reader; never accept an arbitrary client-supplied merchant account.
- Scope create/read/cancel/refund operations and callback reconciliation to the same account and original transaction.
- Save the agreed fee rule and computed fee with each payment attempt; replay uses that original value. Fee treatment of tips, tax, partial payments, cancellations, and refunds must be explicit in the commercial configuration.
- Add the supported card-tab authorization, authorization growth or reauthorization, expiration, final tip and capture flows. Show authorization separately from captured payment. Confirm provider eligibility before exposing each option.
- Define how fees are refunded. Full and partial refunds must reconcile the merchant refund and application-fee refund without duplicates.
- Keep sales, taxes, gratuities, processing costs, platform fees, refunds, and payouts separately reportable. Reconcile settlement instead of treating every successful authorization as revenue.

**Exit:** prove sandbox payment, decline, timeout/recovery, split payment, tab authorization, tip closeout, cancellation, refund, and fee reversal. Then perform an authorized physical-reader pilot and match the payment, ONE Club proceeds, Black Label fee, and refund against provider records.

Official integration references checked in this conversation:

- https://docs.stripe.com/terminal/features/connect
- https://docs.stripe.com/connect/direct-charges#collect-fees

### 3. Bar operations

- Load the venue's actual menu, prices, modifier rules, taxes, happy-hour rules, and receipt identity.
- Configure bartender/manager permissions, void/comp reasons, refunds, drawer assignment, shift handover, and tip reporting.
- Map drink recipes to stock units. A sold cocktail depletes its recipe; a spilled drink records waste; a refund does not automatically put a poured drink back into inventory.
- Implement required ticket/receipt delivery and show failed jobs with safe retry. Reprints must be distinguishable from a new order.
- Deliver manager views for open tabs, sales, cash variance, tips, stockouts, comps, refunds, and pending payment exceptions, with truthful empty states.

**Exit:** complete a simulated service shift using the imported menu and configured roles, including a comp, spill, stockout, table transfer, split check, refund, and drawer close. Totals reconcile across receipts, inventory movements, shift reports, and payment records.

### 4. Production service

- Deploy an isolated ONE Club backend on a managed server with persistent storage. Retain the existing SQLite foundation initially; no database-engine rewrite is required for a single isolated venue.
- Add a production entry point that authenticates every business request regardless of Origin or client headers. Keep the existing trusted-loopback owner fallback confined to its local use case; a public proxy alone is not a deployment plan.
- Use HTTPS, device enrollment, staff sessions, manager account recovery, bounded retries, monitoring, and secret storage outside the browser.
- Provide automatic database backups, a demonstrated restore, controlled migrations, a known rollback artifact, and transactional recovery after a server restart.
- Verify real venue connectivity. Use a tested fallback internet connection where required for continuity. Keep pending orders and payment uncertainty visible during an outage; the current server-driven payment path is not evidence of offline card support.
- Control web-app/service-worker upgrades around active checks and payment attempts. An update must preserve the server state and recovery identifiers.

**Exit:** a fresh device can enroll securely; unauthorized and cross-account access fail; a backup restores successfully; an interrupted deployment and payment recover without duplicate charges or lost tabs.

### 5. Physical iPad and venue acceptance

- Verify the actual iPad model, iPadOS version, Safari storage behavior, orientation, touch targets, keyboard interactions, lock/wake, and Home Screen relaunch.
- Install the app, enroll the venue/device, provision individual staff access, and pair the configured reader through the supported route.
- Verify printing with the selected model and network, drawer behavior if used, and the venue's connectivity/fallback.
- Have a bartender perform the entire shift workflow on that iPad. Keep precise evidence of the app build, account/location, reader model, checks, tips, receipts, refund, and closeout.
- Confirm existing gift-card balances, open tabs, menu data, historical exports, and contract obligations before any cutover from the old POS. Import only verified balances; retain export provenance.

**Exit:** the staff member can ring real menu items, run tabs, split checks, collect a supported payment and tip, print/retrieve a receipt, resolve a mistake, and close the shift. The venue manager can review and export the resulting records.

## What ONE Club receives

1. A working ONE Club icon on its existing iPad and a secure manager access link.
2. A configured compatible card reader and any agreed printing hardware.
3. Its real menu, prices, tax settings, staff permissions, receipt identity, and opening inventory/balances where supplied.
4. Merchant onboarding completed by the venue's authorized representative, with its payout destination and agreed Black Label fees.
5. A short bartender guide, manager guide, outage/recovery instructions, and support contact.
6. A demonstrated shift from open to close, with payment and refund receipts, backups, and monitored service.

## Inputs needed at the point they are used

Core development can proceed independently of the old POS vendor. Menu/pricing/tax and service-charge policies are needed before configuring the live venue. The authorized venue representative completes merchant verification and banking. The actual iPad and selected reader/printer are needed for physical acceptance. Production domain/hosting and commercial fee terms are selected before deployment and live processing.

Do not report the handoff complete based solely on screenshots, passing software tests, a running local process, or an online reader. Completion is the verified staff workflow on the actual iPad with the intended merchant account.
