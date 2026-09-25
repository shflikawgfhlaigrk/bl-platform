import type { Migration } from '@blacklabel/db';

export interface BarDocumentRow {
  id: string;
  tenant_id: string;
  kind: string;
  lifecycle: string;
  version: number;
  data: string;
  created_at: string;
  updated_at: string;
}
export interface BarCommandRow {
  id: string;
  tenant_id: string;
  request_key: string;
  fact_hash: string;
  result: string;
  created_at: string;
}
export interface BarTables {
  api_bar_documents: BarDocumentRow;
  api_bar_commands: BarCommandRow;
}

export const barPosMigrations: Migration[] = [{
  name: 'api.0007_bar_workspace',
  up: async (db) => {
    await db.schema.createTable('api_bar_documents')
      .addColumn('id', 'text', c => c.primaryKey())
      .addColumn('tenant_id', 'text', c => c.notNull())
      .addColumn('kind', 'text', c => c.notNull())
      .addColumn('version', 'integer', c => c.notNull())
      .addColumn('data', 'text', c => c.notNull())
      .addColumn('created_at', 'text', c => c.notNull())
      .addColumn('updated_at', 'text', c => c.notNull()).execute();
    await db.schema.createIndex('api_bar_documents_tenant_kind_idx').on('api_bar_documents')
      .columns(['tenant_id', 'kind', 'updated_at']).execute();
    await db.schema.createTable('api_bar_commands')
      .addColumn('id', 'text', c => c.primaryKey())
      .addColumn('tenant_id', 'text', c => c.notNull())
      .addColumn('request_key', 'text', c => c.notNull())
      .addColumn('fact_hash', 'text', c => c.notNull())
      .addColumn('result', 'text', c => c.notNull())
      .addColumn('created_at', 'text', c => c.notNull()).execute();
    await db.schema.createIndex('api_bar_commands_tenant_key_idx').on('api_bar_commands')
      .columns(['tenant_id', 'request_key']).unique().execute();
  },
}, {
  name: 'api.0008_bar_active_documents',
  up: async (db) => {
    await db.schema.alterTable('api_bar_documents').addColumn('lifecycle', 'text', c => c.notNull().defaultTo('')).execute();
    // Decode in application code; no SQLite-specific JSON functions.
    const typed = db as unknown as import('kysely').Kysely<BarTables>;
    const tenants = await typed.selectFrom('api_bar_documents').select('tenant_id').distinct().execute();
    for (const { tenant_id } of tenants) {
      const docs = await typed.selectFrom('api_bar_documents').selectAll().where('tenant_id', '=', tenant_id).execute();
      for (const doc of docs) {
        const value = JSON.parse(doc.data);
        if (typeof value.status === 'string') await typed.updateTable('api_bar_documents')
          .set({ lifecycle: value.status }).where('tenant_id', '=', tenant_id).where('id', '=', doc.id).execute();
      }
    }
    await db.schema.createIndex('api_bar_active_documents_idx').on('api_bar_documents')
      .columns(['tenant_id', 'kind', 'lifecycle', 'updated_at']).execute();
  },
}];
