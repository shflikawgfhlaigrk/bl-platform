import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { vendorsMigrations } from '../src/migrations';
import type { VendorsDatabase } from '../src/schema';

describe('vendors migrations', () => {
  it('apply on a fresh db and are idempotent on re-run', async () => {
    const db = createTestDb<VendorsDatabase>();
    const first = await runMigrations(db, [...coreMigrations, ...vendorsMigrations]);
    expect(first.applied).toContain('vendors.0001_vendors');
    expect(first.applied).toContain('vendors.0002_catalog_entries');
    expect(first.applied).toContain('vendors.0003_import_jobs');

    const second = await runMigrations(db, [...coreMigrations, ...vendorsMigrations]);
    expect(second.applied).toEqual([]);

    for (const table of [
      'vendors_vendors',
      'vendors_catalog_entries',
      'vendors_import_jobs',
    ] as const) {
      const rows = await db.selectFrom(table).selectAll().execute();
      expect(rows).toEqual([]);
    }
  });
});
