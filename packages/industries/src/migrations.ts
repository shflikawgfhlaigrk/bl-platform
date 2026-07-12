import type { Migration } from '@blacklabel/db';

/**
 * Industries module migrations. Run AFTER coreMigrations:
 *
 *   await runMigrations(db, [...coreMigrations, ...industriesMigrations]);
 *
 * Append-only — never edit or reorder a shipped migration.
 */
export const industriesMigrations: Migration[] = [
  {
    name: 'industries.0001_industry_defaults',
    up: async (db) => {
      await db.schema
        .createTable('industries_tenant_settings')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('industry_key', 'text', (c) => c.notNull())
        .addColumn('terminology', 'text', (c) => c.notNull())
        .addColumn('applied_at', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('industries_tenant_settings_tenant_id_idx')
        .on('industries_tenant_settings')
        .column('tenant_id')
        .unique()
        .execute();

      await db.schema
        .createTable('industries_lead_stages')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('key', 'text', (c) => c.notNull())
        .addColumn('label', 'text', (c) => c.notNull())
        .addColumn('sort_order', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('industries_lead_stages_tenant_key_idx')
        .on('industries_lead_stages')
        .columns(['tenant_id', 'key'])
        .unique()
        .execute();

      await db.schema
        .createTable('industries_quote_templates')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('key', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('description', 'text')
        .addColumn('lines', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('industries_quote_templates_tenant_key_idx')
        .on('industries_quote_templates')
        .columns(['tenant_id', 'key'])
        .unique()
        .execute();

      await db.schema
        .createTable('industries_appointment_types')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('key', 'text', (c) => c.notNull())
        .addColumn('label', 'text', (c) => c.notNull())
        .addColumn('duration_minutes', 'integer', (c) => c.notNull())
        .addColumn('description', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('industries_appointment_types_tenant_key_idx')
        .on('industries_appointment_types')
        .columns(['tenant_id', 'key'])
        .unique()
        .execute();

      await db.schema
        .createTable('industries_dashboard_widgets')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('key', 'text', (c) => c.notNull())
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('widget_type', 'text', (c) => c.notNull())
        .addColumn('config', 'text')
        .addColumn('sort_order', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('industries_dashboard_widgets_tenant_key_idx')
        .on('industries_dashboard_widgets')
        .columns(['tenant_id', 'key'])
        .unique()
        .execute();

      await db.schema
        .createTable('industries_workflow_definitions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('key', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('trigger', 'text', (c) => c.notNull())
        .addColumn('definition', 'text', (c) => c.notNull())
        .addColumn('enabled', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('industries_workflow_definitions_tenant_key_idx')
        .on('industries_workflow_definitions')
        .columns(['tenant_id', 'key'])
        .unique()
        .execute();
    },
  },
];
