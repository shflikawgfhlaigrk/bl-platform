import type { Migration } from '@blacklabel/db';
import { executionJournalMigration } from './execution-migrations';

/** Append-only migrations for the client-ops module. */
export const clientOpsMigrations: Migration[] = [
  {
    name: 'client_ops.0001_installations',
    up: async (db) => {
      await db.schema
        .createTable('client_ops_installations')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('catalog_kind', 'text', (c) => c.notNull())
        .addColumn('catalog_id', 'text', (c) => c.notNull())
        .addColumn('engagement_model_id', 'text')
        .addColumn('manifest_sha256', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('client_ops_installations_tenant_created_idx')
        .on('client_ops_installations')
        .columns(['tenant_id', 'created_at'])
        .execute();

      await db.schema
        .createTable('client_ops_installed_workflows')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('installation_id', 'text', (c) => c.notNull())
        .addColumn('template_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('outcome', 'text', (c) => c.notNull())
        .addColumn('trigger_json', 'text', (c) => c.notNull())
        .addColumn('actions_json', 'text', (c) => c.notNull())
        .addColumn('approval_json', 'text', (c) => c.notNull())
        .addColumn('enabled', 'integer', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('client_ops_workflows_tenant_installation_template_idx')
        .on('client_ops_installed_workflows')
        .columns(['tenant_id', 'installation_id', 'template_id'])
        .unique()
        .execute();

      await db.schema
        .createTable('client_ops_connector_bindings')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('installation_id', 'text', (c) => c.notNull())
        .addColumn('connector_id', 'text', (c) => c.notNull())
        .addColumn('label', 'text', (c) => c.notNull())
        .addColumn('required', 'integer', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('credential_ref', 'text')
        .addColumn('metadata_json', 'text', (c) => c.notNull())
        .addColumn('health_json', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('client_ops_connectors_tenant_installation_connector_idx')
        .on('client_ops_connector_bindings')
        .columns(['tenant_id', 'installation_id', 'connector_id'])
        .unique()
        .execute();

      await db.schema
        .createTable('client_ops_onboarding_steps')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('installation_id', 'text', (c) => c.notNull())
        .addColumn('template_id', 'text', (c) => c.notNull())
        .addColumn('position', 'integer', (c) => c.notNull())
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('description', 'text', (c) => c.notNull())
        .addColumn('required', 'integer', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('evidence_json', 'text')
        .addColumn('completed_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('client_ops_onboarding_tenant_installation_position_idx')
        .on('client_ops_onboarding_steps')
        .columns(['tenant_id', 'installation_id', 'position', 'id'])
        .execute();
    },
  },
  {
    name: 'client_ops.0002_runs_and_reviews',
    up: async (db) => {
      await db.schema
        .createTable('client_ops_runs')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('installation_id', 'text', (c) => c.notNull())
        .addColumn('workflow_id', 'text', (c) => c.notNull())
        .addColumn('idempotency_key', 'text', (c) => c.notNull())
        .addColumn('root_run_id', 'text', (c) => c.notNull())
        .addColumn('retry_of_run_id', 'text')
        .addColumn('attempt', 'integer', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('input_json', 'text', (c) => c.notNull())
        .addColumn('output_json', 'text')
        .addColumn('error', 'text')
        .addColumn('requested_at', 'text', (c) => c.notNull())
        .addColumn('started_at', 'text')
        .addColumn('finished_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('client_ops_runs_tenant_idempotency_idx')
        .on('client_ops_runs')
        .columns(['tenant_id', 'idempotency_key'])
        .unique()
        .execute();
      await db.schema
        .createIndex('client_ops_runs_tenant_installation_created_idx')
        .on('client_ops_runs')
        .columns(['tenant_id', 'installation_id', 'created_at', 'id'])
        .execute();
      await db.schema
        .createIndex('client_ops_runs_tenant_root_attempt_idx')
        .on('client_ops_runs')
        .columns(['tenant_id', 'root_run_id', 'attempt', 'id'])
        .execute();

      await db.schema
        .createTable('client_ops_review_items')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('installation_id', 'text', (c) => c.notNull())
        .addColumn('run_id', 'text')
        .addColumn('workflow_id', 'text')
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('context_json', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('decision_note', 'text')
        .addColumn('decided_by', 'text')
        .addColumn('decided_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('client_ops_reviews_tenant_status_created_idx')
        .on('client_ops_review_items')
        .columns(['tenant_id', 'status', 'created_at', 'id'])
        .execute();
      await db.schema
        .createIndex('client_ops_reviews_tenant_installation_idx')
        .on('client_ops_review_items')
        .columns(['tenant_id', 'installation_id', 'id'])
        .execute();
    },
  },
  {
    name: 'client_ops.0003_evidence_and_usage',
    up: async (db) => {
      await db.schema
        .createTable('client_ops_artifacts')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('installation_id', 'text', (c) => c.notNull())
        .addColumn('run_id', 'text')
        .addColumn('review_item_id', 'text')
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('uri', 'text', (c) => c.notNull())
        .addColumn('media_type', 'text', (c) => c.notNull())
        .addColumn('sha256', 'text')
        .addColumn('metadata_json', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('client_ops_artifacts_tenant_installation_created_idx')
        .on('client_ops_artifacts')
        .columns(['tenant_id', 'installation_id', 'created_at', 'id'])
        .execute();

      await db.schema
        .createTable('client_ops_completion_receipts')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('installation_id', 'text', (c) => c.notNull())
        .addColumn('run_id', 'text', (c) => c.notNull())
        .addColumn('summary', 'text', (c) => c.notNull())
        .addColumn('verification_json', 'text', (c) => c.notNull())
        .addColumn('artifact_ids_json', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('client_ops_receipts_tenant_run_idx')
        .on('client_ops_completion_receipts')
        .columns(['tenant_id', 'run_id'])
        .unique()
        .execute();

      await db.schema
        .createTable('client_ops_usage_events')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('installation_id', 'text', (c) => c.notNull())
        .addColumn('run_id', 'text')
        .addColumn('provider', 'text', (c) => c.notNull())
        .addColumn('model', 'text')
        .addColumn('metric', 'text', (c) => c.notNull())
        .addColumn('quantity', 'integer', (c) => c.notNull())
        .addColumn('unit', 'text', (c) => c.notNull())
        .addColumn('cost_cents', 'integer', (c) => c.notNull())
        .addColumn('occurred_at', 'text', (c) => c.notNull())
        .addColumn('metadata_json', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('client_ops_usage_tenant_occurred_idx')
        .on('client_ops_usage_events')
        .columns(['tenant_id', 'occurred_at', 'id'])
        .execute();
      await db.schema
        .createIndex('client_ops_usage_tenant_installation_idx')
        .on('client_ops_usage_events')
        .columns(['tenant_id', 'installation_id', 'id'])
        .execute();
    },
  },
  {
    name: 'client_ops.0004_portfolio_evidence',
    up: async (db) => {
      await db.schema
        .createTable('client_ops_portfolio_test_runs')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('product_key', 'text', (c) => c.notNull())
        .addColumn('target_kind', 'text', (c) => c.notNull())
        .addColumn('target_key', 'text', (c) => c.notNull())
        .addColumn('suite_key', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('requested_by', 'text', (c) => c.notNull())
        .addColumn('source_revision', 'text')
        .addColumn('started_at', 'text')
        .addColumn('finished_at', 'text')
        .addColumn('exit_code', 'integer')
        .addColumn('duration_ms', 'integer')
        .addColumn('summary', 'text')
        .addColumn('evidence_json', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('client_ops_portfolio_tests_tenant_product_created_idx')
        .on('client_ops_portfolio_test_runs')
        .columns(['tenant_id', 'product_key', 'created_at', 'id'])
        .execute();
      await db.schema
        .createIndex('client_ops_portfolio_tests_tenant_target_suite_idx')
        .on('client_ops_portfolio_test_runs')
        .columns(['tenant_id', 'target_key', 'suite_key', 'created_at', 'id'])
        .execute();
      await db.schema
        .createIndex('client_ops_portfolio_tests_tenant_status_idx')
        .on('client_ops_portfolio_test_runs')
        .columns(['tenant_id', 'status', 'created_at', 'id'])
        .execute();

      await db.schema
        .createTable('client_ops_portfolio_packages')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('product_key', 'text', (c) => c.notNull())
        .addColumn('target_kind', 'text', (c) => c.notNull())
        .addColumn('target_key', 'text', (c) => c.notNull())
        .addColumn('version', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('requested_by', 'text', (c) => c.notNull())
        .addColumn('artifact_uri', 'text')
        .addColumn('sha256', 'text')
        .addColumn('bytes', 'integer')
        .addColumn('manifest_json', 'text', (c) => c.notNull())
        .addColumn('built_at', 'text')
        .addColumn('verified_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('client_ops_portfolio_packages_tenant_product_created_idx')
        .on('client_ops_portfolio_packages')
        .columns(['tenant_id', 'product_key', 'created_at', 'id'])
        .execute();
      await db.schema
        .createIndex('client_ops_portfolio_packages_tenant_target_version_idx')
        .on('client_ops_portfolio_packages')
        .columns(['tenant_id', 'target_key', 'version', 'created_at', 'id'])
        .execute();
      await db.schema
        .createIndex('client_ops_portfolio_packages_tenant_status_idx')
        .on('client_ops_portfolio_packages')
        .columns(['tenant_id', 'status', 'created_at', 'id'])
        .execute();
    },
  },
  executionJournalMigration,
];
