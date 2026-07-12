import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { purchasingMigrations } from '../src/migrations';
import type { PurchasingDatabase } from '../src/schema';

describe('purchasing migrations', () => {
  it('apply on a fresh db and are idempotent on re-run', async () => {
    const db = createTestDb<PurchasingDatabase>();
    const first = await runMigrations(db, [...coreMigrations, ...purchasingMigrations]);
    expect(first.applied).toContain('purchasing.0001_reorder_policies');
    expect(first.applied).toContain('purchasing.0011_bill_exceptions');

    const second = await runMigrations(db, [...coreMigrations, ...purchasingMigrations]);
    expect(second.applied).toEqual([]);

    for (const table of [
      'purchasing_reorder_policies',
      'purchasing_suggestions',
      'purchasing_purchase_orders',
      'purchasing_po_lines',
      'purchasing_po_events',
      'purchasing_po_documents',
      'purchasing_receipts',
      'purchasing_receipt_lines',
      'purchasing_discrepancies',
      'purchasing_vendor_bills',
      'purchasing_bill_exceptions',
    ] as const) {
      const rows = await db.selectFrom(table).selectAll().execute();
      expect(rows).toEqual([]);
    }
  });
});
