import type { Kysely } from 'kysely';
import { EventBus } from '@blacklabel/core';
import type { WorkflowsDatabase } from './schema';
import { createWorkflow, type WorkflowDto } from './service';

/**
 * Demo data: three industry-neutral automations that show off triggers,
 * conditions, templating, and each action family. Pass the real bus if you
 * want the seed's workflow.created events to be observable.
 */
export async function seedWorkflows(
  db: Kysely<WorkflowsDatabase>,
  tenantId: string,
  events: EventBus = new EventBus(),
): Promise<WorkflowDto[]> {
  const created: WorkflowDto[] = [];

  created.push(
    await createWorkflow(db, events, tenantId, {
      name: 'New lead follow-up',
      triggerEvent: 'crm.lead.created',
      actions: [
        {
          type: 'create_task',
          config: { title: 'Call new lead {{payload.leadId}}', dueInHours: 4 },
        },
        {
          type: 'add_tag',
          config: { entityType: 'crm.lead', entityId: '{{payload.leadId}}', tag: 'needs-first-touch' },
        },
      ],
    }),
  );

  created.push(
    await createWorkflow(db, events, tenantId, {
      name: 'Appointment reminder',
      triggerEvent: 'scheduling.appointment.scheduled',
      actions: [
        {
          type: 'send_email',
          config: {
            to: '{{payload.customerId}}',
            subject: 'Your appointment is booked',
            body: 'See you at {{payload.startsAt}}. Reply to reschedule.',
          },
        },
      ],
    }),
  );

  created.push(
    await createWorkflow(db, events, tenantId, {
      name: 'Big invoice paid — thank the customer',
      triggerEvent: 'billing.invoice.paid',
      condition: { field: 'totalCents', op: 'gte', value: 50_000 },
      actions: [
        {
          type: 'send_sms',
          config: { to: '{{payload.customerId}}', body: 'Thanks for your payment!' },
        },
      ],
    }),
  );

  return created;
}
