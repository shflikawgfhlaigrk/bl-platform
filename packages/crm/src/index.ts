/**
 * @blacklabel/crm — universal customer/lead/contact layer for any industry.
 *
 * Events emitted (module.entity.verb; see /CONVENTIONS.md §8):
 *   crm.lead.created         { leadId }                       (catalog event)
 *   crm.lead.stage_changed   { leadId, from, to }
 *   crm.customer.created     { customerId }
 *   crm.deal.created         { dealId }
 *   crm.deal.stage_changed   { dealId, from, to, valueCents }
 *   crm.job.created          { jobId }
 *   crm.task.completed       { taskId }
 *   crm.lead.next_action_completed { leadId, receiptId }
 */
export const MODULE_KEY = 'crm' as const;

// Migrations
export { crmMigrations } from './migrations';

// Router factory
export { crmRouter } from './router';

// Seed (demo data)
export { seedCrm, seed, type CrmSeedSummary } from './seed';

// Public types
export type {
  CrmDatabase,
  CrmCompanyRow,
  CrmCustomerRow,
  CrmContactRow,
  CrmLeadRow,
  CrmLeadStageRow,
  CrmNextActionCompletionRow,
  CrmDealRow,
  CrmJobRow,
  CrmNoteRow,
  CrmTaskRow,
  CrmTagRow,
  CrmTaggableRow,
  CrmTimelineEventRow,
  CrmAttachmentRow,
  CrmSourceAttributionRow,
  CrmCustomerStatus,
  CrmDealStatus,
  CrmJobStatus,
  CrmTaskStatus,
  CrmEntityType,
} from './schema';
export { CRM_ENTITY_TYPES } from './schema';

// Public constants/helpers other layers may need (id-string world only)
export { DEFAULT_LEAD_STAGES, DEAL_STATUSES, listLeadStages, setLeadStages } from './service';
export { ENTITY_DEFS, getEntity, listEntities, updateLead, addTimelineEvent, createJob } from './service';
export { createCustomer, updateCustomer, updateContact } from './service';
export type { CustomerInput, LeadInput, SalesQueueBucket } from './service';
