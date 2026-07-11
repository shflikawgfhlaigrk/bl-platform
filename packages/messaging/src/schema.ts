import type { CoreDatabase } from '@blacklabel/core';

/**
 * Row types for the messaging module (unified inbox). Conventions:
 * - ids: TEXT nanoid via core id()
 * - timestamps: TEXT ISO-8601 UTC via core nowIso()
 * - booleans: INTEGER 0/1 in the DB, converted at the service boundary
 */

/**
 * Channel kinds the inbox unifies. Industry-neutral, fixed set.
 * 'call' is the Front Desk phone channel — an inbound call is stored as a
 * message on its conversation with recording_url/transcript/duration_seconds.
 */
export const CHANNEL_TYPES = ['email', 'sms', 'website', 'social', 'internal', 'call'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const CONVERSATION_STATUSES = ['open', 'pending', 'closed'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const MESSAGE_DIRECTIONS = ['in', 'out'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

/**
 * Message delivery status:
 * - 'received' — inbound message recorded
 * - 'sent'     — outbound, provider accepted (or no provider needed, e.g. internal)
 * - 'failed'   — outbound, provider rejected or threw
 */
export const MESSAGE_STATUSES = ['received', 'sent', 'failed'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/**
 * Who a participant is:
 * - 'customer' / 'contact' — CRM entities referenced by id string only (ref_id)
 * - 'user'                 — a team member (core users id in ref_id)
 * - 'external'             — an outside address with no known entity
 */
export const PARTICIPANT_KINDS = ['customer', 'contact', 'user', 'external'] as const;
export type ParticipantKind = (typeof PARTICIPANT_KINDS)[number];

/** A configured channel endpoint for a tenant (e.g. the from-address for email). */
export interface MessagingChannelRow {
  id: string;
  tenant_id: string;
  type: ChannelType;
  name: string;
  /** Channel address this tenant sends from: email address, phone number, handle, ... */
  address: string;
  /** boolean 0/1 */
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface MessagingConversationRow {
  id: string;
  tenant_id: string;
  subject: string;
  channel: ChannelType;
  status: ConversationStatus;
  /** CRM customer id (string reference only — no FK, no join). */
  customer_id: string | null;
  /** CRM contact id (string reference only). */
  contact_id: string | null;
  /** Core users id of the current assignee. */
  assigned_user_id: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessagingMessageRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  direction: MessageDirection;
  channel: ChannelType;
  from_address: string | null;
  to_address: string | null;
  subject: string | null;
  body: string;
  status: MessageStatus;
  /** Id returned by the channel provider (stub providers return "stub-..."). */
  provider_message_id: string | null;
  failed_reason: string | null;
  /** 'call' channel: URL of the stored call recording (null for other channels). */
  recording_url: string | null;
  /** 'call' channel: full call transcript text (null otherwise). */
  transcript: string | null;
  /** 'call' channel: call length in whole seconds (null otherwise). */
  duration_seconds: number | null;
  created_at: string;
}

export interface MessagingTemplateRow {
  id: string;
  tenant_id: string;
  /** Unique per tenant. */
  name: string;
  /** Restrict to a channel, or null = usable on any channel. */
  channel: ChannelType | null;
  subject: string | null;
  /** Body with {{variable}} placeholders. */
  body: string;
  created_at: string;
  updated_at: string;
}

export interface MessagingParticipantRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  kind: ParticipantKind;
  /** Entity id for customer/contact/user kinds (id string only). */
  ref_id: string | null;
  /** Channel address (email, phone, handle) used for inbound threading. */
  address: string | null;
  display_name: string | null;
  created_at: string;
}

/** Assignment history: one row per (re)assignment of a conversation. */
export interface MessagingAssignmentRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  /** Core users id of the assignee. */
  user_id: string;
  /** Actor who performed the assignment (user id or "system"). */
  assigned_by: string;
  note: string | null;
  created_at: string;
}

export interface MessagingDatabase extends CoreDatabase {
  messaging_channels: MessagingChannelRow;
  messaging_conversations: MessagingConversationRow;
  messaging_messages: MessagingMessageRow;
  messaging_templates: MessagingTemplateRow;
  messaging_participants: MessagingParticipantRow;
  messaging_assignments: MessagingAssignmentRow;
}
