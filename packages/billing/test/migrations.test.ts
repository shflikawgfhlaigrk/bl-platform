import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { billingMigrations } from '../src/migrations';
import type { BillingDatabase } from '../src/schema';

describe('billing migrations', () => {
  it('apply on a fresh db after coreMigrations', async () => {
    const db = createTestDb<BillingDatabase>();
    const result = await runMigrations(db, [...coreMigrations, ...billingMigrations]);
    expect(result.applied).toContain('billing.0001_billing_tables');
    expect(result.skipped).toEqual([]);

    // Every billing table is queryable and empty.
    expect(await db.selectFrom('billing_accounts').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('billing_invoices').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('billing_invoice_lines').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('billing_payments').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('billing_subscriptions').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('billing_memberships').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('billing_invoice_counters').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('billing_webhook_events').selectAll().execute()).toEqual([]);
  });

  it('are idempotent on re-run', async () => {
    const db = createTestDb<BillingDatabase>();
    await runMigrations(db, [...coreMigrations, ...billingMigrations]);
    const second = await runMigrations(db, [...coreMigrations, ...billingMigrations]);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('billing.0001_billing_tables');
  });
});
