/**
 * Row types for the portal-customer module tables.
 *
 * Conventions (see /CONVENTIONS.md):
 * - ids: TEXT, nanoid, generated in code via id()
 * - timestamps: TEXT, ISO-8601 UTC via nowIso()
 * - booleans: INTEGER 0/1
 * - cross-module references (customer_id, file_id, relayed_message_id, ...)
 *   are id STRINGS only — never joined, never foreign-keyed.
 */
import type { CoreDatabase } from '@blacklabel/core';

export type PortalUploadKind = 'photo' | 'document';

/**
 * A customer's portal login account. `customer_id` is an id-string reference
 * to the owning module's customer entity (e.g. crm). The account also holds
 * the contact info the customer can self-manage in the portal.
 */
export interface PortalCustomerAccountRow {
  id: string;
  tenant_id: string;
  /** Id-string reference to the platform customer entity (e.g. crm). */
  customer_id: string;
  /** Login email, stored lowercased. Unique per tenant. */
  email: string;
  name: string;
  phone: string | null;
  created_at: string;
  updated_at: string;
}

/** Single-use magic-link login token. */
export interface PortalCustomerLoginTokenRow {
  id: string;
  tenant_id: string;
  account_id: string;
  token: string;
  /** ISO-8601 UTC expiry. */
  expires_at: string;
  /** Set exactly once when the token is exchanged; non-null = spent. */
  used_at: string | null;
  created_at: string;
}

/** Bearer session issued by exchanging a login token. */
export interface PortalCustomerSessionRow {
  id: string;
  tenant_id: string;
  account_id: string;
  token: string;
  /** ISO-8601 UTC expiry. */
  expires_at: string;
  /** 0/1 boolean. */
  revoked: number;
  created_at: string;
}

/** A message the customer sent to the business from the portal. */
export interface PortalCustomerMessageRow {
  id: string;
  tenant_id: string;
  account_id: string;
  customer_id: string;
  subject: string | null;
  body: string;
  /** Id of the message created via the messaging contract, if it was wired. */
  relayed_message_id: string | null;
  created_at: string;
}

/** Metadata for a file/photo the customer uploaded through the portal. */
export interface PortalCustomerUploadRow {
  id: string;
  tenant_id: string;
  account_id: string;
  customer_id: string;
  /** Id of the file registered with the files module, if the provider was wired. */
  file_id: string | null;
  file_name: string;
  content_type: string;
  size_bytes: number;
  kind: PortalUploadKind;
  /** Optional id-string link to another entity, e.g. "scheduling.appointment". */
  related_entity_type: string | null;
  related_entity_id: string | null;
  created_at: string;
}

export type PortalServiceRequestKind = 'repeat' | 'reschedule';
export type PortalServiceRequestStatus = 'pending' | 'acknowledged' | 'declined' | 'resolved';

/** An owner-reviewed request; creating it never changes a job or booking. */
export interface PortalCustomerServiceRequestRow {
  id: string;
  tenant_id: string;
  account_id: string;
  customer_id: string;
  kind: PortalServiceRequestKind;
  reference_id: string;
  source_title: string;
  requested_starts_at: string | null;
  requested_ends_at: string | null;
  requested_timezone: string;
  note: string | null;
  status: PortalServiceRequestStatus;
  response: string | null;
  version: number;
  idempotency_key: string;
  payload_hash: string;
  created_at: string;
  updated_at: string;
}

export interface PortalCustomerDatabase extends CoreDatabase {
  portal_customer_accounts: PortalCustomerAccountRow;
  portal_customer_login_tokens: PortalCustomerLoginTokenRow;
  portal_customer_sessions: PortalCustomerSessionRow;
  portal_customer_messages: PortalCustomerMessageRow;
  portal_customer_uploads: PortalCustomerUploadRow;
  portal_customer_service_requests: PortalCustomerServiceRequestRow;
}
