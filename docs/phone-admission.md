# FrontDesk phone admission

The business application authenticates the native FrontDesk Bearer credential and
binds it to its installed tenant and owner. These two phone endpoints additionally
require a verified session and the normal scheduling/review RBAC permission. The
standalone development owner's fallback identity does not qualify.

- `POST /api/scheduling/phone-bookings`: strict callerNumber, calendarId,
  appointmentTypeId, staffId, startsAt, endsAt and title. Model code receives only
  a per-call, expiring opaque offer. The trusted adapter supplies these server
  fields. The server derives customerId from exactly one caller contact, rejects
  ambiguous or inactive mappings, and checks the service's exact duration and
  current availability in the same transaction as final conflict checks/insertion.
- `POST /api/reviews/phone-request`: strict callerNumber only. A completed past
  appointment and a customer portal account are required. The response includes
  requestId and availableInCustomerPortal. The portal displays the feedback link
  after authentication. No review capability is returned to the model.

Customer creation/linking, audits and appointment insertion roll back together.
Request-local events are published only after commit, so database subscribers
cannot deadlock the transaction or observe a rolled-back customer.

Carrier caller metadata is trusted adapter context, not proof of a person's
identity. Missing or ambiguous mappings fail with staff assistance required.
Existing privileged staff scheduling and review routes keep their contracts.

Validation: `npm test`, `npm run typecheck`, and
`node_modules/.bin/tsx scripts/verify-phone-admission.ts` (requires the sibling
FrontDesk checkout and its Python venv, configurable with FRONTDESK_ROOT and
FRONTDESK_PYTHON). The latter uses a disposable in-memory database and loopback
HTTP. It never contacts a carrier or messaging provider. The separate real-ledger
acceptance script still requires the owner's actual MagsTack ledger.
