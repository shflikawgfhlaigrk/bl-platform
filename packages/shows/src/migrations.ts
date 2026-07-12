import type { Migration } from '@blacklabel/db';

export const showsMigrations: Migration[] = [
  {
    name: 'shows.0001_venues',
    up: async (db) => {
      await db.schema
        .createTable('shows_venues')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('address', 'text', (c) => c.notNull())
        .addColumn('state', 'text', (c) => c.notNull())
        .addColumn('notes', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('shows_venues_tenant_id_idx')
        .on('shows_venues')
        .column('tenant_id')
        .execute();
    },
  },
  {
    name: 'shows.0002_shows',
    up: async (db) => {
      await db.schema
        .createTable('shows_shows')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('venue_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('starts_on', 'text', (c) => c.notNull())
        .addColumn('ends_on', 'text', (c) => c.notNull())
        .addColumn('setup_window', 'text')
        .addColumn('teardown_window', 'text')
        .addColumn('booth_assignment', 'text')
        .addColumn('travel', 'text')
        .addColumn('booth_fee_cents', 'integer')
        .addColumn('travel_cost_cents', 'integer')
        .addColumn('staffing', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('location_id', 'text')
        .addColumn('notes', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('shows_shows_tenant_id_idx')
        .on('shows_shows')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('shows_shows_tenant_starts_on_idx')
        .on('shows_shows')
        .columns(['tenant_id', 'starts_on'])
        .execute();
    },
  },
  {
    name: 'shows.0003_packing_templates',
    up: async (db) => {
      await db.schema
        .createTable('shows_packing_templates')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('show_type', 'text')
        .addColumn('season', 'text')
        .addColumn('lines', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('shows_packing_templates_tenant_id_idx')
        .on('shows_packing_templates')
        .column('tenant_id')
        .execute();
    },
  },
  {
    name: 'shows.0004_manifests',
    up: async (db) => {
      await db.schema
        .createTable('shows_manifests')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('show_id', 'text', (c) => c.notNull())
        .addColumn('template_id', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('shows_manifests_tenant_id_idx')
        .on('shows_manifests')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('shows_manifests_tenant_show_idx')
        .on('shows_manifests')
        .columns(['tenant_id', 'show_id'])
        .execute();
    },
  },
  {
    name: 'shows.0005_manifest_lines',
    up: async (db) => {
      await db.schema
        .createTable('shows_manifest_lines')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('manifest_id', 'text', (c) => c.notNull())
        .addColumn('variation_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text')
        .addColumn('suggested_qty', 'integer', (c) => c.notNull())
        .addColumn('packed_qty', 'integer')
        .addColumn('returned_qty', 'integer')
        .addColumn('formula_trace', 'text', (c) => c.notNull())
        .addColumn('substitution_of', 'text')
        .addColumn('missing_reason', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('shows_manifest_lines_tenant_id_idx')
        .on('shows_manifest_lines')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('shows_manifest_lines_tenant_manifest_idx')
        .on('shows_manifest_lines')
        .columns(['tenant_id', 'manifest_id'])
        .execute();
    },
  },
  {
    name: 'shows.0006_discrepancies',
    up: async (db) => {
      await db.schema
        .createTable('shows_discrepancies')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('show_id', 'text', (c) => c.notNull())
        .addColumn('manifest_id', 'text')
        .addColumn('variation_id', 'text', (c) => c.notNull())
        .addColumn('expected_qty', 'integer', (c) => c.notNull())
        .addColumn('returned_qty', 'integer', (c) => c.notNull())
        .addColumn('delta', 'integer', (c) => c.notNull())
        .addColumn('resolution', 'text')
        .addColumn('resolved', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('shows_discrepancies_tenant_id_idx')
        .on('shows_discrepancies')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('shows_discrepancies_tenant_show_idx')
        .on('shows_discrepancies')
        .columns(['tenant_id', 'show_id'])
        .execute();
    },
  },
  {
    name: 'shows.0007_closeouts',
    up: async (db) => {
      await db.schema
        .createTable('shows_closeouts')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('show_id', 'text', (c) => c.notNull())
        .addColumn('sales_total_cents', 'integer')
        .addColumn('cash_variance_cents', 'integer')
        .addColumn('refunds_cents', 'integer')
        .addColumn('labor_cents', 'integer')
        .addColumn('travel_cents', 'integer')
        .addColumn('booth_fee_cents', 'integer')
        .addColumn('damages_count', 'integer')
        .addColumn('unresolved_exceptions_count', 'integer', (c) => c.notNull())
        .addColumn('review', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('shows_closeouts_tenant_id_idx')
        .on('shows_closeouts')
        .column('tenant_id')
        .execute();
      // One closeout per show (per tenant).
      await db.schema
        .createIndex('shows_closeouts_tenant_show_idx')
        .on('shows_closeouts')
        .columns(['tenant_id', 'show_id'])
        .unique()
        .execute();
    },
  },
];
