# Platform modules — implemented private candidate

Status: **NOT DONE** for all twelve modules and every gate. Updated 2026-10-03T18:36:25.731619+00:00. This is a source and scoped synthetic-check checkpoint; it does not establish a fresh package, paid entitlement, external delivery or buyer/device acceptance.

Actual implementation: `/Users/michaelbarber/BlackLabelPlatform`, `shflikawgfhlaigrk/bl-platform`, canonical commit `5296833500059a9247e25880c02c8715ab1f3f83` plus preserved owner changes. Isolated candidate: `task-6/platform`, branch `codex/module-outcomes-20261003`, snapshot `d4a8c3a99da0a74be4291004bc9a847ec1b69dfe` with current uncommitted slices. PR preservation baseline `c645d3f` separately preserves original cart assets; the original snapshot remains retained. [Snapshot manifest](../../source-snapshot.json). Root must bind the final unchanged candidate to a commit/artifact hash before acceptance.

## Included basics and boundaries

- [Business composition](../apps/api/src/app.ts) mounts the real modules; [business app](../apps/business/src/app.ts) binds installed tenant, owner sessions and separate customer/crew identities. [RBAC](../apps/api/src/rbac.ts) uses a reviewed method/path inventory. Customer/job records, local notifications/actions, permissions and basic source reports are shared implementation; a buyer must not need sibling subscriptions to finish its purchased job.
- Standalone purchase is **unproved**. Business settings disclose module declarations with `purchaseVerified=false`. Root owns sandbox purchase-to-company/module provisioning, cancellation/refund/access lifecycle and the one-module installation matrix. A runtime containing all tables is not that evidence.
- Existing public starting prices below are unchanged. Tests used synthetic local records/adapters. No customer messages, real charges, new credentials, live configuration, deployments or production merges are evidenced here.
- Preview uses the existing locked dependencies and a fresh task-owned `BLACKLABEL_BUSINESS_DATA` directory. Never use canonical/customer data. No new account/provider grant is required for the remaining local work. Source conventions remain [CONVENTIONS.md](../CONVENTIONS.md).
- Business transport supports internal messages and the existing Resend outbound email adapter. No live receiving-email/SMS/social connection is proved. Google Calendar uses an existing optional connection; mocked provider tests do not prove live calendar behavior. Billing is offline/manual; collection reminders are drafts and entered delivery references are not provider proof.
- [Customer record import](../apps/business/src/integrations.ts) supports import-only JSON preview, explicit identity mapping/conflict resolution and replay receipts. It preserves omitted fields/local edits and exposes follow-up event uncertainty; it does not write back to external CRM/accounting systems.

## Gate checkpoint

| Gate | Status and exact remaining evidence | Owner / next check |
|---|---|---|
| G1 | NOT DONE — accepted standalone job/purchase/access preflight and cross-device private preview | Root; run each module with only its purchase and included basics in fresh fixtures |
| G2 | NOT DONE — slices below are implemented; complete integrated product polish and all advertised-job gaps remain unaccepted | Root plus named module owner; replay failure and neighboring actions against final source |
| G3 | NOT DONE — slice checks overlap and do not replace independent clean-user/device/value/billing/recovery/scale evidence | Independent checker; exact committed candidate and fixture restore/retry/negative journeys |
| G4 | NOT DONE — founder acceptance of exact artifact/campaign, filming/final regression and authorized rollout absent | Michael after G1–G3; no founder action required now |

AI-solvable implementation, checks and preview preparation stay active. The buyer-priority answer is pending; the candidate continues with domain-neutral essentials. Black Water/window cleaning remains one candidate vertical. No claim of beating every competitor or willingness to pay is established.

## Implemented slices and remaining jobs

### CRM — $80/company/month — NOT DONE

Implemented: Owned next-action sales queue with bucket counts, tenant-owned assignees, revision checks and replay-safe completion receipts. Legacy open leads are surfaced without inventing completed actions.

Representative actual routes: `GET /api/crm/sales-queue`; `GET /api/crm/owners`; `PATCH /api/crm/leads/:id`; `POST /api/crm/leads/:id/next-action/complete`; `GET /api/crm/leads/:id/timeline`; `GET /api/crm/leads/export.csv`.

Included composition basics: customers, jobs, users, CRM tasks, queue summary. Standalone inclusion remains subject to the G1 matrix.

Remaining: Actual external due reminders, standalone provisioning and fresh owner/device/large-queue acceptance remain root-owned. Owner: `crm_queue` with root integration. Next check: final unchanged-source regression, then independent fresh-user/device job and recovery evidence.

Source/checks: [service.ts](../packages/crm/src/service.ts), [router.ts](../packages/crm/src/router.ts), [sales-queue.test.ts](../packages/crm/test/sales-queue.test.ts).

### Scheduling — $27/company/month — NOT DONE

Implemented: Admission and next-available use staff/resource hours, time off, buffers, timezone/DST rules and recurrence; terminal edits are guarded. Contract booking receipt atomically binds tenant/key/canonical payload to one appointment; identical replay returns its ID, drift 409. Reminder queue holds ambiguous submission and reconciles saved message evidence.

Representative actual routes: `POST /api/scheduling/appointments`; `POST /api/scheduling/appointments/:id/reschedule`; `POST /api/scheduling/appointments/:id/cancel`; `GET /api/scheduling/next-available`; `GET /api/scheduling/appointments/:id/reminders`.

Included composition basics: customers, jobs, reminders, customer booking actions, reports. Standalone inclusion remains subject to the G1 matrix.

Remaining: Clean-user booking/reschedule/resource/recurrence/device journey; live calendar conflicts/import and reminder delivery unverified. Recurrence edits affect one occurrence; outer caller transactions leave calendar sync pending for after-commit handling. Durable event delivery remains unproved. Owner: `scheduler_resources` with root integration. Next check: final unchanged-source regression, then independent fresh-user/device job and recovery evidence.

Source/checks: [service.ts](../packages/scheduling/src/service.ts), [availability-guards.test.ts](../packages/scheduling/test/availability-guards.test.ts), [contract-receipts.test.ts](../packages/scheduling/test/contract-receipts.test.ts), [business-reminders.test.ts](../apps/api/test/business-reminders.test.ts).

### Quoting — $38/company/month — NOT DONE

Implemented: Immutable full scope/version approval snapshot, stale-approval conflict and safe integer-cent pricing. Revision clones/replays safely and expires the old offer; accepted scope transfers through an atomic single job/invoice handoff with rollback/retry.

Representative actual routes: `POST /api/quoting/quotes/:id/revise`; `POST /api/quoting/quotes/:id/approve`; `POST /api/quoting/quotes/:id/convert`; `GET /api/quoting/quotes/:id/conversion`; `POST /api/portal-customer/me/quotes/:quoteId/approve`.

Included composition basics: customers, jobs, basic invoice, approval screens, files, reports. Standalone inclusion remains subject to the G1 matrix.

Remaining: Fresh-customer version/acceptance/handoff journey. Historical v1 approvals do not prove notes/files scope retroactively. Installed buyer wrapper rejects the legacy caller-payload from-quote path 409; raw package seam remains outside that protected surface. Owner: `quoting_integrity` with root integration. Next check: final unchanged-source regression, then independent fresh-user/device job and recovery evidence.

Source/checks: [service.ts](../packages/quoting/src/service.ts), [integrity.test.ts](../packages/quoting/test/integrity.test.ts), [business-conversion.ts](../apps/api/src/business-conversion.ts), [business-conversion.test.ts](../apps/api/test/business-conversion.test.ts), [billing-boundary.test.ts](../apps/business/test/billing-boundary.test.ts).

### CustomerPortal — $39/company/month — NOT DONE

Implemented: Customer-owned approvals/progress/invoices, actual shared file upload/download controls and repeat/completed-job or reschedule request receipts. Concurrent/open-request replay and changed-input conflicts; owner acknowledgement/answer with version checks is readable by the customer. Reminder preference can stop customer invoice reminder drafts.

Representative actual routes: `GET /api/portal-customer/ui`; `POST /api/portal-customer/me/requests`; `GET /api/portal-customer/me/requests`; `PATCH /api/portal-customer/requests/:requestId`; `POST /api/portal-customer/ui/requests`; `GET /api/portal-customer/ui/files/:fileId/content`; `POST /api/portal-customer/ui/uploads`; `PUT /api/portal-customer/me/invoices/:invoiceId/reminder-preference`.

Included composition basics: customers, jobs, basic quote/invoice, files, notifications. Standalone inclusion remains subject to the G1 matrix.

Remaining: Requests require owner to make the actual booking then answer; they do not silently change capacity. Fresh-customer/device sign-in/file/request/approval journey and live email/TLS delivery unproved. Owner: `root` with root integration. Next check: final unchanged-source regression, then independent fresh-user/device job and recovery evidence.

Source/checks: [router.ts](../packages/portal-customer/src/router.ts), [service.ts](../packages/portal-customer/src/service.ts), [requests.test.ts](../packages/portal-customer/test/requests.test.ts), [business-portal-requests.test.ts](../apps/api/test/business-portal-requests.test.ts), [portal-customer.js](../apps/business/public/portal-customer.js).

### EmployeePortal — $28/company/month — NOT DONE

Implemented: Completion is blocked by incomplete checklists, open exceptions, running time or unapproved linked time. Reasoned replay-safe exceptions, exact-item manager waivers, explicit approve/reject/re-review, job assignment time and one audited completion event. Crew/owner closeout controls and total time review summary; existing historical records retain pending review rather than fabricated approval.

Representative actual routes: `GET /api/portal-employee/assignments/:assignmentId/closeout`; `GET /api/portal-employee/time-entries`; `POST /api/portal-employee/time-entries/:entryId/review`; `POST /api/portal-employee/portal/assignments/:assignmentId/exceptions`; `POST /api/portal-employee/portal/assignments/:assignmentId/status`; `POST /api/portal-employee/portal/clock-in`; `POST /api/business/team/assignments/:assignmentId/photos`.

Included composition basics: jobs, employees, checklists, vault, time review, reports. Standalone inclusion remains subject to the G1 matrix.

Remaining: Independent crew/manager device closeout and approved-hours export/report journey; assignment-to-source job linkage/provisioning evidence remains required. Owner: `root` with root integration. Next check: final unchanged-source regression, then independent fresh-user/device job and recovery evidence.

Source/checks: [service.ts](../packages/portal-employee/src/service.ts), [closeout.test.ts](../packages/portal-employee/test/closeout.test.ts), [team.js](../apps/business/public/team.js), [employee.js](../apps/business/public/employee.js), [team.test.ts](../apps/business/test/team.test.ts).

### OwnerDashboard — $57/company/month — NOT DONE

Implemented: Six source-linked exception categories with exact paginated totals, hasMore, capped rows and local sampledAt/staleAt. Unavailable source produces null count/partial; externalFreshness stays not_verified. Crew exceptions, time review and waivers link to source inspection and valid workspace.

Representative actual routes: `GET /api/dashboard/exceptions`; `GET /api/dashboard/export`.

Included composition basics: source records, local source freshness, basic reports remain elsewhere. Standalone inclusion remains subject to the G1 matrix.

Remaining: Entity action drilldown beyond existing capped module lists; independent stale/missing-source/mobile/value/scale evidence. Basic reports stay included in source modules. Owner: `owner_exceptions` with root integration. Next check: final unchanged-source regression, then independent fresh-user/device job and recovery evidence.

Source/checks: [exceptions.ts](../packages/dashboard/src/exceptions.ts), [exceptions.test.ts](../packages/dashboard/test/exceptions.test.ts), [exceptions-ui.test.ts](../packages/dashboard/test/exceptions-ui.test.ts).

### UnifiedInbox — $100/company/month — NOT DONE

Implemented: Business composer exposes supported email/internal only; unsupported historical channels remain searchable and missing provider fails before writing outbound messages. Tenant/provider/channel/eventID inbound receipts prevent duplicate message/CRM mirror/reopen; changed body conflicts. Tenant-owned assignee and revision/CAS outbound ownership, closed/unresolved blocks; exact saved-message/provider-ID readback and reconciliation without resend.

Representative actual routes: `GET /api/messaging/inbox`; `POST /api/messaging/conversations/:id/assign`; `POST /api/messaging/inbound`; `GET /api/messaging/inbound-receipts`; `GET /api/messaging/messages/:id`; `POST /api/messaging/messages/:id/reconcile`.

Included composition basics: customers, staff, files, internal notifications. Standalone inclusion remains subject to the G1 matrix.

Remaining: No authenticated live inbound email/SMS/social connector; owner ingestion API is not provider ingress. External Resend authentication, delivery and clean-user/device ownership/recovery still unproved. Owner: `review_recovery` with root integration. Next check: final unchanged-source regression, then independent fresh-user/device job and recovery evidence.

Source/checks: [service.ts](../packages/messaging/src/service.ts), [inbound-ownership.test.ts](../packages/messaging/test/inbound-ownership.test.ts), [durable-delivery.test.ts](../packages/messaging/test/durable-delivery.test.ts), [messaging.js](../apps/business/public/messaging.js).

### ReviewEngine — $60/company/month — NOT DONE

Implemented: Neutral all-eligible completed CRM job/past-completed-appointment campaign with source/customer dedup receipts and usable-email checks. Enabled public destinations visible equally for every rating and opt-out revisits; low rating flags internal follow-up only. Tenant-wide persistent opt-out suppresses future requests/reminders; transactional campaign/submit/opt-out and held uncertain delivery with local messaging readback.

Representative actual routes: `GET /api/reviews/eligible-customers`; `POST /api/reviews/campaigns/completed-jobs`; `GET /api/reviews/public/requests/:token`; `POST /api/reviews/requests/:id/delivery`.

Included composition basics: customers, completed jobs, email, neutral customer screen, receipts. Standalone inclusion remains subject to the G1 matrix.

Remaining: No external review import; QR remains placeholder. Independent clean-customer neutral/opt-out/recovery journey and real provider delivery evidence unproved. Owner: `review_recovery` with root integration. Next check: final unchanged-source regression, then independent fresh-user/device job and recovery evidence.

Source/checks: [service.ts](../packages/reviews/src/service.ts), [router.ts](../packages/reviews/src/router.ts), [eligibility-recovery.test.ts](../packages/reviews/test/eligibility-recovery.test.ts), [public-ui.test.ts](../packages/reviews/test/public-ui.test.ts), [business-reviews.test.ts](../apps/api/test/business-reviews.test.ts).

### WorkflowAutomation — $24/company/month — NOT DONE

Implemented: Three bounded local presets: lead-first-touch, approved-quote-handoff, completed-job-closeout; repeat installation preserves owner edits. Stable tenant/workflow/event identity, frozen actions/name/retry inputs, expiring claims and attempts counted before effects. Atomic local task/tag/notification receipts; stable invoice source and appointment keys recover real contract commit-before-log crashes and reject conflicting payload reuse.

Representative actual routes: `GET /api/workflows/recipes`; `POST /api/workflows/recipes/:key/install`; `GET /api/workflows/executions/:id`; `POST /api/workflows/run-pending`.

Included composition basics: records required by recipe, basic tasks/notifications included elsewhere. Standalone inclusion remains subject to the G1 matrix.

Remaining: Lost events before engine admission/postcommit notification delivery have no durable outbox; calendar-provider delivery and ambiguous arbitrary webhook retries unproved. Missing destination contracts still skip; preset/device/scale acceptance required. Owner: `source_discovery` with root integration. Next check: final unchanged-source regression, then independent fresh-user/device job and recovery evidence.

Source/checks: [engine.ts](../packages/workflows/src/engine.ts), [recipes.ts](../packages/workflows/src/recipes.ts), [recovery-receipts.test.ts](../packages/workflows/test/recovery-receipts.test.ts), [RECOVERY-EVIDENCE.json](../packages/workflows/evidence/RECOVERY-EVIDENCE.json).

### Billing — $70/company/month — NOT DONE

Implemented: Tenant/source invoice receipts with legacy adoption/ambiguity checks; manual payment reference replay and one invoice deposit/balance installment plan. Actual offline payment instructions, draft collection reminders stopped by opt-out/paid/void/changed balance, manual delivery-reference records. Invoice/payment ledger exports, paid-invoice void guard and subscription period receipts.

Representative actual routes: `GET /api/billing/invoices/:id/collection-plan`; `PUT /api/billing/invoices/:id/collection-plan`; `POST /api/billing/invoices/:id/payments`; `POST /api/billing/invoices/:id/payment-intents`; `POST /api/billing/invoices/:id/reminders`; `POST /api/billing/invoices/:id/reminders/:reminderId/receipt`; `GET /api/billing/invoices/export.csv`; `GET /api/billing/payments/export.csv`.

Included composition basics: customers, job/approved scope, customer payment instructions, export. Standalone inclusion remains subject to the G1 matrix.

Remaining: Runtime collection is offline/manual; reminder rows are drafts, delivery references do not prove provider delivery. No full accounting/bank reconciliation/real card-charge proof. Fresh owner/customer deposit/export/restore journey required. Owner: `quoting_integrity` with root integration. Next check: final unchanged-source regression, then independent fresh-user/device job and recovery evidence.

Source/checks: [service.ts](../packages/billing/src/service.ts), [collections.test.ts](../packages/billing/test/collections.test.ts), [providers.ts](../packages/billing/src/providers.ts), [billing.js](../apps/business/public/billing.js).

### FileVault — $60/company/month — NOT DONE

Implemented: Original-byte reads verify size and SHA256 and deny corruption; job/record evidence JSON includes accessible originals and manifest data. Export is tenant/file-permission scoped, max100 originals/50MB; no installation/storage secrets included. Existing private company backup/restore remains separate.

Representative actual routes: `GET /api/files/evidence?entity_type=crm.job&entity_id=:jobId`; `GET /api/files/files/:id/content`; `POST /api/files/uploads`; `POST /api/files/uploads/:id/complete`; `GET /api/files/files/:id/permissions`.

Included composition basics: customers, jobs, capture/upload, tenant/user permissions, backup. Standalone inclusion remains subject to the G1 matrix.

Remaining: Fresh-directory restore/corruption/permissions/device/export evidence; upload resume/version history/retention and large exports beyond bounded packet are not implemented. Private whole-company backup contains installation secrets and is not a portable customer packet. Owner: `crm_queue` with root integration. Next check: final unchanged-source regression, then independent fresh-user/device job and recovery evidence.

Source/checks: [service.ts](../packages/files/src/service.ts), [evidence.test.ts](../packages/files/test/evidence.test.ts), [permissions.test.ts](../packages/files/test/permissions.test.ts), [recovery.ts](../apps/business/src/recovery.ts).

### IndustryModules — $159/company/month — NOT DONE

Implemented: Explicit apply in real businessPortals composition installs/readbacks CRM stages, Quoting templates, Scheduling types and supported local create_task recipes. Runtime receipts show installed/preserved/needs_configuration/unsupported/missing/failed; owner edits/deletions and repeated switches preserved. Neutral service-delivery configuration; zero-price quote template intentionally inactive until owner sets rate/enables; unsupported external defaults disabled.

Representative actual routes: `POST /api/industries/:key/apply`; `GET /api/industries/applied`; `GET /api/industries/terminology`.

Included composition basics: required core records/quote/scheduling/crew/billing workflows. Standalone inclusion remains subject to the G1 matrix.

Remaining: Complete independent company request-to-approved-closeout/collection journey; generic UI labels do not consume all terminology, arbitrary industry widgets remain read model. Auto-paused earlier recipes remain paused on switching back until explicit owner activation. Buyer priority still pending. Owner: `owner_exceptions` with root integration. Next check: final unchanged-source regression, then independent fresh-user/device job and recovery evidence.

Source/checks: [business-industry-wiring.ts](../apps/api/src/business-industry-wiring.ts), [runtime.ts](../packages/industries/src/runtime.ts), [service-delivery.ts](../packages/industries/src/configs/service-delivery.ts), [business-industry-wiring.test.ts](../apps/api/test/business-industry-wiring.test.ts).

## Scoped evidence and next root checkpoint

Reports below are attributed to the slice owners; overlapping scopes must not be added. Subsequent code changes require root to rerun affected checks. No module is promoted to DONE by these reports.

| Scope | Reported evidence |
|---|---|
| CRM | 62 focused checks; tenant/owner/revision/replay/legacy behavior, strict TypeScript and UI syntax |
| Employee | 52 focused checks; checklist/exception/manager-time closeout gates |
| Scheduling / Workflow / Portal / API / business compatibility | 179 checks in 20 overlapping files:111 scheduling/workflow/neighbors + 68 portal/API/business; local appointment receipts and original 6 MB file roundtrip, scoped TypeScript/UI syntax |
| Quoting / Billing / portal / conversion / Team | 163 checks in 21 overlapping files plus 2 installed billing-boundary checks; TypeScript |
| Dashboard / Industry / real composition | 135 checks:72 Dashboard + 55 Industry + 8 composition; owner-edit/reapply/switch regression independently replayed |
| Inbox / Reviews / review composition | 145 checks in 18 files; targeted TypeScript, business JS syntax, equal rating links and opt-out/recovery |
| Workflow | 60 checks in 7 files plus narrowed TypeScript/UI syntax; [source-hashed recovery evidence](../packages/workflows/evidence/RECOVERY-EVIDENCE.json) includes real appointment/invoice commit-before-log retries |
| FileVault / customer imports / limits / runtime access | Independent 15 checks plus event-failure replay,50 MiB/EACCES/missing-original probes; larger evidence packets safely refuse |

Next checkpoint: root freezes final source identity and runs [the scoped candidate checks](../scripts/check-module-candidate.mjs), prepares an isolated synthetic private preview and completes independent G3 journeys. Package/install/update/restore proof must use the exact final artifact. External adapter evidence requires verified account/provider receipts and delivery readback; no live operation is implied by this checkpoint. [Machine-readable module contract](MODULE-CONTRACT-CHECKPOINT.json) records each route, included basics, owner, cause and next check.

## Firm residual milestones

1. Root freezes final code and reviewable diff, records exact commit/artifact and reruns affected checks. The earlier root 597/66 report predates final cooldown/UI patches and is not the final acceptance result.
2. Root completes a fresh one-module company/purchase matrix with synthetic or sandbox receipts: required basics, job completion, cancel/refund/access lifecycle and no hidden sibling purchases. **No production charges or new payment accounts are needed now.**
3. Root finishes the exact package/private preview currently underway; an independent checker completes fresh install, cross-device actions, permissions, offline payment instructions, restore/retry/export and bounded-scale journeys. A package build alone does not complete this milestone.
4. After those checkpoints, Michael tests the exact candidate, then filming/final regression and separately authorized rollout follow. No founder action is required now. Actual production proof is required before WORKING LIVE.
