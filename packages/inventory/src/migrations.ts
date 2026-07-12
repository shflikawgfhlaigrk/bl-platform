import type { Migration } from '@blacklabel/db';

export const inventoryMigrations: Migration[] = [
  {
    name: 'inventory.0001_locations',
    up: async (db) => {
      await db.schema
        .createTable('inventory_locations')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('show_id', 'text')
        .addColumn('oversell_policy', 'text', (c) => c.notNull())
        .addColumn('archived', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('inventory_locations_tenant_id_idx')
        .on('inventory_locations')
        .column('tenant_id')
        .execute();
    },
  },
  {
    name: 'inventory.0002_movements',
    up: async (db) => {
      await db.schema
        .createTable('inventory_movements')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('variation_id', 'text', (c) => c.notNull())
        .addColumn('location_id', 'text', (c) => c.notNull())
        .addColumn('delta', 'integer', (c) => c.notNull())
        .addColumn('reason', 'text', (c) => c.notNull())
        .addColumn('ref_type', 'text')
        .addColumn('ref_id', 'text')
        .addColumn('idempotency_key', 'text')
        .addColumn('note', 'text')
        .addColumn('actor', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('inventory_movements_tenant_var_loc_idx')
        .on('inventory_movements')
        .columns(['tenant_id', 'variation_id', 'location_id'])
        .execute();
      await db.schema
        .createIndex('inventory_movements_tenant_created_idx')
        .on('inventory_movements')
        .columns(['tenant_id', 'created_at'])
        .execute();
      // UNIQUE per tenant on idempotency_key (NULLs are distinct in SQLite/ANSI).
      await db.schema
        .createIndex('inventory_movements_tenant_idem_idx')
        .on('inventory_movements')
        .columns(['tenant_id', 'idempotency_key'])
        .unique()
        .execute();
    },
  },
  {
    name: 'inventory.0003_stock_levels',
    up: async (db) => {
      await db.schema
        .createTable('inventory_stock_levels')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('variation_id', 'text', (c) => c.notNull())
        .addColumn('location_id', 'text', (c) => c.notNull())
        .addColumn('on_hand', 'integer', (c) => c.notNull())
        .addColumn('reserved', 'integer', (c) => c.notNull())
        .addColumn('counted_ever', 'integer', (c) => c.notNull())
        .addColumn('last_movement_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('inventory_stock_levels_tenant_var_loc_idx')
        .on('inventory_stock_levels')
        .columns(['tenant_id', 'variation_id', 'location_id'])
        .unique()
        .execute();
    },
  },
  {
    name: 'inventory.0004_reservations',
    up: async (db) => {
      await db.schema
        .createTable('inventory_reservations')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('variation_id', 'text', (c) => c.notNull())
        .addColumn('location_id', 'text', (c) => c.notNull())
        .addColumn('qty', 'integer', (c) => c.notNull())
        .addColumn('ref_type', 'text')
        .addColumn('ref_id', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('oversold', 'integer', (c) => c.notNull())
        .addColumn('expires_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('inventory_reservations_tenant_status_idx')
        .on('inventory_reservations')
        .columns(['tenant_id', 'status'])
        .execute();
      await db.schema
        .createIndex('inventory_reservations_tenant_var_loc_idx')
        .on('inventory_reservations')
        .columns(['tenant_id', 'variation_id', 'location_id'])
        .execute();
    },
  },
  {
    name: 'inventory.0005_count_sessions',
    up: async (db) => {
      await db.schema
        .createTable('inventory_count_sessions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('location_id', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('blind', 'integer', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('assigned_to', 'text')
        .addColumn('recount_threshold', 'integer', (c) => c.notNull())
        .addColumn('signed_by', 'text')
        .addColumn('signed_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('inventory_count_sessions_tenant_id_idx')
        .on('inventory_count_sessions')
        .column('tenant_id')
        .execute();
    },
  },
  {
    name: 'inventory.0006_count_lines',
    up: async (db) => {
      await db.schema
        .createTable('inventory_count_lines')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('session_id', 'text', (c) => c.notNull())
        .addColumn('variation_id', 'text', (c) => c.notNull())
        .addColumn('expected_qty', 'integer', (c) => c.notNull())
        .addColumn('counted_qty', 'integer')
        .addColumn('variance', 'integer')
        .addColumn('recount_required', 'integer', (c) => c.notNull())
        .addColumn('recount_qty', 'integer')
        .addColumn('approved', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('inventory_count_lines_tenant_session_idx')
        .on('inventory_count_lines')
        .columns(['tenant_id', 'session_id'])
        .execute();
    },
  },
  {
    name: 'inventory.0007_transfers',
    up: async (db) => {
      await db.schema
        .createTable('inventory_transfers')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('from_location_id', 'text', (c) => c.notNull())
        .addColumn('to_location_id', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('reason', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('inventory_transfers_tenant_id_idx')
        .on('inventory_transfers')
        .column('tenant_id')
        .execute();
    },
  },
  {
    name: 'inventory.0008_transfer_lines',
    up: async (db) => {
      await db.schema
        .createTable('inventory_transfer_lines')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('transfer_id', 'text', (c) => c.notNull())
        .addColumn('variation_id', 'text', (c) => c.notNull())
        .addColumn('qty_sent', 'integer', (c) => c.notNull())
        .addColumn('qty_received', 'integer')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('inventory_transfer_lines_tenant_transfer_idx')
        .on('inventory_transfer_lines')
        .columns(['tenant_id', 'transfer_id'])
        .execute();
    },
  },
  {
    name: 'inventory.0009_reorder_points',
    up: async (db) => {
      await db.schema
        .createTable('inventory_reorder_points')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('variation_id', 'text', (c) => c.notNull())
        .addColumn('location_id', 'text')
        .addColumn('reorder_point', 'integer', (c) => c.notNull())
        .addColumn('safety_stock', 'integer', (c) => c.notNull())
        .addColumn('enabled', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('inventory_reorder_points_tenant_var_idx')
        .on('inventory_reorder_points')
        .columns(['tenant_id', 'variation_id'])
        .execute();
    },
  },
  {
    name: 'inventory.0010_idempotency',
    up: async (db) => {
      await db.schema
        .createTable('inventory_idempotency')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('key', 'text', (c) => c.notNull())
        .addColumn('scope', 'text', (c) => c.notNull())
        .addColumn('result_json', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('inventory_idempotency_tenant_key_idx')
        .on('inventory_idempotency')
        .columns(['tenant_id', 'key'])
        .unique()
        .execute();
    },
  },
];
