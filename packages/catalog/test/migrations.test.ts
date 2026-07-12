import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { catalogMigrations } from '../src/migrations';
import type { CatalogDatabase } from '../src/schema';

describe('catalog migrations', () => {
  it('apply on a fresh db and create every catalog table', async () => {
    const db = createTestDb<CatalogDatabase>();
    const res = await runMigrations(db, [...coreMigrations, ...catalogMigrations]);
    expect(res.applied).toEqual(expect.arrayContaining(catalogMigrations.map((m) => m.name)));

    const tables = [
      'catalog_departments',
      'catalog_category_mappings',
      'catalog_brands',
      'catalog_products',
      'catalog_variations',
      'catalog_barcodes',
      'catalog_price_books',
      'catalog_price_entries',
      'catalog_promotions',
      'catalog_kits',
      'catalog_kit_components',
      'catalog_bulk_jobs',
    ] as const;
    for (const t of tables) {
      const rows = await db.selectFrom(t as any).selectAll().execute();
      expect(rows).toEqual([]); // table exists, empty
    }
  });

  it('are idempotent on re-run (everything skipped the second time)', async () => {
    const db = createTestDb<CatalogDatabase>();
    await runMigrations(db, [...coreMigrations, ...catalogMigrations]);
    const second = await runMigrations(db, [...coreMigrations, ...catalogMigrations]);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(
      expect.arrayContaining(catalogMigrations.map((m) => m.name)),
    );
  });
});
