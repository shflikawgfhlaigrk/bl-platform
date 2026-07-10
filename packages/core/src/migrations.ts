import type { Migration } from '@blacklabel/db';

/**
 * Core migrations. The api app (and every module test) runs these FIRST,
 * then the module's own migrations:
 *
 *   await runMigrations(db, [...coreMigrations, ...crmMigrations]);
 */
export const coreMigrations: Migration[] = [
  {
    name: 'core.0001_tenants_users',
    up: async (db) => {
      await db.schema
        .createTable('tenants')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('users')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('email', 'text', (c) => c.notNull())
        .addColumn('role', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('users_tenant_id_idx')
        .on('users')
        .column('tenant_id')
        .execute();
    },
  },
  {
    name: 'core.0002_audit_log',
    up: async (db) => {
      await db.schema
        .createTable('audit_log')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('actor', 'text', (c) => c.notNull())
        .addColumn('action', 'text', (c) => c.notNull())
        .addColumn('entity_type', 'text', (c) => c.notNull())
        .addColumn('entity_id', 'text', (c) => c.notNull())
        .addColumn('diff', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('audit_log_tenant_id_idx')
        .on('audit_log')
        .column('tenant_id')
        .execute();

      await db.schema
        .createIndex('audit_log_entity_idx')
        .on('audit_log')
        .columns(['tenant_id', 'entity_type', 'entity_id'])
        .execute();
    },
  },
  {
    name: 'core.0003_custom_field_definitions',
    up: async (db) => {
      await db.schema
        .createTable('custom_field_definitions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('entity_type', 'text', (c) => c.notNull())
        .addColumn('key', 'text', (c) => c.notNull())
        .addColumn('label', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('custom_field_definitions_unique_key_idx')
        .on('custom_field_definitions')
        .columns(['tenant_id', 'entity_type', 'key'])
        .unique()
        .execute();
    },
  },
];
