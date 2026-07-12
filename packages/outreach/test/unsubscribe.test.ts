import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { makeSuppressions, setup } from './helpers';
import {
  createTemplate,
  getOrCreateSettings,
  processUnsubscribe,
  queueSend,
  tokenForSend,
  listSends,
  updateSettings,
} from '../src/service';
import type { OutreachDatabase } from '../src/schema';

async function seed(db: Kysely<OutreachDatabase>, events: any, tenantId: string) {
  await updateSettings(db, tenantId, 'owner', { armed: true, postalAddress: '123 Barn Rd', fromEmail: 'shop@magstack.test', providerCredentialRef: 'c' });
  const t = await createTemplate(db, tenantId, 'owner', {
    name: 'Hello',
    kind: 'transactional',
    subjectTemplate: 'Hi {{name}}',
    bodyTemplate: 'Hello {{name}}',
    requiredPlaceholders: ['name'],
  });
  return t;
}

describe('unsubscribe', () => {
  it('token round-trips, fires the suppression callback, and blocks queued sends', async () => {
    const sup = makeSuppressions();
    const { db, events, tenantA } = await setup();
    const t = await seed(db, events, tenantA.id);
    const s1 = await queueSend(db, events, tenantA.id, 'owner', { templateId: t.id, to: 'jane@buyer.test', vars: { name: 'Jane' }, consent: true });
    // A second queued message to the same address, different subject → still queued.
    const t2 = await createTemplate(db, tenantA.id, 'owner', {
      name: 'Followup',
      kind: 'transactional',
      subjectTemplate: 'Following up {{name}}',
      bodyTemplate: 'Hi again {{name}}',
      requiredPlaceholders: ['name'],
    });
    await queueSend(db, events, tenantA.id, 'owner', { templateId: t2.id, to: 'jane@buyer.test', vars: { name: 'Jane' }, consent: true });

    const settings = await getOrCreateSettings(db, tenantA.id);
    const token = tokenForSend(s1.id, settings.unsubscribe_secret);
    const res = await processUnsubscribe(db, events, tenantA.id, s1.id, token, { suppress: sup.suppress });
    expect(res.ok).toBe(true);
    expect(res.email).toBe('jane@buyer.test');
    expect(res.blockedQueued).toBe(2); // both queued messages to jane
    expect(sup.isSuppressed(tenantA.id, 'jane@buyer.test')).toBe(true);

    const sends = await listSends(db, tenantA.id, { limit: 50, offset: 0 });
    expect(sends.every((s) => s.status === 'blocked' && s.blocked_reason === 'suppressed')).toBe(true);
  });

  it('rejects an invalid or forged token', async () => {
    const { db, events, tenantA } = await setup();
    const t = await seed(db, events, tenantA.id);
    const s1 = await queueSend(db, events, tenantA.id, 'owner', { templateId: t.id, to: 'jane@buyer.test', vars: { name: 'Jane' }, consent: true });
    await expect(processUnsubscribe(db, events, tenantA.id, s1.id, 'not-a-real-token', {})).rejects.toMatchObject({ status: 400 });
  });

  it('is reachable through the public router endpoint', async () => {
    const { app, db, tenantA, events } = await setup();
    const t = await seed(db, events, tenantA.id);
    const s1 = await queueSend(db, events, tenantA.id, 'owner', { templateId: t.id, to: 'jane@buyer.test', vars: { name: 'Jane' }, consent: true });
    const settings = await getOrCreateSettings(db, tenantA.id);
    const token = tokenForSend(s1.id, settings.unsubscribe_secret);
    const res = await app.request(`/unsubscribe?send=${s1.id}&token=${encodeURIComponent(token)}`, {
      headers: { 'x-tenant-id': tenantA.id },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.ok).toBe(true);
  });
});
