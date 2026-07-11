/**
 * Front Desk V3 — the 'call' channel.
 * An inbound call is stored as a message carrying recording_url / transcript /
 * duration_seconds, and (like every other channel) mirrors into the CRM
 * timeline when the conversation is linked to a customer/contact.
 */
import { describe, expect, it } from 'vitest';
import { EventBus, asCoreDb, coreMigrations, createTenant } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import {
  MessagingService,
  messagingMigrations,
  type MessagingDatabase,
  type TimelineEventInput,
  type TimelineWriter,
} from '@blacklabel/messaging';

async function setup() {
  const db = createTestDb<MessagingDatabase>();
  await runMigrations(db, [...coreMigrations, ...messagingMigrations]);
  const tenant = await createTenant(asCoreDb(db), { name: 'Front Desk Co' });
  const captured: TimelineEventInput[] = [];
  const timeline: TimelineWriter = {
    async recordTimelineEvent(input) {
      captured.push(input);
    },
  };
  const service = new MessagingService(db, new EventBus(), { timeline });
  return { db, service, tenantId: tenant.id, captured };
}

describe('call channel', () => {
  it('stores recording_url, transcript and duration_seconds on an inbound call', async () => {
    const { service, tenantId } = await setup();
    const { message } = await service.recordInbound(tenantId, 'front-desk', {
      channel: 'call',
      from: '+15551234567',
      to: '+15550009999',
      subject: 'Inbound call',
      body: 'Caller asked about Saturday availability.',
      customerId: 'cust-1',
      recordingUrl: 'https://recordings.local/calls/abc.wav',
      transcript: 'Agent: Thanks for calling. Caller: Do you have Saturday openings?',
      durationSeconds: 142,
    });
    expect(message.channel).toBe('call');
    expect(message.recording_url).toBe('https://recordings.local/calls/abc.wav');
    expect(message.transcript).toContain('Saturday openings');
    expect(message.duration_seconds).toBe(142);

    // Prove it round-trips through SQLite, not just the returned object.
    const rows = await service.listMessages(tenantId, message.conversation_id);
    expect(rows).toHaveLength(1);
    expect(rows[0].duration_seconds).toBe(142);
    expect(rows[0].recording_url).toBe('https://recordings.local/calls/abc.wav');
  });

  it('mirrors the call into the CRM timeline like other channels', async () => {
    const { service, tenantId, captured } = await setup();
    await service.recordInbound(tenantId, 'front-desk', {
      channel: 'call',
      from: '+15551234567',
      body: 'Voicemail transcript here.',
      customerId: 'cust-42',
      durationSeconds: 30,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].entityType).toBe('crm.customer');
    expect(captured[0].entityId).toBe('cust-42');
    expect(captured[0].kind).toBe('messaging.message.received');
    expect(captured[0].summary).toContain('(call)');
  });

  it('leaves call fields null on non-call channels', async () => {
    const { service, tenantId } = await setup();
    const { message } = await service.recordInbound(tenantId, 'front-desk', {
      channel: 'email',
      from: 'pat@example.test',
      body: 'Just an email.',
    });
    expect(message.recording_url).toBeNull();
    expect(message.transcript).toBeNull();
    expect(message.duration_seconds).toBeNull();
  });
});
