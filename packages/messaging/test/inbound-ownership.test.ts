import { describe, expect, it, vi } from 'vitest';
import { EventBus, asCoreDb, coreMigrations, createTenant, createUser } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { MessagingService, messagingMigrations, messagingRouter, type MessagingDatabase, type ChannelProvider } from '@blacklabel/messaging';

async function fixture(provider?: ChannelProvider) {
  const db = createTestDb<MessagingDatabase>();
  await runMigrations(db, [...coreMigrations, ...messagingMigrations]);
  const tenant = (await createTenant(asCoreDb(db), { name: 'Inbox fixture' })).id;
  const other = (await createTenant(asCoreDb(db), { name: 'Other inbox' })).id;
  const user = await createUser(asCoreDb(db), tenant, { name: 'Inbox owner', email: 'owner@example.test', role: 'owner' });
  const second = await createUser(asCoreDb(db), tenant, { name: 'Other teammate', email: 'other@example.test', role: 'member' });
  const foreign = await createUser(asCoreDb(db), other, { name: 'Foreign teammate', email: 'foreign@example.test', role: 'member' });
  const events = new EventBus(), options = { providers: provider ? { email: provider } : {} };
  const service = new MessagingService(db, events, options), app = messagingRouter({ db, events, contracts: {} }, options);
  return { db, service, events, app, tenant, other, user, second, foreign };
}
const event = { provider: 'verified-email-adapter', providerEventId: 'event-1', channel: 'email' as const, from: 'customer@example.test', subject: 'Question', body: 'Please help.' };

describe('stable inbound receipts', () => {
  it('records one message, one event and one receipt under concurrent provider redelivery', async () => {
    const f = await fixture(), seen: unknown[] = [];
    f.events.on('messaging.message.received', received => { seen.push(received); });
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => f.service.recordInbound(f.tenant, 'adapter', event)));
    expect(outcomes.some(outcome => outcome.status === 'fulfilled')).toBe(true);
    const replay = await f.service.recordInbound(f.tenant, 'adapter', event);
    expect(await f.service.listConversations(f.tenant)).toHaveLength(1);
    expect(await f.service.listMessages(f.tenant, replay.conversation.id)).toHaveLength(1);
    const receipts = await f.service.listInboundReceipts(f.tenant);
    expect(receipts).toHaveLength(1); expect(receipts[0].message_id).toBe(replay.message.id); expect(seen).toHaveLength(1);
    await f.service.setStatus(f.tenant, f.user.id, replay.conversation.id, 'closed');
    expect((await f.service.recordInbound(f.tenant, 'adapter', event)).conversation.status).toBe('closed');
    await expect(f.service.recordInbound(f.tenant, 'adapter', { ...event, body: 'Different payload' })).rejects.toMatchObject({ status: 409 });
    expect(seen).toHaveLength(1);
  });

  it('scopes the event by tenant, provider and channel; denies cross-tenant explicit threading before writing a receipt', async () => {
    const f = await fixture();
    const first = await f.service.recordInbound(f.tenant, 'adapter', event);
    const anotherTenant = await f.service.recordInbound(f.other, 'adapter', event);
    const anotherProvider = await f.service.recordInbound(f.tenant, 'adapter', { ...event, provider: 'other-email-adapter' });
    const anotherChannel = await f.service.recordInbound(f.tenant, 'adapter', { ...event, channel: 'sms' });
    expect(first.message.id).not.toBe(anotherTenant.message.id); expect(first.message.id).not.toBe(anotherProvider.message.id);
    expect(first.message.id).not.toBe(anotherChannel.message.id);
    await expect(f.service.recordInbound(f.other, 'adapter', { ...event, providerEventId: 'foreign-target', conversationId: first.conversation.id })).rejects.toMatchObject({ status: 404 });
    expect(await f.service.listInboundReceipts(f.tenant)).toHaveLength(3); expect(await f.service.listInboundReceipts(f.other)).toHaveLength(1);
  });

  it('rejects partial event identity and channel mismatch without adding a message', async () => {
    const f = await fixture();
    await expect(f.service.recordInbound(f.tenant, 'adapter', { ...event, providerEventId: undefined })).rejects.toMatchObject({ status: 400 });
    const conversation = await f.service.createConversation(f.tenant, 'adapter', { channel: 'email', subject: 'Existing thread' });
    await expect(f.service.recordInbound(f.tenant, 'adapter', { ...event, channel: 'sms', conversationId: conversation.id })).rejects.toMatchObject({ status: 400 });
    expect(await f.service.listMessages(f.tenant, conversation.id)).toEqual([]); expect(await f.service.listInboundReceipts(f.tenant)).toEqual([]);
  });
});

describe('supported transport and reply ownership', () => {
  it.each(['email', 'sms', 'website', 'social', 'call'] as const)('returns 501 for unavailable %s before recording any send', async channel => {
    const f = await fixture();
    const conversation = await f.service.createConversation(f.tenant, f.user.id, { channel, subject: 'Unsupported send', participants: [{ kind: 'external', address: 'customer@example.test' }] });
    const response = await f.app.request(`/conversations/${conversation.id}/messages`, { method: 'POST', headers: { 'x-tenant-id': f.tenant, 'x-user-id': f.user.id, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'Cannot be fictional', idempotencyKey: 'unsupported' }) });
    expect(response.status).toBe(501); expect(await f.service.listMessages(f.tenant, conversation.id)).toEqual([]);
  });

  it('rejects foreign owners and stale assignment/reply revisions, then permits a fresh owner reply exactly once', async () => {
    const send = vi.fn(async () => ({ status: 'sent' as const, providerMessageId: 'provider-message' }));
    const f = await fixture({ type: 'email', send });
    const conversation = await f.service.createConversation(f.tenant, f.user.id, { channel: 'email', subject: 'Owned thread', participants: [{ kind: 'external', address: 'customer@example.test' }] });
    await expect(f.service.assignConversation(f.tenant, f.user.id, conversation.id, { userId: f.foreign.id, expectedRevision: 0 })).rejects.toMatchObject({ status: 404 });
    await f.service.assignConversation(f.tenant, f.user.id, conversation.id, { userId: f.second.id, expectedRevision: 0 });
    await expect(f.service.assignConversation(f.tenant, f.user.id, conversation.id, { userId: f.user.id, expectedRevision: 0 })).rejects.toMatchObject({ status: 409 });
    await expect(f.service.sendOutbound(f.tenant, f.user.id, { conversationId: conversation.id, body: 'Other owner reply', expectedRevision: 1 })).rejects.toMatchObject({ status: 403 });
    const input = { conversationId: conversation.id, body: 'Fresh owner reply', expectedRevision: 1, idempotencyKey: 'owner-reply' };
    const accepted = await f.service.sendOutbound(f.tenant, f.second.id, input);
    expect(accepted.status).toBe('sent');
    expect((await f.service.sendOutbound(f.tenant, f.second.id, input)).id).toBe(accepted.id);
    await expect(f.service.sendOutbound(f.tenant, f.second.id, { ...input, body: 'Stale second reply', idempotencyKey: 'different-operation' })).rejects.toMatchObject({ status: 409 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('holds uncertain submissions against a new reply operation and sanitizes provider exceptions', async () => {
    const send = vi.fn(async () => { throw Error('secret-provider-key-value'); });
    const f = await fixture({ type: 'email', send });
    const conversation = await f.service.createConversation(f.tenant, f.user.id, { channel: 'email', subject: 'Uncertain reply', participants: [{ kind: 'external', address: 'customer@example.test' }] });
    const first = await f.service.sendOutbound(f.tenant, f.user.id, { conversationId: conversation.id, body: 'One reply', expectedRevision: 0, idempotencyKey: 'first' });
    expect(first.status).toBe('queued'); expect(JSON.stringify(first)).not.toContain('secret-provider-key-value');
    await expect(f.service.sendOutbound(f.tenant, f.user.id, { conversationId: conversation.id, body: 'One reply', expectedRevision: 1, idempotencyKey: 'new-key' })).rejects.toMatchObject({ status: 409 });
    expect(send).toHaveBeenCalledTimes(1); expect(await f.service.listMessages(f.tenant, conversation.id)).toHaveLength(1);
  });
});
