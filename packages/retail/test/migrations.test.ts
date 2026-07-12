import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { retailMigrations } from '../src/migrations';
import type { RetailDatabase } from '../src/schema';

describe('retail migrations', () => {
  it('apply on a fresh db and are idempotent on re-run', async () => {
    const db = createTestDb<RetailDatabase>();
    const first = await runMigrations(db, [...coreMigrations, ...retailMigrations]);
    expect(first.applied).toContain('retail.0001_payments');
    expect(first.applied).toContain('retail.0005_import_runs');

    const second = await runMigrations(db, [...coreMigrations, ...retailMigrations]);
    expect(second.applied).toEqual([]);

    // Tables exist and are queryable.
    for (const table of [
      'retail_payments',
      'retail_order_lines',
      'retail_refunds',
      'retail_customer_links',
      'retail_import_runs',
    ] as const) {
      const rows = await db.selectFrom(table).selectAll().execute();
      expect(rows).toEqual([]);
    }
  });
});
