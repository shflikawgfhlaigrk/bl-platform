import type { Migration } from '@blacklabel/db';

export const executionJournalMigration: Migration = {
  name: 'client_ops.0005_execution_journal',
  up: async (db) => {
    await db.schema.createTable('client_ops_execution_journal')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('tenant_id', 'text', (c) => c.notNull())
      .addColumn('installation_id', 'text', (c) => c.notNull())
      .addColumn('root_run_id', 'text', (c) => c.notNull())
      .addColumn('action_key', 'text', (c) => c.notNull())
      .addColumn('request_sha256', 'text', (c) => c.notNull())
      .addColumn('output_json', 'text', (c) => c.notNull())
      .addColumn('references_json', 'text', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();
    await db.schema.createIndex('client_ops_execution_journal_scope_unique')
      .on('client_ops_execution_journal')
      .columns(['tenant_id', 'root_run_id', 'action_key']).unique().execute();
  },
};
