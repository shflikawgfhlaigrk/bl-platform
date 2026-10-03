import { describe, expect, it, vi } from 'vitest';
import { EventBus, asCoreDb, coreMigrations, createTenant } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { MessagingService, createMessagingSendContract, messagingMigrations, messagingRouter, ResendEmailProvider,
  type ChannelProvider, type MessagingDatabase, type OutboundPayload } from '@blacklabel/messaging';

async function setup(provider?: ChannelProvider) {
  const db = createTestDb<MessagingDatabase>();
  await runMigrations(db, [...coreMigrations, ...messagingMigrations]);
  const a = (await createTenant(asCoreDb(db), { name: 'Delivery fixture A' })).id;
  const b = (await createTenant(asCoreDb(db), { name: 'Delivery fixture B' })).id;
  const events = new EventBus();
  const providers = provider ? { email: provider } : {};
  const service = new MessagingService(db, events, { providers });
  const contract = createMessagingSendContract(db, events, { providers });
  const app = messagingRouter({ db, events, contracts: {} }, { providers });
  const conversation = await service.createConversation(a, 'fixture', { channel: 'email', subject: 'Delivery acceptance',
    participants: [{ kind: 'external', address: 'customer@example.test' }] });
  return { db, a, b, events, service, contract, app, conversationId: conversation.id };
}
const sent = () => ({ providerMessageId: 'fixture-provider-id', status: 'sent' as const });

describe('durable submission', () => {
  it('persists before provider execution and sends once under concurrent duplicate requests', async () => {
    let fixture: Awaited<ReturnType<typeof setup>>;
    const send = vi.fn(async (payload: OutboundPayload) => {
      const persisted = await fixture.service.getMessage(payload.tenantId, payload.operationId!);
      expect(persisted.status).toBe('queued');
      expect(persisted.body).toBe(payload.body);
      return sent();
    });
    fixture = await setup({ type: 'email', send });
    const input = { conversationId: fixture.conversationId, body: 'Actual fixture message', idempotencyKey: 'same-operation' };
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => fixture.service.sendOutbound(fixture.a, 'fixture', input)));
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const replay = await fixture.service.sendOutbound(fixture.a, 'fixture', input);
    expect(replay.status).toBe('sent');
    expect(await fixture.service.listMessages(fixture.a, fixture.conversationId)).toHaveLength(1);
    await expect(fixture.service.sendOutbound(fixture.a, 'fixture', { ...input, body: 'Changed' })).rejects.toMatchObject({ status: 409 });
    expect(send).toHaveBeenCalledTimes(1);
    await fixture.db.destroy();
  });

  it('retains uncertain submissions across service recreation and refuses automatic resubmission', async () => {
    const send = vi.fn(async () => { throw new Error('connection closed after provider admission'); });
    const f = await setup({ type: 'email', send });
    const input = { conversationId: f.conversationId, body: 'One attempt', idempotencyKey: 'uncertain' };
    expect((await f.service.sendOutbound(f.a, 'fixture', input)).status).toBe('queued');
    const restarted = new MessagingService(f.db, f.events, { providers: { email: { type: 'email', send } } });
    await expect(restarted.sendOutbound(f.a, 'fixture', input)).rejects.toMatchObject({ status: 409 });
    expect(send).toHaveBeenCalledTimes(1);
    await f.db.destroy();
  });

  it('the cross-module contract reuses a single conversation and operation, scoped by tenant', async () => {
    const send = vi.fn(async () => sent());
    const f = await setup({ type: 'email', send });
    const input = { tenantId: f.a, channel: 'email' as const, to: 'customer@example.test', body: 'Contract message', idempotencyKey: 'action-1' };
    const one = await f.contract.sendMessage(input);
    expect(await f.contract.sendMessage(input)).toEqual(one);
    await expect(f.contract.sendMessage({ ...input, to: 'another@example.test' })).rejects.toMatchObject({ status: 409 });
    await f.contract.sendMessage({ ...input, tenantId: f.b });
    expect(send).toHaveBeenCalledTimes(2);
    expect(await f.service.listConversations(f.a)).toHaveLength(2); // initial thread plus the contract thread
    expect(await f.service.listConversations(f.b)).toHaveLength(1);
    await f.db.destroy();
  });

  it('the contract never returns success when an external provider is absent', async () => {
    const f = await setup();
    await expect(f.contract.sendMessage({ tenantId: f.a, channel: 'email', to: 'customer@example.test', body: 'Unconnected' }))
      .rejects.toMatchObject({ status: 501 });
    await f.db.destroy();
  });
});

describe('provider reconciliation', () => {
  it('reads an existing exact message and does not send during reconciliation; other tenants are denied', async () => {
    const send = vi.fn(async () => ({ status: 'queued' as const, providerMessageId: '' }));
    const reconcile = vi.fn(async () => ({ status: 'delivered' as const, providerMessageId: 'known-provider-id', evidenceSha256: 'a'.repeat(64) }));
    const f = await setup({ type: 'email', send, reconcile });
    const message = await f.service.sendOutbound(f.a, 'fixture', { conversationId: f.conversationId, body: 'Tracked', idempotencyKey: 'tracked' });
    const request = (tenantId: string) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-tenant-id': tenantId }, body: JSON.stringify({ providerMessageId: 'known-provider-id' }) });
    expect((await f.app.request(`/messages/${message.id}/reconcile`, request(f.b))).status).toBe(404);
    expect(reconcile).not.toHaveBeenCalled();
    const response = await f.app.request(`/messages/${message.id}/reconcile`, request(f.a));
    expect(response.status).toBe(200);
    expect((await response.json() as any).data).toMatchObject({ status: 'sent', delivery_status: 'delivered', provider_message_id: 'known-provider-id' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await expect(f.service.reconcileMessage(f.a, 'fixture', message.id, 'other-provider-id')).rejects.toMatchObject({ status: 409 });
    expect(reconcile).toHaveBeenCalledTimes(1);
    await f.db.destroy();
  });

  it('rejects mismatched readback without changing the persisted operation', async () => {
    const f = await setup({ type: 'email', send: async () => sent(), reconcile: async () => ({
      providerMessageId: 'wrong-message', status: 'delivered', evidenceSha256: 'b'.repeat(64) }) });
    const m = await f.service.sendOutbound(f.a, 'fixture', { conversationId: f.conversationId, body: 'Keep' });
    await expect(f.service.reconcileMessage(f.a, 'fixture', m.id)).rejects.toMatchObject({ status: 409 });
    expect((await f.service.getMessage(f.a, m.id)).reconciled_at).toBeNull();
    await f.db.destroy();
  });
});

describe('Resend adapter with isolated HTTP fixtures', () => {
  const payload = { tenantId: 'tenant-fixture', operationId: 'operation-fixture', to: 'customer@example.test', from: 'team@example.test', subject: 'Fixture subject', body: 'Fixture body' };
  const connection = async (tenantId: string) => tenantId === 'tenant-fixture' ? { apiKey: 'test-key-only', from: payload.from } : undefined;
  it('uses the fixed official endpoint, exact content and a durable idempotency header', async () => {
    const transport = vi.fn(async () => Response.json({ id: 'provider-fixture' }));
    const provider = new ResendEmailProvider({ connection, fetchImpl: transport });
    expect(await provider.send(payload)).toEqual({ status: 'sent', providerMessageId: 'provider-fixture' });
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.redirect).toBe('error');
    expect((init.headers as any)['Idempotency-Key']).toBe(payload.operationId);
    expect(JSON.parse(init.body as string)).toMatchObject({ from: payload.from, to: [payload.to], subject: payload.subject, text: payload.body });
    expect((await provider.send({ ...payload, tenantId: 'other-tenant' })).status).toBe('failed');
    expect((await provider.send({ ...payload, from: 'different@example.test' })).status).toBe('failed');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('keeps server failures and missing provider ids unresolved without exposing provider response bodies', async () => {
    for (const response of [new Response('sensitive error detail', { status: 503 }), Response.json({})]) {
      const provider = new ResendEmailProvider({ connection, fetchImpl: async () => response });
      const result = await provider.send(payload);
      expect(result.status).toBe('queued');
      expect(JSON.stringify(result)).not.toContain('sensitive error detail');
    }
  });
  it('distinguishes admission, delivery and bounce events and checks the entire message identity', async () => {
    for (const [event, status] of [['sent', 'accepted'], ['delivered', 'delivered'], ['bounced', 'failed']]) {
      const transport = vi.fn(async () => Response.json({ id: 'provider-fixture', from: payload.from, to: [payload.to], subject: payload.subject, text: payload.body, last_event: event }));
      const provider = new ResendEmailProvider({ connection, fetchImpl: transport });
      expect(await provider.reconcile({ ...payload, providerMessageId: 'provider-fixture' })).toMatchObject({ status, evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect((transport.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe('GET');
      await expect(provider.reconcile({ ...payload, body: 'different', providerMessageId: 'provider-fixture' })).rejects.toThrow('exact sender');
    }
  });
});
