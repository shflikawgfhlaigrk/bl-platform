import type { Migration } from '@blacklabel/db';

export const retailMigrations: Migration[] = [
  {
    name: 'retail.0001_payments',
    up: async (db) => {
      await db.schema
        .createTable('retail_payments')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('source_id', 'text', (c) => c.notNull())
        .addColumn('paid_at', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('amount_cents', 'integer', (c) => c.notNull())
        .addColumn('fee_cents', 'integer')
        .addColumn('customer_source_id', 'text')
        .addColumn('order_source_id', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('retail_payments_tenant_source_idx')
        .on('retail_payments')
        .columns(['tenant_id', 'source_id'])
        .unique()
        .execute();
      await db.schema
        .createIndex('retail_payments_tenant_paid_at_idx')
        .on('retail_payments')
        .columns(['tenant_id', 'paid_at'])
        .execute();
    },
  },
  {
    name: 'retail.0002_order_lines',
    up: async (db) => {
      await db.schema
        .createTable('retail_order_lines')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('source_order_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('quantity', 'real', (c) => c.notNull())
        .addColumn('total_cents', 'integer', (c) => c.notNull())
        .addColumn('catalog_source_id', 'text')
        .addColumn('category_name', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('retail_order_lines_tenant_order_idx')
        .on('retail_order_lines')
        .columns(['tenant_id', 'source_order_id'])
        .execute();
    },
  },
  {
    name: 'retail.0003_refunds',
    up: async (db) => {
      await db.schema
        .createTable('retail_refunds')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('source_id', 'text', (c) => c.notNull())
        .addColumn('refunded_at', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('amount_cents', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('retail_refunds_tenant_source_idx')
        .on('retail_refunds')
        .columns(['tenant_id', 'source_id'])
        .unique()
        .execute();
    },
  },
  {
    name: 'retail.0004_customer_links',
    up: async (db) => {
      await db.schema
        .createTable('retail_customer_links')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('source_id', 'text', (c) => c.notNull())
        .addColumn('crm_customer_id', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('retail_customer_links_tenant_source_idx')
        .on('retail_customer_links')
        .columns(['tenant_id', 'source_id'])
        .unique()
        .execute();
    },
  },
  {
    name: 'retail.0005_import_runs',
    up: async (db) => {
      await db.schema
        .createTable('retail_import_runs')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('source', 'text', (c) => c.notNull())
        .addColumn('started_at', 'text', (c) => c.notNull())
        .addColumn('finished_at', 'text', (c) => c.notNull())
        .addColumn('payments_inserted', 'integer', (c) => c.notNull())
        .addColumn('payments_skipped', 'integer', (c) => c.notNull())
        .addColumn('lines_inserted', 'integer', (c) => c.notNull())
        .addColumn('lines_skipped', 'integer', (c) => c.notNull())
        .addColumn('refunds_inserted', 'integer', (c) => c.notNull())
        .addColumn('refunds_skipped', 'integer', (c) => c.notNull())
        .addColumn('completed_gross_cents_after', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('retail_import_runs_tenant_id_idx')
        .on('retail_import_runs')
        .column('tenant_id')
        .execute();
    },
  },
];
