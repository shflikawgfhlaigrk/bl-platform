# @blacklabel/retail — provider-neutral Square import lane

Extends the original Square historical-import lane (25,221 payments imported in
production via `importSales`) into a full **incremental import system**. One
normalized contract, four producers, one pipeline. **No network, ever** — every
credentialed transport is injected at wiring.

## The normalized contract

Every producer emits the same `ImportBatch`:

```ts
interface ImportBatch {
  source: 'square_export' | 'square_api' | 'square_webhook' | 'simulator';
  kind:   'payments'|'orders'|'customers'|'catalog'|'gift_cards'
        | 'payouts'|'disputes'|'invoices'|'inventory_counts'|'refunds';
  records: unknown[];
  sourceMeta: { fileName?: string; cursor?: string; webhookEventId?: string; fetchedAt: string };
}
```

## The four producers

1. **Export drop** (`parseExportFile`) — the only lane shipped enabled. Founder
   drops Square JSON into `~/MagsTack/data/incoming/`; a bare array or a
   dict-wrapped array is parsed. No network.
2. **API polling** (`SquarePollingClient`) — **built, never wired to a live
   transport here**. Cursor pagination, 429 retry-after, and an overlap window
   (re-scan `watermark − overlapSeconds`) so late/edited records re-pull and
   dedup downstream. The HTTP `transport` is **injected**; there is no `fetch`
   import anywhere in this package.
3. **Webhook** (`verifyWebhookSignature` + `normalizeWebhookEvent`) — real
   HMAC-SHA256 (`node:crypto`) over `notificationUrl + rawBody`, timing-safe.
   `retail_webhook_receipts.event_id` is UNIQUE per tenant → replays are no-ops.
4. **Simulator** (`SimulatedSquareProvider`) — deterministic, seeded (no
   `Math.random`); realistic batches for every kind so the whole pipeline is
   testable with zero credentials.

## The pipeline (per batch)

`validate (per-kind zod) → quarantine (never silent) → idempotent upsert
(check-then-insert/update, no ON CONFLICT) → reconcile`. Everything is recorded
on `retail_import_manifests` (`record_count / accepted / updated /
skipped_duplicates / quarantined`, `source_hash`, cursors, recon totals). A
re-import of the same batch produces `accepted=0, updated=0`, all
`skipped_duplicates` — row counts and gross never duplicate (acceptance journey 2).

## 🔒 Founder gates (surface, never bypass)

- **API polling requires a least-privilege, READ-ONLY Square token** — a founder
  decision (PROMPT.md §6 gate #5 / §1 item 1: *never call the Square API*). Until
  the founder approves and the integrator injects a real read-only transport,
  `POST /imports/poll` returns **501** (honest). This module never constructs a
  connection to `connect.squareup.com`.
- **Webhook ingestion requires a signature key + notification URL** from the
  tenant's admin-configured, AES-GCM-encrypted credential store. Absent config,
  `POST /imports/webhook` returns **501**.

## Integrator wiring

`apps/api` mounts the router and injects the founder-approved config:

```ts
retailRouter(
  { db, events, contracts },
  {
    webhook: { signatureKey, notificationUrl },   // enables POST /imports/webhook
    pollTransport,                                 // injected read-only transport; enables POST /imports/poll
    pollOverlapSeconds: 3600,                      // overlap re-scan window
  },
);
```

Action wiring: `retail.import.quarantined` drives the *quarantined_import_record*
action; `retail.import.reconciliation_failed` drives the reconciliation action.
Both are internal events under the standard 3-segment naming; subscribe via
`deps.events`.

## Endpoints

`POST /imports/export-drop` · `POST /imports/webhook` · `POST /imports/poll` ·
`GET /imports/manifests` · `GET /imports/manifests/:id` · `GET /imports/cursors` ·
`GET /imports/reconciliation` · `GET /imports/status` · `GET /quarantine` ·
`GET /quarantine/:id` · `POST /quarantine/:id/repair` · `POST /quarantine/:id/discard`
(plus the original `/import`, `/import-runs`, `/payments`, `/customer-links`, `/summary`).
