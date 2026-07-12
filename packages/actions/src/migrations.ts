import type { Migration } from '@blacklabel/db';

export const actionsMigrations: Migration[] = [
  {
    name: 'actions.0001_actions',
    up: async (db) => {
      await db.schema
        .createTable('actions_actions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('body', 'text')
        .addColumn('owner_user_id', 'text')
        .addColumn('priority', 'text', (c) => c.notNull())
        .addColumn('due_at', 'text')
        .addColumn('evidence', 'text')
        .addColumn('deep_link', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('snoozed_until', 'text')
        .addColumn('snooze_reason', 'text')
        .addColumn('source_module', 'text')
        .addColumn('source_entity_type', 'text')
        .addColumn('source_entity_id', 'text')
        .addColumn('dedupe_key', 'text', (c) => c.notNull())
        .addColumn('resolution_kind', 'text')
        .addColumn('resolution_proof', 'text')
        .addColumn('resolved_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      // Dedupe lookups (NOT unique — resolved rows may share a dedupe_key with a
      // new live one; active-uniqueness is enforced by check-then-insert).
      await db.schema
        .createIndex('actions_actions_tenant_dedupe_idx')
        .on('actions_actions')
        .columns(['tenant_id', 'dedupe_key'])
        .execute();
      await db.schema
        .createIndex('actions_actions_tenant_status_idx')
        .on('actions_actions')
        .columns(['tenant_id', 'status'])
        .execute();
      await db.schema
        .createIndex('actions_actions_tenant_kind_idx')
        .on('actions_actions')
        .columns(['tenant_id', 'kind'])
        .execute();
      await db.schema
        .createIndex('actions_actions_tenant_source_idx')
        .on('actions_actions')
        .columns(['tenant_id', 'source_entity_type', 'source_entity_id'])
        .execute();
    },
  },
  {
    name: 'actions.0002_comments',
    up: async (db) => {
      await db.schema
        .createTable('actions_comments')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('action_id', 'text', (c) => c.notNull())
        .addColumn('author', 'text', (c) => c.notNull())
        .addColumn('body', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('actions_comments_tenant_action_idx')
        .on('actions_comments')
        .columns(['tenant_id', 'action_id'])
        .execute();
    },
  },
  {
    name: 'actions.0003_escalations',
    up: async (db) => {
      await db.schema
        .createTable('actions_escalations')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('action_id', 'text', (c) => c.notNull())
        .addColumn('from_priority', 'text', (c) => c.notNull())
        .addColumn('to_priority', 'text', (c) => c.notNull())
        .addColumn('reason', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('actions_escalations_tenant_action_idx')
        .on('actions_escalations')
        .columns(['tenant_id', 'action_id'])
        .execute();
    },
  },
];
