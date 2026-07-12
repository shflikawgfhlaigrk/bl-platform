import type { Migration } from '@blacklabel/db';

/**
 * Dashboard-owned tables ONLY. The dashboard reads other modules' tables
 * (see schema.ts) but NEVER creates or alters them — those tables belong to
 * their owning modules' migrations.
 */
export const dashboardMigrations: Migration[] = [
  {
    name: 'dashboard.0001_widget_configs',
    up: async (db) => {
      await db.schema
        .createTable('dashboard_widget_configs')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('widget_key', 'text', (c) => c.notNull())
        .addColumn('position', 'integer', (c) => c.notNull())
        .addColumn('enabled', 'integer', (c) => c.notNull())
        .addColumn('settings', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('dashboard_widget_configs_tenant_id_idx')
        .on('dashboard_widget_configs')
        .column('tenant_id')
        .execute();

      await db.schema
        .createIndex('dashboard_widget_configs_tenant_widget_idx')
        .on('dashboard_widget_configs')
        .columns(['tenant_id', 'widget_key'])
        .unique()
        .execute();
    },
  },
  {
    name: 'dashboard.0002_alert_rules',
    up: async (db) => {
      await db.schema
        .createTable('dashboard_alert_rules')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('metric', 'text', (c) => c.notNull())
        .addColumn('threshold', 'real', (c) => c.notNull())
        .addColumn('direction', 'text', (c) => c.notNull())
        .addColumn('enabled', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('dashboard_alert_rules_tenant_id_idx')
        .on('dashboard_alert_rules')
        .column('tenant_id')
        .execute();
    },
  },
];
