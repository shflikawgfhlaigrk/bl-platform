import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { outreachMigrations } from '../src/migrations';
import type { OutreachDatabase } from '../src/schema';

describe('outreach migrations', () => {
  it('apply on a fresh db and create every table', async () => {
    const db = createTestDb<OutreachDatabase>();
    const res = await runMigrations(db, [...coreMigrations, ...outreachMigrations]);
    expect(res.applied).toEqual(expect.arrayContaining(outreachMigrations.map((m) => m.name)));

    const tables = [
      'outreach_settings',
      'outreach_templates',
      'outreach_campaigns',
      'outreach_sends',
      'outreach_capacity',
      'outreach_inbox',
      'outreach_reader_state',
    ] as const;
    for (const t of tables) {
      // Each table is queryable (empty).
      const rows = await db.selectFrom(t).selectAll().execute();
      expect(rows).toEqual([]);
    }
  });

  it('are idempotent on re-run', async () => {
    const db = createTestDb<OutreachDatabase>();
    await runMigrations(db, [...coreMigrations, ...outreachMigrations]);
    const second = await runMigrations(db, [...coreMigrations, ...outreachMigrations]);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(
      expect.arrayContaining(outreachMigrations.map((m) => m.name)),
    );
  });
});
