# POS split payments and iPad preview — 2026-09-06

Implemented cash + card (card first), multiple cards, and preserved cash + external splits. Each card portion is bounded by the remaining order balance and has a durable idempotency key. Partial approval keeps the order unpaid and immutable until the balance is completed. Reload resumes the exact portion. Provider refunds now match the selected tender to its original payment rather than choosing the latest card on the order. Tax remains configured for the next cart after completion.

Verified in real connected Google Chrome at 1180×820 landscape and 820×1180 portrait, with no horizontal overflow. The screenshots use the exact product UI with an isolated test store and a prominently labeled simulated processor. This is not physical iPad Safari or live-card acceptance evidence.

- Browser workflow: $140.71 = $100.00 simulated card + $40.71 cash; $50 received, $9.29 change; reload preserves the partial payment; drawer closes at $140.71 with $0 variance.
- Final-build browser workflow: $97.41 = $50.00 + $47.41 on two simulated cards; reload preserves $50 approved and $47.41 remaining; sale completes and the next cart retains 8.25% tax.
- Automated: 227 files / 1,586 tests pass, including three-card splits, exact-tender refunds, cross-tenant denial, duplicate callback/idempotency replay, overpayment rejection, and blocking drawer closure during a partial sale. TypeScript and diff checks pass.
- Screenshots: `ipad-landscape.png`, `ipad-multiple-cards.png`, `ipad-portrait-split-recovery.png`; earlier cash-split screenshots and receipts retained as separate evidence.
- Source fingerprints: `SHA256SUMS.txt`.

The actual app on port 8468 authenticates to the existing live Stripe API using a server-only credential file. Its read-only connection check returns one offline `mobile_phone_reader`, incompatible with this server-driven checkout. No webhook secret is configured. The Stripe Terminal location is named “Black Label Signals”; this is not confirmation that it is the merchant intended for this POS. No live charge or live refund was attempted.

Live activation requires the intended merchant and compatible smart reader, followed by webhook ingress setup and a physical payment/refund test. Stripe documents server-driven support for smart readers and excludes mobile readers: https://docs.stripe.com/terminal/payments/setup-integration?terminal-sdk-platform=server-driven

The app remains loopback-only. The preview URLs open on this Mac; they are not physical-iPad network deployment URLs. Production iPad access needs an authenticated HTTPS deployment. Existing non-browser loopback owner access must not be exposed through an unrestricted public proxy.

Incomplete card splits now have a **Cancel split & refund** action. Each original card is refunded through the durable processor ledger; reservations release only after every refund succeeds. New tender attempts are blocked once cancellation starts. Tests cover two original-card reversals, delayed signed confirmations, duplicate callbacks, cross-tenant denial, and an ambiguous transport failure retried with the same idempotency key. This final cancellation path is API-tested; its visible browser check remains pending because the Mac locked before recapture.

The screenshots predate the added cancellation control and the primary-button hover contrast correction. They remain evidence of the completed split workflows and iPad-sized layout at that earlier source state, not of the final cancellation UI. The preview store was restarted on the final source and its disposable data reset. Both local servers pass current API/health checks; the real Stripe read-only connection was refreshed after restart.

Browser-held carts remain local to that device. Full merchandise returns spanning multiple original tenders still need a dedicated combined-return workflow; the current return screen selects one tender and available line quantities. These are local pilot workflows, not a production sign-off.

Run `node --import tsx scripts/pos-ui-preview.ts` for the disposable demo on port 8469 (test PIN 246810). All demo data resets on process restart. `node scripts/start-pos.mjs` starts the actual API with explicitly configured persistent storage and an optional private `POS_STRIPE_ENV_FILE`.
