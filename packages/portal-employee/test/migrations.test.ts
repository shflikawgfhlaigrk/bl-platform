import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { portalEmployeeMigrations, type PortalEmployeeDatabase } from '@blacklabel/portal-employee';

describe('portal-employee migrations', () => {
  it('apply cleanly on a fresh test db (after core)', async () => {
    const db = createTestDb<PortalEmployeeDatabase>();
    const result = await runMigrations(db, [...coreMigrations, ...portalEmployeeMigrations]);
    expect(result.applied).toContain('portal_employee.0001_tables');
    expect(result.applied).toContain('portal_employee.0002_work_logs_seq');
    expect(result.skipped).toEqual([]);

    // Tables exist and are queryable (empty).
    const employees = await db.selectFrom('portal_employee_employees').selectAll().execute();
    expect(employees).toEqual([]);
    const entries = await db.selectFrom('portal_employee_time_entries').selectAll().execute();
    expect(entries).toEqual([]);
  });

  it('are idempotent on re-run', async () => {
    const db = createTestDb<PortalEmployeeDatabase>();
    await runMigrations(db, [...coreMigrations, ...portalEmployeeMigrations]);
    const second = await runMigrations(db, [...coreMigrations, ...portalEmployeeMigrations]);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('portal_employee.0001_tables');
  });
});
