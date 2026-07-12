import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { quotingMigrations, type QuotingDatabase } from '@blacklabel/quoting';

describe('quoting migrations', () => {
  it('apply cleanly on a fresh db after core, and are idempotent', async () => {
    const db = createTestDb<QuotingDatabase>();
    const first = await runMigrations(db, [...coreMigrations, ...quotingMigrations]);
    expect(first.applied).toContain('quoting.0001_quoting_tables');
    expect(first.skipped).toEqual([]);

    const second = await runMigrations(db, [...coreMigrations, ...quotingMigrations]);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('quoting.0001_quoting_tables');
  });

  it('create all quoting tables (queryable and tenant-filterable)', async () => {
    const db = createTestDb<QuotingDatabase>();
    await runMigrations(db, [...coreMigrations, ...quotingMigrations]);
    // Every table must exist and accept a tenant_id-filtered select.
    const tables = [
      'quoting_quotes',
      'quoting_quote_lines',
      'quoting_pricing_rules',
      'quoting_service_templates',
      'quoting_discounts',
      'quoting_taxes',
      'quoting_approval_events',
    ] as const;
    for (const table of tables) {
      const rows = await db
        .selectFrom(table)
        .selectAll()
        .where('tenant_id', '=', 'none')
        .execute();
      expect(rows).toEqual([]);
    }
  });
});
