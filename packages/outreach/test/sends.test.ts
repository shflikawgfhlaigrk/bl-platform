import { describe, expect, it } from 'vitest';
import { listAuditEntries, asCoreDb, type EventBus } from '@blacklabel/core';
import { collect, makeSuppressions, setup } from './helpers';
import {
  createTemplate,
  listSends,
  queueSend,
  sendPending,
  updateSettings,
} from '../src/service';
import { SimulatorTransport } from '../src/adapters';
import type { OutreachDatabase } from '../src/schema';
import type { Kysely } from 'kysely';

const NOW_OPEN = '2026-07-13T15:00:00.000Z'; // 11:00 ET — not quiet
const NOW_QUIET = '2026-07-13T04:00:00.000Z'; // 00:00 ET — quiet
const RECIP = 'jane@buyer.test';

async function makeTemplate(db: Kysely<OutreachDatabase>, tenantId: string) {
  return createTemplate(db, tenantId, 'owner', {
    name: 'Hello',
    kind: 'transactional',
    subjectTemplate: 'Hi {{name}}',
    bodyTemplate: 'Hello {{name}}, welcome.',
    requiredPlaceholders: ['name'],
  });
}

async function arm(db: Kysely<OutreachDatabase>, tenantId: string, extra: Record<string, unknown> = {}) {
  return updateSettings(db, tenantId, 'owner', {
    armed: true,
    postalAddress: '123 Barn Rd, Newnan GA',
    fromEmail: 'shop@magstack.test',
    providerCredentialRef: 'cred_1',
    ...extra,
  });
}

describe('send gates — each blocks with its exact reason', () => {
  it('not_armed', async () => {
    const { db, events, tenantA } = await setup();
    const t = await makeTemplate(db, tenantA.id);
    await queueSend(db, events, tenantA.id, 'owner', { templateId: t.id, to: RECIP, vars: { name: 'Jane' }, consent: true });
    const r = await sendPending(db, events, tenantA.id, NOW_OPEN, { transport: new SimulatorTransport() });
    expect(r.blocked).toEqual([expect.objectContaining({ reason: 'not_armed' })]);
  });

  it('no_postal', async () => {
    const { db, events, tenantA } = await setup();
    const t = await makeTemplate(db, tenantA.id);
    await updateSettings(db, tenantA.id, 'owner', { armed: true, fromEmail: 'x@y.test', providerCredentialRef: 'c' });
    await queueSend(db, events, tenantA.id, 'owner', { templateId: t.id, to: RECIP, vars: { name: 'Jane' }, consent: true });
    const r = await sendPending(db, events, tenantA.id, NOW_OPEN, { transport: new SimulatorTransport() });
    expect(r.blocked).toEqual([expect.objectContaining({ reason: 'no_postal' })]);
  });

  it('no_provider — no transport injected is the honest cold path', async () => {
    const { db, events, tenantA } = await setup();
    const t = await makeTemplate(db, tenantA.id);
    await arm(db, tenantA.id);
    await queueSend(db, events, tenantA.id, 'owner', { templateId: t.id, to: RECIP, vars: { name: 'Jane' }, consent: true });
    const r = await sendPending(db, events, tenantA.id, NOW_OPEN, {}); // no transport
    expect(r.blocked).toEqual([expect.objectContaining({ reason: 'no_provider' })]);
  });

  it('no_consent', async () => {
    const { db, events, tenantA } = await setup();
    const t = await makeTemplate(db, tenantA.id);
    await arm(db, tenantA.id);
    await queueSend(db, events, tenantA.id, 'owner', { templateId: t.id, to: RECIP, vars: { name: 'Jane' }, consent: false });
    const r = await sendPending(db, events, tenantA.id, NOW_OPEN, { transport: new SimulatorTransport() });
    expect(r.blocked).toEqual([expect.objectContaining({ reason: 'no_consent' })]);
  });

  it('suppressed (injected suppress-check)', async () => {
    const sup = makeSuppressions();
    const { db, events, tenantA } = await setup();
    const t = await makeTemplate(db, tenantA.id);
    await arm(db, tenantA.id);
    sup.suppress(tenantA.id, RECIP, 'prior');
    await queueSend(db, events, tenantA.id, 'owner', { templateId: t.id, to: RECIP, vars: { name: 'Jane' }, consent: true });
    const r = await sendPending(db, events, tenantA.id, NOW_OPEN, {
      transport: new SimulatorTransport(),
      isSuppressed: sup.isSuppressed,
    });
    expect(r.blocked).toEqual([expect.objectContaining({ reason: 'suppressed' })]);
  });

  it('quiet_hours defers (row stays queued for a later drain)', async () => {
    const { db, events, tenantA } = await setup();
    const t = await makeTemplate(db, tenantA.id);
    await arm(db, tenantA.id);
    await queueSend(db, events, tenantA.id, 'owner', { templateId: t.id, to: RECIP, vars: { name: 'Jane' }, consent: true });
    const r = await sendPending(db, events, tenantA.id, NOW_QUIET, { transport: new SimulatorTransport() });
    expect(r.deferred).toEqual([expect.objectContaining({ reason: 'quiet_hours' })]);
    const sends = await listSends(db, tenantA.id, { limit: 50, offset: 0 });
    expect(sends[0].status).toBe('queued'); // still retryable
  });

  it('cap_reached defers once the warmup cap is spent', async () => {
    const { db, events, tenantA } = await setup();
    const t = await makeTemplate(db, tenantA.id);
    await arm(db, tenantA.id, { dailyCapOverride: 1 });
    await queueSend(db, events, tenantA.id, 'owner', { templateId: t.id, to: 'a@buyer.test', vars: { name: 'A' }, consent: true });
    await queueSend(db, events, tenantA.id, 'owner', { templateId: t.id, to: 'b@buyer.test', vars: { name: 'B' }, consent: true });
    const r = await sendPending(db, events, tenantA.id, NOW_OPEN, { transport: new SimulatorTransport() });
    expect(r.sent).toHaveLength(1);
    expect(r.deferred).toEqual([expect.objectContaining({ reason: 'cap_reached' })]);
  });
});

describe('send-of-record dedup', () => {
  it('a duplicate (recipient, subject) NEVER double-sends — records blocked/duplicate', async () => {
    const { db, events, tenantA } = await setup();
    const t = await makeTemplate(db, tenantA.id);
    const first = await queueSend(db, events, tenantA.id, 'owner', { templateId: t.id, to: RECIP, vars: { name: 'Jane' }, consent: true });
    const second = await queueSend(db, events, tenantA.id, 'owner', { templateId: t.id, to: RECIP, vars: { name: 'Jane' }, consent: true });
    expect(first.status).toBe('queued');
    expect(second.status).toBe('blocked');
    expect(second.blocked_reason).toBe('duplicate');
  });
});

describe('simulator send end-to-end', () => {
  it('queued → sent with a provider id, capacity consumed, events emitted', async () => {
    const { db, events, tenantA } = await setup();
    const captured = collect(events, 'outreach.delivery.changed');
    const t = await makeTemplate(db, tenantA.id);
    await arm(db, tenantA.id);
    const transport = new SimulatorTransport();
    const s = await queueSend(db, events, tenantA.id, 'owner', { templateId: t.id, to: RECIP, vars: { name: 'Jane' }, consent: true });
    const r = await sendPending(db, events, tenantA.id, NOW_OPEN, { transport });
    expect(r.sent).toEqual([s.id]);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].to).toBe(RECIP);

    const sends = await listSends(db, tenantA.id, { limit: 50, offset: 0 });
    expect(sends[0].status).toBe('sent');
    expect(sends[0].provider_message_id).toBe('sim-msg-1');
    expect(sends[0].sent_at).toBe(NOW_OPEN);

    // delivery events: queued then sent, ids-only payload (NO PII).
    const states = captured.map((e) => (e.payload as any).state);
    expect(states).toEqual(['queued', 'sent']);
    for (const e of captured) {
      expect(Object.keys(e.payload as object).sort()).toEqual(['sendId', 'state', 'v']);
      expect(JSON.stringify(e.payload)).not.toContain('@');
      expect(JSON.stringify(e.payload)).not.toContain(RECIP);
    }
  });

  it('provider failure → status failed + failed event', async () => {
    const { db, events, tenantA } = await setup();
    const t = await makeTemplate(db, tenantA.id);
    await arm(db, tenantA.id);
    const transport = new SimulatorTransport().failFor(RECIP);
    await queueSend(db, events, tenantA.id, 'owner', { templateId: t.id, to: RECIP, vars: { name: 'Jane' }, consent: true });
    const r = await sendPending(db, events, tenantA.id, NOW_OPEN, { transport });
    expect(r.failed).toHaveLength(1);
    const sends = await listSends(db, tenantA.id, { limit: 50, offset: 0 });
    expect(sends[0].status).toBe('failed');
  });

  it('replay-safe: a sent row is never re-sent on a second drain', async () => {
    const { db, events, tenantA } = await setup();
    const t = await makeTemplate(db, tenantA.id);
    await arm(db, tenantA.id);
    const transport = new SimulatorTransport();
    await queueSend(db, events, tenantA.id, 'owner', { templateId: t.id, to: RECIP, vars: { name: 'Jane' }, consent: true });
    await sendPending(db, events, tenantA.id, NOW_OPEN, { transport });
    await sendPending(db, events, tenantA.id, NOW_OPEN, { transport });
    expect(transport.sent).toHaveLength(1);
  });

  it('audits the send', async () => {
    const { db, events, tenantA } = await setup();
    const t = await makeTemplate(db, tenantA.id);
    await arm(db, tenantA.id);
    const s = await queueSend(db, events, tenantA.id, 'owner', { templateId: t.id, to: RECIP, vars: { name: 'Jane' }, consent: true });
    await sendPending(db, events, tenantA.id, NOW_OPEN, { transport: new SimulatorTransport() });
    const entries = await listAuditEntries(asCoreDb(db as unknown as Kysely<OutreachDatabase>), tenantA.id, 'outreach.send', s.id);
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('outreach.send.queued');
    expect(actions).toContain('outreach.send.sent');
  });
});

describe('tenant isolation (denial)', () => {
  it('a drain for tenant B never touches tenant A queued sends', async () => {
    const { db, events, tenantA, tenantB } = await setup();
    const t = await makeTemplate(db, tenantA.id);
    await arm(db, tenantA.id);
    await queueSend(db, events, tenantA.id, 'owner', { templateId: t.id, to: RECIP, vars: { name: 'Jane' }, consent: true });
    const r = await sendPending(db, events, tenantB.id, NOW_OPEN, { transport: new SimulatorTransport() });
    expect(r.processed).toBe(0);
    const aSends = await listSends(db, tenantA.id, { limit: 50, offset: 0 });
    expect(aSends[0].status).toBe('queued'); // untouched
    const bSends = await listSends(db, tenantB.id, { limit: 50, offset: 0 });
    expect(bSends).toEqual([]);
  });
});
