import type { Migration } from '@blacklabel/db';

export const vendorsMigrations: Migration[] = [
  {
    name: 'vendors.0001_vendors',
    up: async (db) => {
      await db.schema
        .createTable('vendors_vendors')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('contacts', 'text', (c) => c.notNull())
        .addColumn('address', 'text', (c) => c.notNull())
        .addColumn('account_number', 'text')
        .addColumn('payment_terms', 'text')
        .addColumn('lead_time_days', 'integer', (c) => c.notNull())
        .addColumn('minimum_order_cents', 'integer', (c) => c.notNull())
        .addColumn('free_freight_threshold_cents', 'integer')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('vendors_vendors_tenant_id_idx')
        .on('vendors_vendors')
        .column('tenant_id')
        .execute();
    },
  },
  {
    name: 'vendors.0002_catalog_entries',
    up: async (db) => {
      await db.schema
        .createTable('vendors_catalog_entries')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('vendor_id', 'text', (c) => c.notNull())
        .addColumn('variation_id', 'text', (c) => c.notNull())
        .addColumn('vendor_sku', 'text', (c) => c.notNull())
        .addColumn('cost_cents', 'integer', (c) => c.notNull())
        .addColumn('case_pack_qty', 'integer', (c) => c.notNull())
        .addColumn('effective_from', 'text', (c) => c.notNull())
        .addColumn('effective_to', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('vendors_catalog_entries_tenant_vendor_variation_idx')
        .on('vendors_catalog_entries')
        .columns(['tenant_id', 'vendor_id', 'variation_id'])
        .execute();
      await db.schema
        .createIndex('vendors_catalog_entries_tenant_vendor_sku_idx')
        .on('vendors_catalog_entries')
        .columns(['tenant_id', 'vendor_id', 'vendor_sku'])
        .execute();
    },
  },
  {
    name: 'vendors.0003_import_jobs',
    up: async (db) => {
      await db.schema
        .createTable('vendors_import_jobs')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('vendor_id', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('rows_total', 'integer', (c) => c.notNull())
        .addColumn('rows_valid', 'integer', (c) => c.notNull())
        .addColumn('rows_error', 'integer', (c) => c.notNull())
        .addColumn('rows_committed', 'integer', (c) => c.notNull())
        .addColumn('errors', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('vendors_import_jobs_tenant_vendor_idx')
        .on('vendors_import_jobs')
        .columns(['tenant_id', 'vendor_id'])
        .execute();
    },
  },
];
