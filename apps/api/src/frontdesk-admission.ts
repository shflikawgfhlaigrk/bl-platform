/** Trusted phone adapter boundary. Model inputs never supply customer identity. */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { ApiError, asCoreDb, errorHandler, nowIso, tenantMiddleware, EventBus, type TenantEnv } from '@blacklabel/core';
import type { Kysely } from '@blacklabel/db';
import { createCustomer, updateContact, type CrmDatabase } from '@blacklabel/crm';
import { createAppointment, createSchedulingContext, findNextAvailable, getCalendar, getAppointmentType,
  type SchedulingDatabase, type SchedulingRouterOptions } from '@blacklabel/scheduling';
import { createRequest, type ReviewsDatabase } from '@blacklabel/reviews';
import type { PlatformDatabase } from './app';

const caller = z.string().regex(/^\+[1-9][0-9]{7,14}$/);
const booking = z.object({ callerNumber: caller, calendarId: z.string().min(1), appointmentTypeId: z.string().min(1),
  staffId: z.string().min(1), startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }),
  title: z.string().trim().min(1).max(200) }).strict();
const review = z.object({ callerNumber: caller }).strict();
const actorOf = (c: Context) => c.get('actingUserId') as string || 'system';

// Service events must reach database-using subscribers only AFTER commit.
// A rolled-back admission discards this request-local buffer entirely.
function deferredEvents(target: EventBus) {
  const bus = new EventBus();
  const pending: Array<{ tenantId: string; type: string; payload: unknown }> = [];
  bus.on('*', event => { pending.push(event); });
  return { bus, flush: async () => {
    for (const event of pending) await target.emit(event.tenantId, event.type, event.payload);
  } };
}

/** The caller number is fixed by the authenticated carrier adapter, never the LLM.
 * A CRM contact's ID is not a customer ID. Ambiguous/inactive mappings fail closed.
 */
async function resolveCaller(db: Kysely<PlatformDatabase>, events: EventBus, tenantId: string, phone: string,
  actor: string, create: boolean): Promise<string> {
  const contacts = await db.selectFrom('crm_contacts').selectAll().where('tenant_id', '=', tenantId)
    .where('phone', '=', phone).orderBy('id').limit(2).execute();
  if (contacts.length !== 1) throw ApiError.conflict('Resolve the caller contact with staff before proceeding');
  const contact = contacts[0];
  let customerId = contact.customer_id;
  if (!customerId) {
    const matches = await db.selectFrom('crm_customers').selectAll().where('tenant_id', '=', tenantId)
      .where('phone', '=', phone).orderBy('id').limit(2).execute();
    if (matches.length > 1) throw ApiError.conflict('Caller matches multiple customer accounts');
    customerId = matches[0]?.id ?? null;
    if (!customerId && create) {
      const customer = await createCustomer(db as unknown as Kysely<CrmDatabase>, events, tenantId, actor,
        { name: [contact.first_name, contact.last_name].filter(Boolean).join(' '), phone });
      customerId = customer.id;
    }
    if (!customerId) throw ApiError.conflict('Caller has no linked customer account');
    if (create) await updateContact(db as unknown as Kysely<CrmDatabase>, tenantId, actor, contact.id, { customer_id: customerId });
  }
  const customer = await db.selectFrom('crm_customers').select(['id', 'status']).where('tenant_id', '=', tenantId)
    .where('id', '=', customerId).executeTakeFirst();
  if (!customer || customer.status !== 'active') throw ApiError.conflict('Caller customer account is unavailable');
  return customer.id;
}

export function frontdeskAdmissionRouter(db: Kysely<PlatformDatabase>, events: EventBus, options: SchedulingRouterOptions = {}) {
  const app = new Hono<TenantEnv & { Variables: { verifiedSession?: boolean } }>();
  app.onError(errorHandler);
  for (const path of ['/scheduling/phone-bookings', '/reviews/phone-request']) {
    app.use(path, tenantMiddleware(asCoreDb(db)));
    app.use(path, async (c, next) => {
      if (!c.get('verifiedSession')) throw ApiError.unauthorized('Authenticated phone adapter session required');
      return next();
    });
  }
  const ctx = createSchedulingContext({ db: db as unknown as Kysely<SchedulingDatabase>, events, ...options });

  app.post('/scheduling/phone-bookings', async c => {
    const input = booking.parse(await c.req.json());
    const tenant = c.get('tenantId'), actor = actorOf(c);
    const queued = deferredEvents(events);
    const calendar = await getCalendar(ctx, tenant, input.calendarId);
    const result = await createAppointment({ ...ctx, events: queued.bus }, tenant, { calendarId: calendar.id, appointmentTypeId: input.appointmentTypeId,
      title: input.title, startsAt: input.startsAt, endsAt: input.endsAt, staffIds: [input.staffId], timezone: calendar.timezone,
      status: 'confirmed' }, actor, async transaction => {
      const currentCalendar = await getCalendar(transaction, tenant, input.calendarId);
      if (currentCalendar.timezone !== calendar.timezone) throw ApiError.conflict('Calendar changed; find a new slot');
      const type = await getAppointmentType(transaction, tenant, input.appointmentTypeId);
      const start = DateTime.fromISO(input.startsAt).toUTC();
      const end = start.plus({ minutes: type.duration_minutes });
      if (start.toMillis() <= Date.now() || end.toMillis() !== DateTime.fromISO(input.endsAt).toMillis()) {
        throw ApiError.conflict('The offered service duration or time changed; find a new slot');
      }
      // This is inside the same serialized transaction as final conflict checks
      // and insertion. Hours, exceptions, staff and service changes are re-read.
      const available = await findNextAvailable(transaction, tenant, { appointmentTypeId: type.id,
        from: start.setZone(calendar.timezone).toFormat('yyyy-MM-dd'), days: 1, timezone: calendar.timezone,
        staffId: input.staffId, after: start.minus({ milliseconds: 1 }).toISO()!, limit: 1 });
      const slot = available.slots[0];
      if (!slot || Date.parse(slot.starts_at) !== start.toMillis() || Date.parse(slot.ends_at) !== end.toMillis()) {
        throw ApiError.conflict('That offered slot is no longer available');
      }
      const customerId = await resolveCaller(transaction.db as unknown as Kysely<PlatformDatabase>, queued.bus, tenant,
        input.callerNumber, actor, true);
      return { customerId };
    });
    await queued.flush();
    return c.json({ data: result }, 201);
  });

  app.post('/reviews/phone-request', async c => {
    const input = review.parse(await c.req.json());
    const tenant = c.get('tenantId'), actor = actorOf(c);
    const queued = deferredEvents(events);
    const requestId = await db.transaction().execute(async trx => {
      const customerId = await resolveCaller(trx, queued.bus, tenant, input.callerNumber, actor, false);
      // Delivery is the existing authenticated customer portal. Neither a model
      // nor an unverified spoken address ever receives a bearer review link.
      const account = await trx.selectFrom('portal_customer_accounts').select('id').where('tenant_id', '=', tenant)
        .where('customer_id', '=', customerId).orderBy('id').executeTakeFirst();
      if (!account) throw ApiError.conflict('Customer portal access must be set up before requesting a review');
      const completed = await trx.selectFrom('scheduling_appointments').select(['id', 'ends_at']).where('tenant_id', '=', tenant)
        .where('customer_id', '=', customerId).where('status', '=', 'completed').where('ends_at', '<=', nowIso())
        .orderBy('ends_at', 'desc').orderBy('id').executeTakeFirst();
      if (!completed) throw ApiError.conflict('A completed appointment is required before requesting a review');
      const previous = await trx.selectFrom('reviews_requests').select(['id', 'status']).where('tenant_id', '=', tenant)
        .where('customer_id', '=', customerId).where('created_at', '>=', completed.ends_at)
        .orderBy('created_at', 'desc').orderBy('id').executeTakeFirst();
      if (previous) {
        if (previous.status === 'completed' || previous.status === 'opted_out') throw ApiError.conflict('Feedback was already handled for the completed appointment');
        return previous.id;
      }
      const request = await createRequest(trx as unknown as Kysely<ReviewsDatabase>, queued.bus, tenant, actor, { customerId });
      return request.id;
    });
    await queued.flush();
    return c.json({ data: { requestId, availableInCustomerPortal: true } }, 201);
  });
  return app;
}
