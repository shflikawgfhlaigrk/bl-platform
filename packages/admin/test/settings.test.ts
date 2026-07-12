import { describe, expect, it } from 'vitest';
import { listAuditEntries, asCoreDb } from '@blacklabel/core';
import { setup, headers } from './helpers';
import { SettingsService } from '../src/settings';

const validSettings = {
  name: 'Mags Tack & Supply',
  postalAddress: {
    line1: '123 Barn Rd',
    city: 'Ocala',
    region: 'FL',
    postalCode: '34470',
    country: 'US',
  },
  timezone: 'America/New_York',
  quietHours: { start: '21:00', end: '08:00' },
};

describe('settings — validate + upsert singleton', () => {
  it('returns null before configuration (setup state)', async () => {
    const { db, tenantA } = await setup();
    const svc = new SettingsService(db);
    expect(await svc.get(tenantA.id)).toBeNull();
  });

  it('creates then updates the single row and audits', async () => {
    const { db, tenantA } = await setup();
    const svc = new SettingsService(db);
    await svc.update(tenantA.id, 'owner1', validSettings);
    let stored = await svc.get(tenantA.id);
    expect(stored!.name).toBe('Mags Tack & Supply');

    await svc.update(tenantA.id, 'owner1', { ...validSettings, name: 'Renamed' });
    stored = await svc.get(tenantA.id);
    expect(stored!.name).toBe('Renamed');

    // Still exactly one row.
    const rows = await db.selectFrom('admin_settings').selectAll().where('tenant_id', '=', tenantA.id).execute();
    expect(rows).toHaveLength(1);

    const audits = await listAuditEntries(asCoreDb(db), tenantA.id, 'admin.settings', tenantA.id);
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects invalid settings (bad quiet hours)', async () => {
    const { db, tenantA } = await setup();
    const svc = new SettingsService(db);
    await expect(
      svc.update(tenantA.id, 'owner1', { ...validSettings, quietHours: { start: '25:00', end: '08:00' } }),
    ).rejects.toThrow();
  });

  it('is tenant-scoped through the router', async () => {
    const { app, tenantA, tenantB } = await setup();
    await app.request('/settings', {
      method: 'PUT',
      headers: headers(tenantA, 'owner1'),
      body: JSON.stringify(validSettings),
    });
    const bGet = await app.request('/settings', { headers: headers(tenantB) });
    expect(((await bGet.json()) as any).data).toBeNull();
  });
});
