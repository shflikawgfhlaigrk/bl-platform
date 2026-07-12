import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { workforceMigrations, type WorkforceDatabase } from '@blacklabel/workforce';

describe('workforce migrations', () => {
  it('apply cleanly on a fresh test db (after core)', async () => {
    const db = createTestDb<WorkforceDatabase>();
    const result = await runMigrations(db, [...coreMigrations, ...workforceMigrations]);
    expect(result.applied).toContain('workforce.0001_rbac');
    expect(result.applied).toContain('workforce.0002_scheduling_exports_handoffs');
    expect(result.skipped).toEqual([]);

    // Every table exists and is queryable (empty).
    for (const table of [
      'workforce_roles',
      'workforce_role_permissions',
      'workforce_user_roles',
      'workforce_invitations',
      'workforce_session_policies',
      'workforce_schedules',
      'workforce_time_exports',
      'workforce_handoffs',
    ] as const) {
      expect(await db.selectFrom(table).selectAll().execute()).toEqual([]);
    }
  });

  it('are idempotent on re-run', async () => {
    const db = createTestDb<WorkforceDatabase>();
    await runMigrations(db, [...coreMigrations, ...workforceMigrations]);
    const second = await runMigrations(db, [...coreMigrations, ...workforceMigrations]);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('workforce.0001_rbac');
    expect(second.skipped).toContain('workforce.0002_scheduling_exports_handoffs');
  });
});
