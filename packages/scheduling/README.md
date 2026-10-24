# @blacklabel/scheduling

Universal, industry-neutral scheduling/calendar engine for the BlackLabel
Platform: spa appointments, service jobs, consultations, shifts, dispatch,
meetings — same primitives everywhere.

## Objects

| Object | Table | Notes |
|---|---|---|
| Calendar | `scheduling_calendars` | has an IANA `timezone`; appointments are stored UTC |
| Location | `scheduling_locations` | optional per-location timezone |
| StaffMember | `scheduling_staff_members` | optional `user_id` link to core users (id string only) |
| Resource | `scheduling_resources` | rooms, vehicles, equipment… (`kind` is free text) |
| AppointmentType | `scheduling_appointment_types` | per-tenant duration + before/after buffers |
| AvailabilityWindow | `scheduling_availability_windows` | weekly windows per staff/resource (weekday 1=Mon…7=Sun, "HH:MM") |
| AvailabilityException | `scheduling_availability_exceptions` | dated overrides: time off or extra hours |
| ScheduleRule | `scheduling_schedule_rules` | RRULE-lite (daily/weekly/monthly, interval, count XOR until) |
| Appointment | `scheduling_appointments` | status machine, internal `notes`, materialized occurrences |
| — staff/resource assignment | `scheduling_appointment_staff` / `scheduling_appointment_resources` | many-to-many |
| Reminder | `scheduling_reminders` | `send_at` + provider-stub delivery |
| Appointment receipt | `scheduling_appointment_receipts` | tenant-scoped contract retry key + payload hash + original appointment id |

Every table carries `tenant_id`; every query filters by it. The tenant comes
from the core `x-tenant-id` middleware — never from the body. The acting user
may be sent as `x-user-id` (defaults to `system` in the audit log).

## Statuses

`requested → confirmed → completed | no_show`, and `requested|confirmed →
canceled`. Anything else is a `409` with `{ from, to, allowed }` details.
`completed`, `canceled`, `no_show` are terminal.

## Wiring (apps/api)

```ts
import { schedulingMigrations, schedulingRouter, createSchedulingContract } from '@blacklabel/scheduling';

await runMigrations(db, [...coreMigrations, ...schedulingMigrations]);
app.route('/api/scheduling', schedulingRouter({ db, events, contracts }));
// cross-module bookings (workflows, crm, …):
contracts.createAppointment = createSchedulingContract({ db, events });
```

`schedulingRouter(deps, options?)` optionally takes `{ calendarSync,
reminderDelivery }` provider implementations; defaults are the built-in stubs.

## API examples

All requests need `x-tenant-id`. Envelopes: `{ "data": … }` for single
entities, `{ "data": […], "limit": n, "offset": n }` for lists. Errors:
`{ "error": { "message", "code", "details" } }`.

### Calendars, staff, resources, types

```bash
curl -X POST /api/scheduling/calendars -H 'x-tenant-id: T' \
  -d '{ "name": "Main", "timezone": "America/Chicago" }'

curl -X POST /api/scheduling/staff -H 'x-tenant-id: T' \
  -d '{ "name": "Alex Morgan", "email": "alex@example.com", "userId": "core-user-id" }'

curl -X POST /api/scheduling/resources -H 'x-tenant-id: T' \
  -d '{ "name": "Room 1", "kind": "room" }'

curl -X POST /api/scheduling/appointment-types -H 'x-tenant-id: T' \
  -d '{ "name": "Consultation", "durationMinutes": 30, "bufferBeforeMinutes": 5, "bufferAfterMinutes": 10 }'
```

### Availability

```bash
# Weekly window: Mondays 09:00–17:00 for a staff member
curl -X POST /api/scheduling/availability-windows -H 'x-tenant-id: T' \
  -d '{ "ownerType": "staff", "ownerId": "STAFF_ID", "weekday": 1, "startTime": "09:00", "endTime": "17:00" }'

# Exception: afternoon off on one date
curl -X POST /api/scheduling/availability-exceptions -H 'x-tenant-id: T' \
  -d '{ "ownerType": "staff", "ownerId": "STAFF_ID", "date": "2027-06-07", "available": false, "startTime": "13:00", "endTime": "17:00" }'

# Free slots for a local date (windows − exceptions − bookings incl. buffers), returned as UTC intervals
curl '/api/scheduling/availability?owner_type=staff&owner_id=STAFF_ID&date=2027-06-07&timezone=America/Chicago' \
  -H 'x-tenant-id: T'

# Duration-sized suggestions requiring both staff and every selected resource.
# calendar_id makes hours use the same timezone as booking admission.
curl '/api/scheduling/next-available?appointment_type_id=TYPE_ID&calendar_id=CAL_ID&staff=any&resource_ids=ROOM_ID,VEHICLE_ID&from=2027-06-07&days=7' \
  -H 'x-tenant-id: T'
# slots carry starts_at, ends_at, staff_id, resource_ids and local date.
```

Booking and rescheduling enforce configured weekly hours and dated time off
for every assigned staff member and resource, including before/after buffers.
Hours follow the selected calendar's timezone; a timestamp parsing timezone
does not redefine them. Time off wins over added hours regardless of exception
ordering. A denied recurring occurrence rejects the entire new series. Existing
appointments are not moved or canceled when hours change.

For compatibility, an owner with no weekly hours remains manually bookable,
subject to explicit dated hours and time off. Suggested slots require staff
hours; resources without weekly hours may accompany those slots subject to their
dated exceptions and existing bookings. Suggestions are advisory: booking
rechecks conflicts and hours in its transaction. Rescheduling changes the
selected occurrence only.

### Appointments

```bash
# Book. startsAt without an offset is interpreted in `timezone`
# (default: the calendar's zone) and stored as UTC. endsAt may be omitted
# when appointmentTypeId supplies a duration.
curl -X POST /api/scheduling/appointments -H 'x-tenant-id: T' \
  -d '{
    "calendarId": "CAL_ID",
    "title": "Consultation — new customer",
    "appointmentTypeId": "TYPE_ID",
    "customerId": "crm-customer-id",
    "startsAt": "2027-06-07T09:30:00",
    "staffIds": ["STAFF_ID"],
    "resourceIds": ["ROOM_ID"],
    "notes": "internal note — never exported"
  }'
# → 201 { "data": { "appointments": [ … ], "scheduleRuleId": null } }
# → 409 on staff/resource double-booking (buffers included):
#   { "error": { "code": "conflict", "details": { "conflicts": [
#       { "owner_type": "staff", "owner_id": "…", "appointment_id": "…", "starts_at": "…", "ends_at": "…" } ] } } }
# → 409 outside hours: details.unavailable names owner_type, owner_id and
#   local date; details.timezone is the calendar's zone.

# Recurring (RRULE-lite): daily/weekly/monthly, interval, count XOR until.
# Occurrences are materialized as appointment rows sharing scheduleRuleId.
# Cap: max 100 occurrences per rule — a count/until beyond that is a 400.
curl -X POST /api/scheduling/appointments -H 'x-tenant-id: T' \
  -d '{ "calendarId": "CAL_ID", "title": "Weekly service", "startsAt": "2027-06-07T11:00:00",
        "endsAt": "2027-06-07T12:00:00", "recurrence": { "frequency": "weekly", "count": 4 } }'

# List with filters: calendar_id, status, staff_id, resource_id, customer_id, from, to (+ limit/offset)
curl '/api/scheduling/appointments?staff_id=STAFF_ID&status=confirmed&from=2027-06-01T00:00:00Z' -H 'x-tenant-id: T'

curl -X POST /api/scheduling/appointments/APPT_ID/reschedule -H 'x-tenant-id: T' \
  -d '{ "startsAt": "2027-06-08T10:00:00", "timezone": "America/Chicago" }'   # duration preserved if endsAt omitted

curl -X POST /api/scheduling/appointments/APPT_ID/cancel -H 'x-tenant-id: T' -d '{ "reason": "customer request" }'
curl -X POST /api/scheduling/appointments/APPT_ID/status -H 'x-tenant-id: T' -d '{ "status": "completed" }'
curl -X PATCH /api/scheduling/appointments/APPT_ID -H 'x-tenant-id: T' -d '{ "notes": "updated internal note" }'
```

### Reminders

```bash
curl -X POST /api/scheduling/appointments/APPT_ID/reminders -H 'x-tenant-id: T' \
  -d '{ "sendAt": "2027-06-06T09:30:00Z", "channel": "email", "recipient": "c@example.com", "message": "See you tomorrow" }'

# Delivery queue for a worker: pending AND send_at <= before (default now)
curl '/api/scheduling/reminders/pending?before=2027-06-06T10:00:00Z' -H 'x-tenant-id: T'

# Deliver through the configured provider (stub by default); marks it sent
curl -X POST /api/scheduling/reminders/REM_ID/send -H 'x-tenant-id: T'
```

Canceling an appointment cancels its pending reminders.

### ICS export

```bash
curl /api/scheduling/calendars/CAL_ID/ics -H 'x-tenant-id: T'
# text/calendar; valid VCALENDAR/VEVENT, UTC DTSTART/DTEND, RFC5545 escaping
# and line folding. Canceled appointments and internal notes are excluded.
```

## Events

Catalog events (emitted after the DB write):

- `scheduling.appointment.scheduled` `{ appointmentId, customerId, startsAt }` — one per materialized occurrence
- `scheduling.appointment.completed` `{ appointmentId }`
- `scheduling.appointment.canceled` `{ appointmentId, reason? }`

Module-internal events:

- `scheduling.appointment.rescheduled` `{ appointmentId, startsAt, endsAt }`
- `scheduling.reminder.sent` `{ reminderId, appointmentId, channel }`

## Integration layer (Google-Calendar-ready)

`ExternalCalendarProvider` (`upsertEvent` / `deleteEvent`) is the seam for a
real Google Calendar sync; the shipped `NoopExternalCalendarProvider` records
calls and talks to nobody. Sync is best-effort — provider failures never break
a mutation. `ReminderDeliveryProvider` is the same seam for reminder
transports (`StubReminderProvider` ships as default). Inject real ones via
`schedulingRouter(deps, { calendarSync, reminderDelivery })`.

## Contract

`createSchedulingContract({ db, events })` implements core's
`CreateAppointmentContract`: books on the tenant's first calendar (creating a
"Default" UTC calendar if none exists) and resolves `assigneeUserId` to a
staff member via `staff.user_id` (unassigned if no match).

An optional `idempotencyKey` records the appointment and receipt in one
transaction. Concurrent calls/retries with the same tenant, key, and normalized
payload return the original appointment id without another booking, scheduled
event, or calendar operation. A changed payload or dangling receipt returns
`409` for review. Retries reconcile the original appointment even if it was
later canceled; they do not rebook canceled work. Workflow actions supply a
stable execution/action key and retain their original retry payload.

The contract supports an existing caller transaction; the caller injects a
deferred event bus and owns event release after commit. External calendar sync
stays pending in that case, so a rolled-back outer transaction reaches no
external calendar. Ordinary calls synchronize after their own commit. This
receipt protects local booking writes; it does not prove remote-provider
delivery or durable event replay across a process crash.

## Seed & tests

```ts
import { seedScheduling } from '@blacklabel/scheduling';
await seedScheduling(db, tenantId); // calendar, location, 2 staff, room, 2 types, windows, appointments, reminder
```

```bash
npx vitest run packages/scheduling   # 41 tests: conflicts, recurrence, DST/tz, ICS, reminders, tenant isolation
```
