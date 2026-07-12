import { describe, expect, it } from 'vitest';
import { listAuditEntries, asCoreDb, type PlatformEvent } from '@blacklabel/core';
import { setup, headers, TEST_KEY, okTester, failTester } from './helpers';
import { CredentialsService } from '../src/credentials';

const SECRET = 'hunter2-super-secret';
const smtpPayload = {
  host: 'smtp.mags.com',
  port: 587,
  user: 'ops@mags.com',
  password: SECRET,
};

describe('credentials — save, mask, and never leak plaintext', () => {
  it('saves masked and the masked list NEVER contains the plaintext', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request('/credentials', {
      method: 'POST',
      headers: headers(tenantA, 'owner1'),
      body: JSON.stringify({ name: 'Mailer', provider: 'smtp', payload: smtpPayload }),
    });
    expect(res.status).toBe(201);
    const saved = (await res.json()) as any;
    expect(saved.data.status).toBe('untested');
    expect(saved.data.fieldsMasked.password).toBe('***');
    expect(saved.data.fieldsMasked.user).toBe('o***@mags.com');

    const listRes = await app.request('/credentials', { headers: headers(tenantA) });
    const listText = await listRes.text();
    // Serialize the WHOLE response and prove the secret does not appear.
    expect(new RegExp(SECRET).test(listText)).toBe(false);
    expect(listText).not.toContain('payload_encrypted');
  });

  it('rejects an unknown provider', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request('/credentials', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ name: 'x', provider: 'ftp', payload: {} }),
    });
    expect(res.status).toBe(400);
  });
});

describe('credentials — tenant isolation', () => {
  it('tenant B cannot see or mutate tenant A credentials', async () => {
    const { app, tenantA, tenantB } = await setup({ tester: okTester });
    const created = await app.request('/credentials', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ name: 'Mailer', provider: 'smtp', payload: smtpPayload }),
    });
    const id = ((await created.json()) as any).data.id;

    // B's list is empty.
    const bList = await app.request('/credentials', { headers: headers(tenantB) });
    expect(((await bList.json()) as any).data).toHaveLength(0);

    // B cannot rotate A's credential.
    const bRotate = await app.request(`/credentials/${id}/rotate`, {
      method: 'POST',
      headers: headers(tenantB),
      body: JSON.stringify({ payload: { host: 'x' } }),
    });
    expect(bRotate.status).toBe(404);

    // B cannot delete A's credential.
    const bDel = await app.request(`/credentials/${id}`, {
      method: 'DELETE',
      headers: headers(tenantB),
    });
    expect(bDel.status).toBe(404);

    // A's credential is untouched.
    const aList = await app.request('/credentials', { headers: headers(tenantA) });
    expect(((await aList.json()) as any).data).toHaveLength(1);
  });
});

describe('credentials — decrypt is audited with a purpose', () => {
  it('get() returns plaintext and writes a read audit carrying the purpose', async () => {
    const { db, events, tenantA } = await setup();
    const svc = new CredentialsService(db, events, TEST_KEY);
    const saved = await svc.save(tenantA.id, 'owner1', {
      name: 'Mailer',
      provider: 'smtp',
      payload: smtpPayload,
    });

    const dec = await svc.get(tenantA.id, 'owner1', saved.id, 'send nightly digest');
    expect(dec.payload.password).toBe(SECRET);

    const audits = await listAuditEntries(asCoreDb(db), tenantA.id, 'admin.credential', saved.id);
    const read = audits.find((a) => a.action === 'admin.credential.read');
    expect(read).toBeDefined();
    expect(JSON.parse(read!.diff!)).toEqual({ purpose: 'send nightly digest' });
  });

  it('get() refuses an empty purpose', async () => {
    const { db, events, tenantA } = await setup();
    const svc = new CredentialsService(db, events, TEST_KEY);
    const saved = await svc.save(tenantA.id, 'owner1', {
      name: 'Mailer',
      provider: 'smtp',
      payload: smtpPayload,
    });
    await expect(svc.get(tenantA.id, 'owner1', saved.id, '   ')).rejects.toThrow();
  });
});

describe('credentials — rotation chain', () => {
  it('rotate writes a new row linked via rotated_from and archives the old', async () => {
    const { db, events, tenantA } = await setup();
    const svc = new CredentialsService(db, events, TEST_KEY);
    const first = await svc.save(tenantA.id, 'owner1', {
      name: 'Mailer',
      provider: 'smtp',
      payload: smtpPayload,
    });
    const second = await svc.rotate(tenantA.id, 'owner1', first.id, {
      ...smtpPayload,
      password: 'rotated-secret',
    });
    expect(second.rotatedFrom).toBe(first.id);
    expect(second.archivedAt).toBeNull();

    // Old is archived, hidden from the default list, shown with ?includeArchived.
    const active = await svc.list(tenantA.id);
    expect(active.map((c) => c.id)).toEqual([second.id]);
    const all = await svc.list(tenantA.id, { limit: 50, offset: 0 }, { includeArchived: true });
    const old = all.find((c) => c.id === first.id);
    expect(old!.archivedAt).not.toBeNull();

    // New payload decrypts to the rotated secret.
    const dec = await svc.get(tenantA.id, 'owner1', second.id, 'verify rotation');
    expect(dec.payload.password).toBe('rotated-secret');
  });
});

describe('credentials — testConnection records the result (injected tester)', () => {
  it('records ok + last_tested_at with a passing tester', async () => {
    const { db, events, tenantA } = await setup();
    const svc = new CredentialsService(db, events, TEST_KEY);
    const saved = await svc.save(tenantA.id, 'owner1', {
      name: 'Mailer',
      provider: 'smtp',
      payload: smtpPayload,
    });
    const res = await svc.testConnection(tenantA.id, 'owner1', saved.id, okTester);
    expect(res.status).toBe('ok');
    const after = (await svc.list(tenantA.id))[0];
    expect(after.status).toBe('ok');
    expect(after.lastTestedAt).not.toBeNull();
  });

  it('records failed when the tester rejects', async () => {
    const { db, events, tenantA } = await setup();
    const svc = new CredentialsService(db, events, TEST_KEY);
    const saved = await svc.save(tenantA.id, 'owner1', {
      name: 'Mailer',
      provider: 'imap',
      payload: smtpPayload,
    });
    const res = await svc.testConnection(tenantA.id, 'owner1', saved.id, failTester);
    expect(res.status).toBe('failed');
    expect((await svc.list(tenantA.id))[0].status).toBe('failed');
  });

  it('POST /credentials/:id/test is 501 when no tester is wired', async () => {
    const { app, tenantA } = await setup(); // no tester
    const saved = await app.request('/credentials', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ name: 'Mailer', provider: 'smtp', payload: smtpPayload }),
    });
    const id = ((await saved.json()) as any).data.id;
    const test = await app.request(`/credentials/${id}/test`, {
      method: 'POST',
      headers: headers(tenantA),
    });
    expect(test.status).toBe(501);
  });
});

describe('credentials — expiry watch', () => {
  it('lists soon-to-expire creds and emits admin.credential.expiring', async () => {
    const { db, events, tenantA } = await setup();
    const svc = new CredentialsService(db, events, TEST_KEY);
    await svc.save(tenantA.id, 'owner1', {
      name: 'Expiring soon',
      provider: 'square',
      payload: { token: 'abc' },
      expiresAt: '2026-07-20T00:00:00.000Z',
    });
    await svc.save(tenantA.id, 'owner1', {
      name: 'Far future',
      provider: 'stripe',
      payload: { token: 'def' },
      expiresAt: '2027-01-01T00:00:00.000Z',
    });

    const seen: PlatformEvent[] = [];
    events.on('admin.credential.expiring', (e) => {
      seen.push(e);
    });

    const now = '2026-07-12T00:00:00.000Z';
    const soon = await svc.watchExpiringCredentials(tenantA.id, now, 14);
    expect(soon.map((c) => c.name)).toEqual(['Expiring soon']);
    expect(seen).toHaveLength(1);
    expect((seen[0].payload as any).v).toBe(1);
    expect((seen[0].payload as any).credentialId).toBe(soon[0].id);
  });
});

describe('credentials — delete disposition', () => {
  it('hard-deletes a never-used credential, archives a used one', async () => {
    const { db, events, tenantA } = await setup();
    const svc = new CredentialsService(db, events, TEST_KEY);
    const fresh = await svc.save(tenantA.id, 'owner1', {
      name: 'Never used',
      provider: 'custom',
      payload: { token: 'x' },
    });
    const del = await svc.delete(tenantA.id, 'owner1', fresh.id);
    expect(del.disposition).toBe('deleted');
    expect(await svc.list(tenantA.id, { limit: 50, offset: 0 }, { includeArchived: true })).toHaveLength(0);

    const used = await svc.save(tenantA.id, 'owner1', {
      name: 'Used',
      provider: 'custom',
      payload: { token: 'y' },
    });
    await svc.testConnection(tenantA.id, 'owner1', used.id, okTester);
    const del2 = await svc.delete(tenantA.id, 'owner1', used.id);
    expect(del2.disposition).toBe('archived');
    const all = await svc.list(tenantA.id, { limit: 50, offset: 0 }, { includeArchived: true });
    expect(all.find((c) => c.id === used.id)!.archivedAt).not.toBeNull();
  });
});
