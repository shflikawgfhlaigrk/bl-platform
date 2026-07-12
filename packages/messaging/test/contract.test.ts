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
  MessagingService,
  createMessagingSendContract,
  messagingMigrations,
  type MessagingDatabase,
} from '@blacklabel/messaging';

async function setup() {
  const db = createTestDb<MessagingDatabase>();
  await runMigrations(db, [...coreMigrations, ...messagingMigrations]);
  const tenant = await createTenant(asCoreDb(db), { name: 'Contract Tenant' });
  const events = new EventBus();
  const email = new LogOnlyEmailProvider();
  const contract = createMessagingSendContract(db, events, { providers: { email } });
  const service = new MessagingService(db, events);
  return { db, events, contract, service, email, tenantId: tenant.id };
}

describe('SendMessageContract implementation (core contract)', () => {
  it('creates a conversation + outbound message and returns the message id', async () => {
    const { contract, service, email, events, tenantId } = await setup();
    const seen: PlatformEvent[] = [];
    events.on('messaging.message.sent', (e) => {
      seen.push(e);
    });

    const result = await contract.sendMessage({
      tenantId,
      channel: 'email',
      to: 'customer@x.test',
      subject: 'Your quote is ready',
      body: 'Quote #12 is ready for review.',
    });
    expect(result.id).toBeTruthy();

    const conversations = await service.listConversations(tenantId);
    expect(conversations).toHaveLength(1);
    expect(conversations[0].subject).toBe('Your quote is ready');
    expect(conversations[0].channel).toBe('email');

    const messages = await service.listMessages(tenantId, conversations[0].id);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(result.id);
    expect(messages[0]).toMatchObject({
      direction: 'out',
      status: 'sent',
      to_address: 'customer@x.test',
      body: 'Quote #12 is ready for review.',
    });

    expect(email.log).toHaveLength(1);
    expect(email.log[0].to).toBe('customer@x.test');
    expect(seen).toHaveLength(1);
  });

  it('maps the "portal" contract channel to the internal channel', async () => {
    const { contract, service, tenantId } = await setup();
    const result = await contract.sendMessage({
      tenantId,
      channel: 'portal',
      to: 'portal-user-1',
      body: 'A new document is available.',
    });
    const conversations = await service.listConversations(tenantId);
    expect(conversations[0].channel).toBe('internal');
    const messages = await service.listMessages(tenantId, conversations[0].id);
    expect(messages[0].id).toBe(result.id);
    expect(messages[0].status).toBe('sent'); // store-only channel, no provider needed
  });

  it('links the conversation to a CRM customer via relatedEntity fields', async () => {
    const { contract, service, tenantId } = await setup();
    await contract.sendMessage({
      tenantId,
      channel: 'email',
      to: 'c@x.test',
      body: 'hello',
      relatedEntityType: 'crm.customer',
      relatedEntityId: 'cust-99',
    });
    const conversations = await service.listConversations(tenantId, { customer_id: 'cust-99' });
    expect(conversations).toHaveLength(1);
    expect(conversations[0].customer_id).toBe('cust-99');
  });
});
