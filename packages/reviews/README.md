# @blacklabel/reviews — Review Engine

Prepare neutral requests after completed customer work, collect optional private feedback, and offer the same enabled public-review destinations to every customer. Links appear before a rating, after every rating, and on completed or opted-out revisits. The module never posts a public review for a customer. Internal low-rating follow-up flags do not control access to public links.

The business provider verifies tenant-owned completed CRM jobs or past completed appointments and usable customer email. One latest completed job per customer is eligible. Existing requests for that job, legacy requests prepared after its completion, customer-wide opt-outs, and missing contact details are excluded with visible reasons. `POST /campaigns/completed-jobs` prepares all eligible customers together, without a rating filter. Optional provider eligibility preserves the low-level service API and isolated fixtures; the installed business runtime must forward `listCompletedJobs` to enforce eligibility on manual request/campaign endpoints.

Customer opt-out cancels all pending review requests and reminders for that customer within the business and suppresses future requests. Completed feedback stays recorded. Opt-out does not remove public destinations. Testimonials still require explicit customer consent.

Delivery receipts distinguish `not_sent`, `sending`, `blocked`, `submitted` (provider accepted), `delivered`, and `needs_attention`. Requests and reminders are atomically claimed before submission; overlapping workers cannot submit the same operation twice. Uncertain outcomes remain held until read-only provider reconciliation. A failing recipient does not stop the rest of a batch. The installed email provider uses a stable messaging idempotency key for each request/reminder and saved message readback. Provider acceptance does not prove delivery.

Append-only migration `reviews.0002_eligibility_delivery_opt_out` preserves old tokens/submissions and carries old opt-outs into customer-wide preferences. Verified job references have a tenant-scoped unique index. Existing manually prepared requests remain visible as legacy requests.

## Endpoints

Tenant endpoints require the composition layer's company/user authentication and permissions:

- `POST | GET /platforms`, `GET | PATCH | DELETE /platforms/:id`
- `GET /eligible-customers` — eligible completed-job customers and excluded reasons; 501 if verification is not connected
- `POST /campaigns/completed-jobs` — prepare every eligible customer (`name`, optional `throttlePerDay`, `scheduleStartAt`)
- `POST | GET /campaigns`, `GET | PATCH /campaigns/:id`, `POST /campaigns/:id/dispatch`
- `POST | GET /requests`, `GET /requests/:id`, `GET /requests/:id/link`
- `POST /requests/:id/delivery` — read-only delivery reconciliation; never sends a new message
- `POST /requests/:id/reminders`, `GET /reminders`, `POST /reminders/process`
- `POST /reminders/:id/delivery` — read-only reminder reconciliation
- `GET /responses?flagged=true`, `POST /responses/:id/resolve`
- `POST | GET /testimonials`, `GET /dashboard`

Public endpoints use the secret request token, never a tenant header:

- `GET /public/requests/:token` — status, opt-out preference, and enabled destinations
- `POST /public/requests/:token/submit` — optional private feedback (`rating` 1–5, optional `comment`)
- `POST /public/requests/:token/opt-out` — customer-wide opt-out; repeat calls are idempotent

Public responses omit tenant, customer, and request identifiers. The legacy submit `gate` field classifies internal follow-up only; every value receives identical links and invitation wording.

## Current boundaries

The default `GoogleBusinessProvider` is a strict no-op delivery stub. External review import and QR rendering are still unimplemented. The installed business adapter supports email through the configured messaging provider; it requires a customer-reachable HTTPS company origin. It does not claim SMS, Google review synchronization, or email delivery without a provider receipt. Review-only purchase provisioning must include the basic customer/job records used by this provider; subscription boundaries are owned by composition.

Focused checks: `npx vitest run packages/reviews apps/api/test/business-reviews.test.ts --maxWorkers=1 --minWorkers=1`. Fixtures are synthetic and databases are in memory; no live outbound messages are sent.
