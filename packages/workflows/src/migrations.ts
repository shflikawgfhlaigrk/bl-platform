import type { Migration } from '@blacklabel/db';

/**
 * Workflows module migrations. Run AFTER coreMigrations:
 *   await runMigrations(db, [...coreMigrations, ...workflowsMigrations]);
 * Append-only — never edit or reorder a shipped migration.
 */
export const workflowsMigrations: Migration[] = [
  {
    name: 'workflows.0001_workflows_and_actions',
    up: async (db) => {
      await db.schema
        .createTable('workflows_workflows')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('trigger_event', 'text', (c) => c.notNull())
        .addColumn('condition_json', 'text')
        .addColumn('enabled', 'integer', (c) => c.notNull())
        .addColumn('max_attempts', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('workflows_workflows_tenant_trigger_idx')
        .on('workflows_workflows')
        .columns(['tenant_id', 'trigger_event'])
        .execute();

      await db.schema
        .createTable('workflows_workflow_actions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('workflow_id', 'text', (c) => c.notNull())
        .addColumn('position', 'integer', (c) => c.notNull())
        .addColumn('type', 'text', (c) => c.notNull())
        .addColumn('config_json', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('workflows_workflow_actions_tenant_workflow_idx')
        .on('workflows_workflow_actions')
        .columns(['tenant_id', 'workflow_id'])
        .execute();
    },
  },
  {
    name: 'workflows.0002_executions',
    up: async (db) => {
      await db.schema
        .createTable('workflows_executions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('workflow_id', 'text', (c) => c.notNull())
        .addColumn('trigger_event', 'text', (c) => c.notNull())
        .addColumn('trigger_payload_json', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('attempts', 'integer', (c) => c.notNull())
        .addColumn('next_retry_at', 'text')
        .addColumn('failed_action_ids_json', 'text')
        .addColumn('started_at', 'text', (c) => c.notNull())
        .addColumn('finished_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('workflows_executions_tenant_id_idx')
        .on('workflows_executions')
        .column('tenant_id')
        .execute();

      await db.schema
        .createIndex('workflows_executions_tenant_status_retry_idx')
        .on('workflows_executions')
        .columns(['tenant_id', 'status', 'next_retry_at'])
        .execute();

      await db.schema
        .createTable('workflows_execution_actions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('execution_id', 'text', (c) => c.notNull())
        .addColumn('action_id', 'text', (c) => c.notNull())
        .addColumn('attempt', 'integer', (c) => c.notNull())
        .addColumn('position', 'integer', (c) => c.notNull())
        .addColumn('type', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('output_json', 'text')
        .addColumn('error', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('workflows_execution_actions_tenant_execution_idx')
        .on('workflows_execution_actions')
        .columns(['tenant_id', 'execution_id'])
        .execute();
    },
  },
  {
    name: 'workflows.0003_tasks_notifications_tags',
    up: async (db) => {
      await db.schema
        .createTable('workflows_tasks')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('description', 'text')
        .addColumn('assignee_user_id', 'text')
        .addColumn('due_at', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('related_entity_type', 'text')
        .addColumn('related_entity_id', 'text')
        .addColumn('completed_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('workflows_tasks_tenant_status_idx')
        .on('workflows_tasks')
        .columns(['tenant_id', 'status'])
        .execute();

      await db.schema
        .createTable('workflows_notifications')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('user_id', 'text', (c) => c.notNull())
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('body', 'text')
        .addColumn('read', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('workflows_notifications_tenant_user_idx')
        .on('workflows_notifications')
        .columns(['tenant_id', 'user_id'])
        .execute();

      await db.schema
        .createTable('workflows_tags')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('entity_type', 'text', (c) => c.notNull())
        .addColumn('entity_id', 'text', (c) => c.notNull())
        .addColumn('tag', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('workflows_tags_tenant_entity_idx')
        .on('workflows_tags')
        .columns(['tenant_id', 'entity_type', 'entity_id'])
        .execute();
    },
  },
];
