import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { showsMigrations } from '../src/migrations';
import type { ShowsDatabase } from '../src/schema';

describe('shows migrations', () => {
  it('apply on a fresh db and are idempotent on re-run', async () => {
    const db = createTestDb<ShowsDatabase>();
    const first = await runMigrations(db, [...coreMigrations, ...showsMigrations]);
    expect(first.applied).toContain('shows.0001_venues');
    expect(first.applied).toContain('shows.0007_closeouts');

    const second = await runMigrations(db, [...coreMigrations, ...showsMigrations]);
    expect(second.applied).toEqual([]);

    for (const table of [
      'shows_venues',
      'shows_shows',
      'shows_packing_templates',
      'shows_manifests',
      'shows_manifest_lines',
      'shows_discrepancies',
      'shows_closeouts',
    ] as const) {
      const rows = await db.selectFrom(table).selectAll().execute();
      expect(rows).toEqual([]);
    }
  });
});
