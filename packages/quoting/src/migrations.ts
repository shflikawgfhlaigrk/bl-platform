import type { Migration } from '@blacklabel/db';

/**
 * Quoting module migrations. Append-only — never edit or reorder a shipped
 * migration; add a new one at the end of the array instead.
 */
export const quotingMigrations: Migration[] = [
  {
    name: 'quoting.0001_quoting_tables',
    up: async (db) => {
      await db.schema
        .createTable('quoting_quotes')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('customer_id', 'text', (c) => c.notNull())
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('notes', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('discount_bps', 'integer')
        .addColumn('discount_fixed_cents', 'integer')
        .addColumn('discount_id', 'text')
        .addColumn('tax_id', 'text')
        .addColumn('tax_bps', 'integer')
        .addColumn('valid_until', 'text')
        .addColumn('attachments', 'text', (c) => c.notNull())
        .addColumn('subtotal_cents', 'integer', (c) => c.notNull())
        .addColumn('discount_cents', 'integer', (c) => c.notNull())
        .addColumn('tax_cents', 'integer', (c) => c.notNull())
        .addColumn('total_cents', 'integer', (c) => c.notNull())
        .addColumn('total_cost_cents', 'integer', (c) => c.notNull())
        .addColumn('margin_cents', 'integer', (c) => c.notNull())
        .addColumn('margin_bps', 'integer', (c) => c.notNull())
        .addColumn('converted_at', 'text')
        .addColumn('invoice_id', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('quoting_quotes_tenant_id_idx')
        .on('quoting_quotes')
        .columns(['tenant_id', 'status'])
        .execute();

      await db.schema
        .createTable('quoting_quote_lines')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('quote_id', 'text', (c) => c.notNull())
        .addColumn('description', 'text', (c) => c.notNull())
        .addColumn('quantity', 'real', (c) => c.notNull())
        .addColumn('unit_price_cents', 'integer', (c) => c.notNull())
        .addColumn('unit_cost_cents', 'integer', (c) => c.notNull())
        .addColumn('effective_unit_price_cents', 'integer', (c) => c.notNull())
        .addColumn('discount_bps', 'integer')
        .addColumn('discount_fixed_cents', 'integer')
        .addColumn('total_cents', 'integer', (c) => c.notNull())
        .addColumn('position', 'integer', (c) => c.notNull())
        .addColumn('service_template_id', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('quoting_quote_lines_tenant_id_idx')
        .on('quoting_quote_lines')
        .columns(['tenant_id', 'quote_id'])
        .execute();

      await db.schema
        .createTable('quoting_pricing_rules')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('scope', 'text', (c) => c.notNull())
        .addColumn('conditions', 'text', (c) => c.notNull())
        .addColumn('action', 'text', (c) => c.notNull())
        .addColumn('active', 'integer', (c) => c.notNull())
        .addColumn('priority', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('quoting_pricing_rules_tenant_id_idx')
        .on('quoting_pricing_rules')
        .column('tenant_id')
        .execute();

      await db.schema
        .createTable('quoting_service_templates')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('description', 'text')
        .addColumn('line_items', 'text', (c) => c.notNull())
        .addColumn('child_template_ids', 'text', (c) => c.notNull())
        .addColumn('active', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('quoting_service_templates_tenant_id_idx')
        .on('quoting_service_templates')
        .column('tenant_id')
        .execute();

      await db.schema
        .createTable('quoting_discounts')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('bps', 'integer')
        .addColumn('fixed_cents', 'integer')
        .addColumn('active', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('quoting_discounts_tenant_id_idx')
        .on('quoting_discounts')
        .column('tenant_id')
        .execute();

      await db.schema
        .createTable('quoting_taxes')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('rate_bps', 'integer', (c) => c.notNull())
        .addColumn('active', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('quoting_taxes_tenant_id_idx')
        .on('quoting_taxes')
        .column('tenant_id')
        .execute();

      await db.schema
        .createTable('quoting_approval_events')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('quote_id', 'text', (c) => c.notNull())
        .addColumn('seq', 'integer', (c) => c.notNull())
        .addColumn('event_type', 'text', (c) => c.notNull())
        .addColumn('signer_name', 'text')
        .addColumn('signer_ip', 'text')
        .addColumn('payload_hash', 'text', (c) => c.notNull())
        .addColumn('note', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('quoting_approval_events_tenant_id_idx')
        .on('quoting_approval_events')
        .columns(['tenant_id', 'quote_id'])
        .execute();
    },
  },
  {
    name: 'quoting.0002_verified_conversions',
    up: async (db) => {
      await db.schema.createTable('quoting_conversions')
        .addColumn('id', 'text', c => c.primaryKey())
        .addColumn('tenant_id', 'text', c => c.notNull())
        .addColumn('quote_id', 'text', c => c.notNull())
        .addColumn('job_id', 'text', c => c.notNull())
        .addColumn('invoice_id', 'text', c => c.notNull())
        .addColumn('created_at', 'text', c => c.notNull()).execute();
      await db.schema.createIndex('quoting_conversions_tenant_quote_idx').on('quoting_conversions').columns(['tenant_id', 'quote_id']).unique().execute();
    },
  },
  {
    name: 'quoting.0003_immutable_scope_revisions',
    up: async (db) => {
      await db.schema.alterTable('quoting_quotes').addColumn('revision_number', 'integer', c => c.notNull().defaultTo(1)).execute();
      await db.schema.alterTable('quoting_quotes').addColumn('supersedes_quote_id', 'text').execute();
      await db.schema.alterTable('quoting_quotes').addColumn('superseded_by_quote_id', 'text').execute();
      await db.schema.createIndex('quoting_quotes_tenant_revision_idx').on('quoting_quotes').columns(['tenant_id', 'supersedes_quote_id']).unique().execute();
      await db.schema.alterTable('quoting_approval_events').addColumn('payload_schema_version', 'integer', c => c.notNull().defaultTo(1)).execute();
      // Legacy hashes are preserved as legacy evidence; never invent an old scope snapshot.
      await db.schema.alterTable('quoting_approval_events').addColumn('payload_json', 'text').execute();
    },
  },
];
