import type { Migration } from '@blacklabel/db';

/**
 * Catalog migrations — append-only. Table names are prefixed `catalog_`.
 * Every tenant-scoped table gets a tenant index; natural-key uniqueness
 * (source ids, slugs) is enforced with unique indexes (NOT ON CONFLICT).
 */
export const catalogMigrations: Migration[] = [
  {
    name: 'catalog.0001_departments',
    up: async (db) => {
      await db.schema
        .createTable('catalog_departments')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('slug', 'text', (c) => c.notNull())
        .addColumn('parent_id', 'text')
        .addColumn('sort', 'integer', (c) => c.notNull())
        .addColumn('archived', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('catalog_departments_tenant_slug_idx')
        .on('catalog_departments')
        .columns(['tenant_id', 'slug'])
        .unique()
        .execute();
      await db.schema
        .createIndex('catalog_departments_tenant_parent_idx')
        .on('catalog_departments')
        .columns(['tenant_id', 'parent_id'])
        .execute();
    },
  },
  {
    name: 'catalog.0002_category_mappings',
    up: async (db) => {
      await db.schema
        .createTable('catalog_category_mappings')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('source_category_name', 'text', (c) => c.notNull())
        .addColumn('department_id', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('rule_name', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('catalog_category_mappings_tenant_name_idx')
        .on('catalog_category_mappings')
        .columns(['tenant_id', 'source_category_name'])
        .unique()
        .execute();
      await db.schema
        .createIndex('catalog_category_mappings_tenant_status_idx')
        .on('catalog_category_mappings')
        .columns(['tenant_id', 'status'])
        .execute();
    },
  },
  {
    name: 'catalog.0003_brands',
    up: async (db) => {
      await db.schema
        .createTable('catalog_brands')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('slug', 'text', (c) => c.notNull())
        .addColumn('extraction_rule', 'text', (c) => c.notNull())
        .addColumn('min_items_met', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('catalog_brands_tenant_slug_idx')
        .on('catalog_brands')
        .columns(['tenant_id', 'slug'])
        .unique()
        .execute();
    },
  },
  {
    name: 'catalog.0004_products',
    up: async (db) => {
      await db.schema
        .createTable('catalog_products')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('source_item_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('description', 'text')
        .addColumn('department_id', 'text')
        .addColumn('brand_id', 'text')
        .addColumn('source_category_name', 'text')
        .addColumn('publication_state', 'text', (c) => c.notNull())
        .addColumn('exclusion_reason', 'text')
        .addColumn('archived', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('catalog_products_tenant_source_idx')
        .on('catalog_products')
        .columns(['tenant_id', 'source_item_id'])
        .unique()
        .execute();
      await db.schema
        .createIndex('catalog_products_tenant_pubstate_idx')
        .on('catalog_products')
        .columns(['tenant_id', 'publication_state'])
        .execute();
    },
  },
  {
    name: 'catalog.0005_variations',
    up: async (db) => {
      await db.schema
        .createTable('catalog_variations')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('product_id', 'text', (c) => c.notNull())
        .addColumn('source_variation_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('sku', 'text')
        .addColumn('price_cents', 'integer')
        .addColumn('price_book_id', 'text')
        .addColumn('track_inventory', 'integer', (c) => c.notNull())
        .addColumn('archived', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('catalog_variations_tenant_source_idx')
        .on('catalog_variations')
        .columns(['tenant_id', 'source_variation_id'])
        .unique()
        .execute();
      await db.schema
        .createIndex('catalog_variations_tenant_product_idx')
        .on('catalog_variations')
        .columns(['tenant_id', 'product_id'])
        .execute();
      await db.schema
        .createIndex('catalog_variations_tenant_sku_idx')
        .on('catalog_variations')
        .columns(['tenant_id', 'sku'])
        .execute();
    },
  },
  {
    name: 'catalog.0006_barcodes',
    up: async (db) => {
      await db.schema
        .createTable('catalog_barcodes')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('variation_id', 'text', (c) => c.notNull())
        .addColumn('code_raw', 'text', (c) => c.notNull())
        .addColumn('code_normalized', 'text', (c) => c.notNull())
        .addColumn('symbology', 'text', (c) => c.notNull())
        .addColumn('checksum_valid', 'integer', (c) => c.notNull())
        .addColumn('is_primary', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('catalog_barcodes_tenant_variation_idx')
        .on('catalog_barcodes')
        .columns(['tenant_id', 'variation_id'])
        .execute();
      await db.schema
        .createIndex('catalog_barcodes_tenant_norm_idx')
        .on('catalog_barcodes')
        .columns(['tenant_id', 'code_normalized'])
        .execute();
      // A given raw code appears at most once per variation (idempotent import).
      await db.schema
        .createIndex('catalog_barcodes_tenant_variation_raw_idx')
        .on('catalog_barcodes')
        .columns(['tenant_id', 'variation_id', 'code_raw'])
        .unique()
        .execute();
    },
  },
  {
    name: 'catalog.0007_price_books',
    up: async (db) => {
      await db.schema
        .createTable('catalog_price_books')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('currency', 'text', (c) => c.notNull())
        .addColumn('effective_from', 'text')
        .addColumn('effective_to', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('catalog_price_books_tenant_id_idx')
        .on('catalog_price_books')
        .column('tenant_id')
        .execute();
    },
  },
  {
    name: 'catalog.0008_price_entries',
    up: async (db) => {
      await db.schema
        .createTable('catalog_price_entries')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('price_book_id', 'text', (c) => c.notNull())
        .addColumn('variation_id', 'text', (c) => c.notNull())
        .addColumn('price_cents', 'integer', (c) => c.notNull())
        .addColumn('effective_from', 'text')
        .addColumn('effective_to', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('catalog_price_entries_tenant_variation_idx')
        .on('catalog_price_entries')
        .columns(['tenant_id', 'variation_id'])
        .execute();
      await db.schema
        .createIndex('catalog_price_entries_tenant_book_idx')
        .on('catalog_price_entries')
        .columns(['tenant_id', 'price_book_id'])
        .execute();
    },
  },
  {
    name: 'catalog.0009_promotions',
    up: async (db) => {
      await db.schema
        .createTable('catalog_promotions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('type', 'text', (c) => c.notNull())
        .addColumn('value', 'integer', (c) => c.notNull())
        .addColumn('scope', 'text', (c) => c.notNull())
        .addColumn('starts_at', 'text')
        .addColumn('ends_at', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('catalog_promotions_tenant_id_idx')
        .on('catalog_promotions')
        .column('tenant_id')
        .execute();
    },
  },
  {
    name: 'catalog.0010_kits',
    up: async (db) => {
      await db.schema
        .createTable('catalog_kits')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('product_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('archived', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('catalog_kits_tenant_product_idx')
        .on('catalog_kits')
        .columns(['tenant_id', 'product_id'])
        .unique()
        .execute();
    },
  },
  {
    name: 'catalog.0011_kit_components',
    up: async (db) => {
      await db.schema
        .createTable('catalog_kit_components')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('kit_id', 'text', (c) => c.notNull())
        .addColumn('variation_id', 'text', (c) => c.notNull())
        .addColumn('quantity', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('catalog_kit_components_tenant_kit_idx')
        .on('catalog_kit_components')
        .columns(['tenant_id', 'kit_id'])
        .execute();
    },
  },
  {
    name: 'catalog.0012_bulk_jobs',
    up: async (db) => {
      await db.schema
        .createTable('catalog_bulk_jobs')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('rows_total', 'integer', (c) => c.notNull())
        .addColumn('rows_ok', 'integer', (c) => c.notNull())
        .addColumn('rows_failed', 'integer', (c) => c.notNull())
        .addColumn('errors', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('catalog_bulk_jobs_tenant_id_idx')
        .on('catalog_bulk_jobs')
        .column('tenant_id')
        .execute();
    },
  },
];
