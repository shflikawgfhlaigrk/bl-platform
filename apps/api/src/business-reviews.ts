import { ApiError, type EventBus } from '@blacklabel/core';
import type { Kysely } from '@blacklabel/db';
import { ENTITY_DEFS, getEntity, type CrmDatabase } from '@blacklabel/crm';
import { createMessagingSendContract, MessagingService, type MessagingDatabase, type MessagingServiceOptions } from '@blacklabel/messaging';
import type { ReviewProvider, ReviewProviderSendContext } from '@blacklabel/reviews';

/** One stable messaging operation per review request/reminder, with saved readback. */
export function businessReviewProvider<DB extends CrmDatabase & MessagingDatabase>(db: Kysely<DB>, events: EventBus,
  messaging: MessagingServiceOptions, publicOrigin: () => string | undefined): ReviewProvider {
  const messages = new MessagingService(db as unknown as Kysely<MessagingDatabase>, events, messaging);
  const contract = createMessagingSendContract(db as unknown as Kysely<MessagingDatabase>, events, messaging);
  async function submit(context: ReviewProviderSendContext, operation: string, reminder: boolean) {
    const origin = publicOrigin();
    if (!origin || new URL(origin).protocol !== 'https:') throw ApiError.conflict('Configure the public HTTPS company address before sending review links.');
    const customer = await getEntity(db as unknown as Kysely<CrmDatabase>, context.tenantId, ENTITY_DEFS.customer, context.customerId);
    if (!customer) throw ApiError.notFound('Customer not found.');
    if (!customer.email) throw ApiError.conflict('Add an email address for this customer.');
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
    syncExternalReviews: async () => { throw new ApiError(501, 'External review import is not connected.'); } };
}
