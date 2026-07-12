import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { collect, setup } from './helpers';
import {
  approveCampaign,
  checkReplies,
  createCampaign,
  createTemplate,
  getCampaign,
  queueCampaign,
  sendPending,
  updateSettings,
  type AudienceEntry,
} from '../src/service';
import { SimulatorReader, SimulatorTransport } from '../src/adapters';
import type { OutreachDatabase } from '../src/schema';

const NOW = '2026-07-13T15:00:00.000Z';

async function arm(db: Kysely<OutreachDatabase>, tenantId: string) {
  return updateSettings(db, tenantId, 'owner', {
    armed: true,
    postalAddress: '123 Barn Rd',
    fromEmail: 'shop@magstack.test',
    providerCredentialRef: 'cred_1',
  });
}

describe('campaign approval gate', () => {
  it('a promotional campaign cannot be queued until approved', async () => {
    const { db, events, tenantA } = await setup();
    const t = await createTemplate(db, tenantA.id, 'owner', {
      name: 'Sale',
      kind: 'promotional',
      subjectTemplate: 'Sale for {{name}}',
      bodyTemplate: 'Deals {{name}}! {{unsubscribe_url}} {{postal_address}}',
      requiredPlaceholders: ['name'],
    });
    const c = await createCampaign(db, tenantA.id, 'owner', {
      name: 'Spring',
      templateId: t.id,
      audience: [{ email: 'a@buyer.test', vars: { name: 'A' }, consent: true }],
    });
    await expect(queueCampaign(db, events, tenantA.id, 'owner', c.id)).rejects.toMatchObject({ status: 409 });

    await approveCampaign(db, events, tenantA.id, 'owner', c.id);
    const res = await queueCampaign(db, events, tenantA.id, 'owner', c.id);
    expect(res.queued).toBe(1);
    expect((await getCampaign(db, tenantA.id, c.id))!.status).toBe('sending');
  });
});

describe('campaign counts', () => {
  it('tracks queued/duplicate/sent accurately', async () => {
    const { db, events, tenantA } = await setup();
    await arm(db, tenantA.id);
    const t = await createTemplate(db, tenantA.id, 'owner', {
      name: 'Hello',
      kind: 'transactional',
      subjectTemplate: 'Hi {{name}}',
      bodyTemplate: 'Hello {{name}}',
      requiredPlaceholders: ['name'],
    });
    const audience: AudienceEntry[] = [
      { email: 'a@buyer.test', vars: { name: 'A' }, consent: true },
      { email: 'a@buyer.test', vars: { name: 'A' }, consent: true }, // duplicate (same recipient+subject)
      { email: 'b@buyer.test', vars: { name: 'B' }, consent: true },
    ];
    const c = await createCampaign(db, tenantA.id, 'owner', { name: 'Welcome', templateId: t.id, audience });
    const res = await queueCampaign(db, events, tenantA.id, 'owner', c.id);
    expect(res).toMatchObject({ queued: 2, duplicates: 1 });

    let cm = (await getCampaign(db, tenantA.id, c.id))!;
    expect(cm.queued_count).toBe(2);
    expect(cm.suppressed_skipped_count).toBe(1);

    await sendPending(db, events, tenantA.id, NOW, { transport: new SimulatorTransport() });
    cm = (await getCampaign(db, tenantA.id, c.id))!;
    expect(cm.sent_count).toBe(2);
    expect(cm.queued_count).toBe(0);
    expect(cm.status).toBe('done');
  });
});

describe('bounce auto-pause (>10%, min 10 sends)', () => {
  it('pauses the campaign and emits outreach.campaign.paused', async () => {
    const { db, events, tenantA } = await setup();
    await arm(db, tenantA.id);
    const captured = collect(events, 'outreach.campaign.paused');
    const t = await createTemplate(db, tenantA.id, 'owner', {
      name: 'Hello',
      kind: 'transactional',
      subjectTemplate: 'Hi {{name}}',
      bodyTemplate: 'Hello {{name}}',
      requiredPlaceholders: ['name'],
    });
    const audience: AudienceEntry[] = Array.from({ length: 10 }, (_, i) => ({
      email: `buyer${i}@x.test`,
      vars: { name: `B${i}` },
      consent: true,
    }));
    const c = await createCampaign(db, tenantA.id, 'owner', { name: 'Blast', templateId: t.id, audience });
    await queueCampaign(db, events, tenantA.id, 'owner', c.id);
    await sendPending(db, events, tenantA.id, NOW, { transport: new SimulatorTransport() });
    expect((await getCampaign(db, tenantA.id, c.id))!.sent_count).toBe(10);

    // Two hard bounces = 20% > 10% threshold.
    const reader = new SimulatorReader();
    reader.pushBounce({ to: 'shop@magstack.test', recipient: 'buyer0@x.test', subject: 'Hi B0', providerRef: 'dsn-0', receivedAt: NOW });
    reader.pushBounce({ to: 'shop@magstack.test', recipient: 'buyer1@x.test', subject: 'Hi B1', providerRef: 'dsn-1', receivedAt: NOW });
    const rr = await checkReplies(db, events, tenantA.id, reader);
    expect(rr.bounces).toBe(2);

    const cm = (await getCampaign(db, tenantA.id, c.id))!;
    expect(cm.bounced_count).toBe(2);
    expect(cm.sent_count).toBe(8);
    expect(cm.status).toBe('paused_bounce');

    expect(captured).toHaveLength(1);
    const payload = captured[0].payload as any;
    expect(payload).toMatchObject({ v: 1, campaignId: c.id, reason: 'bounce' });
    expect(JSON.stringify(payload)).not.toContain('@'); // NO PII
  });
});
