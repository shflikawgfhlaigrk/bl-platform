import { describe, expect, it } from 'vitest';
import { EVENT_NAME_PATTERN } from '@blacklabel/core';
import { createInstallation, headers, setup } from './helpers';

describe('client-ops router installations', () => {
  it('serves the catalog and performs installation create/read/update/archive with expanded records', async () => {
    const { app, db, tenantA, events } = await setup();
    const seen: string[] = [];
    events.on('*', (event) => {
      seen.push(event.type);
    });

    const catalogResponse = await app.request('/catalog', { headers: headers(tenantA) });
    expect(catalogResponse.status).toBe(200);
    const catalog = ((await catalogResponse.json()) as any).data;
    expect(catalog.services).toHaveLength(8);
    expect(catalog.verticalPacks).toHaveLength(7);

    const created = await createInstallation(app, tenantA, {
      name: 'Alpha Operating System',
      engagementModelId: 'workflow-automation-sprint',
    });
    expect(created.status).toBe('onboarding');
    expect(created.name).toBe('Alpha Operating System');
    expect(created.workflows.length).toBeGreaterThan(0);
    expect(created.connectors.length).toBeGreaterThan(0);
    expect(created.onboarding.length).toBeGreaterThan(0);
    expect(created.manifestSha256).toMatch(/^[a-f0-9]{64}$/);

    const list = await app.request('/installations', { headers: headers(tenantA) });
    const listBody = (await list.json()) as any;
    expect(listBody.data.map((item: any) => item.id)).toEqual([created.id]);
    expect(listBody).toMatchObject({ limit: 50, offset: 0 });

    const get = await app.request(`/installations/${created.id}`, { headers: headers(tenantA) });
    expect(((await get.json()) as any).data.catalogId).toBe('workflow-operating-system');

    const update = await app.request(`/installations/${created.id}`, {
      method: 'PATCH', headers: headers(tenantA), body: JSON.stringify({ name: 'Alpha Ops' }),
    });
    expect(update.status).toBe(200);
    expect(((await update.json()) as any).data.name).toBe('Alpha Ops');

    const archive = await app.request(`/installations/${created.id}`, {
      method: 'DELETE', headers: headers(tenantA),
    });
    const archived = ((await archive.json()) as any).data;
    expect(archived.status).toBe('archived');
    expect(archived.workflows.every((item: any) => !item.enabled && item.status === 'paused')).toBe(true);

    expect(seen.every((type) => EVENT_NAME_PATTERN.test(type))).toBe(true);
    expect(seen).toEqual(expect.arrayContaining([
      'client_ops.installation.created', 'client_ops.installation.updated', 'client_ops.installation.archived',
    ]));
    const auditRows = await db.selectFrom('audit_log').selectAll()
      .where('tenant_id', '=', tenantA.id).orderBy('created_at').orderBy('id').execute();
    expect(auditRows.map((row) => row.action)).toEqual(expect.arrayContaining(seen));
  });

  it('requires a tenant and denies tenant B read, update, and delete access to tenant A data', async () => {
    const { app, tenantA, tenantB } = await setup();
    const created = await createInstallation(app, tenantA);

    expect((await app.request('/installations')).status).toBe(400);
    expect((await app.request('/installations', { headers: { 'x-tenant-id': 'missing' } })).status).toBe(404);
    expect((await app.request(`/installations/${created.id}`, { headers: headers(tenantB) })).status).toBe(404);

    const listB = await app.request('/installations', { headers: headers(tenantB) });
    expect(((await listB.json()) as any).data).toEqual([]);

    const updateB = await app.request(`/installations/${created.id}`, {
      method: 'PATCH', headers: headers(tenantB), body: JSON.stringify({ name: 'Cross tenant' }),
    });
    expect(updateB.status).toBe(404);
    const deleteB = await app.request(`/installations/${created.id}`, { method: 'DELETE', headers: headers(tenantB) });
    expect(deleteB.status).toBe(404);

    for (const path of [
      `/installations/${created.id}/workflows/${created.workflows[0].id}`,
      `/installations/${created.id}/connectors/${created.connectors[0].id}`,
      `/installations/${created.id}/onboarding/${created.onboarding[0].id}`,
    ]) {
      const response = await app.request(path, {
        method: 'PATCH', headers: headers(tenantB),
        body: JSON.stringify(path.includes('/workflows/') ? { enabled: false } : path.includes('/connectors/') ? { status: 'connected' } : { status: 'completed' }),
      });
      expect(response.status).toBe(404);
    }

    const stillA = await app.request(`/installations/${created.id}`, { headers: headers(tenantA) });
    expect(((await stillA.json()) as any).data.name).toBe(created.name);
  });

  it('stores connector credential references but recursively rejects secret material', async () => {
    const { app, db, tenantA } = await setup();
    const created = await createInstallation(app, tenantA);
    const binding = created.connectors[0];
    const safe = await app.request(`/installations/${created.id}/connectors/${binding.id}`, {
      method: 'PATCH', headers: headers(tenantA),
      body: JSON.stringify({ credentialRef: 'admin-credential:cred_123', metadata: { account: { id: 'acct_1', region: 'us' } } }),
    });
    expect(safe.status).toBe(200);
    expect(((await safe.json()) as any).data).toMatchObject({
      credentialRef: 'admin-credential:cred_123',
      metadata: { account: { id: 'acct_1', region: 'us' } },
    });

    for (const unsafe of [
      { metadata: { apiKey: 'plaintext' } },
      { metadata: { nested: [{ access_token: 'plaintext' }] } },
      { health: { authorization: 'Bearer plaintext' } },
      { metadata: { connector: { privateKey: 'plaintext' } } },
      { metadata: { connector: { 'x-api-key': 'plaintext' } } },
      { metadata: { connector: { private_key_pem: 'plaintext' } } },
    ]) {
      const response = await app.request(`/installations/${created.id}/connectors/${binding.id}`, {
        method: 'PATCH', headers: headers(tenantA), body: JSON.stringify(unsafe),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as any).error.details.use).toBe('credentialRef');
    }

    const persisted = await db.selectFrom('client_ops_connector_bindings').selectAll()
      .where('tenant_id', '=', tenantA.id).where('id', '=', binding.id).executeTakeFirstOrThrow();
    expect(persisted.credential_ref).toBe('admin-credential:cred_123');
    expect(persisted.metadata_json).not.toContain('plaintext');
    expect(persisted.health_json ?? '').not.toContain('plaintext');
  });
});
