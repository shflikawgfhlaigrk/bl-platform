import { ApiError, nowIso, type EventBus } from '@blacklabel/core';
import type { Kysely } from '@blacklabel/db';
import { ENTITY_DEFS, getEntity, type CrmDatabase } from '@blacklabel/crm';
import { createMessagingSendContract, MessagingService, type MessagingDatabase, type MessagingServiceOptions } from '@blacklabel/messaging';
import type { ReviewProvider, ReviewProviderSendContext, ReviewCompletedJob, ReviewsDatabase } from '@blacklabel/reviews';
import type { SchedulingDatabase } from '@blacklabel/scheduling';

/** One stable messaging operation per review request/reminder, with saved readback. */
export function businessReviewProvider<DB extends CrmDatabase & MessagingDatabase & SchedulingDatabase & ReviewsDatabase>(db: Kysely<DB>, events: EventBus,
  messaging: MessagingServiceOptions, publicOrigin: () => string | undefined): ReviewProvider {
  const data = db as unknown as Kysely<CrmDatabase & MessagingDatabase & SchedulingDatabase & ReviewsDatabase>;
  const messages = new MessagingService(db as unknown as Kysely<MessagingDatabase>, events, messaging);
  const contract = createMessagingSendContract(db as unknown as Kysely<MessagingDatabase>, events, messaging);
  async function listCompletedJobs(tenantId: string): Promise<ReviewCompletedJob[]> {
    const customers = await data.selectFrom('crm_customers').select(['id', 'name', 'email']).where('tenant_id', '=', tenantId)
      .orderBy('id').execute();
    const byId = new Map(customers.map(customer => [String(customer.id), customer]));
    const jobs = await data.selectFrom('crm_jobs').select(['id', 'customer_id', 'updated_at']).where('tenant_id', '=', tenantId)
      .where('status', '=', 'completed').orderBy('updated_at', 'desc').orderBy('id').execute();
    const appointments = await data.selectFrom('scheduling_appointments').select(['id', 'customer_id', 'ends_at']).where('tenant_id', '=', tenantId)
      .where('status', '=', 'completed').where('ends_at', '<=', nowIso()).orderBy('ends_at', 'desc').orderBy('id').execute();
    const completed = [
      ...jobs.map(job => ({ jobId: String(job.id), sourceType: 'crm.job', customerId: String(job.customer_id ?? ''), completedAt: String(job.updated_at) })),
      ...appointments.map(job => ({ jobId: String(job.id), sourceType: 'scheduling.appointment', customerId: String(job.customer_id ?? ''), completedAt: String(job.ends_at) })),
    ];
    return completed.filter(job => byId.has(job.customerId)).map(job => {
      const customer = byId.get(job.customerId)!;
      return { ...job, customerName: String(customer.name), contactReady: typeof customer.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email) };
    });
  }
  async function submit(context: ReviewProviderSendContext, operation: string, reminder: boolean) {
    const origin = publicOrigin();
    if (!origin || new URL(origin).protocol !== 'https:') throw ApiError.conflict('Configure the public HTTPS company address before sending review links.');
    const customer = await getEntity(db as unknown as Kysely<CrmDatabase>, context.tenantId, ENTITY_DEFS.customer, context.customerId);
    if (!customer) throw ApiError.notFound('Customer not found.');
    if (!customer.email) throw ApiError.conflict('Add an email address for this customer.');
    const completed = await listCompletedJobs(context.tenantId);
    if (!completed.some(job => job.customerId === context.customerId && job.contactReady &&
      (!context.sourceJobId || job.jobId === context.sourceJobId && job.sourceType === context.sourceJobType))) {
      throw ApiError.conflict('A completed customer job with usable contact details is required before requesting a review.');
    }
    const optOut = await data.selectFrom('reviews_opt_outs').select('id').where('tenant_id', '=', context.tenantId)
      .where('customer_id', '=', context.customerId).executeTakeFirst();
    if (optOut) throw ApiError.conflict('This customer opted out of review requests.');
    const token = context.link.split('/').at(-1)!;
    const link = new URL(`/review#${encodeURIComponent(token)}`, origin).href;
    const message = await contract.sendMessage({
      tenantId: context.tenantId, channel: 'email', to: String(customer.email), subject: reminder ? 'A reminder to share your feedback' : 'Please share your feedback',
      body: `Please share your honest feedback about your recent experience: ${link}`,
      idempotencyKey: `review:${operation}`, relatedEntityType: 'crm.customer', relatedEntityId: context.customerId,
    });
    const saved = await messages.getMessage(context.tenantId, message.id);
    if (saved.status !== 'sent' || !saved.provider_message_id) throw ApiError.conflict('Review submission needs attention in the company inbox.');
    return { delivered: saved.delivery_status === 'delivered', submitted: true, messageId: saved.id };
  }
  return { key: 'business_email', sendReviewRequest: context => submit(context, `request:${context.requestId}`, false),
    sendReminder: context => submit(context, `reminder:${context.reminderId}`, true),
    listCompletedJobs,
    getDeliveryStatus: async context => {
      const operation = context.reminderId ? `reminder:${context.reminderId}` : `request:${context.requestId}`;
      const saved = await data.selectFrom('messaging_messages').select(['id', 'status', 'provider_message_id', 'delivery_status'])
        .where('tenant_id', '=', context.tenantId).where('idempotency_key', '=', `review:${operation}`).executeTakeFirst();
      if (!saved) return { status: 'blocked' };
      if (saved.status === 'sent' && saved.provider_message_id && !['bounced', 'rejected', 'failed', 'suppressed'].includes(String(saved.delivery_status))) {
        return { status: saved.delivery_status === 'delivered' ? 'delivered' : 'submitted', messageId: String(saved.id) };
      }
      return { status: 'needs_attention', messageId: String(saved.id) };
    },
    syncExternalReviews: async () => { throw new ApiError(501, 'External review import is not connected.'); } };
}
