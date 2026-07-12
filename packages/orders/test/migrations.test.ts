import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { ordersMigrations } from '../src/migrations';
import type { OrdersDatabase } from '../src/schema';

const TABLES = [
  'orders_orders',
  'orders_lines',
  'orders_tenders',
  'orders_refunds',
  'orders_refund_lines',
  'orders_fulfillments',
  'orders_fulfillment_lines',
  'orders_checkout_sessions',
  'orders_webhook_events',
];

describe('orders migrations', () => {
  it('apply on a fresh db and create every table', async () => {
    const db = createTestDb<OrdersDatabase>();
    const results = await runMigrations(db, [...coreMigrations, ...ordersMigrations]);
    expect(results.applied).toContain('orders.0001_orders_tables');
    for (const table of TABLES) {
      // A select against each table must succeed (table exists).
      const rows = await db
        .selectFrom(table as 'orders_orders')
        .selectAll()
        .execute();
      expect(rows).toEqual([]);
    }
  });

  it('are idempotent on re-run (no duplicate application)', async () => {
    const db = createTestDb<OrdersDatabase>();
    await runMigrations(db, [...coreMigrations, ...ordersMigrations]);
    // Re-running must not throw and must apply nothing new.
    const second = await runMigrations(db, [...coreMigrations, ...ordersMigrations]);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('orders.0001_orders_tables');
  });
});
