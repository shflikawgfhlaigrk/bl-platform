import type { Kysely } from 'kysely';
import { ApiError, asCoreDb, audit, id, nowIso, type Pagination } from '@blacklabel/core';
import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import type { AdminBackupRow, AdminDatabase, BackupStatus } from './schema';

type Db = Kysely<AdminDatabase>;

/**
 * File operations for backups live behind an INJECTED provider so this module
 * never touches domain data files itself. A better-sqlite3 impl is sketched in
 * the integrator notes (VACUUM INTO + sha256 + PRAGMA integrity_check).
 */
export interface BackupProvider {
  /** Encryption support must be explicit before a requested encrypted write. */
  supportsEncryption?: boolean;
  /** HTTP backup access is only wired for an explicitly scoped provider. */
  scope?: 'single-tenant-database';
  /** Destination is trusted server configuration; HTTP clients cannot supply it. */
  create(destDir?: string, options?: { encrypted?: boolean; tenantId?: string }): Promise<{ path: string; bytes: number; sha256: string; encrypted?: boolean }>;
  readArtifact?(path: string): Promise<Uint8Array>;
  /** Restore an artifact to a throwaway temp location for verification. */
  restoreToTemp(path: string): Promise<{ tempPath: string }>;
  /** Integrity-check a restored temp copy (e.g. PRAGMA integrity_check + probes). */
  integrityCheck(tempPath: string): Promise<{ ok: boolean; detail?: unknown }>;
  /** Delete an artifact (used by retention pruning). Optional. */
  delete?(path: string): Promise<void>;
  /** Best-effort cleanup of a temp restore. Optional. */
  cleanupTemp?(tempPath: string): Promise<void>;
}

/** Counts of critical tables, keyed by table name — compared live vs restored. */
export type CountProbe = (dbPath: string | null) => Promise<Record<string, number>>;

export interface RunBackupOptions {
  destDir?: string;
  /**
   * Count probe used to compare the LIVE db (dbPath === null) against the
   * restored temp copy. Verification requires the two to match exactly.
   */
  countProbe?: CountProbe;
  /** Request actual provider encryption; unsupported providers fail before writing. */
  encrypted?: boolean;
}

export interface RetentionPolicy {
  /** Always keep the N most recent (by created_at). */
  keepLast: number;
  /** Also keep one-per-ISO-week for this many recent weeks. */
  keepWeeklyForWeeks: number;
}

export class BackupService {
  constructor(
    private readonly db: Db,
    private readonly provider: BackupProvider | undefined,
  ) {}

  get hasProvider(): boolean {
    return this.provider !== undefined;
  }

  private requireProvider(): BackupProvider {
    if (!this.provider) {
      throw new Error('backup provider not configured'); // router maps to 501
    }
    return this.provider;
  }

  /**
   * create → verify pipeline. Creates the artifact, records it (status
   * "created"), then verifies via restore-to-temp + integrity check +
   * count-comparison. On success → "verified"; on any failure →
   * "failed_verification" and emit `admin.backup.failed`.
   */
  async runBackup(
    tenantId: string,
    actor: string,
    opts: RunBackupOptions,
    emitFailed: (payload: { backupId: string; reason: string }) => Promise<void>,
  ): Promise<AdminBackupRow> {
    const provider = this.requireProvider();
    const now = nowIso();
    if (opts.encrypted && !provider.supportsEncryption) throw ApiError.badRequest('backup provider does not support encryption');
    const created = await provider.create(opts.destDir, { encrypted: opts.encrypted, tenantId });
    if (opts.encrypted && !created.encrypted) {
      await provider.delete?.(created.path);
      throw ApiError.badRequest('provider did not produce an encrypted backup');
    }
    const row: AdminBackupRow = {
      id: id(),
      tenant_id: tenantId,
      path: created.path,
      bytes: created.bytes,
      sha256: created.sha256,
      encrypted: created.encrypted ? 1 : 0,
      status: 'created',
      detail: null,
      verified_at: null,
      created_at: now,
    };
    await this.db.insertInto('admin_backups').values(row).execute();
    await audit(asCoreDb(this.db), tenantId, actor, 'admin.backup.created', 'admin.backup', row.id, {
      bytes: row.bytes,
      sha256: row.sha256,
    });

    // Verify.
    let verified = false;
    let detail: unknown;
    let reason = '';
    let tempPath: string | undefined;
    try {
      const restored = await provider.restoreToTemp(created.path);
      tempPath = restored.tempPath;
      const integrity = await provider.integrityCheck(restored.tempPath);
      let counts: { live?: Record<string, number>; temp?: Record<string, number>; match?: boolean } = {};
      let countsOk = true;
      if (opts.countProbe) {
        const live = await opts.countProbe(null);
        const temp = await opts.countProbe(restored.tempPath);
        countsOk = countsMatch(live, temp);
        counts = { live, temp, match: countsOk };
      }
      verified = integrity.ok && countsOk;
      detail = { integrity, counts };
      if (!verified) {
        reason = !integrity.ok ? 'integrity check failed' : 'row-count comparison mismatch';
      }
    } catch (e) {
      verified = false;
      reason = e instanceof Error ? e.message : String(e);
      detail = { error: reason };
    } finally {
      if (tempPath && provider.cleanupTemp) {
        try {
          await provider.cleanupTemp(tempPath);
        } catch {
          /* best-effort */
        }
      }
    }

    const status: BackupStatus = verified ? 'verified' : 'failed_verification';
    const verifiedAt = nowIso();
    await this.db
      .updateTable('admin_backups')
      .set({ status, detail: JSON.stringify(detail), verified_at: verifiedAt })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', row.id)
      .execute();
    await audit(asCoreDb(this.db), tenantId, actor, 'admin.backup.verified', 'admin.backup', row.id, {
      status,
    });

    if (!verified) {
      await emitFailed({ backupId: row.id, reason });
    }
    return { ...row, status, detail: JSON.stringify(detail), verified_at: verifiedAt };
  }

  /** Verify an existing backup record again (re-run of the verify half). */
  async verifyExisting(
    tenantId: string,
    actor: string,
    backupId: string,
    opts: { countProbe?: CountProbe } = {},
    emitFailed?: (payload: { backupId: string; reason: string }) => Promise<void>,
  ): Promise<AdminBackupRow> {
    const provider = this.requireProvider();
    const row = await this.getRow(tenantId, backupId);
    let verified = false;
    let detail: unknown;
    let reason = '';
    let tempPath: string | undefined;
    try {
      const restored = await provider.restoreToTemp(row.path);
      tempPath = restored.tempPath;
      const integrity = await provider.integrityCheck(restored.tempPath);
      let countsOk = true;
      let counts: unknown = {};
      if (opts.countProbe) {
        const live = await opts.countProbe(null);
        const temp = await opts.countProbe(restored.tempPath);
        countsOk = countsMatch(live, temp);
        counts = { live, temp, match: countsOk };
      }
      verified = integrity.ok && countsOk;
      detail = { integrity, counts };
      if (!verified) reason = !integrity.ok ? 'integrity check failed' : 'row-count comparison mismatch';
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
      detail = { error: reason };
    } finally {
      if (tempPath && provider.cleanupTemp) {
        try {
          await provider.cleanupTemp(tempPath);
        } catch {
          /* best-effort */
        }
      }
    }
    const status: BackupStatus = verified ? 'verified' : 'failed_verification';
    const verifiedAt = nowIso();
    await this.db
      .updateTable('admin_backups')
      .set({ status, detail: JSON.stringify(detail), verified_at: verifiedAt })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', backupId)
      .execute();
    await audit(asCoreDb(this.db), tenantId, actor, 'admin.backup.verified', 'admin.backup', backupId, {
      status,
    });
    if (!verified && emitFailed) await emitFailed({ backupId, reason });
    return { ...row, status, detail: JSON.stringify(detail), verified_at: verifiedAt };
  }

  async list(
    tenantId: string,
    page: Pagination = { limit: 50, offset: 0 },
  ): Promise<AdminBackupRow[]> {
    return this.db
      .selectFrom('admin_backups')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .limit(page.limit)
      .offset(page.offset)
      .execute();
  }

  /** Raw database exports are disabled whenever the database has multiple tenants. */
  async assertHttpScope(tenantId: string): Promise<void> {
    const provider = this.requireProvider();
    if (provider.scope !== 'single-tenant-database') throw ApiError.forbidden('backup provider has no HTTP export scope');
    const tenants = await this.db.selectFrom('tenants').select('id').limit(2).execute();
    if (tenants.length !== 1 || tenants[0].id !== tenantId) {
      throw ApiError.forbidden('complete database backups require a single-tenant installation');
    }
  }

  async download(tenantId: string, backupId: string): Promise<Uint8Array> {
    await this.assertHttpScope(tenantId);
    const provider = this.requireProvider();
    if (!provider.readArtifact) throw new ApiError(501, 'backup download not configured', 'not_implemented');
    const row = await this.getRow(tenantId, backupId);
    if (row.status !== 'verified' || !row.encrypted) throw ApiError.forbidden('only verified encrypted backups can be downloaded');
    const bytes = await provider.readArtifact(row.path);
    if (bytes.length !== row.bytes || createHash('sha256').update(bytes).digest('hex') !== row.sha256) {
      throw ApiError.conflict('backup artifact no longer matches its verified record');
    }
    return bytes;
  }

  private async getRow(tenantId: string, backupId: string): Promise<AdminBackupRow> {
    const row = await this.db
      .selectFrom('admin_backups')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', backupId)
      .executeTakeFirst();
    if (!row) throw ApiError.notFound('backup not found');
    return row;
  }

  /**
   * Apply the retention policy: the pure planner decides which artifacts to
   * prune, the provider deletes them, and their records flip to "pruned"
   * (records are append-only history — we never hard-delete the row).
   */
  async prune(
    tenantId: string,
    actor: string,
    policy: RetentionPolicy,
    now = nowIso(),
  ): Promise<{ prunedIds: string[] }> {
    const provider = this.requireProvider();
    const rows = await this.db
      .selectFrom('admin_backups')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('status', '!=', 'pruned')
      .execute();
    const toPrune = selectBackupsToPrune(rows, policy, now);
    for (const b of toPrune) {
      if (provider.delete) await provider.delete(b.path);
      await this.db
        .updateTable('admin_backups')
        .set({ status: 'pruned' })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', b.id)
        .execute();
      await audit(asCoreDb(this.db), tenantId, actor, 'admin.backup.pruned', 'admin.backup', b.id, {});
    }
    return { prunedIds: toPrune.map((b) => b.id) };
  }
}

/** Compare two count maps for exact key+value equality. */
export function countsMatch(a: Record<string, number>, b: Record<string, number>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * PURE retention planner. Keep the `keepLast` most recent artifacts, PLUS one
 * artifact per ISO week for the `keepWeeklyForWeeks` most recent weeks; return
 * everything else as the prune list. Deterministic ordering by (created_at,id).
 * Only considers records not already pruned (caller filters).
 */
export function selectBackupsToPrune<
  T extends { id: string; created_at: string; path: string },
>(backups: readonly T[], policy: RetentionPolicy, now: string): T[] {
  const sorted = [...backups].sort((a, b) => {
    if (a.created_at === b.created_at) return a.id < b.id ? 1 : -1;
    return a.created_at < b.created_at ? 1 : -1; // newest first
  });

  const keep = new Set<string>();

  // Rule 1: keep the N most recent.
  for (let i = 0; i < Math.min(policy.keepLast, sorted.length); i += 1) {
    keep.add(sorted[i].id);
  }

  // Rule 2: keep one-per-ISO-week for the most recent M weeks.
  const nowDt = DateTime.fromISO(now, { zone: 'utc' });
  const weeksSeen = new Map<string, string>(); // weekKey -> kept id (first/newest in that week)
  for (const b of sorted) {
    const dt = DateTime.fromISO(b.created_at, { zone: 'utc' });
    const weekKey = `${dt.weekYear}-W${dt.weekNumber}`;
    const weeksAgo = Math.floor(nowDt.diff(dt, 'weeks').weeks);
    if (weeksAgo < 0 || weeksAgo >= policy.keepWeeklyForWeeks) continue;
    if (!weeksSeen.has(weekKey)) {
      weeksSeen.set(weekKey, b.id);
      keep.add(b.id);
    }
  }

  return sorted.filter((b) => !keep.has(b.id));
}
