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
  {
    name: 'retail.0006_import_manifests',
    up: async (db) => {
      await db.schema
        .createTable('retail_import_manifests')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('source', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('record_count', 'integer', (c) => c.notNull())
        .addColumn('accepted', 'integer', (c) => c.notNull())
        .addColumn('updated', 'integer', (c) => c.notNull())
        .addColumn('skipped_duplicates', 'integer', (c) => c.notNull())
        .addColumn('quarantined', 'integer', (c) => c.notNull())
        .addColumn('source_hash', 'text', (c) => c.notNull())
        .addColumn('cursor_before', 'text')
        .addColumn('cursor_after', 'text')
        .addColumn('recon_gross_cents', 'integer')
        .addColumn('recon_count', 'integer')
        .addColumn('started_at', 'text', (c) => c.notNull())
        .addColumn('finished_at', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('error', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('retail_import_manifests_tenant_kind_idx')
        .on('retail_import_manifests')
        .columns(['tenant_id', 'kind', 'created_at'])
        .execute();
    },
  },
  {
    name: 'retail.0007_quarantine',
    up: async (db) => {
      await db.schema
        .createTable('retail_quarantine')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('manifest_id', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('record', 'text', (c) => c.notNull())
        .addColumn('errors', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('retail_quarantine_tenant_status_idx')
        .on('retail_quarantine')
        .columns(['tenant_id', 'status'])
        .execute();
      await db.schema
        .createIndex('retail_quarantine_tenant_manifest_idx')
        .on('retail_quarantine')
        .columns(['tenant_id', 'manifest_id'])
        .execute();
    },
  },
  {
    name: 'retail.0008_import_cursors',
    up: async (db) => {
      await db.schema
        .createTable('retail_import_cursors')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('source', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('cursor', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('retail_import_cursors_tenant_source_kind_idx')
        .on('retail_import_cursors')
        .columns(['tenant_id', 'source', 'kind'])
        .unique()
        .execute();
    },
  },
  {
    name: 'retail.0009_webhook_receipts',
    up: async (db) => {
      await db.schema
        .createTable('retail_webhook_receipts')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('event_id', 'text', (c) => c.notNull())
        .addColumn('event_type', 'text', (c) => c.notNull())
        .addColumn('manifest_id', 'text')
        .addColumn('received_at', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('retail_webhook_receipts_tenant_event_idx')
        .on('retail_webhook_receipts')
        .columns(['tenant_id', 'event_id'])
        .unique()
        .execute();
    },
  },
  {
    name: 'retail.0010_orders',
    up: async (db) => {
      await db.schema
        .createTable('retail_orders')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('source_id', 'text', (c) => c.notNull())
        .addColumn('state', 'text', (c) => c.notNull())
        .addColumn('total_cents', 'integer', (c) => c.notNull())
        .addColumn('ordered_at', 'text', (c) => c.notNull())
        .addColumn('location_source_id', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('retail_orders_tenant_source_idx')
        .on('retail_orders')
        .columns(['tenant_id', 'source_id'])
        .unique()
        .execute();
    },
  },
  {
    name: 'retail.0011_customers',
    up: async (db) => {
      await db.schema
        .createTable('retail_customers')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('source_id', 'text', (c) => c.notNull())
        .addColumn('given_name', 'text')
        .addColumn('family_name', 'text')
        .addColumn('email', 'text')
        .addColumn('phone', 'text')
        .addColumn('created_source', 'text')
        .addColumn('customer_created_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('retail_customers_tenant_source_idx')
        .on('retail_customers')
        .columns(['tenant_id', 'source_id'])
        .unique()
        .execute();
    },
  },
  {
    name: 'retail.0012_catalog_objects',
    up: async (db) => {
      await db.schema
        .createTable('retail_catalog_objects')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('source_id', 'text', (c) => c.notNull())
        .addColumn('object_type', 'text', (c) => c.notNull())
        .addColumn('name', 'text')
        .addColumn('item_source_id', 'text')
        .addColumn('price_cents', 'integer')
        .addColumn('sku', 'text')
        .addColumn('upc', 'text')
        .addColumn('category_name', 'text')
        .addColumn('is_deleted', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('retail_catalog_objects_tenant_source_idx')
        .on('retail_catalog_objects')
        .columns(['tenant_id', 'source_id'])
        .unique()
        .execute();
    },
  },
  {
    name: 'retail.0013_gift_cards',
    up: async (db) => {
      await db.schema
        .createTable('retail_gift_cards')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('source_id', 'text', (c) => c.notNull())
        .addColumn('gan', 'text')
        .addColumn('state', 'text', (c) => c.notNull())
        .addColumn('balance_cents', 'integer', (c) => c.notNull())
        .addColumn('gift_card_created_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('retail_gift_cards_tenant_source_idx')
        .on('retail_gift_cards')
        .columns(['tenant_id', 'source_id'])
        .unique()
        .execute();
    },
  },
  {
    name: 'retail.0014_payouts',
    up: async (db) => {
      await db.schema
        .createTable('retail_payouts')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('source_id', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('amount_cents', 'integer', (c) => c.notNull())
        .addColumn('destination_type', 'text')
        .addColumn('payout_created_at', 'text')
        .addColumn('arrival_date', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('retail_payouts_tenant_source_idx')
        .on('retail_payouts')
        .columns(['tenant_id', 'source_id'])
        .unique()
        .execute();
    },
  },
  {
    name: 'retail.0015_disputes',
    up: async (db) => {
      await db.schema
        .createTable('retail_disputes')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('source_id', 'text', (c) => c.notNull())
        .addColumn('state', 'text', (c) => c.notNull())
        .addColumn('reason', 'text')
        .addColumn('amount_cents', 'integer', (c) => c.notNull())
        .addColumn('payment_source_id', 'text')
        .addColumn('dispute_created_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('retail_disputes_tenant_source_idx')
        .on('retail_disputes')
        .columns(['tenant_id', 'source_id'])
        .unique()
        .execute();
    },
  },
  {
    name: 'retail.0016_invoices',
    up: async (db) => {
      await db.schema
        .createTable('retail_invoices')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('source_id', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('order_source_id', 'text')
        .addColumn('customer_source_id', 'text')
        .addColumn('computed_amount_cents', 'integer', (c) => c.notNull())
        .addColumn('invoice_number', 'text')
        .addColumn('invoice_created_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('retail_invoices_tenant_source_idx')
        .on('retail_invoices')
        .columns(['tenant_id', 'source_id'])
        .unique()
        .execute();
    },
  },
  {
    name: 'retail.0017_inventory_counts',
    up: async (db) => {
      await db.schema
        .createTable('retail_inventory_counts')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('catalog_source_id', 'text', (c) => c.notNull())
        .addColumn('location_source_id', 'text', (c) => c.notNull())
        .addColumn('state', 'text', (c) => c.notNull())
        .addColumn('quantity', 'text')
        .addColumn('calculated_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('retail_inventory_counts_tenant_key_idx')
        .on('retail_inventory_counts')
        .columns(['tenant_id', 'catalog_source_id', 'location_source_id', 'state'])
        .unique()
        .execute();
    },
  },
];
