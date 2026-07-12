import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { collect, setup } from './helpers';
import {
  checkReplies,
  createTemplate,
  getThread,
  listInbox,
  listSends,
  queueSend,
  sendPending,
  updateSettings,
} from '../src/service';
import { SimulatorReader, SimulatorTransport } from '../src/adapters';
import type { OutreachDatabase } from '../src/schema';

const NOW = '2026-07-13T15:00:00.000Z';
const JANE = 'jane@buyer.test';

async function armAndSend(db: Kysely<OutreachDatabase>, events: any, tenantId: string) {
  await updateSettings(db, tenantId, 'owner', {
    armed: true,
    postalAddress: '123 Barn Rd',
    fromEmail: 'shop@magstack.test',
    providerCredentialRef: 'cred_1',
  });
  const t = await createTemplate(db, tenantId, 'owner', {
    name: 'Hello',
    kind: 'transactional',
    subjectTemplate: 'Hi {{name}}',
    bodyTemplate: 'Hello {{name}}',
    requiredPlaceholders: ['name'],
  });
  const s = await queueSend(db, events, tenantId, 'owner', { templateId: t.id, to: JANE, vars: { name: 'Jane' }, consent: true });
  await sendPending(db, events, tenantId, NOW, { transport: new SimulatorTransport() });
  return s;
}

describe('reply ingest', () => {
  it('is idempotent per provider_ref (same ref twice → one inbox row)', async () => {
    const { db, events, tenantA } = await setup();
    await armAndSend(db, events, tenantA.id);
    const reader = new SimulatorReader();
    const msg = { providerRef: 'r1', from: JANE, to: 'shop@magstack.test', subject: 'Re: Hi Jane', text: 'yes please', receivedAt: NOW };
    reader.push(msg);
    const first = await checkReplies(db, events, tenantA.id, reader);
    expect(first.ingested).toBe(1);

    // Same provider_ref arrives again (e.g. cursor loss).
    reader.push({ ...msg });
    const second = await checkReplies(db, events, tenantA.id, reader);
    expect(second.ingested).toBe(0);
    expect(second.duplicates).toBe(1);

    const inbox = await listInbox(db, tenantA.id, { limit: 50, offset: 0 });
    expect(inbox).toHaveLength(1);
  });

  it('classifies reply / auto_reply / unknown and matches the reply to its send', async () => {
    const { db, events, tenantA } = await setup();
    const send = await armAndSend(db, events, tenantA.id);
    const reader = new SimulatorReader();
    reader.push(
      { providerRef: 'm1', from: JANE, to: 'shop@magstack.test', subject: 'Re: Hi Jane', text: 'interested!', receivedAt: NOW },
      { providerRef: 'm2', from: JANE, to: 'shop@magstack.test', subject: 'Out of Office: Re: Hi Jane', text: 'away', receivedAt: NOW },
      { providerRef: 'm3', from: 'stranger@vendor.test', to: 'shop@magstack.test', subject: 'partnership', text: 'hi', receivedAt: NOW },
    );
    const r = await checkReplies(db, events, tenantA.id, reader);
    expect(r).toMatchObject({ replies: 1, autoReplies: 1, unknown: 1 });

    const inbox = await listInbox(db, tenantA.id, { limit: 50, offset: 0 });
    const reply = inbox.find((i) => i.provider_ref === 'm1')!;
    expect(reply.classification).toBe('reply');
    expect(reply.matched_send_id).toBe(send.id);
  });

  it('a bounce DSN flips the matched send to bounced and emits the delivery event', async () => {
    const { db, events, tenantA } = await setup();
    const send = await armAndSend(db, events, tenantA.id);
    const captured = collect(events, 'outreach.delivery.changed');
    const reader = new SimulatorReader();
    reader.pushBounce({ to: 'shop@magstack.test', recipient: JANE, subject: 'Hi Jane', providerRef: 'dsn-1', receivedAt: NOW });
    const r = await checkReplies(db, events, tenantA.id, reader);
    expect(r.bounces).toBe(1);

    const sends = await listSends(db, tenantA.id, { limit: 50, offset: 0 });
    expect(sends.find((s) => s.id === send.id)!.status).toBe('bounced');
    expect(captured.map((e) => (e.payload as any).state)).toContain('bounced');
  });
});

describe('thread view', () => {
  it('groups a recipient sends + inbound messages in order', async () => {
    const { db, events, tenantA } = await setup();
    await armAndSend(db, events, tenantA.id);
    const reader = new SimulatorReader();
    reader.push({ providerRef: 't1', from: JANE, to: 'shop@magstack.test', subject: 'Re: Hi Jane', text: 'thanks', receivedAt: NOW });
    await checkReplies(db, events, tenantA.id, reader);

    const thread = await getThread(db, tenantA.id, JANE);
    expect(thread.recipient).toBe(JANE);
    expect(thread.sends).toHaveLength(1);
    expect(thread.inbox).toHaveLength(1);
    expect(thread.inbox[0].classification).toBe('reply');
  });
});
