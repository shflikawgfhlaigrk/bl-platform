# @blacklabel/reviews — Review Engine

Request, track, and improve **genuine** customer reviews.

> **Integrity rule: this module NEVER fabricates reviews.** It only requests
> real feedback from real customers, records what they actually submitted, and
> routes happy customers to the tenant's public review platforms. Nothing here
> writes a review on a customer's behalf, auto-posts to any platform, or
> synthesizes ratings. Providers are read/deliver-only by contract.

Industry-neutral: platforms, campaigns, and copy carry no industry assumptions.

## Objects

| Object | Table | Purpose |
|---|---|---|
| ReviewPlatform | `reviews_platforms` | Per-tenant configured review destinations with target URLs (e.g. a business profile page). `enabled` gates visibility to customers. |
| ReviewCampaign | `reviews_campaigns` | A review-request push: audience (customer ids), optional `schedule_start_at`, per-UTC-day `throttle_per_day`, gating `rating_threshold`. |
| ReviewRequest | `reviews_requests` | One per customer. Carries the secret public-link `token` and status: `pending → clicked → completed` or `opted_out`. |
| ReviewResponse | `reviews_responses` | What the customer actually submitted (rating, comment, sentiment). Negative gates are `flagged_for_followup` until resolved. |
| Testimonial | `reviews_testimonials` | A quotable snippet, stored **only with `consent: true`** — capture without explicit customer consent is rejected with 400. |
| Reminder | `reviews_reminders` | Follow-up rows with `send_at`, delivered through the provider stub by `POST /reminders/process`. |

All tables carry `tenant_id` (indexed); every query is tenant-filtered.
`customer_id` is a cross-module reference by id string only.

## Endpoints (mounted by apps/api at `/api/reviews`)

Tenant-scoped (require `x-tenant-id`; optional `x-user-id` becomes the audit actor):

- `POST | GET /platforms`, `GET | PATCH | DELETE /platforms/:id`
- `POST | GET /campaigns`, `GET /campaigns/:id` (includes request-status stats), `PATCH /campaigns/:id`
- `POST /campaigns/:id/dispatch` — sends the next pending batch, honoring schedule + throttle. Returns `{ dispatched, reason }` (`not_started` / `throttled` / `no_pending` / `null`).
- `POST | GET /requests`, `GET /requests/:id`
- `GET /requests/:id/link` — per-customer link + **QR placeholder contract**: `{ requestId, token, url, qr: "placeholder" }` (clients render the QR from `url`).
- `POST /requests/:id/reminders` (`{ sendAt }`), `GET /reminders`, `POST /reminders/process`
- `GET /responses?flagged=true`, `POST /responses/:id/resolve`
- `POST | GET /testimonials` — `consent: true` is mandatory.
- `GET /dashboard` — `{ requests: {total, pending, clicked, completed, opted_out}, reviews: {volume, averageRating, positive, negative, flaggedOpen}, responseRate, testimonials }`

Public, token-authenticated (NO tenant header — the globally-unique secret
token is the credential; an invalid token is always 404). Public payloads
never contain internal ids (`tenant_id`, `customer_id`, `request_id`):
`tenant_id` is the header credential for tenant-scoped routes and must never
reach an unauthenticated response.

- `GET /public/requests/:token` — landing view; marks `pending → clicked`.
- `POST /public/requests/:token/submit` (`{ rating 1..5, comment? }`) — gating flow.
- `POST /public/requests/:token/opt-out` — idempotent; cancels scheduled reminders.

## Positive/negative gating

On submit, the rating is compared to the request's `rating_threshold`
(copied from its campaign at creation; default 4):

- `rating >= threshold` → **positive**: the response is recorded, and the
  customer is offered the tenant's *enabled* platform links. Posting publicly
  stays the customer's choice — we never post for them.
- `rating < threshold` → **negative**: the private feedback form is captured
  as a ReviewResponse `flagged_for_followup`; **no platform links are shown**.
  Resolve the follow-up via `POST /responses/:id/resolve`.

Both paths complete the request and emit `reviews.review.submitted`.

## Events

- `reviews.review.submitted` `{ reviewId, requestId, customerId, rating, sentiment }` — catalog event
- `reviews.campaign.created` `{ campaignId, requestCount }`
- `reviews.request.created` `{ requestId, customerId, campaignId }`
- `reviews.request.opted_out` `{ requestId, customerId }`
- `reviews.reminder.scheduled` `{ reminderId, requestId, sendAt }`
- `reviews.testimonial.captured` `{ testimonialId, customerId }`

## Provider interface

`ReviewProvider` (exported) is the delivery/integration seam:
`sendReviewRequest`, `sendReminder`, `syncExternalReviews`.
`GoogleBusinessProvider` is the **Google-Business-ready no-op stub** — it
satisfies the interface with zero network calls and never imports/invents
reviews. apps/api can pass a real implementation as the second argument of
`reviewsRouter(deps, provider)`. When a `sendMessage` contract is wired in
`deps.contracts`, dispatch and reminders also deliver the tokenized link
through messaging (best-effort; absent contract degrades gracefully).

## Seed & tests

- `seedReviews(db, tenantId)` — demo platforms, a campaign, requests in mixed
  states, one positive + one flagged negative response, a consented testimonial,
  and a scheduled reminder.
- `npx vitest run packages/reviews` — 44 tests: migrations (idempotent), router
  CRUD, gating both paths (incl. threshold boundary and disabled-platform
  exclusion), token security, public-payload id-leak denial, opt-out,
  throttle/schedule, reminder processing, consent enforcement, dashboard math,
  audit entries, and tenant-isolation denial tests for every entity (incl.
  cross-tenant campaign attachment).
