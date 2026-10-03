# @blacklabel/portal-customer

Customer-facing portal for the BlackLabel Platform: customers sign in with a
magic link and see **only their own data**, strictly scoped to
`(tenant_id, customer_id)`. Industry-neutral and white-label.

## What it does

| Feature | How |
|---|---|
| Customer auth | Magic-token login. `POST /auth/request-link` creates a single-use token row (15 min TTL); `POST /auth/exchange` spends it and issues a bearer session (30 days). No external auth deps. |
| Session identity | Every `/me/*` endpoint resolves the customer from the session (`Authorization: Bearer`, `x-portal-session` header, or `portal_session` cookie) — never from a param or body. |
| View own appointments | `GET /me/appointments` via the injected scheduling provider. |
| View + approve/decline quotes | `GET /me/quotes[/:id]`, `POST /me/quotes/:id/approve|decline` — ownership is verified via `getForCustomer`, then an **ApprovalEvent is written through the quoting service** (`recordApprovalEvent`). |
| View invoices + pay placeholder | `GET /me/invoices`, `POST /me/invoices/:id/pay` returns a **payment-intent stub** from the billing provider interface (built-in `stubPaymentProvider()` when none is wired). Amount = outstanding balance, integer cents. |
| Upload and download files/photos | `POST /me/uploads` validates base64 original bytes and registers them with the files provider; `/me/files` and `/me/files/:id/content` expose explicitly shared files. HTML screens provide real multipart upload and original-byte download. |
| Message the business | `POST /me/messages` stores the customer's message and relays it through core's `SendMessageContract` (messaging module) when wired. |
| Job/project status | `GET /me/jobs` via the jobs provider. |
| Request repeat service or a reschedule | `POST /me/requests` creates one durable owner-reviewed receipt for an owned completed job or active appointment. Duplicate retries return the same receipt; jobs and bookings stay unchanged. `GET /me/requests` includes the business's response. |
| Leave-review prompt | `GET /me/reviews/pending` surfaces pending review requests from the reviews provider. |
| Update own contact info | `PATCH /me/contact` (name/phone/email; email uniqueness per tenant). |
| Server-rendered UI | `/ui/login`, `/ui/session?token=`, `/ui` (dashboard), form posts for messages / quote decisions / payment / service requests, request receipts, multipart file upload, and file download. Mobile-first, inline CSS, zero branding, all output HTML-escaped. Cookie session (`portal_session`, HttpOnly). |

Business-side account management: `POST /accounts`, `GET /accounts`,
`GET /accounts/:id` (mounted behind the business's own auth by `apps/api`).
Owner request queue: `GET /requests[?status=pending]`, `GET /requests/:id`,
`PATCH /requests/:id` with `status`, `response`, and `expectedVersion`.
Closing a request requires a customer-visible response. Stale versions get
`409`; closed requests cannot be reopened through this endpoint. The owner
confirms actual scheduling changes through Scheduling, then records the answer.

Customer request bodies contain `kind` (`repeat` or `reschedule`), `referenceId`
(job or appointment), `idempotencyKey`, and optional `note`. Reschedules require
`requestedStartsAt`; `requestedEndsAt` is optional and otherwise preserves the
original duration. An optional IANA `timezone` interprets local input (default
UTC). Invalid, nonexistent, or ambiguous local times require correction; preferred
starts must be in the future. No provider sends a message or charges a customer
as part of recording a request.

## Cross-module boundaries

Per CONVENTIONS §9 this module never reads another module's tables and never
imports another module. Cross-module data flows through **provider
interfaces** exported from this package (`PortalCustomerProviders`):

```ts
import { portalCustomerRouter, type PortalCustomerDeps } from '@blacklabel/portal-customer';

const app = portalCustomerRouter({
  db, events, contracts,          // standard ModuleDeps
  providers: {                    // OPTIONAL — wired by apps/api
    appointments,                 // scheduling-backed
    quotes,                       // quoting-backed (list/get/recordApprovalEvent)
    invoices, payments,           // billing-backed (payments falls back to stubPaymentProvider())
    files,                        // files-backed (registerUpload -> file id)
    jobs,                         // workflows/job-owner-backed
    reviews,                      // reviews-backed (pending review requests)
  },
});
```

Every provider is optional. Absent providers degrade to `501 not_implemented`
(the messaging relay degrades to local-only storage instead). Providers
receive `(tenantId, customerId)` from the session and MUST scope to both.
A plain `ModuleDeps<PortalCustomerDatabase>` is accepted unchanged.

## Tables

- `portal_customer_accounts` — portal identity + self-managed contact info; `customer_id` is an id-string ref; unique `(tenant_id, email)`.
- `portal_customer_login_tokens` — single-use magic tokens (`used_at` spends them; guarded update prevents double-spend).
- `portal_customer_sessions` — bearer sessions (`revoked` 0/1, ISO expiry).
- `portal_customer_messages` — customer→business messages (+ `relayed_message_id` from the messaging module).
- `portal_customer_uploads` — upload metadata (+ `file_id` from the files module).
- `portal_customer_service_requests` — customer-owned repeat/reschedule receipts, source references, preferred times, owner response, version, and idempotency fingerprint. Added by append-only migration `portal-customer.0002_service_requests`.

All tables carry `tenant_id` (indexed) and every query filters by it.

## Events emitted

`portal_customer.account.created`, `portal_customer.login_link.requested`,
`portal_customer.session.created`, `portal_customer.contact.updated`,
`portal_customer.quote.approved`, `portal_customer.quote.declined`,
`portal_customer.payment_intent.created`, `portal_customer.message.sent`,
`portal_customer.upload.created`, `portal_customer.request.created`,
`portal_customer.request.updated` — payloads in `src/index.ts`.

Every mutation is also written to the core audit log (actor = the customer's
account id, or `system` for business-side account creation).

## Security notes

- Cross-tenant and cross-customer access is denied by construction: tenant
  comes from core's `tenantMiddleware`, customer comes from the session, and
  both are covered by explicit denial tests (`test/isolation.test.ts`).
- `request-link` responds identically whether or not the email exists (no
  account enumeration) and never returns the token in the response; delivery
  goes out-of-band via the messaging contract when wired.
- Login tokens are single-use (atomic guarded update) and expire in 15 min.
- Production hardening left to the integrator: token hashing at rest, rate
  limiting on `request-link`, HTTPS-only cookie flags.

## Dev

```sh
npx vitest run packages/portal-customer --maxWorkers=1
npx vitest run apps/api/test/business-portal-requests.test.ts --maxWorkers=1
```

Seed demo data with `seedPortalCustomer(db, tenantId)` — returns two demo
accounts plus a ready-to-exchange login token and a live session token.
