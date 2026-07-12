import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { automationMigrations } from '../src/migrations';
import type { AutomationDatabase } from '../src/schema';

describe('automation migrations', () => {
  it('apply on a fresh db and are idempotent on re-run', async () => {
    const db = createTestDb<AutomationDatabase>();
    const first = await runMigrations(db, [...coreMigrations, ...automationMigrations]);
    expect(first.applied).toContain('automation.0001_outbox');
    expect(first.applied).toContain('automation.0002_rules');
    expect(first.applied).toContain('automation.0003_executions');
    expect(first.applied).toContain('automation.0004_approvals');

    const second = await runMigrations(db, [...coreMigrations, ...automationMigrations]);
    expect(second.applied).toEqual([]);

    for (const table of [
      'automation_outbox',
      'automation_rules',
      'automation_executions',
      'automation_approvals',
    ] as const) {
      const rows = await db.selectFrom(table).selectAll().execute();
      expect(rows).toEqual([]);
    }
  });
});
