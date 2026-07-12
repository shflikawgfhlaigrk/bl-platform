import type { Migration } from '@blacklabel/db';

/**
 * storefront projection migrations. Append-only. Every table carries
 * `tenant_id` + a `tenant_id` index. No PII/cost/revenue/count columns exist
 * here by construction (see schema.ts).
 */
export const storefrontMigrations: Migration[] = [
  {
    name: 'storefront.0001_publish_runs',
    up: async (db) => {
      await db.schema
        .createTable('storefront_publish_runs')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('data_as_of', 'text', (c) => c.notNull())
        .addColumn('item_count', 'integer', (c) => c.notNull())
        .addColumn('variation_count', 'integer', (c) => c.notNull())
        .addColumn('page_count', 'integer', (c) => c.notNull())
        .addColumn('checksum', 'text', (c) => c.notNull())
        .addColumn('duration_ms', 'integer', (c) => c.notNull())
        .addColumn('gate_results', 'text', (c) => c.notNull())
        .addColumn('failures', 'text', (c) => c.notNull())
        .addColumn('error', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('storefront_publish_runs_tenant_id_idx')
        .on('storefront_publish_runs')
        .columns(['tenant_id', 'status'])
        .execute();
    },
  },
  {
    name: 'storefront.0002_published_items',
    up: async (db) => {
      await db.schema
        .createTable('storefront_published_items')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('publish_run_id', 'text', (c) => c.notNull())
        .addColumn('source_product_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('description', 'text')
        .addColumn('department_slug', 'text')
        .addColumn('department_name', 'text')
        .addColumn('category_name', 'text')
        .addColumn('brand_slug', 'text')
        .addColumn('brand_name', 'text')
        .addColumn('slug', 'text', (c) => c.notNull())
        .addColumn('images', 'text', (c) => c.notNull())
        .addColumn('velocity_rank', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('storefront_published_items_tenant_id_idx')
        .on('storefront_published_items')
        .columns(['tenant_id', 'publish_run_id'])
        .execute();
    },
  },
  {
    name: 'storefront.0003_published_variations',
    up: async (db) => {
      await db.schema
        .createTable('storefront_published_variations')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('publish_run_id', 'text', (c) => c.notNull())
        .addColumn('item_id', 'text', (c) => c.notNull())
        .addColumn('source_variation_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('sku', 'text')
        .addColumn('price_cents', 'integer')
        .addColumn('sort', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('storefront_published_variations_tenant_id_idx')
        .on('storefront_published_variations')
        .columns(['tenant_id', 'publish_run_id', 'item_id'])
        .execute();
    },
  },
  {
    name: 'storefront.0004_availability',
    up: async (db) => {
      await db.schema
        .createTable('storefront_availability')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('publish_run_id', 'text', (c) => c.notNull())
        .addColumn('variation_id', 'text', (c) => c.notNull())
        .addColumn('state', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('storefront_availability_tenant_id_idx')
        .on('storefront_availability')
        .columns(['tenant_id', 'publish_run_id', 'variation_id'])
        .execute();
    },
  },
  {
    name: 'storefront.0005_pages',
    up: async (db) => {
      await db.schema
        .createTable('storefront_pages')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('publish_run_id', 'text', (c) => c.notNull())
        .addColumn('path', 'text', (c) => c.notNull())
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('description', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('storefront_pages_tenant_id_idx')
        .on('storefront_pages')
        .columns(['tenant_id', 'publish_run_id'])
        .execute();
    },
  },
];
