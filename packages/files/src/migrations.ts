import type { Migration } from '@blacklabel/db';

/**
 * files module migrations — append-only (see /CONVENTIONS.md §3).
 * Portable column types only: text, integer (booleans as 0/1), ISO-8601 text
 * timestamps. Every table carries tenant_id and a tenant_id-leading index.
 */
export const filesMigrations: Migration[] = [
  {
    name: 'files.0001_files_tables',
    up: async (db) => {
      await db.schema
        .createTable('files_folders')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('parent_id', 'text')
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('files_folders_tenant_parent_idx')
        .on('files_folders')
        .columns(['tenant_id', 'parent_id'])
        .execute();

      await db.schema
        .createTable('files_assets')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('folder_id', 'text')
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('mime', 'text', (c) => c.notNull())
        .addColumn('size_bytes', 'integer', (c) => c.notNull())
        .addColumn('sha256', 'text', (c) => c.notNull())
        .addColumn('storage_key', 'text', (c) => c.notNull())
        .addColumn('uploaded_by', 'text', (c) => c.notNull())
        .addColumn('visibility', 'text', (c) => c.notNull())
        .addColumn('tags', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('files_assets_tenant_folder_idx')
        .on('files_assets')
        .columns(['tenant_id', 'folder_id'])
        .execute();
      await db.schema
        .createIndex('files_assets_tenant_sha256_idx')
        .on('files_assets')
        .columns(['tenant_id', 'sha256'])
        .execute();

      await db.schema
        .createTable('files_links')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('file_id', 'text', (c) => c.notNull())
        .addColumn('entity_type', 'text', (c) => c.notNull())
        .addColumn('entity_id', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('files_links_tenant_entity_idx')
        .on('files_links')
        .columns(['tenant_id', 'entity_type', 'entity_id'])
        .execute();
      await db.schema
        .createIndex('files_links_tenant_file_idx')
        .on('files_links')
        .columns(['tenant_id', 'file_id'])
        .execute();

      await db.schema
        .createTable('files_upload_sessions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('folder_id', 'text')
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('mime', 'text', (c) => c.notNull())
        .addColumn('visibility', 'text', (c) => c.notNull())
        .addColumn('tags', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('storage_key', 'text', (c) => c.notNull())
        .addColumn('created_by', 'text', (c) => c.notNull())
        .addColumn('file_id', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('completed_at', 'text')
        .execute();
      await db.schema
        .createIndex('files_upload_sessions_tenant_status_idx')
        .on('files_upload_sessions')
        .columns(['tenant_id', 'status'])
        .execute();

      await db.schema
        .createTable('files_permissions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('file_id', 'text', (c) => c.notNull())
        .addColumn('grantee_type', 'text', (c) => c.notNull())
        .addColumn('grantee', 'text', (c) => c.notNull())
        .addColumn('can_write', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('files_permissions_tenant_file_idx')
        .on('files_permissions')
        .columns(['tenant_id', 'file_id'])
        .execute();
    },
  },
];
