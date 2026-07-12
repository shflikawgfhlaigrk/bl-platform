import { describe, expect, it } from 'vitest';
import type { PlatformEvent } from '@blacklabel/core';
import { setup } from './helpers';
import {
  BackupService,
  selectBackupsToPrune,
  countsMatch,
  type BackupProvider,
} from '../src/backups';

/** In-memory fake provider (no real fs); tunable to fail integrity. */
function fakeProvider(opts: {
  integrityOk?: boolean;
  deleted?: string[];
} = {}): BackupProvider {
  return {
    async create() {
      return { path: `/tmp/backup-${Math.random().toString(36).slice(2)}.db`, bytes: 4096, sha256: 'deadbeef' };
    },
    async restoreToTemp() {
      return { tempPath: '/tmp/restore-x' };
    },
    async integrityCheck() {
      return { ok: opts.integrityOk ?? true, detail: 'PRAGMA integrity_check=ok' };
    },
    async delete(path: string) {
      opts.deleted?.push(path);
    },
  };
}

describe('backups — create → verify pipeline', () => {
  it('happy path: created then verified with matching counts', async () => {
    const { db, tenantA, events } = await setup();
    const svc = new BackupService(db, fakeProvider({ integrityOk: true }));
    const counts = { admin_credentials: 3, admin_jobs: 2 };
    const failures: PlatformEvent[] = [];
    events.on('admin.backup.failed', (e) => { failures.push(e); });

    const row = await svc.runBackup(
      tenantA.id,
      'owner1',
      { destDir: '/tmp/b', countProbe: async () => ({ ...counts }) },
      async (p) => {
        await events.emit(tenantA.id, 'admin.backup.failed', { v: 1, ...p });
      },
    );
    expect(row.status).toBe('verified');
    expect(row.verified_at).not.toBeNull();
    expect(failures).toHaveLength(0);
  });

  it('failed integrity → failed_verification + emits admin.backup.failed', async () => {
    const { db, tenantA, events } = await setup();
    const svc = new BackupService(db, fakeProvider({ integrityOk: false }));
    const failures: PlatformEvent[] = [];
    events.on('admin.backup.failed', (e) => { failures.push(e); });

    const row = await svc.runBackup(
      tenantA.id,
      'owner1',
      { destDir: '/tmp/b' },
      async (p) => {
        await events.emit(tenantA.id, 'admin.backup.failed', { v: 1, ...p });
      },
    );
    expect(row.status).toBe('failed_verification');
    expect(failures).toHaveLength(1);
    expect((failures[0].payload as any).backupId).toBe(row.id);
  });

  it('count mismatch → failed_verification', async () => {
    const { db, tenantA, events } = await setup();
    const svc = new BackupService(db, fakeProvider({ integrityOk: true }));
    let call = 0;
    const row = await svc.runBackup(
      tenantA.id,
      'owner1',
      {
        destDir: '/tmp/b',
        // live=3, temp=2 → mismatch
        countProbe: async () => ({ admin_credentials: call++ === 0 ? 3 : 2 }),
      },
      async (p) => {
        await events.emit(tenantA.id, 'admin.backup.failed', { v: 1, ...p });
      },
    );
    expect(row.status).toBe('failed_verification');
  });

  it('runBackup throws honestly without a provider', async () => {
    const { db, tenantA } = await setup();
    const svc = new BackupService(db, undefined);
    expect(svc.hasProvider).toBe(false);
    await expect(
      svc.runBackup(tenantA.id, 'owner1', { destDir: '/tmp/b' }, async () => {}),
    ).rejects.toThrow();
  });
});

describe('countsMatch', () => {
  it('exact key/value equality', () => {
    expect(countsMatch({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(countsMatch({ a: 1 }, { a: 2 })).toBe(false);
    expect(countsMatch({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});

describe('selectBackupsToPrune — retention planner (pure)', () => {
  const mk = (id: string, created_at: string) => ({ id, created_at, path: `/b/${id}` });
  const now = '2026-07-12T12:00:00.000Z';

  it('keeps the N most recent when no weekly window', () => {
    const backups = [
      mk('a', '2026-07-12T00:00:00.000Z'),
      mk('b', '2026-07-11T00:00:00.000Z'),
      mk('c', '2026-07-10T00:00:00.000Z'),
      mk('d', '2026-07-09T00:00:00.000Z'),
    ];
    const prune = selectBackupsToPrune(backups, { keepLast: 2, keepWeeklyForWeeks: 0 }, now);
    expect(prune.map((b) => b.id).sort()).toEqual(['c', 'd']);
  });

  it('keeps one-per-week for the weekly window on top of keepLast', () => {
    const backups = [
      mk('w0a', '2026-07-12T00:00:00.000Z'), // this week
      mk('w0b', '2026-07-11T00:00:00.000Z'), // this week (dup)
      mk('w1a', '2026-07-05T00:00:00.000Z'), // 1 wk ago
      mk('w1b', '2026-07-04T00:00:00.000Z'), // 1 wk ago (dup)
      mk('w2a', '2026-06-28T00:00:00.000Z'), // 2 wks ago
      mk('old', '2026-05-01T00:00:00.000Z'), // far past
    ];
    // keepLast=1 keeps w0a; weekly window of 3 keeps newest-of-week: w0a, w1a, w2a
    const prune = selectBackupsToPrune(backups, { keepLast: 1, keepWeeklyForWeeks: 3 }, now);
    expect(prune.map((b) => b.id).sort()).toEqual(['old', 'w0b', 'w1b']);
  });

  it('prunes nothing when everything is retained', () => {
    const backups = [mk('a', '2026-07-12T00:00:00.000Z'), mk('b', '2026-07-11T00:00:00.000Z')];
    expect(selectBackupsToPrune(backups, { keepLast: 5, keepWeeklyForWeeks: 0 }, now)).toEqual([]);
  });
});

describe('backups — prune marks records pruned and calls provider.delete', () => {
  it('flips status to pruned and deletes the artifact', async () => {
    const { db, tenantA } = await setup();
    const deleted: string[] = [];
    const svc = new BackupService(db, fakeProvider({ integrityOk: true, deleted }));

    // Seed 3 backups directly (older than any keep window).
    const now = new Date();
    for (let i = 0; i < 3; i += 1) {
      const created = new Date(now.getTime() - (i + 30) * 24 * 3600 * 1000).toISOString();
      await db
        .insertInto('admin_backups')
        .values({
          id: `bk_${i}`,
          tenant_id: tenantA.id,
          path: `/b/bk_${i}`,
          bytes: 1,
          sha256: 'x',
          encrypted: 0,
          status: 'verified',
          detail: null,
          verified_at: created,
          created_at: created,
        })
        .execute();
    }
    const res = await svc.prune(tenantA.id, 'owner1', { keepLast: 1, keepWeeklyForWeeks: 0 });
    expect(res.prunedIds).toHaveLength(2);
    expect(deleted).toHaveLength(2);
    const pruned = await db
      .selectFrom('admin_backups')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .where('status', '=', 'pruned')
      .execute();
    expect(pruned).toHaveLength(2);
  });
});
