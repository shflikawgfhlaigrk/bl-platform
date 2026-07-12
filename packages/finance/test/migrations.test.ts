import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { financeMigrations } from '../src/migrations';
import type { FinanceDatabase } from '../src/schema';

const TABLES = [
  'finance_payments',
  'finance_refunds',
  'finance_payouts',
  'finance_disputes',
  'finance_vendor_bill_refs',
  'finance_payout_matches',
  'finance_cash_sessions',
  'finance_cash_adjustments',
  'finance_item_costs',
  'finance_liability_snapshots',
  'finance_tax_configs',
  'finance_tax_evidence',
] as const;

describe('finance migrations', () => {
  it('apply on a fresh db and create every table', async () => {
    const db = createTestDb<FinanceDatabase>();
    await runMigrations(db, [...coreMigrations, ...financeMigrations]);
    for (const t of TABLES) {
      const rows = await db.selectFrom(t as any).selectAll().execute();
      expect(rows).toEqual([]);
    }
  });

  it('are idempotent on re-run (no throw, tables intact)', async () => {
    const db = createTestDb<FinanceDatabase>();
    await runMigrations(db, [...coreMigrations, ...financeMigrations]);
    await runMigrations(db, [...coreMigrations, ...financeMigrations]);
    const rows = await db.selectFrom('finance_payments').selectAll().execute();
    expect(rows).toEqual([]);
  });
});
