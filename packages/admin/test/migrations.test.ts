import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { adminMigrations } from '../src/migrations';
import type { AdminDatabase } from '../src/schema';

describe('admin migrations', () => {
  it('apply on a fresh db and create every admin table', async () => {
    const db = createTestDb<AdminDatabase>();
    const res = await runMigrations(db, [...coreMigrations, ...adminMigrations]);
    expect(res.applied).toEqual(
      expect.arrayContaining(adminMigrations.map((m) => m.name)),
    );

    // Each table is queryable (empty).
    for (const t of [
      'admin_credentials',
      'admin_settings',
      'admin_health_runs',
      'admin_health_rows',
      'admin_backups',
      'admin_jobs',
    ] as const) {
      const rows = await db.selectFrom(t).selectAll().execute();
      expect(rows).toEqual([]);
    }
  });

  it('are idempotent on re-run (all skipped the second time)', async () => {
    const db = createTestDb<AdminDatabase>();
    await runMigrations(db, [...coreMigrations, ...adminMigrations]);
    const second = await runMigrations(db, [...coreMigrations, ...adminMigrations]);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(
      expect.arrayContaining(adminMigrations.map((m) => m.name)),
    );
  });
});
