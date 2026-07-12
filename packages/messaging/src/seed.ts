import type { Kysely } from 'kysely';
import { id, nowIso } from '@blacklabel/core';
import type {
  MessagingChannelRow,
  MessagingConversationRow,
  MessagingDatabase,
  MessagingMessageRow,
  MessagingParticipantRow,
  MessagingTemplateRow,
} from './schema';

export interface MessagingSeedResult {
  channelIds: string[];
  conversationIds: string[];
  messageIds: string[];
  templateIds: string[];
}

/**
 * Demo data for the unified inbox: two channels, two templates, and two
 * conversations with an in/out message thread. Direct inserts only — no
 * events, no audit entries (this is demo scaffolding, not business activity).
 * Industry-neutral content.
 */
export async function seedMessaging(
  db: Kysely<MessagingDatabase>,
  tenantId: string,
): Promise<MessagingSeedResult> {
  const now = nowIso();

  const channels: MessagingChannelRow[] = [
    {
      id: id(),
      tenant_id: tenantId,
      type: 'email',
      name: 'Support email',
      address: 'support@example.test',
      is_active: 1,
      created_at: now,
      updated_at: now,
    },
    {
      id: id(),
      tenant_id: tenantId,
      type: 'sms',
      name: 'Main SMS line',
      address: '+15550000001',
      is_active: 1,
      created_at: now,
      updated_at: now,
    },
  ];
  await db.insertInto('messaging_channels').values(channels).execute();

  const templates: MessagingTemplateRow[] = [
    {
      id: id(),
      tenant_id: tenantId,
      name: 'welcome',
      channel: null,
      subject: 'Welcome, {{name}}!',
      body: 'Hi {{name}}, thanks for reaching out — we will get back to you within {{sla_hours}} hours.',
      created_at: now,
      updated_at: now,
    },
    {
      id: id(),
      tenant_id: tenantId,
      name: 'follow_up',
      channel: 'email',
      subject: 'Following up on your request',
      body: 'Hi {{name}}, just checking in on your recent request. Reply to this message any time.',
      created_at: now,
      updated_at: now,
    },
  ];
  await db.insertInto('messaging_templates').values(templates).execute();

  const conv1: MessagingConversationRow = {
    id: id(),
    tenant_id: tenantId,
    subject: 'Question about your services',
    channel: 'email',
    status: 'open',
    customer_id: null,
    contact_id: null,
    assigned_user_id: null,
    last_message_at: now,
    created_at: now,
    updated_at: now,
  };
  const conv2: MessagingConversationRow = {
    id: id(),
    tenant_id: tenantId,
    subject: 'Rescheduling request',
    channel: 'sms',
    status: 'pending',
    customer_id: null,
    contact_id: null,
    assigned_user_id: null,
    last_message_at: now,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('messaging_conversations').values([conv1, conv2]).execute();

  const participants: MessagingParticipantRow[] = [
    {
      id: id(),
      tenant_id: tenantId,
      conversation_id: conv1.id,
      kind: 'external',
      ref_id: null,
      address: 'pat@example.test',
      display_name: 'Pat Example',
      created_at: now,
    },
    {
      id: id(),
      tenant_id: tenantId,
      conversation_id: conv2.id,
      kind: 'external',
      ref_id: null,
      address: '+15550000123',
      display_name: null,
      created_at: now,
    },
  ];
  await db.insertInto('messaging_participants').values(participants).execute();

  const messages: MessagingMessageRow[] = [
    {
      id: id(),
      tenant_id: tenantId,
      conversation_id: conv1.id,
      direction: 'in',
      channel: 'email',
      from_address: 'pat@example.test',
      to_address: 'support@example.test',
      subject: 'Question about your services',
      body: 'Hello! Could you tell me more about what you offer?',
      status: 'received',
      provider_message_id: null,
      failed_reason: null,
      recording_url: null,
      transcript: null,
      duration_seconds: null,
      seq: 1,
      created_at: now,
    },
    {
      id: id(),
      tenant_id: tenantId,
      conversation_id: conv1.id,
      direction: 'out',
      channel: 'email',
      from_address: 'support@example.test',
      to_address: 'pat@example.test',
      subject: 'Re: Question about your services',
      body: 'Hi Pat, happy to help — here is an overview of what we do.',
      status: 'sent',
      provider_message_id: 'stub-email-seed',
      failed_reason: null,
      recording_url: null,
      transcript: null,
      duration_seconds: null,
      seq: 2,
      created_at: now,
    },
    {
      id: id(),
      tenant_id: tenantId,
      conversation_id: conv2.id,
      direction: 'in',
      channel: 'sms',
      from_address: '+15550000123',
      to_address: '+15550000001',
      subject: null,
      body: 'Can we move my appointment to next week?',
      status: 'received',
      provider_message_id: null,
      failed_reason: null,
      recording_url: null,
      transcript: null,
      duration_seconds: null,
      seq: 1,
      created_at: now,
    },
  ];
  await db.insertInto('messaging_messages').values(messages).execute();

  return {
    channelIds: channels.map((c) => c.id),
    conversationIds: [conv1.id, conv2.id],
    messageIds: messages.map((m) => m.id),
    templateIds: templates.map((t) => t.id),
  };
}
