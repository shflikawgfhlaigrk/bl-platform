import { describe, expect, it } from 'vitest';
import { setup, headers, HealthService, okTester } from './helpers';
import type { BackupProvider } from '../src/index';

describe('router — tenant middleware', () => {
  it('400 without x-tenant-id header', async () => {
    const { app } = await setup();
    const res = await app.request('/credentials');
    expect(res.status).toBe(400);
  });

  it('404 for an unknown tenant', async () => {
    const { app } = await setup();
    const res = await app.request('/credentials', { headers: { 'x-tenant-id': 'nope' } });
    expect(res.status).toBe(404);
  });
});

describe('router — honest 501 when a capability is unwired', () => {
  it('health run/history are 501 without a health service', async () => {
    const { app, tenantA } = await setup();
    expect((await app.request('/health/run', { method: 'POST', headers: headers(tenantA) })).status).toBe(501);
    expect((await app.request('/health/runs', { headers: headers(tenantA) })).status).toBe(501);
  });

  it('backup routes are 501 without a provider', async () => {
    const { app, tenantA } = await setup();
    expect((await app.request('/backups/run', { method: 'POST', headers: headers(tenantA) })).status).toBe(501);
    expect((await app.request('/backups/prune', { method: 'POST', headers: headers(tenantA), body: '{}' })).status).toBe(501);
  });
});

describe('router — health run through the endpoint', () => {
  it('runs registered probes and returns a report', async () => {
    const { app, tenantA } = await setup(({ db }) => {
      const health = new HealthService(db);
      health.register({ name: 'db', critical: 1, run: () => ({ ok: true }) });
      return { healthService: health };
    });
    const res = await app.request('/health/run', { method: 'POST', headers: headers(tenantA) });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).data.overallOk).toBe(true);
  });
});

describe('router — full backup flow with a fake provider', () => {
  it('runs a backup and lists it as verified', async () => {
    const provider: BackupProvider = {
      async create() {
        return { path: '/tmp/x.db', bytes: 10, sha256: 'abc' };
      },
      async restoreToTemp() {
        return { tempPath: '/tmp/x-restore' };
      },
      async integrityCheck() {
        return { ok: true };
      },
    };
    const { app, tenantA } = await setup({ backupProvider: provider });
    const run = await app.request('/backups/run', {
      method: 'POST',
      headers: headers(tenantA, 'owner1'),
      body: JSON.stringify({ destDir: '/tmp/b' }),
    });
    expect(run.status).toBe(201);
    expect(((await run.json()) as any).data.status).toBe('verified');

    const list = await app.request('/backups', { headers: headers(tenantA) });
    expect(((await list.json()) as any).data).toHaveLength(1);
  });
});

describe('router — diagnostics + audit export downloads', () => {
  it('serves a redacted diagnostics bundle', async () => {
    const { app, tenantA } = await setup({
      diagnostics: { version: '9.9.9', migrations: ['admin.0001_credentials'] },
    });
    // Configure settings first so the bundle has business identity.
    await app.request('/settings', {
      method: 'PUT',
      headers: headers(tenantA, 'owner1'),
      body: JSON.stringify({
        name: 'Mags',
        postalAddress: { line1: '1 Barn', city: 'Ocala', region: 'FL', postalCode: '34470', country: 'US' },
        timezone: 'America/New_York',
      }),
    });
    const res = await app.request('/diagnostics', { headers: headers(tenantA) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('diagnostics.json');
    const bundle = (await res.json()) as any;
    expect(bundle.version).toBe('9.9.9');
    expect(bundle.settings.name).toBe('Mags');
  });

  it('serves an audit CSV after a mutation', async () => {
    const { app, tenantA } = await setup({ tester: okTester });
    await app.request('/credentials', {
      method: 'POST',
      headers: headers(tenantA, 'owner1'),
      body: JSON.stringify({ name: 'M', provider: 'smtp', payload: { host: 'h', password: 'p' } }),
    });
    const res = await app.request('/audit/export', { headers: headers(tenantA) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const csv = await res.text();
    expect(csv).toContain('admin.credential.saved');
    // The saved secret never appears in the audit export.
    expect(csv).not.toContain('password');
  });
});
