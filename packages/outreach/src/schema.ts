import type { CoreDatabase } from '@blacklabel/core';

/**
 * Outreach module schema (prefix `outreach_`). Owns the whole cold-email lane:
 * per-tenant settings + gates, fixed templates, campaigns, the APPEND-ONLY
 * send-of-record, warmup capacity ledger, the inbound inbox, and the reader
 * cursor. Booleans are integer 0/1; timestamps ISO-8601 UTC; JSON columns are
 * serialized text. References to other modules (crm profiles) are id strings.
 */

export type TemplateKind = 'transactional' | 'promotional';

export type CampaignStatus =
  | 'draft'
  | 'approved'
  | 'sending'
  | 'paused'
  | 'paused_bounce'
  | 'done'
  | 'canceled';

export type SendStatus = 'queued' | 'blocked' | 'sent' | 'bounced' | 'failed';

export type BlockedReason =
  | 'not_armed'
  | 'no_postal'
  | 'no_provider'
  | 'no_consent'
  | 'suppressed'
  | 'cap_reached'
  | 'quiet_hours'
  | 'duplicate';

export type InboxClassification = 'reply' | 'bounce' | 'auto_reply' | 'unknown';

/** One row per tenant. armed DEFAULTS to 0 — the module ships fully COLD. */
export interface OutreachSettingsRow {
  id: string;
  tenant_id: string;
  /** 0/1 — the founder arm gate. Default 0. */
  armed: number;
  /** CAN-SPAM physical postal address. Null blocks every send. */
  postal_address: string | null;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  /** Admin credential-id string; null = no connected provider. */
  provider_credential_ref: string | null;
  /** JSON {startHour,endHour,timezone}. */
  quiet_hours: string;
  /** Optional lower daily cap; null = warmup ramp governs. */
  daily_cap_override: number | null;
  /** Per-tenant HMAC secret for unsubscribe tokens (generated at create). */
  unsubscribe_secret: string;
  created_at: string;
  updated_at: string;
}

export interface OutreachTemplateRow {
  id: string;
  tenant_id: string;
  name: string;
  kind: TemplateKind;
  subject_template: string;
  body_template: string;
  /** JSON string[] of placeholder keys required at send. */
  required_placeholders: string;
  /** 0/1 — promotional must carry the unsubscribe footer. */
  unsubscribe_footer_required: number;
  created_at: string;
  updated_at: string;
}

export interface OutreachCampaignRow {
  id: string;
  tenant_id: string;
  name: string;
  template_id: string;
  /** JSON [{email, vars, profileId?, consent?}] snapshotted at creation. */
  audience: string;
  status: CampaignStatus;
  approved_by: string | null;
  scheduled_at: string | null;
  queued_count: number;
  sent_count: number;
  bounced_count: number;
  replied_count: number;
  suppressed_skipped_count: number;
  created_at: string;
  updated_at: string;
}

/** THE send-of-record. Append-only; status transitions in place. */
export interface OutreachSendRow {
  id: string;
  tenant_id: string;
  recipient_email_normalized: string;
  subject: string;
  campaign_id: string | null;
  template_id: string;
  status: SendStatus;
  blocked_reason: BlockedReason | null;
  provider_message_id: string | null;
  /** Rendered bodies (kept so the drain sends deterministically). */
  body_text: string;
  body_html: string | null;
  /** Snapshotted consent/relationship flag (0/1) from the audience row. */
  recipient_consent: number;
  sent_at: string | null;
  created_at: string;
}

/** Warmup capacity ledger — one row per tenant per business day. */
export interface OutreachCapacityRow {
  id: string;
  tenant_id: string;
  /** Business date YYYY-MM-DD in the tenant's quiet-hours timezone. */
  date: string;
  sent_count: number;
  cap: number;
  created_at: string;
  updated_at: string;
}

/** Ingested inbound message; provider_ref is the per-tenant idempotency key. */
export interface OutreachInboxRow {
  id: string;
  tenant_id: string;
  provider_ref: string;
  from_email: string;
  subject: string;
  body_text: string;
  classification: InboxClassification;
  matched_send_id: string | null;
  received_at: string;
  created_at: string;
}

/** Persisted IMAP-style cursor, one per tenant. */
export interface OutreachReaderStateRow {
  id: string;
  tenant_id: string;
  cursor: string | null;
  updated_at: string;
}

export interface OutreachDatabase extends CoreDatabase {
  outreach_settings: OutreachSettingsRow;
  outreach_templates: OutreachTemplateRow;
  outreach_campaigns: OutreachCampaignRow;
  outreach_sends: OutreachSendRow;
  outreach_capacity: OutreachCapacityRow;
  outreach_inbox: OutreachInboxRow;
  outreach_reader_state: OutreachReaderStateRow;
}
