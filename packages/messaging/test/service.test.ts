import { describe, expect, it } from 'vitest';
import {
  EventBus,
  asCoreDb,
  coreMigrations,
  createTenant,
  type PlatformEvent,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import {
  LogOnlyEmailProvider,
  LogOnlySmsProvider,
  MessagingService,
  messagingMigrations,
  renderTemplate,
  type ChannelProvider,
  type MessagingDatabase,
  type TimelineEventInput,
  type TimelineWriter,
} from '@blacklabel/messaging';

async function setup(options: { timeline?: TimelineWriter; providers?: Record<string, ChannelProvider> } = {}) {
  const db = createTestDb<MessagingDatabase>();
  await runMigrations(db, [...coreMigrations, ...messagingMigrations]);
  const tenantA = await createTenant(asCoreDb(db), { name: 'Tenant A' });
  const tenantB = await createTenant(asCoreDb(db), { name: 'Tenant B' });
  const events = new EventBus();
  const email = new LogOnlyEmailProvider();
  const sms = new LogOnlySmsProvider();
  const service = new MessagingService(db, events, {
    providers: { email, sms, ...(options.providers as any) },
    timeline: options.timeline,
  });
  return { db, events, service, email, sms, a: tenantA.id, b: tenantB.id };
}

describe('threading', () => {
  it('creates a new conversation for an unknown sender and threads follow-ups onto it', async () => {
    const { service, a } = await setup();
    const first = await service.recordInbound(a, 'system', {
      channel: 'email',
      from: 'pat@example.test',
      subject: 'Need help',
      body: 'Hello there',
    });
    expect(first.conversation.subject).toBe('Need help');
    expect(first.conversation.status).toBe('open');
    expect(first.message.direction).toBe('in');
    expect(first.message.status).toBe('received');

    const second = await service.recordInbound(a, 'system', {
      channel: 'email',
      from: 'pat@example.test',
      body: 'Following up!',
    });
    expect(second.conversation.id).toBe(first.conversation.id);
    const messages = await service.listMessages(a, first.conversation.id);
    expect(messages.map((m) => m.body)).toEqual(['Hello there', 'Following up!']);
  });

  it('does NOT thread different senders or different channels together', async () => {
    const { service, a } = await setup();
    const one = await service.recordInbound(a, 'system', {
      channel: 'email',
      from: 'pat@example.test',
      body: 'From pat',
    });
    const otherSender = await service.recordInbound(a, 'system', {
      channel: 'email',
      from: 'sam@example.test',
      body: 'From sam',
    });
    const otherChannel = await service.recordInbound(a, 'system', {
      channel: 'sms',
      from: 'pat@example.test',
      body: 'From pat by sms',
    });
    expect(otherSender.conversation.id).not.toBe(one.conversation.id);
    expect(otherChannel.conversation.id).not.toBe(one.conversation.id);
  });

  it('appends to an explicit conversationId and reopens it if closed', async () => {
    const { service, a } = await setup();
    const { conversation } = await service.recordInbound(a, 'system', {
      channel: 'sms',
      from: '+15550001111',
      body: 'First',
    });
    await service.setStatus(a, 'system', conversation.id, 'closed');
    const result = await service.recordInbound(a, 'system', {
      channel: 'sms',
      from: '+15550001111',
      conversationId: conversation.id,
      body: 'Knock knock',
    });
    expect(result.conversation.id).toBe(conversation.id);
    expect(result.conversation.status).toBe('open');
  });
});

describe('events', () => {
  it('emits messaging.message.received with { messageId, channel, from }', async () => {
    const { service, events, a } = await setup();
    const seen: PlatformEvent[] = [];
    events.on('messaging.message.received', (e) => {
      seen.push(e);
    });
    const { message } = await service.recordInbound(a, 'system', {
      channel: 'email',
      from: 'pat@example.test',
      body: 'Hi',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].tenantId).toBe(a);
    expect(seen[0].payload).toEqual({
      messageId: message.id,
      channel: 'email',
      from: 'pat@example.test',
    });
  });

  it('emits messaging.conversation.closed on close', async () => {
    const { service, events, a } = await setup();
    const seen: PlatformEvent[] = [];
    events.on('messaging.conversation.closed', (e) => {
      seen.push(e);
    });
    const conv = await service.createConversation(a, 'system', {
      subject: 'To close',
      channel: 'internal',
    });
    await service.setStatus(a, 'system', conv.id, 'closed');
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toEqual({ conversationId: conv.id });
  });

  it('emits messaging.message.sent only on successful sends', async () => {
    const failing: ChannelProvider = {
      type: 'email',
      send: async () => ({ providerMessageId: 'x', status: 'failed', detail: 'mailbox full' }),
    };
    const { service, events, a } = await setup({ providers: { email: failing } });
    const seen: PlatformEvent[] = [];
    events.on('messaging.message.sent', (e) => {
      seen.push(e);
    });
    const conv = await service.createConversation(a, 'system', {
      subject: 'Outbound',
      channel: 'email',
      participants: [{ kind: 'external', address: 'pat@example.test' }],
    });
    const message = await service.sendOutbound(a, 'system', {
      conversationId: conv.id,
      body: 'This will fail',
    });
    expect(message.status).toBe('failed');
    expect(message.failed_reason).toBe('mailbox full');
    expect(seen).toHaveLength(0);
  });
});

describe('outbound sending via channel providers', () => {
  it('sends through the log-only email stub and records provider metadata', async () => {
    const { service, email, events, a } = await setup();
    const seen: PlatformEvent[] = [];
    events.on('messaging.message.sent', (e) => {
      seen.push(e);
    });
    await service.createChannel(a, 'system', {
      type: 'email',
      name: 'Support',
      address: 'support@tenant-a.test',
    });
    const conv = await service.createConversation(a, 'system', {
      subject: 'Hello thread',
      channel: 'email',
      participants: [{ kind: 'external', address: 'pat@example.test' }],
    });
    const message = await service.sendOutbound(a, 'system', {
      conversationId: conv.id,
      body: 'Hello from the team',
    });
    expect(message.status).toBe('sent');
    expect(message.direction).toBe('out');
    expect(message.to_address).toBe('pat@example.test'); // resolved from participant
    expect(message.from_address).toBe('support@tenant-a.test'); // resolved from active channel
    expect(message.provider_message_id).toMatch(/^stub-email-/);
    expect(email.log).toHaveLength(1);
    expect(email.log[0]).toMatchObject({
      tenantId: a,
      to: 'pat@example.test',
      from: 'support@tenant-a.test',
      body: 'Hello from the team',
    });
    expect(seen[0].payload).toEqual({
      messageId: message.id,
      channel: 'email',
      to: 'pat@example.test',
    });
  });

  it('keeps submission unresolved when the provider throws after possible acceptance', async () => {
    const throwing: ChannelProvider = {
      type: 'sms',
      send: async () => {
        throw new Error('carrier unreachable');
      },
    };
    const { service, a } = await setup({ providers: { sms: throwing } });
    const conv = await service.createConversation(a, 'system', {
      subject: 'SMS thread',
      channel: 'sms',
      participants: [{ kind: 'external', address: '+15550002222' }],
    });
    const message = await service.sendOutbound(a, 'system', {
      conversationId: conv.id,
      body: 'ping',
    });
    expect(message.status).toBe('queued');
    expect(message.failed_reason).toBe('carrier unreachable');
  });

  it('stores provider-less channels (internal) as sent with no provider id', async () => {
    const { service, a } = await setup();
    const conv = await service.createConversation(a, 'system', {
      subject: 'Internal note',
      channel: 'internal',
      participants: [{ kind: 'user', refId: 'user-1', address: 'user-1' }],
    });
    const message = await service.sendOutbound(a, 'system', {
      conversationId: conv.id,
      to: 'user-1',
      body: 'Note to team',
    });
    expect(message.status).toBe('sent');
    expect(message.provider_message_id).toBeNull();
  });

  it('refuses to send on a closed conversation (409)', async () => {
    const { service, a } = await setup();
    const conv = await service.createConversation(a, 'system', {
      subject: 'Done deal',
      channel: 'internal',
    });
    await service.setStatus(a, 'system', conv.id, 'closed');
    await expect(
      service.sendOutbound(a, 'system', { conversationId: conv.id, to: 'x', body: 'hi' }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('templates & {{variable}} substitution', () => {
  it('substitutes variables (whitespace-tolerant) and renders subject + body', async () => {
    const { service, a } = await setup();
    const template = await service.createTemplate(a, 'system', {
      name: 'greeting',
      subject: 'Hi {{ name }}',
      body: 'Hello {{name}}, your visit is on {{ date }}.',
    });
    const conv = await service.createConversation(a, 'system', {
      subject: 'Templated',
      channel: 'email',
      participants: [{ kind: 'external', address: 'pat@example.test' }],
    });
    const message = await service.sendOutbound(a, 'system', {
      conversationId: conv.id,
      templateId: template.id,
      variables: { name: 'Pat', date: '2026-07-14' },
    });
    expect(message.subject).toBe('Hi Pat');
    expect(message.body).toBe('Hello Pat, your visit is on 2026-07-14.');
  });

  it('rejects renders with missing variables, listing them', () => {
    let thrown: any;
    try {
      renderTemplate('Hi {{name}}, see {{link}}', { name: 'Pat' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown.status).toBe(400);
    expect(thrown.details).toEqual({ missing: ['link'] });
  });

  it('rejects using a channel-restricted template on another channel', async () => {
    const { service, a } = await setup();
    const template = await service.createTemplate(a, 'system', {
      name: 'sms_only',
      channel: 'sms',
      body: 'Short {{thing}}',
    });
    const conv = await service.createConversation(a, 'system', {
      subject: 'Email thread',
      channel: 'email',
      participants: [{ kind: 'external', address: 'pat@example.test' }],
    });
    await expect(
      service.sendOutbound(a, 'system', {
        conversationId: conv.id,
        templateId: template.id,
        variables: { thing: 'x' },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('enforces unique template names per tenant but not across tenants', async () => {
    const { service, a, b } = await setup();
    await service.createTemplate(a, 'system', { name: 'welcome', body: 'Hi {{name}}' });
    await expect(
      service.createTemplate(a, 'system', { name: 'welcome', body: 'Other' }),
    ).rejects.toMatchObject({ status: 409 });
    // same name is fine in another tenant
    const other = await service.createTemplate(b, 'system', { name: 'welcome', body: 'Hi' });
    expect(other.tenant_id).toBe(b);
  });
});

describe('status transitions', () => {
  it('allows open->pending->open->closed->open and rejects closed->pending', async () => {
    const { service, a } = await setup();
    const conv = await service.createConversation(a, 'system', {
      subject: 'Lifecycle',
      channel: 'internal',
    });
    expect((await service.setStatus(a, 'system', conv.id, 'pending')).status).toBe('pending');
    expect((await service.setStatus(a, 'system', conv.id, 'open')).status).toBe('open');
    expect((await service.setStatus(a, 'system', conv.id, 'closed')).status).toBe('closed');
    await expect(service.setStatus(a, 'system', conv.id, 'pending')).rejects.toMatchObject({
      status: 409,
    });
    expect((await service.setStatus(a, 'system', conv.id, 'open')).status).toBe('open');
  });

  it('rejects no-op transitions (same status)', async () => {
    const { service, a } = await setup();
    const conv = await service.createConversation(a, 'system', {
      subject: 'Stuck',
      channel: 'internal',
    });
    await expect(service.setStatus(a, 'system', conv.id, 'open')).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('assignment', () => {
  it('assigns a conversation, keeps history, and emits the assigned event', async () => {
    const { service, events, a } = await setup();
    const seen: PlatformEvent[] = [];
    events.on('messaging.conversation.assigned', (e) => {
      seen.push(e);
    });
    const conv = await service.createConversation(a, 'system', {
      subject: 'Assign me',
      channel: 'email',
    });
    await service.assignConversation(a, 'manager-1', conv.id, { userId: 'agent-1', note: 'yours' });
    await service.assignConversation(a, 'manager-1', conv.id, { userId: 'agent-2' });

    const fresh = await service.getConversationRow(a, conv.id);
    expect(fresh.assigned_user_id).toBe('agent-2');

    const history = await service.listAssignments(a, conv.id);
    expect(history).toHaveLength(2);
    // both assignments can share a millisecond timestamp, so assert by content
    expect(new Set(history.map((h) => h.user_id))).toEqual(new Set(['agent-1', 'agent-2']));
    const first = history.find((h) => h.user_id === 'agent-1')!;
    expect(first.note).toBe('yours');
    expect(first.assigned_by).toBe('manager-1');

    expect(seen.map((e) => (e.payload as any).userId)).toEqual(['agent-1', 'agent-2']);
    expect((seen[0].payload as any).conversationId).toBe(conv.id);
  });
});

describe('search (LIKE-based)', () => {
  it('finds matches in message bodies and conversation subjects, case-insensitively', async () => {
    const { service, a } = await setup();
    await service.recordInbound(a, 'system', {
      channel: 'email',
      from: 'pat@example.test',
      subject: 'Warranty question',
      body: 'Does the WIDGET have a warranty?',
    });
    await service.recordInbound(a, 'system', {
      channel: 'sms',
      from: '+15550003333',
      body: 'totally unrelated',
    });
    const result = await service.search(a, 'widget');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].body).toContain('WIDGET');
    const bySubject = await service.search(a, 'WARRANTY');
    expect(bySubject.conversations).toHaveLength(1);
    expect(bySubject.conversations[0].subject).toBe('Warranty question');
  });

  it('escapes LIKE wildcards in the search term', async () => {
    const { service, a } = await setup();
    await service.recordInbound(a, 'system', {
      channel: 'email',
      from: 'pat@example.test',
      body: 'You get 100% satisfaction',
    });
    await service.recordInbound(a, 'system', {
      channel: 'email',
      from: 'sam@example.test',
      body: 'You get 1000 points',
    });
    const literal = await service.search(a, '100%');
    expect(literal.messages).toHaveLength(1);
    expect(literal.messages[0].body).toContain('100%');
    // '%' alone must not match everything
    const percent = await service.search(a, '%');
    expect(percent.messages).toHaveLength(1);
  });

  it('never returns another tenant\'s data', async () => {
    const { service, a, b } = await setup();
    await service.recordInbound(a, 'system', {
      channel: 'email',
      from: 'pat@example.test',
      subject: 'Secret plans',
      body: 'the secret launch code is 1234',
    });
    const result = await service.search(b, 'secret');
    expect(result.conversations).toEqual([]);
    expect(result.messages).toEqual([]);
  });
});

describe('CRM timeline contract', () => {
  it('writes timeline entries for received messages and closed conversations on linked conversations', async () => {
    const written: TimelineEventInput[] = [];
    const timeline: TimelineWriter = {
      recordTimelineEvent: async (input) => {
        written.push(input);
      },
    };
    const { service, a } = await setup({ timeline });
    const conv = await service.createConversation(a, 'system', {
      subject: 'Linked',
      channel: 'email',
      customerId: 'cust-42',
      participants: [{ kind: 'external', address: 'pat@example.test' }],
    });
    const { message } = await service.recordInbound(a, 'system', {
      channel: 'email',
      from: 'pat@example.test',
      conversationId: conv.id,
      body: 'hi',
    });
    await service.setStatus(a, 'system', conv.id, 'closed');

    expect(written).toHaveLength(2);
    expect(written[0]).toMatchObject({
      tenantId: a,
      entityType: 'crm.customer',
      entityId: 'cust-42',
      kind: 'messaging.message.received',
      refId: message.id,
    });
    expect(written[1]).toMatchObject({
      entityType: 'crm.customer',
      entityId: 'cust-42',
      kind: 'messaging.conversation.closed',
      refId: conv.id,
    });
  });

  it('skips the timeline for unlinked conversations and survives writer failures', async () => {
    const written: TimelineEventInput[] = [];
    const timeline: TimelineWriter = {
      recordTimelineEvent: async (input) => {
        written.push(input);
        throw new Error('timeline down');
      },
    };
    const { service, a } = await setup({ timeline });
    // unlinked -> no call at all
    const { conversation } = await service.recordInbound(a, 'system', {
      channel: 'email',
      from: 'anon@example.test',
      body: 'no crm link',
    });
    expect(written).toHaveLength(0);
    // linked + failing writer -> mutation still succeeds
    await service.updateConversation(a, 'system', conversation.id, { contactId: 'contact-7' });
    const result = await service.recordInbound(a, 'system', {
      channel: 'email',
      from: 'anon@example.test',
      conversationId: conversation.id,
      body: 'still works',
    });
    expect(result.message.body).toBe('still works');
    expect(written).toHaveLength(1);
    expect(written[0].entityType).toBe('crm.contact');
  });
});

describe('audit trail', () => {
  it('audits mutations with namespaced entity types', async () => {
    const { db, service, a } = await setup();
    const conv = await service.createConversation(a, 'user-9', {
      subject: 'Audited',
      channel: 'internal',
    });
    await service.assignConversation(a, 'user-9', conv.id, { userId: 'agent-1' });
    await service.setStatus(a, 'user-9', conv.id, 'closed');
    const entries = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('tenant_id', '=', a)
      .where('entity_id', '=', conv.id)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('messaging.conversation.created');
    expect(actions).toContain('messaging.conversation.assigned');
    expect(actions).toContain('messaging.conversation.status_changed');
    expect(entries.every((e) => e.entity_type === 'messaging.conversation')).toBe(true);
    expect(entries.every((e) => e.actor === 'user-9')).toBe(true);
  });
});
