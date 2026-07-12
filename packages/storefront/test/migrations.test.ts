import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { storefrontMigrations } from '../src/migrations';
import type { StorefrontDatabase } from '../src/schema';

describe('storefront migrations', () => {
  it('apply on a fresh db and are idempotent on re-run', async () => {
    const db = createTestDb<StorefrontDatabase>();
    const first = await runMigrations(db, [...coreMigrations, ...storefrontMigrations]);
    expect(first.applied).toEqual(expect.arrayContaining(storefrontMigrations.map((m) => m.name)));

    const second = await runMigrations(db, [...coreMigrations, ...storefrontMigrations]);
    expect(second.applied).toHaveLength(0);
    expect(second.skipped).toEqual(expect.arrayContaining(storefrontMigrations.map((m) => m.name)));

    // tables exist and are queryable
    const runs = await db.selectFrom('storefront_publish_runs').selectAll().execute();
    expect(runs).toEqual([]);
  });
});
