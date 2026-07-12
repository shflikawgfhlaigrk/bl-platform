import type { Migration } from '@blacklabel/db';

/**
 * Customers migrations. Append-only — never edit or reorder a shipped migration.
 * Every table carries tenant_id and an index that starts with tenant_id.
 */
export const customersMigrations: Migration[] = [
  {
    name: 'customers.0001_profiles_merges',
    up: async (db) => {
      await db.schema
        .createTable('customers_profiles')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('crm_customer_id', 'text')
        .addColumn('email_normalized', 'text')
        .addColumn('phone_normalized', 'text')
        .addColumn('first_name', 'text')
        .addColumn('last_name', 'text')
        .addColumn('source', 'text', (c) => c.notNull())
        .addColumn('merged_into', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('customers_profiles_tenant_id_idx')
        .on('customers_profiles')
        .column('tenant_id')
        .execute();
      // crm_customer_id UNIQUE per tenant (multiple NULLs allowed by SQLite).
      await db.schema
        .createIndex('customers_profiles_tenant_crm_uq')
        .unique()
        .on('customers_profiles')
        .columns(['tenant_id', 'crm_customer_id'])
        .execute();
      await db.schema
        .createIndex('customers_profiles_tenant_email_idx')
        .on('customers_profiles')
        .columns(['tenant_id', 'email_normalized'])
        .execute();
      await db.schema
        .createIndex('customers_profiles_tenant_phone_idx')
        .on('customers_profiles')
        .columns(['tenant_id', 'phone_normalized'])
        .execute();

      await db.schema
        .createTable('customers_merges')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('winner_profile_id', 'text', (c) => c.notNull())
        .addColumn('loser_profile_id', 'text', (c) => c.notNull())
        .addColumn('evidence', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('applied_at', 'text')
        .addColumn('undone_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('customers_merges_tenant_id_idx')
        .on('customers_merges')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('customers_merges_tenant_status_idx')
        .on('customers_merges')
        .columns(['tenant_id', 'status'])
        .execute();
    },
  },
  {
    name: 'customers.0002_consents_prefs_suppressions',
    up: async (db) => {
      await db.schema
        .createTable('customers_consents')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('profile_id', 'text', (c) => c.notNull())
        .addColumn('channel', 'text', (c) => c.notNull())
        .addColumn('state', 'text', (c) => c.notNull())
        .addColumn('text_shown', 'text')
        .addColumn('source', 'text')
        .addColumn('ip', 'text')
        .addColumn('user_agent', 'text')
        .addColumn('occurred_at', 'text', (c) => c.notNull())
        .addColumn('evidence', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('customers_consents_tenant_id_idx')
        .on('customers_consents')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('customers_consents_tenant_profile_channel_idx')
        .on('customers_consents')
        .columns(['tenant_id', 'profile_id', 'channel'])
        .execute();

      await db.schema
        .createTable('customers_consent_tokens')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('profile_id', 'text', (c) => c.notNull())
        .addColumn('channel', 'text', (c) => c.notNull())
        .addColumn('token', 'text', (c) => c.notNull())
        .addColumn('expires_at', 'text', (c) => c.notNull())
        .addColumn('consumed_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('customers_consent_tokens_tenant_id_idx')
        .on('customers_consent_tokens')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('customers_consent_tokens_tenant_token_uq')
        .unique()
        .on('customers_consent_tokens')
        .columns(['tenant_id', 'token'])
        .execute();

      await db.schema
        .createTable('customers_preferences')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('profile_id', 'text', (c) => c.notNull())
        .addColumn('key', 'text', (c) => c.notNull())
        .addColumn('value', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('customers_preferences_tenant_id_idx')
        .on('customers_preferences')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('customers_preferences_tenant_profile_key_uq')
        .unique()
        .on('customers_preferences')
        .columns(['tenant_id', 'profile_id', 'key'])
        .execute();

      await db.schema
        .createTable('customers_suppressions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('scope', 'text', (c) => c.notNull())
        .addColumn('value_normalized', 'text', (c) => c.notNull())
        .addColumn('reason', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('customers_suppressions_tenant_id_idx')
        .on('customers_suppressions')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('customers_suppressions_tenant_scope_value_uq')
        .unique()
        .on('customers_suppressions')
        .columns(['tenant_id', 'scope', 'value_normalized'])
        .execute();
    },
  },
  {
    name: 'customers.0003_segments_restock_cases',
    up: async (db) => {
      await db.schema
        .createTable('customers_segments')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('rules', 'text', (c) => c.notNull())
        .addColumn('builtin', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('customers_segments_tenant_id_idx')
        .on('customers_segments')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('customers_segments_tenant_name_uq')
        .unique()
        .on('customers_segments')
        .columns(['tenant_id', 'name'])
        .execute();

      await db.schema
        .createTable('customers_segment_members')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('segment_id', 'text', (c) => c.notNull())
        .addColumn('profile_id', 'text', (c) => c.notNull())
        .addColumn('computed_at', 'text', (c) => c.notNull())
        .addColumn('inputs_hash', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('customers_segment_members_tenant_id_idx')
        .on('customers_segment_members')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('customers_segment_members_tenant_segment_idx')
        .on('customers_segment_members')
        .columns(['tenant_id', 'segment_id'])
        .execute();

      await db.schema
        .createTable('customers_restock_requests')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('profile_id', 'text')
        .addColumn('variation_id', 'text', (c) => c.notNull())
        .addColumn('source', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('customers_restock_requests_tenant_id_idx')
        .on('customers_restock_requests')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('customers_restock_requests_tenant_variation_idx')
        .on('customers_restock_requests')
        .columns(['tenant_id', 'variation_id'])
        .execute();

      await db.schema
        .createTable('customers_service_cases')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('profile_id', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('body', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('assigned_to', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('customers_service_cases_tenant_id_idx')
        .on('customers_service_cases')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('customers_service_cases_tenant_status_idx')
        .on('customers_service_cases')
        .columns(['tenant_id', 'status'])
        .execute();

      await db.schema
        .createTable('customers_service_case_notes')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('case_id', 'text', (c) => c.notNull())
        .addColumn('body', 'text', (c) => c.notNull())
        .addColumn('author', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('customers_service_case_notes_tenant_id_idx')
        .on('customers_service_case_notes')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('customers_service_case_notes_tenant_case_idx')
        .on('customers_service_case_notes')
        .columns(['tenant_id', 'case_id'])
        .execute();
    },
  },
  {
    name: 'customers.0004_consent_seq',
    up: async (db) => {
      // Monotonic per-(tenant, profile, channel) sequence so "current consent"
      // is strictly ordered even when two rows share a millisecond timestamp.
      // Nullable: rows written before this migration have seq NULL (sorted last
      // on DESC in SQLite) and remain valid history.
      await db.schema
        .alterTable('customers_consents')
        .addColumn('seq', 'integer')
        .execute();
      await db.schema
        .createIndex('customers_consents_tenant_profile_channel_seq_idx')
        .on('customers_consents')
        .columns(['tenant_id', 'profile_id', 'channel', 'seq'])
        .execute();
    },
  },
];
