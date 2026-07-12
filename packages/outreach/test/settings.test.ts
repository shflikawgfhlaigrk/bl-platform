import { describe, expect, it } from 'vitest';
import { listAuditEntries, asCoreDb } from '@blacklabel/core';
import { headers, setup } from './helpers';

describe('settings + gate report', () => {
  it('ships COLD: armed defaults to 0 and every send gate is closed', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request('/settings', { headers: headers(tenantA) });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as any;
    expect(data.armed).toBe(0);
    expect(data.postal_address).toBeNull();
    expect(data.provider_credential_ref).toBeNull();

    const gates = (await (await app.request('/settings/gates', { headers: headers(tenantA) })).json()) as any;
    expect(gates.data.canSend).toBe(false);
    const byGate = Object.fromEntries(gates.data.gates.map((g: any) => [g.gate, g.open]));
    expect(byGate).toEqual({ armed: false, postal_address: false, provider: false, from_email: false });
  });

  it('opens gates on update and reports canSend honestly', async () => {
    const { app, tenantA } = await setup();
    await app.request('/settings', {
      method: 'PUT',
      headers: headers(tenantA),
      body: JSON.stringify({
        armed: true,
        postalAddress: '123 Barn Rd',
        fromEmail: 'shop@magstack.test',
        providerCredentialRef: 'cred_1',
      }),
    });
    const gates = (await (await app.request('/settings/gates', { headers: headers(tenantA) })).json()) as any;
    expect(gates.data.canSend).toBe(true);
  });

  it('audits settings creation + update', async () => {
    const { app, db, tenantA } = await setup();
    await app.request('/settings', { headers: headers(tenantA) }); // creates
    await app.request('/settings', {
      method: 'PUT',
      headers: headers(tenantA),
      body: JSON.stringify({ armed: true }),
    });
    const settings = (await (await app.request('/settings', { headers: headers(tenantA) })).json()) as any;
    const entries = await listAuditEntries(asCoreDb(db), tenantA.id, 'outreach.settings', settings.data.id);
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('outreach.settings.created');
    expect(actions).toContain('outreach.settings.updated');
  });

  it('isolates settings per tenant (denial)', async () => {
    const { app, tenantA, tenantB } = await setup();
    await app.request('/settings', {
      method: 'PUT',
      headers: headers(tenantA),
      body: JSON.stringify({ armed: true, postalAddress: 'A address' }),
    });
    const b = (await (await app.request('/settings', { headers: headers(tenantB) })).json()) as any;
    expect(b.data.armed).toBe(0);
    expect(b.data.postal_address).toBeNull();
  });

  it('rejects a request with no tenant header', async () => {
    const { app } = await setup();
    const res = await app.request('/settings');
    expect(res.status).toBe(400);
  });
});
