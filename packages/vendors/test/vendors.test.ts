import { describe, expect, it } from 'vitest';
import { listAuditEntries } from '@blacklabel/core';
import { asCoreDb } from '@blacklabel/core';
import { setup, headers } from './helpers';

describe('vendors CRUD + tenancy', () => {
  it('creates, reads, lists, updates, archives a vendor and audits it', async () => {
    const { app, db, tenantA } = await setup();

    const created = await app.request('/vendors', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({
        name: 'Ellany Equine',
        contacts: [{ name: 'Sam', email: 'sam@ellany.example' }],
        address: { city: 'Ocala', region: 'FL' },
        paymentTerms: 'Net 30',
        leadTimeDays: 7,
        minimumOrderCents: 25000,
        freeFreightThresholdCents: 50000,
      }),
    });
    expect(created.status).toBe(201);
    const { data: vendor } = (await created.json() as any);
    expect(vendor.name).toBe('Ellany Equine');
    expect(vendor.status).toBe('active');
    expect(JSON.parse(vendor.contacts)).toEqual([{ name: 'Sam', email: 'sam@ellany.example' }]);

    const got = await app.request(`/vendors/${vendor.id}`, { headers: headers(tenantA) });
    expect(got.status).toBe(200);

    const patched = await app.request(`/vendors/${vendor.id}`, {
      method: 'PATCH',
      headers: headers(tenantA),
      body: JSON.stringify({ leadTimeDays: 10 }),
    });
    expect(((await patched.json() as any)).data.lead_time_days).toBe(10);

    const archived = await app.request(`/vendors/${vendor.id}/archive`, {
      method: 'POST',
      headers: headers(tenantA),
    });
    expect(((await archived.json() as any)).data.status).toBe('archived');

    const audits = await listAuditEntries(
      asCoreDb(db),
      tenantA.id,
      'vendors.vendor',
      vendor.id,
    );
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('vendors.vendor.created');
    expect(actions).toContain('vendors.vendor.updated');
  });

  it('denies cross-tenant reads/updates and leaves A untouched', async () => {
    const { app, tenantA, tenantB } = await setup();
    const created = await app.request('/vendors', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ name: 'Alpha-Only Vendor' }),
    });
    const { data: vendor } = (await created.json() as any);

    // Tenant B cannot see it.
    const bRead = await app.request(`/vendors/${vendor.id}`, { headers: headers(tenantB) });
    expect(bRead.status).toBe(404);

    // Tenant B list is empty.
    const bList = await app.request('/vendors', { headers: headers(tenantB) });
    expect(((await bList.json() as any)).data).toEqual([]);

    // Tenant B cannot update.
    const bUpdate = await app.request(`/vendors/${vendor.id}`, {
      method: 'PATCH',
      headers: headers(tenantB),
      body: JSON.stringify({ name: 'hijacked' }),
    });
    expect(bUpdate.status).toBe(404);

    // A is untouched.
    const aRead = await app.request(`/vendors/${vendor.id}`, { headers: headers(tenantA) });
    expect(((await aRead.json() as any)).data.name).toBe('Alpha-Only Vendor');
  });

  it('rejects a missing x-tenant-id header', async () => {
    const { app } = await setup();
    const res = await app.request('/vendors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(400);
  });
});
