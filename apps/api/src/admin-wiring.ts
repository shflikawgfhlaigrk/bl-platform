/**
 * Real admin injections — the point where "provider injected" stops being a
 * stub and becomes actual behavior.
 *
 *  - `SqliteBackupProvider`: better-sqlite3 `VACUUM INTO` a fresh artifact,
 *    sha256 it, restore-to-temp by copy, verify with `PRAGMA integrity_check`
 *    plus row-count probes over critical tables.
 *  - `makeCountProbe`: counts critical tables live (dbPath === null → the shared
 *    Kysely db) vs a restored temp copy (better-sqlite3, read-only).
 *  - `buildHealthProbes`: ops-level health signals wired to the pure probe
 *    helpers admin exports (backup/import freshness, outbox depth, disk free).
 *
 * These are ops-level (single-owner box): the freshness/outbox probes read
 * whole-db counts rather than per-tenant, matching admin's infrastructure role.
 * Anything touching the filesystem lives here (server.ts wires it); the
 * in-memory boot path leaves the backup provider absent (routes 501).
 */
import { copyFileSync, statfsSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { Kysely } from 'kysely';
import {
  backupFreshness,
  diskFree,
  importFreshness,
  outboxDepth,
  type BackupProvider,
  type CountProbe,
  type HealthProbe,
} from '@blacklabel/admin';

/** Critical tables whose row counts must survive a backup/restore round-trip. */
export const CRITICAL_TABLES = [
  'tenants',
  'users',
  'retail_payments',
  'crm_customers',
  'orders_orders',
  'inventory_movements',
  'automation_outbox',
] as const;

/* ------------------------------------------------------------------ *
 * Backup provider (better-sqlite3)
 * ------------------------------------------------------------------ */

export class SqliteBackupProvider implements BackupProvider {
  constructor(private readonly livePath: string) {}

  async create(destDir: string): Promise<{ path: string; bytes: number; sha256: string }> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(destDir, `backup-${stamp}.sqlite`);
    const db = new Database(this.livePath, { readonly: true, fileMustExist: true });
    try {
      // VACUUM INTO writes a clean, self-contained copy (checkpoints WAL).
      db.prepare('VACUUM INTO ?').run(dest);
    } finally {
      db.close();
    }
    const bytes = readFileSync(dest);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return { path: dest, bytes: bytes.length, sha256 };
  }

  async restoreToTemp(artifactPath: string): Promise<{ tempPath: string }> {
    const tempPath = `${artifactPath}.verify-${process.pid}.tmp`;
    copyFileSync(artifactPath, tempPath);
    return { tempPath };
  }

  async integrityCheck(tempPath: string): Promise<{ ok: boolean; detail?: unknown }> {
    const db = new Database(tempPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
      const result = row?.integrity_check ?? 'unknown';
      return { ok: result === 'ok', detail: { integrity_check: result } };
    } finally {
      db.close();
    }
  }

  async cleanupTemp(tempPath: string): Promise<void> {
    try {
      unlinkSync(tempPath);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Count critical tables. `dbPath === null` → the LIVE shared db (Kysely);
 * otherwise a restored temp copy opened read-only with better-sqlite3.
 * Missing tables count as 0 (a table absent on both sides still matches).
 */
export function makeCountProbe(
  liveDb: Kysely<Record<string, unknown>>,
  tables: readonly string[] = CRITICAL_TABLES,
): CountProbe {
  return async (dbPath: string | null): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    if (dbPath === null) {
      for (const t of tables) {
        try {
          const row = await liveDb
            .selectFrom(t as never)
            .select((eb) => eb.fn.countAll<number>().as('n'))
            .executeTakeFirst();
          out[t] = Number((row as { n?: number } | undefined)?.n ?? 0);
        } catch {
          out[t] = 0;
        }
      }
      return out;
    }
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      for (const t of tables) {
        try {
          const row = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n?: number } | undefined;
          out[t] = Number(row?.n ?? 0);
        } catch {
          out[t] = 0;
        }
      }
    } finally {
      db.close();
    }
    return out;
  };
}

/* ------------------------------------------------------------------ *
 * Health probes
 * ------------------------------------------------------------------ */

export interface HealthProbeOptions {
  db: Kysely<Record<string, unknown>>;
  /** Storage dir for the disk-free probe; absent → probe reports honestly-unknown. */
  storageDir?: string;
  now?: () => string;
}

/** ISO-now default. */
const isoNow = () => new Date().toISOString();

export function buildHealthProbes(opts: HealthProbeOptions): HealthProbe[] {
  const { db, storageDir } = opts;
  const now = opts.now ?? isoNow;

  const maxIso = async (table: string, column: string): Promise<string | null> => {
    try {
      const row = await db
        .selectFrom(table as never)
        .select((eb) => eb.fn.max<string>(column as never).as('m'))
        .executeTakeFirst();
      return ((row as { m?: string | null } | undefined)?.m ?? null) as string | null;
    } catch {
      return null;
    }
  };

  const countWhere = async (table: string, column: string, value: string): Promise<number> => {
    try {
      const row = await db
        .selectFrom(table as never)
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where(column as never, '=', value as never)
        .executeTakeFirst();
      return Number((row as { n?: number } | undefined)?.n ?? 0);
    } catch {
      return 0;
    }
  };

  return [
    {
      name: 'backup_freshness',
      critical: 1,
      run: async () =>
        backupFreshness({ lastBackupAt: await maxIso('admin_backups', 'verified_at'), maxAgeHours: 26, now: now() }),
    },
    {
      name: 'import_freshness',
      critical: 0,
      run: async () => {
        // Consider both the legacy bulk lane and the incremental manifest lane.
        const a = await maxIso('retail_import_runs', 'created_at');
        const b = await maxIso('retail_import_manifests', 'created_at');
        const lastImportAt = [a, b].filter((x): x is string => !!x).sort().pop() ?? null;
        return importFreshness({ lastImportAt, maxAgeHours: 24 * 30, now: now() });
      },
    },
    {
      name: 'outbox_depth',
      critical: 0,
      run: async () =>
        outboxDepth({
          pending: await countWhere('automation_outbox', 'status', 'pending'),
          dead: await countWhere('automation_outbox', 'status', 'dead'),
          thresholds: { pending: 100, dead: 0 },
        }),
    },
    {
      name: 'disk_free',
      critical: 0,
      run: () => {
        if (!storageDir) return { ok: false, detail: { reason: 'no storage dir configured' } };
        try {
          const st = statfsSync(storageDir);
          const bytesFree = Number(st.bavail) * Number(st.bsize);
          return diskFree({ bytesFree, minBytes: 500 * 1024 * 1024 });
        } catch (e) {
          return { ok: false, detail: { error: e instanceof Error ? e.message : String(e) } };
        }
      },
    },
  ];
}
