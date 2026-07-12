import type { Migration } from '@blacklabel/db';

/**
 * admin migrations. Append-only. Every tenant_id column gets an index.
 * Portable SQL only: text ids, ISO text timestamps, integer booleans/cents,
 * no AUTOINCREMENT, no ON CONFLICT, no triggers/views.
 */
export const adminMigrations: Migration[] = [
  {
    name: 'admin.0001_credentials',
    up: async (db) => {
      await db.schema
        .createTable('admin_credentials')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('provider', 'text', (c) => c.notNull())
        .addColumn('payload_encrypted', 'text', (c) => c.notNull())
        .addColumn('fields_masked', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('last_tested_at', 'text')
        .addColumn('expires_at', 'text')
        .addColumn('rotated_from', 'text')
        .addColumn('archived_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('admin_credentials_tenant_idx')
        .on('admin_credentials')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('admin_credentials_tenant_expires_idx')
        .on('admin_credentials')
        .columns(['tenant_id', 'expires_at'])
        .execute();
    },
  },
  {
    name: 'admin.0002_settings',
    up: async (db) => {
      await db.schema
        .createTable('admin_settings')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('data', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      // One settings row per tenant.
      await db.schema
        .createIndex('admin_settings_tenant_idx')
        .on('admin_settings')
        .column('tenant_id')
        .unique()
        .execute();
    },
  },
  {
    name: 'admin.0003_health_runs',
    up: async (db) => {
      await db.schema
        .createTable('admin_health_runs')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('started_at', 'text', (c) => c.notNull())
        .addColumn('finished_at', 'text', (c) => c.notNull())
        .addColumn('overall_ok', 'integer', (c) => c.notNull())
        .addColumn('total', 'integer', (c) => c.notNull())
        .addColumn('ok_count', 'integer', (c) => c.notNull())
        .addColumn('critical_failures', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('admin_health_runs_tenant_created_idx')
        .on('admin_health_runs')
        .columns(['tenant_id', 'created_at'])
        .execute();
    },
  },
  {
    name: 'admin.0004_health_rows',
    up: async (db) => {
      await db.schema
        .createTable('admin_health_rows')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('run_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('critical', 'integer', (c) => c.notNull())
        .addColumn('ok', 'integer', (c) => c.notNull())
        .addColumn('detail', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('admin_health_rows_tenant_run_idx')
        .on('admin_health_rows')
        .columns(['tenant_id', 'run_id'])
        .execute();
    },
  },
  {
    name: 'admin.0005_backups',
    up: async (db) => {
      await db.schema
        .createTable('admin_backups')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('path', 'text', (c) => c.notNull())
        .addColumn('bytes', 'integer', (c) => c.notNull())
        .addColumn('sha256', 'text', (c) => c.notNull())
        .addColumn('encrypted', 'integer', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('detail', 'text')
        .addColumn('verified_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('admin_backups_tenant_created_idx')
        .on('admin_backups')
        .columns(['tenant_id', 'created_at'])
        .execute();
    },
  },
  {
    name: 'admin.0006_jobs',
    up: async (db) => {
      await db.schema
        .createTable('admin_jobs')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('detail', 'text')
        .addColumn('started_at', 'text', (c) => c.notNull())
        .addColumn('finished_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('admin_jobs_tenant_created_idx')
        .on('admin_jobs')
        .columns(['tenant_id', 'created_at'])
        .execute();
    },
  },
];
