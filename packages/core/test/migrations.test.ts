import { describe, expect, it } from 'vitest';
import { coreMigrations, type CoreDatabase } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';

describe('coreMigrations', () => {
  it('creates all core tables', async () => {
    const db = createTestDb<CoreDatabase>();
    const result = await runMigrations(db, coreMigrations);
    expect(result.applied).toEqual([
      'core.0001_tenants_users',
      'core.0002_audit_log',
      'core.0003_custom_field_definitions',
    ]);
    const tables = (await db.introspection.getTables()).map((t) => t.name);
    for (const table of ['tenants', 'users', 'audit_log', 'custom_field_definitions']) {
      expect(tables).toContain(table);
    }
  });

  it('is idempotent when re-run (module pattern: [...coreMigrations, ...moduleMigrations])', async () => {
    const db = createTestDb<CoreDatabase>();
    await runMigrations(db, coreMigrations);
    const second = await runMigrations(db, coreMigrations);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toHaveLength(coreMigrations.length);
  });
});
