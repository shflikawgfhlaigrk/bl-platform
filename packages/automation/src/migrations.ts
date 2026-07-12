import type { Migration } from '@blacklabel/db';

export const automationMigrations: Migration[] = [
  {
    name: 'automation.0001_outbox',
    up: async (db) => {
      await db.schema
        .createTable('automation_outbox')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('idempotency_key', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('payload', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('attempts', 'integer', (c) => c.notNull())
        .addColumn('max_attempts', 'integer', (c) => c.notNull())
        .addColumn('next_attempt_at', 'text', (c) => c.notNull())
        .addColumn('last_error', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .addColumn('delivered_at', 'text')
        .execute();
      // Idempotency: at most one row per (tenant, idempotency_key).
      await db.schema
        .createIndex('automation_outbox_tenant_key_idx')
        .on('automation_outbox')
        .columns(['tenant_id', 'idempotency_key'])
        .unique()
        .execute();
      // Dispatcher claim path: due rows by tenant/status/time.
      await db.schema
        .createIndex('automation_outbox_tenant_status_next_idx')
        .on('automation_outbox')
        .columns(['tenant_id', 'status', 'next_attempt_at'])
        .execute();
    },
  },
  {
    name: 'automation.0002_rules',
    up: async (db) => {
      await db.schema
        .createTable('automation_rules')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('rule_key', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('version', 'integer', (c) => c.notNull())
        .addColumn('trigger_event', 'text', (c) => c.notNull())
        .addColumn('conditions', 'text', (c) => c.notNull())
        .addColumn('action_kind', 'text', (c) => c.notNull())
        .addColumn('action_template', 'text', (c) => c.notNull())
        .addColumn('policy', 'text', (c) => c.notNull())
        .addColumn('schedule', 'text')
        .addColumn('idempotency_window_seconds', 'integer', (c) => c.notNull())
        .addColumn('enabled', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      // One row per (tenant, rule_key, version).
      await db.schema
        .createIndex('automation_rules_tenant_key_version_idx')
        .on('automation_rules')
        .columns(['tenant_id', 'rule_key', 'version'])
        .unique()
        .execute();
      // Evaluate lookup by trigger event.
      await db.schema
        .createIndex('automation_rules_tenant_trigger_idx')
        .on('automation_rules')
        .columns(['tenant_id', 'trigger_event'])
        .execute();
    },
  },
  {
    name: 'automation.0003_executions',
    up: async (db) => {
      await db.schema
        .createTable('automation_executions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('rule_id', 'text', (c) => c.notNull())
        .addColumn('rule_version', 'integer', (c) => c.notNull())
        .addColumn('event_type', 'text', (c) => c.notNull())
        .addColumn('event_payload', 'text', (c) => c.notNull())
        .addColumn('matched', 'integer', (c) => c.notNull())
        .addColumn('outcome', 'text', (c) => c.notNull())
        .addColumn('outbox_id', 'text')
        .addColumn('dedupe_key', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('automation_executions_tenant_created_idx')
        .on('automation_executions')
        .columns(['tenant_id', 'created_at'])
        .execute();
      await db.schema
        .createIndex('automation_executions_tenant_rule_idx')
        .on('automation_executions')
        .columns(['tenant_id', 'rule_id'])
        .execute();
      // Idempotency-window dedup lookup.
      await db.schema
        .createIndex('automation_executions_tenant_dedupe_idx')
        .on('automation_executions')
        .columns(['tenant_id', 'dedupe_key'])
        .execute();
    },
  },
  {
    name: 'automation.0004_approvals',
    up: async (db) => {
      await db.schema
        .createTable('automation_approvals')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('rule_id', 'text', (c) => c.notNull())
        .addColumn('rule_version', 'integer', (c) => c.notNull())
        .addColumn('execution_id', 'text', (c) => c.notNull())
        .addColumn('action_kind', 'text', (c) => c.notNull())
        .addColumn('action_payload', 'text', (c) => c.notNull())
        .addColumn('idempotency_key', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('reason', 'text')
        .addColumn('outbox_id', 'text')
        .addColumn('decided_by', 'text')
        .addColumn('decided_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('automation_approvals_tenant_status_idx')
        .on('automation_approvals')
        .columns(['tenant_id', 'status'])
        .execute();
      await db.schema
        .createIndex('automation_approvals_tenant_id_idx')
        .on('automation_approvals')
        .column('tenant_id')
        .execute();
    },
  },
];
