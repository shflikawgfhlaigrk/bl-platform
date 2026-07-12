# @blacklabel/outreach

The Mags Commerce OS cold-email lane: provider adapters (interfaces + in-memory
simulators), fixed templates, campaigns, an **append-only send-of-record**,
warmup capacity, an inbound inbox with threads, and the CAN-SPAM + armed gates.

**The package holds NO network code.** Real SMTP/IMAP transports are injected by
`apps/api` behind admin-configured credentials (referenced by a credential-id
string in `outreach_settings.provider_credential_ref` — the secret never lives
here). Every test drives the send/reply lane through the simulators. Ships fully
**COLD**: nothing can send until every gate is open.

## Gate order (the drain, `sendPending`)

Each queued send is evaluated against ALL gates, in order. Hard gates record the
send `status=blocked` with the exact reason and emit `outreach.delivery.changed`.
Transient gates leave the row **queued** and report it in `deferred` (a later
drain retries it) — never a silent skip.

| # | Gate | `blocked_reason` | Kind |
|---|------|------------------|------|
| 1 | not armed (`armed != 1`) | `not_armed` | hard block |
| 2 | no CAN-SPAM postal address | `no_postal` | hard block |
| 3 | no connected provider / no transport injected | `no_provider` | hard block |
| 4 | recipient has no consent/relationship flag | `no_consent` | hard block |
| 5 | recipient suppressed (injected check) | `suppressed` | hard block |
| 6 | inside quiet hours | `quiet_hours` | defer (stays queued) |
| 7 | daily warmup cap spent | `cap_reached` | defer (stays queued) |

The send-of-record is **append-only** and deduped by check-then-insert on
`(tenant_id, recipient_email_normalized, subject)`: a duplicate attempt is
recorded as its own `status=blocked, blocked_reason=duplicate` row — a live send
is never issued twice.

## Warmup ramp (ported from `mail_capacity.py`)

A brand-new sender must not blast full volume — that wrecks domain reputation.
The deliverability-safe daily cap ramps by **week** from a cold floor to a hard
ceiling, keyed on whole days since the tenant's **first successful send**:

```
week 1  (age 0–6 days)    →  20 / day      (WARMUP_START)
week 2  (age 7–13 days)   →  30 / day      (+10 / week)
week 3  (age 14–20 days)  →  40 / day
…       +10 / day each subsequent week
week 19+ (age ≥ 126 days) → 200 / day      (WARMUP_HARD_CEILING — capped)

cap = min(200, 20 + floor(ageDays / 7) * 10)
```

A per-tenant `daily_cap_override` only ever **lowers** the cap (never raises it),
so a reputation-sensitive tenant can be pinned to a conservative volume forever.
Capacity is a ledger: one `outreach_capacity` row per tenant per business day
(business day computed in the tenant's quiet-hours timezone, default
`America/New_York`). A successful send consumes one unit.

## Bounce auto-pause

A campaign with **≥ 10 sent** whose **bounce rate > 10 %** (`bounced /
(sent + bounced)`) is moved to `paused_bounce` and emits
`outreach.campaign.paused` (drives an owner action). Bounces are detected in the
reply lane and legitimately arrive after a campaign finishes, so a `done`
campaign is still eligible to pause.

## Reply/bounce classification (ported from `mail_replies.py`)

`checkReplies` ingests inbound messages since a persisted cursor, idempotent per
`(tenant, provider_ref)`. Each message is classified, in order:

1. **bounce** — a mailer-daemon@ / postmaster@ sender, a DSN-shaped subject
   ("delivery status notification", "undelivered mail", "mail delivery failed",
   "failure notice", "returned mail", "undeliverable"), or an RFC-3464 DSN flag.
   Matched to its send by the DSN's structured failed-recipient (never the
   mailer-daemon `from`) and flips that send `sent → bounced`.
2. **auto_reply** — a no-reply/do-not-reply sender, an auto-submitted flag, or an
   out-of-office / auto-reply / vacation subject.
3. **reply** — a human answer whose `from` + normalized subject (Re:/Fwd:
   stripped) matches a real prior send.
4. **unknown** — none of the above.

bounce/auto-reply win over `reply` so a genuine DSN is never misfiled as a "yes".

## Unsubscribe

Each send carries an HMAC-SHA256 token (per-tenant secret × send id) embedded in
`{{unsubscribe_url}}`. `processUnsubscribe(sendId, token)` validates the token,
calls the injected `suppress(tenantId, email, reason)` callback, and blocks every
still-queued send to that address.

## Events (payloads carry ids + numbers only — NEVER PII)

| Event | Payload |
|---|---|
| `outreach.delivery.changed` (canonical) | `{ v:1, sendId, state }` on every state change |
| `outreach.campaign.paused` (internal) | `{ v:1, campaignId, reason, bounceRate, sent, bounced }` |

## Integrator wiring (`apps/api`)

```ts
outreachRouter(deps, {
  transport,           // MailTransport  — real SMTP behind admin creds
  reader,              // MailboxReader  — real IMAP behind admin creds
  suppress,            // (tenantId,email,reason) => void   (customers.suppressions)
  isSuppressed,        // (tenantId,email) => boolean        (customers.suppressions)
  unsubscribeBaseUrl,  // public URL the unsubscribe link points at
});
```

With no `transport`, the drain honestly blocks every queued row `no_provider`.
With no `reader`, `POST /check-replies` returns 400. SMTP/IMAP config shapes are
exported as zod schemas (`smtpConfigSchema`, `imapConfigSchema`); credentials are
referenced by id and resolved in admin.
