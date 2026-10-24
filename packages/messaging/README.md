# @blacklabel/messaging — Unified Inbox

The installed business workspace supports configured outbound email and internal message recording. Other channel records remain searchable; an enum or stored address does not mean an external transport is connected. Unavailable external sends return 501 before creating a fictional message. Email acceptance, later delivery, rejection and unresolved submission remain separate receipt states.

## Reliable operations

Outbound messages are saved before provider execution with a tenant-scoped idempotency key and content fingerprint. Duplicate operations reuse their saved receipt, while changed content under the same key is rejected. A timeout remains unresolved rather than becoming permission to resend. An unresolved message blocks another reply on that conversation until readback resolves it. Provider exceptions are stored as a generic recovery instruction, without raw provider details.

`ResendEmailProvider` is the existing email adapter. It submits to the fixed provider endpoint with a stable operation header and reads the existing provider message for reconciliation. Readback checks exact sender, recipient, subject and body plus provider identity; it never sends another message. The Inbox can enter a known existing provider message ID when a timed-out admission did not return one. That lookup does not establish delivery until the provider receipt does.

## Inbound event receipts

Authenticated adapter ingestion accepts `provider` and `providerEventId` together. A receipt is claimed before threading or creating a message. Uniqueness is scoped to tenant, provider, channel and event ID. Repeat delivery returns the existing message/conversation without another message, received event, timeline entry or reopen. Changed content under the same event ID returns 409. An in-progress or interrupted receipt remains held for recovery instead of creating a duplicate. Explicit conversation IDs are checked against both tenant and channel before a receipt is written.

Legacy record-only ingestion without event identity remains supported and has no duplicate-event guarantee. This endpoint is not a public authenticated provider webhook: composition must verify an actual connector's transport identity/signature before calling it. No live inbound email/SMS/social webhook has been connected by these changes.

## Conversation ownership

Assignment requires an actual user in the same business, records its history and increments the conversation revision. An optional observed revision rejects stale assignments. Business UI replies carry a stable operation ID and observed revision; an atomic claim rejects another reply from the same stale view. A conversation assigned to another team member requires reassignment before a user reply. The system contract keeps its existing trusted automation behavior.

New inbound messages, replies, status changes, customer links and ownership changes invalidate stale composer revisions. Closed conversations must be reopened. The UI retains drafts, hides composers for unsupported transport/closed/other-owned/unresolved conversations, and avoids issuing unchanged status transitions.

## API additions

- `GET /inbound-receipts` — tenant-scoped saved event receipts
- `POST /inbound` — optional `provider` + `providerEventId`, plus existing message fields
- `POST /conversations/:id/assign` — `userId`, optional `note`, `expectedRevision`
- `POST /conversations/:id/messages` — existing body/template fields, optional `idempotencyKey`, `expectedRevision`
- `GET /messages/:id`, `POST /messages/:id/reconcile` — existing durable readback flow; optional known `providerMessageId`

Existing channel/conversation/template CRUD, participant and assignment history, search, tenant isolation, optional CRM timeline contract and `createMessagingSendContract` remain. Module tables reference customer/contact records by IDs and do not import another module's business logic. The internal `portal` contract mapping records a workspace message; it does not claim email or SMS delivery.

Append-only migration `messaging.0011_inbound_receipts_ownership` adds inbound receipts and default-zero conversation revisions. Existing messages and channel records are preserved. Log-only test adapters remain synthetic fixtures and never prove customer delivery.

Focused checks: `npx vitest run packages/messaging packages/reviews apps/api/test/business-reviews.test.ts --maxWorkers=1 --minWorkers=1`. They use synthetic data and in-memory databases, with isolated HTTP fixtures for the existing Resend adapter. No live messages are sent.
