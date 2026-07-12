import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { actionsMigrations } from '../src/migrations';
import type { ActionsDatabase } from '../src/schema';

describe('actions migrations', () => {
  it('apply on a fresh db and are idempotent on re-run', async () => {
    const db = createTestDb<ActionsDatabase>();
    const first = await runMigrations(db, [...coreMigrations, ...actionsMigrations]);
    expect(first.applied).toContain('actions.0001_actions');
    expect(first.applied).toContain('actions.0002_comments');
    expect(first.applied).toContain('actions.0003_escalations');

    const second = await runMigrations(db, [...coreMigrations, ...actionsMigrations]);
    expect(second.applied).toEqual([]);

    for (const table of ['actions_actions', 'actions_comments', 'actions_escalations'] as const) {
      const rows = await db.selectFrom(table).selectAll().execute();
      expect(rows).toEqual([]);
    }
  });
});
