/**
 * @blacklabel/crm — row types. Extends CoreDatabase per /CONVENTIONS.md.
 *
 * - ids: TEXT nanoid via id()
 * - timestamps: TEXT ISO-8601 UTC via nowIso()
 * - money: INTEGER cents (value_cents)
 * - JSON (custom_fields, timeline data): TEXT, serialized in code
 */
import type { CoreDatabase } from '@blacklabel/core';

export type CrmCustomerStatus = 'active' | 'inactive' | 'archived';
export type CrmDealStatus = 'open' | 'won' | 'lost';
export type CrmJobStatus = 'planned' | 'in_progress' | 'completed' | 'canceled';
export type CrmTaskStatus = 'open' | 'completed';

/** Entity types that notes/tags/attachments/attributions/timeline can point at. */
export const CRM_ENTITY_TYPES = [
  'crm.customer',
  'crm.company',
  'crm.contact',
  'crm.lead',
  'crm.deal',
  'crm.job',
] as const;
export type CrmEntityType = (typeof CRM_ENTITY_TYPES)[number];

export interface CrmCompanyRow {
  id: string;
  tenant_id: string;
  name: string;
  domain: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  owner_user_id: string | null;
  /** JSON object keyed by core custom-field definition keys. */
  custom_fields: string | null;
  created_at: string;
  updated_at: string;
}

export interface CrmCustomerRow {
  id: string;
  tenant_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  status: CrmCustomerStatus;
  /** crm_companies id (same module). */
  company_id: string | null;
  owner_user_id: string | null;
  custom_fields: string | null;
  created_at: string;
  updated_at: string;
}

export interface CrmContactRow {
  id: string;
  tenant_id: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  customer_id: string | null;
  company_id: string | null;
  owner_user_id: string | null;
  custom_fields: string | null;
  created_at: string;
  updated_at: string;
}

export interface CrmLeadRow {
  id: string;
  tenant_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  /** Free-text acquisition source ("referral", "website", ...). */
  source: string | null;
  /** Key from the tenant's configured lead stage list. */
  stage: string;
  /** Estimated value in integer cents. */
  value_cents: number | null;
  customer_id: string | null;
  contact_id: string | null;
  company_id: string | null;
  owner_user_id: string | null;
  custom_fields: string | null;
  created_at: string;
  updated_at: string;
}

/** Per-tenant configurable lead stage list. Empty = defaults apply. */
export interface CrmLeadStageRow {
  id: string;
  tenant_id: string;
  key: string;
  label: string;
  sort_order: number;
  created_at: string;
}

export interface CrmDealRow {
  id: string;
  tenant_id: string;
  title: string;
  status: CrmDealStatus;
  value_cents: number;
  customer_id: string | null;
  lead_id: string | null;
  company_id: string | null;
  owner_user_id: string | null;
  /** ISO-8601 UTC. */
  expected_close_at: string | null;
  custom_fields: string | null;
  created_at: string;
  updated_at: string;
}

export interface CrmJobRow {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  status: CrmJobStatus;
  customer_id: string | null;
  deal_id: string | null;
  owner_user_id: string | null;
  starts_at: string | null;
  ends_at: string | null;
  custom_fields: string | null;
  created_at: string;
  updated_at: string;
}

/** Polymorphic note attached to any CRM entity. */
export interface CrmNoteRow {
  id: string;
  tenant_id: string;
  entity_type: string;
  entity_id: string;
  body: string;
  author_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CrmTaskRow {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  status: CrmTaskStatus;
  due_at: string | null;
  assignee_user_id: string | null;
  /** Optional link to a CRM entity. */
  entity_type: string | null;
  entity_id: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CrmTagRow {
  id: string;
  tenant_id: string;
  name: string;
  color: string | null;
  created_at: string;
}

/** Join table: tag <-> any CRM entity. */
export interface CrmTaggableRow {
  id: string;
  tenant_id: string;
  tag_id: string;
  entity_type: string;
  entity_id: string;
  created_at: string;
}

export interface CrmTimelineEventRow {
  id: string;
  tenant_id: string;
  entity_type: string;
  entity_id: string;
  /** e.g. "created", "updated", "stage_changed", "note_added", "lead.stage_changed" (mirrored). */
  event_type: string;
  actor: string;
  /** JSON payload or null. */
  data: string | null;
  created_at: string;
}

/** Reference to a file owned by the files module — id string only, no FK. */
export interface CrmAttachmentRow {
  id: string;
  tenant_id: string;
  entity_type: string;
  entity_id: string;
  /** files-module file id (cross-module id-string reference). */
  file_id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  created_at: string;
}

export interface CrmSourceAttributionRow {
  id: string;
  tenant_id: string;
  entity_type: string;
  entity_id: string;
  source: string;
  medium: string | null;
  campaign: string | null;
  detail: string | null;
  created_at: string;
}

export interface CrmDatabase extends CoreDatabase {
  crm_companies: CrmCompanyRow;
  crm_customers: CrmCustomerRow;
  crm_contacts: CrmContactRow;
  crm_leads: CrmLeadRow;
  crm_lead_stages: CrmLeadStageRow;
  crm_deals: CrmDealRow;
  crm_jobs: CrmJobRow;
  crm_notes: CrmNoteRow;
  crm_tasks: CrmTaskRow;
  crm_tags: CrmTagRow;
  crm_taggables: CrmTaggableRow;
  crm_timeline_events: CrmTimelineEventRow;
  crm_attachments: CrmAttachmentRow;
  crm_source_attributions: CrmSourceAttributionRow;
}
