# @blacklabel/messaging — Unified Messaging Inbox

One inbox across channels (**email, sms, website, social, internal**) for the
BlackLabel Platform. Multi-tenant, industry-neutral, built on `@blacklabel/core`
and `@blacklabel/db` per `/CONVENTIONS.md`.

## Objects

| Object | Table | Notes |
|---|---|---|
| Channel | `messaging_channels` | Tenant channel config (type + from-address, active flag) |
| Conversation | `messaging_conversations` | subject, channel, status, CRM links, assignee, last_message_at |
| Message | `messaging_messages` | direction `in`/`out`, body, channel, status `received`/`sent`/`failed`, provider id |
| MessageTemplate | `messaging_templates` | `{{variable}}` body/subject, optional channel restriction, name unique per tenant |
| Participant | `messaging_participants` | kind `customer`/`contact`/`user`/`external`, address used for threading |
| Assignment | `messaging_assignments` | conversation → team member, full history (`assigned_by`, note) |

All tables carry `tenant_id` and every query filters by it. CRM entities are
referenced **by id string only** (`customer_id`, `contact_id`, `ref_id`) — no
cross-module SQL.

## Behavior

- **Threading** — `recordInbound` (or `POST /inbound`) appends to an explicit
  `conversationId` (reopening it if closed), else finds the most recent
  non-closed conversation on the same channel with a participant matching the
  sender's address, else starts a new conversation with an `external`
  participant. Threading never crosses tenants.
- **Status transitions** — `open ↔ pending`, `open/pending → closed`,
  `closed → open` (reopen). Anything else (including no-ops) is a `409`.
  Sending on a closed conversation is a `409`.
- **Assignment** — sets `assigned_user_id` and appends an assignment-history
  row; emits `messaging.conversation.assigned`.
- **Templates** — `renderTemplate(text, vars)` substitutes `{{ variable }}`
  (whitespace-tolerant); referencing a variable that isn't supplied is a `400`
  listing the missing keys. Channel-restricted templates refuse other channels.
- **Search** — LIKE-based (`lower(col) LIKE '%term%' ESCAPE '\'`), wildcards in
  the term are escaped; covers conversation subjects and message
  body/subject/from/to. Tenant-scoped.
- **Audit** — every mutation writes `audit_log` (`messaging.*` actions,
  `messaging.<entity>` entity types). Actor comes from the `x-user-id` header
  (falls back to `system`).

## Channel providers (stubs)

`ChannelProvider` is **the exact interface a real adapter implements**:

```ts
interface ChannelProvider {
  readonly type: ChannelType;                       // 'email' | 'sms' | ...
  send(payload: OutboundPayload): Promise<ChannelSendResult>;
}
// OutboundPayload = { tenantId, to, from, subject, body }
// ChannelSendResult = { providerMessageId, status: 'sent' | 'failed', detail? }
```

The package ships **log-only stubs** (`LogOnlyEmailProvider`,
`LogOnlySmsProvider`) that record each send in an in-memory `log` array and
deliver nothing — NO real provider integration. `website`/`social`/`internal`
have no provider and are store-only (marked `sent`). A provider that returns
`failed` or throws produces a `failed` message row with `failed_reason`; the
API call itself still succeeds. Swap in real adapters via
`messagingRouter(deps, { providers })`. The outbound `from` address is resolved
from the tenant's active channel config of the matching type.

## Events (emitted after the DB write succeeds)

| Event | Payload | When |
|---|---|---|
| `messaging.message.received` (catalog) | `{ messageId, channel, from }` | inbound recorded |
| `messaging.message.sent` | `{ messageId, channel, to }` | outbound accepted by provider |
| `messaging.conversation.closed` | `{ conversationId }` | status → closed |
| `messaging.conversation.assigned` | `{ conversationId, userId }` | assignment |

## Cross-module contracts

- **Implements** core's `SendMessageContract` via
  `createMessagingSendContract(db, events, options?)` — apps/api wires it into
  other modules' `deps.contracts.sendMessage`. Each call creates a new
  conversation (contract channel `portal` maps to `internal`;
  `relatedEntityType` `crm.customer`/`crm.contact` links the conversation) and
  sends one outbound message, returning `{ id: messageId }`.
- **Consumes** the documented `TimelineWriter` contract (exported here):

  ```ts
  interface TimelineWriter {
    recordTimelineEvent(input: {
      tenantId; entityType; entityId;   // 'crm.customer' | 'crm.contact' + id
      kind;                             // 'messaging.message.received' | 'messaging.conversation.closed'
      summary; occurredAt; refId?;      // refId = message/conversation id
    }): Promise<void>;
  }
  ```

  apps/api passes the CRM implementation via
  `messagingRouter(deps, { timeline })`. When a conversation is linked to a
  customer/contact, message-received and conversation-closed entries are
  written. Optional and best-effort: absent → skipped; a throwing writer never
  breaks the messaging mutation.

## HTTP API (mounted at `/api/messaging`, tenant via `x-tenant-id`)

```
GET    /inbox                              server-rendered HTML inbox (?conversation=<id> for thread view)
POST   /channels                           GET /channels · GET/PATCH/DELETE /channels/:id
POST   /conversations                      GET /conversations?status=&channel=&assigned_user_id=&customer_id=&sort=&limit=&offset=
GET    /conversations/:id                  detail incl. messages, participants, assignments
PATCH  /conversations/:id                  subject / CRM linking (customerId, contactId)
POST   /conversations/:id/status           { status } with transition rules
POST   /conversations/:id/assign           { userId, note? }
GET    /conversations/:id/assignments      assignment history
POST   /conversations/:id/participants     add a participant
GET    /conversations/:id/messages         paginated thread
POST   /conversations/:id/messages         send outbound { to?, subject?, body? | templateId?, variables? }
POST   /inbound                            inbound webhook entry { channel, from, body, ... } (threads/creates)
POST   /templates                          GET /templates · GET/PATCH/DELETE /templates/:id
POST   /templates/:id/render               { variables } → rendered subject/body preview
GET    /search?q=term                      { conversations: [...], messages: [...] }
```

Envelopes follow the platform convention: `{ data }` / `{ data, limit, offset }`
and `{ error: { message, code, details } }`.

## Usage

```ts
import { messagingMigrations, messagingRouter, seedMessaging } from '@blacklabel/messaging';

await runMigrations(db, [...coreMigrations, ...messagingMigrations]);
app.route('/api/messaging', messagingRouter({ db, events, contracts }, {
  providers: { email: realSendgridAdapter, sms: realTwilioAdapter },  // optional
  timeline: crmTimelineWriter,                                        // optional
}));
await seedMessaging(db, tenantId); // demo data (no events/audit)
```

## Tests

`npx vitest run packages/messaging` — 48 tests: migrations (fresh +
idempotent), threading, providers (stub log, failure paths), templates +
substitution, status transitions, assignment history + events, LIKE search +
wildcard escaping, timeline contract, SendMessageContract, router CRUD, inbox
HTML (escaping), and tenant-isolation denial tests for every entity.
