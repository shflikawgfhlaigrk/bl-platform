import type { Kysely } from 'kysely';
import type { EventBus } from '@blacklabel/core';
import { createMessagingSendContract, MessagingService, type MessagingDatabase, type MessagingServiceOptions } from '@blacklabel/messaging';
import type { ReminderDeliveryProvider } from '@blacklabel/scheduling';

/** The reminder id binds a single submission; every later attempt is readback. */
export function businessReminderDelivery(db: Kysely<MessagingDatabase>, events: EventBus, options: MessagingServiceOptions = {}): ReminderDeliveryProvider {
  const service = new MessagingService(db, events, options);
  const contract = createMessagingSendContract(db, events, options);
  return {
    name: 'company-messaging', durableOperations: true,
    async deliver(input) {
      if (!['email', 'sms'].includes(input.channel)) return { delivered: false, state: 'failed', detail: 'Use email or SMS for customer reminders.' };
      if (!input.message?.trim()) return { delivered: false, state: 'failed', detail: 'A reminder needs the final customer message.' };
      const operation = `reminder:${input.reminderId}`;
      let message = await service.getOperationMessage(input.tenantId, operation);
      if (!message) {
        if (!options.providers?.[input.channel as 'email' | 'sms']) return { delivered: false, detail: 'Connect the reminder channel before delivery.' };
        try {
          await contract.sendMessage({ tenantId: input.tenantId, channel: input.channel as 'email' | 'sms', to: input.recipient,
            body: input.message, subject: 'Appointment reminder', idempotencyKey: operation });
        } catch { /* An unresolved message must be found and reconciled, never replaced. */ }
        message = await service.getOperationMessage(input.tenantId, operation);
      }
      if (!message) return { delivered: false, state: 'review', detail: 'The reminder operation needs review in the company inbox.' };
      if (message.body !== input.message || message.to_address !== input.recipient || message.channel !== input.channel) {
        return { delivered: false, state: 'review', deliveryReference: message.id, detail: 'Reminder content differs from its recorded submission.' };
      }
      if (input.deliveryReference && input.deliveryReference !== message.id) return { delivered: false, state: 'review', detail: 'The recorded reminder reference changed.' };
      if (message.delivery_status === 'delivered') return { delivered: true, deliveryReference: message.id };
      if (message.status === 'failed') return { delivered: false, state: 'failed', deliveryReference: message.id, detail: message.failed_reason ?? 'Provider rejected the reminder.' };
      if (!message.provider_message_id) return { delivered: false, state: 'review', deliveryReference: message.id, detail: 'Submission outcome is unresolved. Locate the existing provider message in the inbox.' };
      try { message = await service.reconcileMessage(input.tenantId, 'system', message.id); }
      catch { return { delivered: false, state: 'submitted', deliveryReference: message.id, detail: 'Provider readback is pending.' }; }
      return { delivered: message.delivery_status === 'delivered', deliveryReference: message.id,
        ...(message.delivery_status === 'delivered' ? {} : { state: message.status === 'failed' ? 'failed' as const : 'submitted' as const }), detail: message.failed_reason ?? undefined };
    },
  };
}
