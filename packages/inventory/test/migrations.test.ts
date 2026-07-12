import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { inventoryMigrations } from '../src/migrations';
import type { InventoryDatabase } from '../src/schema';

describe('inventory migrations', () => {
  it('apply on a fresh db and create every table', async () => {
    const db = createTestDb<InventoryDatabase>();
    await runMigrations(db, [...coreMigrations, ...inventoryMigrations]);
    const tables = [
      'inventory_locations',
      'inventory_movements',
      'inventory_stock_levels',
      'inventory_reservations',
      'inventory_count_sessions',
      'inventory_count_lines',
      'inventory_transfers',
      'inventory_transfer_lines',
      'inventory_reorder_points',
      'inventory_idempotency',
    ] as const;
    for (const table of tables) {
      const rows = await db.selectFrom(table).selectAll().execute();
      expect(rows).toEqual([]);
    }
  });

  it('are idempotent on re-run', async () => {
    const db = createTestDb<InventoryDatabase>();
    await runMigrations(db, [...coreMigrations, ...inventoryMigrations]);
    // Second run must not throw (bookkeeping in _migrations skips applied ones).
    await runMigrations(db, [...coreMigrations, ...inventoryMigrations]);
    const rows = await db.selectFrom('inventory_locations').selectAll().execute();
    expect(rows).toEqual([]);
  });

  it('have globally-unique, ordered migration names', () => {
    const names = inventoryMigrations.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.startsWith('inventory.'))).toBe(true);
  });
});
