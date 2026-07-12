import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { customersMigrations, type CustomersDatabase } from '@blacklabel/customers';

const TABLES = [
  'customers_profiles',
  'customers_merges',
  'customers_consents',
  'customers_consent_tokens',
  'customers_preferences',
  'customers_suppressions',
  'customers_segments',
  'customers_segment_members',
  'customers_restock_requests',
  'customers_service_cases',
  'customers_service_case_notes',
] as const;

describe('customers migrations', () => {
  it('apply cleanly on a fresh db after core migrations', async () => {
    const db = createTestDb<CustomersDatabase>();
    const result = await runMigrations(db, [...coreMigrations, ...customersMigrations]);
    expect(result.applied).toEqual(
      expect.arrayContaining([
        'customers.0001_profiles_merges',
        'customers.0002_consents_prefs_suppressions',
        'customers.0003_segments_restock_cases',
      ]),
    );
    for (const table of TABLES) {
      expect(await db.selectFrom(table).selectAll().execute()).toEqual([]);
    }
  });

  it('are idempotent on re-run', async () => {
    const db = createTestDb<CustomersDatabase>();
    const all = [...coreMigrations, ...customersMigrations];
    const first = await runMigrations(db, all);
    expect(first.skipped).toEqual([]);
    const second = await runMigrations(db, all);
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBe(all.length);
  });
});
