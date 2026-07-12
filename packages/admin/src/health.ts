import type { Kysely } from 'kysely';
import { audit, asCoreDb, id, nowIso, type Pagination } from '@blacklabel/core';
import { DateTime } from 'luxon';
import type {
  AdminDatabase,
  AdminHealthRowRow,
  AdminHealthRunRow,
} from './schema';

type Db = Kysely<AdminDatabase>;

export interface ProbeResult {
  ok: boolean;
  detail?: unknown;
}

/** A health probe. Integrators register these; `run` may throw (isolated). */
export interface HealthProbe {
  name: string;
  /** 0/1 — a critical probe failing fails the overall run's critical count. */
  critical: 0 | 1;
  run: () => Promise<ProbeResult> | ProbeResult;
}

export interface HealthRunReport {
  runId: string;
  overallOk: boolean;
  total: number;
  okCount: number;
  criticalFailures: number;
  results: {
    name: string;
    critical: 0 | 1;
    ok: boolean;
    detail: unknown;
  }[];
}

/**
 * Health check service. The integrator registers probes (db, disk, backup
 * freshness, import freshness, outbox depth, dead letters, credential expiry,
 * public projection freshness). runHealth executes all, isolating throws so a
 * single broken probe cannot abort the run, and persists a run + its rows.
 */
export class HealthService {
  private readonly probes: HealthProbe[] = [];

  constructor(private readonly db: Db) {}

  register(probe: HealthProbe): void {
    this.probes.push(probe);
  }

  registerMany(probes: readonly HealthProbe[]): void {
    for (const p of probes) this.register(p);
  }

  /** Count of registered probes (handy for tests / status). */
  get probeCount(): number {
    return this.probes.length;
  }

  async runHealth(tenantId: string, actor = 'system'): Promise<HealthRunReport> {
    const startedAt = nowIso();
    const results: HealthRunReport['results'] = [];
    for (const probe of this.probes) {
      let ok = false;
      let detail: unknown;
      try {
        const r = await probe.run();
        ok = r.ok;
        detail = r.detail;
      } catch (e) {
        // Isolation: a throwing probe is not-ok, never aborts the batch.
        ok = false;
        detail = { error: e instanceof Error ? e.message : String(e) };
      }
      results.push({ name: probe.name, critical: probe.critical, ok, detail });
    }

    const okCount = results.filter((r) => r.ok).length;
    const criticalFailures = results.filter((r) => r.critical === 1 && !r.ok).length;
    const overallOk = okCount === results.length;
    const finishedAt = nowIso();
    const runId = id();

    const runRow: AdminHealthRunRow = {
      id: runId,
      tenant_id: tenantId,
      started_at: startedAt,
      finished_at: finishedAt,
      overall_ok: overallOk ? 1 : 0,
      total: results.length,
      ok_count: okCount,
      critical_failures: criticalFailures,
      created_at: finishedAt,
    };
    const rowRows: AdminHealthRowRow[] = results.map((r) => ({
      id: id(),
      tenant_id: tenantId,
      run_id: runId,
      name: r.name,
      critical: r.critical,
      ok: r.ok ? 1 : 0,
      detail: r.detail === undefined ? null : JSON.stringify(r.detail),
      created_at: finishedAt,
    }));

    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto('admin_health_runs').values(runRow).execute();
      if (rowRows.length > 0) {
        await trx.insertInto('admin_health_rows').values(rowRows).execute();
      }
    });
    await audit(
      asCoreDb(this.db),
      tenantId,
      actor,
      'admin.health_run.recorded',
      'admin.health_run',
      runId,
      { overall_ok: overallOk, total: results.length, critical_failures: criticalFailures },
    );

    return { runId, overallOk, total: results.length, okCount, criticalFailures, results };
  }

  async listRuns(
    tenantId: string,
    page: Pagination = { limit: 50, offset: 0 },
  ): Promise<AdminHealthRunRow[]> {
    return this.db
      .selectFrom('admin_health_runs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .limit(page.limit)
      .offset(page.offset)
      .execute();
  }

  async getRunRows(tenantId: string, runId: string): Promise<AdminHealthRowRow[]> {
    return this.db
      .selectFrom('admin_health_rows')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('run_id', '=', runId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }
}

/* ------------------------------------------------------------------ *
 * Built-in probe helpers — PURE functions integrators parameterize into
 * HealthProbe.run closures. No I/O; the caller supplies the measured inputs.
 * ------------------------------------------------------------------ */

function hoursSince(fromIso: string, nowIso_: string): number {
  const from = DateTime.fromISO(fromIso, { zone: 'utc' });
  const now = DateTime.fromISO(nowIso_, { zone: 'utc' });
  return now.diff(from, 'hours').hours;
}

/** ok when the last backup is younger than maxAgeHours. */
export function backupFreshness(input: {
  lastBackupAt: string | null;
  maxAgeHours: number;
  now?: string;
}): ProbeResult {
  const now = input.now ?? nowIso();
  if (!input.lastBackupAt) {
    return { ok: false, detail: { reason: 'no backup on record', maxAgeHours: input.maxAgeHours } };
  }
  const ageHours = hoursSince(input.lastBackupAt, now);
  return {
    ok: ageHours <= input.maxAgeHours,
    detail: { ageHours: Math.round(ageHours * 100) / 100, maxAgeHours: input.maxAgeHours, lastBackupAt: input.lastBackupAt },
  };
}

/** ok when the last import is younger than maxAgeHours. */
export function importFreshness(input: {
  lastImportAt: string | null;
  maxAgeHours: number;
  now?: string;
}): ProbeResult {
  const now = input.now ?? nowIso();
  if (!input.lastImportAt) {
    return { ok: false, detail: { reason: 'no import on record', maxAgeHours: input.maxAgeHours } };
  }
  const ageHours = hoursSince(input.lastImportAt, now);
  return {
    ok: ageHours <= input.maxAgeHours,
    detail: { ageHours: Math.round(ageHours * 100) / 100, maxAgeHours: input.maxAgeHours, lastImportAt: input.lastImportAt },
  };
}

/** ok when outbox pending/dead depths are at or below thresholds. */
export function outboxDepth(input: {
  pending: number;
  dead: number;
  thresholds: { pending: number; dead: number };
}): ProbeResult {
  const pendingOk = input.pending <= input.thresholds.pending;
  const deadOk = input.dead <= input.thresholds.dead;
  return {
    ok: pendingOk && deadOk,
    detail: {
      pending: input.pending,
      dead: input.dead,
      thresholds: input.thresholds,
      pendingOk,
      deadOk,
    },
  };
}

/** ok when free disk bytes are at or above the minimum. */
export function diskFree(input: { bytesFree: number; minBytes: number }): ProbeResult {
  return {
    ok: input.bytesFree >= input.minBytes,
    detail: { bytesFree: input.bytesFree, minBytes: input.minBytes },
  };
}
