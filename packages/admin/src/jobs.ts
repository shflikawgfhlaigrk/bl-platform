import type { Kysely } from 'kysely';
import { asCoreDb, audit, id, nowIso, type Pagination } from '@blacklabel/core';
import type { AdminDatabase, AdminJobRow, JobKind, JobStatus } from './schema';

type Db = Kysely<AdminDatabase>;

/**
 * Record an operational job around a unit of work. Inserts a "running" row,
 * runs `fn`, then flips to "done" (with the returned detail) or "failed" (with
 * the error). The one place the UI shows import/export/backup/health/publish
 * history.
 */
export async function recordJob<T>(
  db: Db,
  tenantId: string,
  actor: string,
  kind: JobKind,
  fn: () => Promise<{ result: T; detail?: unknown }>,
): Promise<{ jobId: string; result: T }> {
  const jobId = id();
  const startedAt = nowIso();
  const row: AdminJobRow = {
    id: jobId,
    tenant_id: tenantId,
    kind,
    status: 'running',
    detail: null,
    started_at: startedAt,
    finished_at: null,
    created_at: startedAt,
  };
  await db.insertInto('admin_jobs').values(row).execute();

  try {
    const { result, detail } = await fn();
    await finish(db, tenantId, jobId, 'done', detail);
    await audit(asCoreDb(db), tenantId, actor, 'admin.job.recorded', 'admin.job', jobId, {
      kind,
      status: 'done',
    });
    return { jobId, result };
  } catch (e) {
    const detail = { error: e instanceof Error ? e.message : String(e) };
    await finish(db, tenantId, jobId, 'failed', detail);
    await audit(asCoreDb(db), tenantId, actor, 'admin.job.recorded', 'admin.job', jobId, {
      kind,
      status: 'failed',
    });
    throw e;
  }
}

async function finish(
  db: Db,
  tenantId: string,
  jobId: string,
  status: JobStatus,
  detail: unknown,
): Promise<void> {
  await db
    .updateTable('admin_jobs')
    .set({
      status,
      detail: detail === undefined ? null : JSON.stringify(detail),
      finished_at: nowIso(),
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', jobId)
    .execute();
}

export async function listJobs(
  db: Db,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
): Promise<AdminJobRow[]> {
  return db
    .selectFrom('admin_jobs')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}
