import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import {
  HealthService,
  backupFreshness,
  importFreshness,
  outboxDepth,
  diskFree,
} from '../src/health';

describe('health — probe isolation', () => {
  it('a throwing probe is not-ok and does not starve the others', async () => {
    const { db, tenantA } = await setup();
    const svc = new HealthService(db);
    svc.register({ name: 'db', critical: 1, run: () => ({ ok: true, detail: 'connected' }) });
    svc.register({
      name: 'boom',
      critical: 1,
      run: () => {
        throw new Error('probe exploded');
      },
    });
    svc.register({ name: 'disk', critical: 0, run: () => ({ ok: true }) });

    const report = await svc.runHealth(tenantA.id, 'owner1');
    expect(report.total).toBe(3);
    expect(report.okCount).toBe(2);
    expect(report.overallOk).toBe(false);
    expect(report.criticalFailures).toBe(1);
    const boom = report.results.find((r) => r.name === 'boom')!;
    expect(boom.ok).toBe(false);
    expect((boom.detail as any).error).toContain('probe exploded');

    // Persisted run + rows are readable.
    const runs = await svc.listRuns(tenantA.id);
    expect(runs).toHaveLength(1);
    const rows = await svc.getRunRows(tenantA.id, report.runId);
    expect(rows).toHaveLength(3);
  });

  it('is tenant-scoped: another tenant sees no runs', async () => {
    const { db, tenantA, tenantB } = await setup();
    const svc = new HealthService(db);
    svc.register({ name: 'db', critical: 1, run: () => ({ ok: true }) });
    await svc.runHealth(tenantA.id, 'owner1');
    expect(await svc.listRuns(tenantB.id)).toHaveLength(0);
  });
});

describe('health — builtin probe helpers (pure math)', () => {
  const now = '2026-07-12T12:00:00.000Z';

  it('backupFreshness', () => {
    expect(backupFreshness({ lastBackupAt: '2026-07-12T06:00:00.000Z', maxAgeHours: 24, now }).ok).toBe(true);
    expect(backupFreshness({ lastBackupAt: '2026-07-10T06:00:00.000Z', maxAgeHours: 24, now }).ok).toBe(false);
    expect(backupFreshness({ lastBackupAt: null, maxAgeHours: 24, now }).ok).toBe(false);
  });

  it('importFreshness', () => {
    expect(importFreshness({ lastImportAt: '2026-07-12T11:00:00.000Z', maxAgeHours: 6, now }).ok).toBe(true);
    expect(importFreshness({ lastImportAt: '2026-07-11T00:00:00.000Z', maxAgeHours: 6, now }).ok).toBe(false);
  });

  it('outboxDepth', () => {
    expect(outboxDepth({ pending: 5, dead: 0, thresholds: { pending: 10, dead: 0 } }).ok).toBe(true);
    expect(outboxDepth({ pending: 5, dead: 1, thresholds: { pending: 10, dead: 0 } }).ok).toBe(false);
    expect(outboxDepth({ pending: 11, dead: 0, thresholds: { pending: 10, dead: 0 } }).ok).toBe(false);
  });

  it('diskFree', () => {
    expect(diskFree({ bytesFree: 2_000_000, minBytes: 1_000_000 }).ok).toBe(true);
    expect(diskFree({ bytesFree: 500_000, minBytes: 1_000_000 }).ok).toBe(false);
  });
});
