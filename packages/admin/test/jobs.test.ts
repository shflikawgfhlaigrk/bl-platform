import { describe, expect, it } from 'vitest';
import { listAuditEntries, asCoreDb } from '@blacklabel/core';
import { setup, headers } from './helpers';
import { recordJob, listJobs } from '../src/jobs';

describe('jobs — recordJob wrapper', () => {
  it('records a done job with detail', async () => {
    const { db, tenantA } = await setup();
    const { jobId, result } = await recordJob(db, tenantA.id, 'owner1', 'import', async () => ({
      result: 42,
      detail: { rows: 10 },
    }));
    expect(result).toBe(42);
    const jobs = await listJobs(db, tenantA.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(jobId);
    expect(jobs[0].status).toBe('done');
    expect(JSON.parse(jobs[0].detail!)).toEqual({ rows: 10 });
    expect(jobs[0].finished_at).not.toBeNull();

    const audits = await listAuditEntries(asCoreDb(db), tenantA.id, 'admin.job', jobId);
    expect(audits).toHaveLength(1);
  });

  it('records a failed job and rethrows', async () => {
    const { db, tenantA } = await setup();
    await expect(
      recordJob(db, tenantA.id, 'owner1', 'backup', async () => {
        throw new Error('backup blew up');
      }),
    ).rejects.toThrow('backup blew up');
    const jobs = await listJobs(db, tenantA.id);
    expect(jobs[0].status).toBe('failed');
    expect(JSON.parse(jobs[0].detail!).error).toContain('backup blew up');
  });

  it('is tenant-scoped and visible via the router', async () => {
    const { db, app, tenantA, tenantB } = await setup();
    await recordJob(db, tenantA.id, 'owner1', 'health', async () => ({ result: null }));
    const aList = await app.request('/jobs', { headers: headers(tenantA) });
    expect(((await aList.json()) as any).data).toHaveLength(1);
    const bList = await app.request('/jobs', { headers: headers(tenantB) });
    expect(((await bList.json()) as any).data).toHaveLength(0);
  });
});
