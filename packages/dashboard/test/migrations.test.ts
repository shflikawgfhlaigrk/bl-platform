import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { dashboardMigrations } from '../src/migrations';
import type { DashboardDatabase } from '../src/schema';

describe('dashboard migrations', () => {
  it('apply on a fresh db after core and create the owned tables', async () => {
    const db = createTestDb<DashboardDatabase>();
    const result = await runMigrations(db, [...coreMigrations, ...dashboardMigrations]);
    expect(result.applied).toContain('dashboard.0001_widget_configs');
    expect(result.applied).toContain('dashboard.0002_alert_rules');

    // Tables exist and are queryable (empty).
    expect(await db.selectFrom('dashboard_widget_configs').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('dashboard_alert_rules').selectAll().execute()).toEqual([]);
  });

  it('are idempotent on re-run', async () => {
    const db = createTestDb<DashboardDatabase>();
    await runMigrations(db, [...coreMigrations, ...dashboardMigrations]);
    const second = await runMigrations(db, [...coreMigrations, ...dashboardMigrations]);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(
      expect.arrayContaining(['dashboard.0001_widget_configs', 'dashboard.0002_alert_rules']),
    );
  });
});
