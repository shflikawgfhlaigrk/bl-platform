/**
 * @blacklabel/customers — row types. Extends CoreDatabase per /CONVENTIONS.md.
 *
 * This module owns the customer *profile* layer that sits on top of crm
 * customer rows-of-record. It references crm customers ONLY by id string
 * (`crm_customer_id`) — it never imports, joins, or FKs into crm tables.
 *
 * Conventions:
 * - ids: TEXT nanoid via id()
 * - timestamps: TEXT ISO-8601 UTC via nowIso()
 * - booleans: INTEGER 0/1 (converted at the service boundary)
 * - JSON (evidence, rules, value, inputs): TEXT, serialized in code
 * - NO PII in event payloads or logs — ids only.
 */
import type { CoreDatabase } from '@blacklabel/core';

export type CustomerSource =
  | 'square_import'
  | 'storefront'
  | 'register_qr'
  | 'staff'
  | 'receipt_link';

export const CUSTOMER_SOURCES: readonly CustomerSource[] = [
  'square_import',
  'storefront',
  'register_qr',
  'staff',
  'receipt_link',
];

export type ConsentChannel = 'email' | 'sms';
export const CONSENT_CHANNELS: readonly ConsentChannel[] = ['email', 'sms'];

export type ConsentState = 'granted' | 'withdrawn' | 'pending_double_opt_in';
export const CONSENT_STATES: readonly ConsentState[] = [
  'granted',
  'withdrawn',
  'pending_double_opt_in',
];

export type SuppressionScope = 'email' | 'phone';
export const SUPPRESSION_SCOPES: readonly SuppressionScope[] = ['email', 'phone'];

export type SuppressionReason = 'unsubscribed' | 'bounced' | 'manual' | 'complaint';
export const SUPPRESSION_REASONS: readonly SuppressionReason[] = [
  'unsubscribed',
  'bounced',
  'manual',
  'complaint',
];

export type MergeStatus = 'proposed' | 'applied' | 'undone';

export type RestockStatus = 'open' | 'notified' | 'closed';
export const RESTOCK_STATUSES: readonly RestockStatus[] = ['open', 'notified', 'closed'];

export type ServiceCaseKind = 'question' | 'return' | 'complaint' | 'fit_help';
export const SERVICE_CASE_KINDS: readonly ServiceCaseKind[] = [
  'question',
  'return',
  'complaint',
  'fit_help',
];

export type ServiceCaseStatus = 'open' | 'waiting' | 'resolved';
export const SERVICE_CASE_STATUSES: readonly ServiceCaseStatus[] = ['open', 'waiting', 'resolved'];

export interface CustomersProfileRow {
  id: string;
  tenant_id: string;
  /** crm_customers id (string ref only). NULL = prospect not yet in crm. Unique per tenant. */
  crm_customer_id: string | null;
  email_normalized: string | null;
  phone_normalized: string | null;
  first_name: string | null;
  last_name: string | null;
  source: CustomerSource;
  /** When merged into another profile, the winner profile id; else NULL. */
  merged_into: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomersMergeRow {
  id: string;
  tenant_id: string;
  winner_profile_id: string;
  loser_profile_id: string;
  /** JSON: { matched: {field, value}, applied?: {...prior state for exact undo} }. */
  evidence: string;
  status: MergeStatus;
  applied_at: string | null;
  undone_at: string | null;
  created_at: string;
  updated_at: string;
}

/** APPEND-ONLY consent history. Current state = latest row per (profile, channel). */
export interface CustomersConsentRow {
  id: string;
  tenant_id: string;
  profile_id: string;
  channel: ConsentChannel;
  state: ConsentState;
  text_shown: string | null;
  source: CustomerSource | null;
  ip: string | null;
  user_agent: string | null;
  occurred_at: string;
  /** JSON evidence blob or null. */
  evidence: string | null;
  created_at: string;
}

/** Double-opt-in confirmation tokens. */
export interface CustomersConsentTokenRow {
  id: string;
  tenant_id: string;
  profile_id: string;
  channel: ConsentChannel;
  token: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

export interface CustomersPreferenceRow {
  id: string;
  tenant_id: string;
  profile_id: string;
  key: string;
  /** JSON-serialized value. */
  value: string;
  created_at: string;
  updated_at: string;
}

export interface CustomersSuppressionRow {
  id: string;
  tenant_id: string;
  scope: SuppressionScope;
  value_normalized: string;
  reason: SuppressionReason;
  created_at: string;
}

export interface CustomersSegmentRow {
  id: string;
  tenant_id: string;
  name: string;
  /** JSON: { all: [{ field, op, value }] }. */
  rules: string;
  /** 1 = a built-in seeded definition. */
  builtin: number;
  created_at: string;
  updated_at: string;
}

export interface CustomersSegmentMemberRow {
  id: string;
  tenant_id: string;
  segment_id: string;
  profile_id: string;
  computed_at: string;
  inputs_hash: string;
  created_at: string;
}

export interface CustomersRestockRequestRow {
  id: string;
  tenant_id: string;
  profile_id: string | null;
  variation_id: string;
  source: CustomerSource;
  status: RestockStatus;
  created_at: string;
  updated_at: string;
}

export interface CustomersServiceCaseRow {
  id: string;
  tenant_id: string;
  profile_id: string;
  kind: ServiceCaseKind;
  body: string;
  status: ServiceCaseStatus;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomersServiceCaseNoteRow {
  id: string;
  tenant_id: string;
  case_id: string;
  body: string;
  author: string;
  created_at: string;
}

export interface CustomersDatabase extends CoreDatabase {
  customers_profiles: CustomersProfileRow;
  customers_merges: CustomersMergeRow;
  customers_consents: CustomersConsentRow;
  customers_consent_tokens: CustomersConsentTokenRow;
  customers_preferences: CustomersPreferenceRow;
  customers_suppressions: CustomersSuppressionRow;
  customers_segments: CustomersSegmentRow;
  customers_segment_members: CustomersSegmentMemberRow;
  customers_restock_requests: CustomersRestockRequestRow;
  customers_service_cases: CustomersServiceCaseRow;
  customers_service_case_notes: CustomersServiceCaseNoteRow;
}

/** Child tables whose rows carry a profile_id and are re-pointed on merge apply(). */
export const MERGE_CHILD_TABLES = [
  'customers_consents',
  'customers_consent_tokens',
  'customers_preferences',
  'customers_restock_requests',
  'customers_service_cases',
] as const;
export type MergeChildTable = (typeof MERGE_CHILD_TABLES)[number];
