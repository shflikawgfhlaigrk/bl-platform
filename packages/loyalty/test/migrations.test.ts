import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { loyaltyMigrations, type LoyaltyDatabase } from '@blacklabel/loyalty';

const TABLES = [
  'loyalty_programs',
  'loyalty_accounts',
  'loyalty_ledger',
  'loyalty_gift_cards',
  'loyalty_gift_card_ledger',
  'loyalty_store_credit_ledger',
  'loyalty_redemptions',
] as const;

describe('loyalty migrations', () => {
  it('apply cleanly on a fresh db after core migrations', async () => {
    const db = createTestDb<LoyaltyDatabase>();
    const result = await runMigrations(db, [...coreMigrations, ...loyaltyMigrations]);
    expect(result.applied).toEqual(
      expect.arrayContaining([
        'loyalty.0001_programs_accounts_ledger',
        'loyalty.0002_gift_cards_store_credit_redemptions',
      ]),
    );
    for (const table of TABLES) {
      expect(await db.selectFrom(table).selectAll().execute()).toEqual([]);
    }
  });

  it('are idempotent on re-run', async () => {
    const db = createTestDb<LoyaltyDatabase>();
    const all = [...coreMigrations, ...loyaltyMigrations];
    const first = await runMigrations(db, all);
    expect(first.skipped).toEqual([]);
    const second = await runMigrations(db, all);
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBe(all.length);
  });
});
