import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { clientOpsMigrations } from '../src/migrations';
import type { ClientOpsDatabase } from '../src/schema';

describe('client-ops migrations', () => {
  it('apply on a fresh database and are idempotent', async () => {
    const db = createTestDb<ClientOpsDatabase>();
    const migrations = [...coreMigrations, ...clientOpsMigrations];
    const first = await runMigrations(db, migrations);
    expect(first.applied).toEqual(migrations.map((item) => item.name));
    const second = await runMigrations(db, migrations);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(migrations.map((item) => item.name));
    const tables = await db.introspection.getTables();
    const names = tables.map((table) => table.name);
    expect(names).toEqual(expect.arrayContaining([
      'client_ops_installations', 'client_ops_installed_workflows',
      'client_ops_connector_bindings', 'client_ops_onboarding_steps',
      'client_ops_runs', 'client_ops_review_items', 'client_ops_artifacts',
      'client_ops_completion_receipts', 'client_ops_usage_events',
      'client_ops_portfolio_test_runs', 'client_ops_portfolio_packages',
    ]));
    await db.destroy();
  });
});
