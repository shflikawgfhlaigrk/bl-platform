import type { Migration } from '@blacklabel/db';

/**
 * CRM migrations. Append-only — never edit or reorder a shipped migration.
 * Every table carries tenant_id and an index that starts with tenant_id.
 */
export const crmMigrations: Migration[] = [
  {
    name: 'crm.0001_companies_customers_contacts',
    up: async (db) => {
      await db.schema
        .createTable('crm_companies')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('domain', 'text')
        .addColumn('email', 'text')
        .addColumn('phone', 'text')
        .addColumn('address', 'text')
        .addColumn('owner_user_id', 'text')
        .addColumn('custom_fields', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('crm_companies_tenant_id_idx')
        .on('crm_companies')
        .column('tenant_id')
        .execute();

      await db.schema
        .createTable('crm_customers')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('email', 'text')
        .addColumn('phone', 'text')
        .addColumn('address', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('company_id', 'text')
        .addColumn('owner_user_id', 'text')
        .addColumn('custom_fields', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('crm_customers_tenant_id_idx')
        .on('crm_customers')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('crm_customers_tenant_status_idx')
        .on('crm_customers')
        .columns(['tenant_id', 'status'])
        .execute();

      await db.schema
        .createTable('crm_contacts')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('first_name', 'text', (c) => c.notNull())
        .addColumn('last_name', 'text')
        .addColumn('email', 'text')
        .addColumn('phone', 'text')
        .addColumn('title', 'text')
        .addColumn('customer_id', 'text')
        .addColumn('company_id', 'text')
        .addColumn('owner_user_id', 'text')
        .addColumn('custom_fields', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('crm_contacts_tenant_id_idx')
        .on('crm_contacts')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('crm_contacts_tenant_customer_idx')
        .on('crm_contacts')
        .columns(['tenant_id', 'customer_id'])
        .execute();
    },
  },
  {
    name: 'crm.0002_leads_stages_deals_jobs',
    up: async (db) => {
      await db.schema
        .createTable('crm_leads')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('email', 'text')
        .addColumn('phone', 'text')
        .addColumn('source', 'text')
        .addColumn('stage', 'text', (c) => c.notNull())
        .addColumn('value_cents', 'integer')
        .addColumn('customer_id', 'text')
        .addColumn('contact_id', 'text')
        .addColumn('company_id', 'text')
        .addColumn('owner_user_id', 'text')
        .addColumn('custom_fields', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('crm_leads_tenant_id_idx')
        .on('crm_leads')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('crm_leads_tenant_stage_idx')
        .on('crm_leads')
        .columns(['tenant_id', 'stage'])
        .execute();

      await db.schema
        .createTable('crm_lead_stages')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('key', 'text', (c) => c.notNull())
        .addColumn('label', 'text', (c) => c.notNull())
        .addColumn('sort_order', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('crm_lead_stages_tenant_key_idx')
        .on('crm_lead_stages')
        .columns(['tenant_id', 'key'])
        .unique()
        .execute();

      await db.schema
        .createTable('crm_deals')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('value_cents', 'integer', (c) => c.notNull())
        .addColumn('customer_id', 'text')
        .addColumn('lead_id', 'text')
        .addColumn('company_id', 'text')
        .addColumn('owner_user_id', 'text')
        .addColumn('expected_close_at', 'text')
        .addColumn('custom_fields', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('crm_deals_tenant_id_idx')
        .on('crm_deals')
        .column('tenant_id')
        .execute();

      await db.schema
        .createTable('crm_jobs')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('description', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('customer_id', 'text')
        .addColumn('deal_id', 'text')
        .addColumn('owner_user_id', 'text')
        .addColumn('starts_at', 'text')
        .addColumn('ends_at', 'text')
        .addColumn('custom_fields', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('crm_jobs_tenant_id_idx')
        .on('crm_jobs')
        .column('tenant_id')
        .execute();
    },
  },
  {
    name: 'crm.0003_notes_tasks_tags_timeline_attachments_attribution',
    up: async (db) => {
      await db.schema
        .createTable('crm_notes')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('entity_type', 'text', (c) => c.notNull())
        .addColumn('entity_id', 'text', (c) => c.notNull())
        .addColumn('body', 'text', (c) => c.notNull())
        .addColumn('author_user_id', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('crm_notes_tenant_entity_idx')
        .on('crm_notes')
        .columns(['tenant_id', 'entity_type', 'entity_id'])
        .execute();

      await db.schema
        .createTable('crm_tasks')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('description', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('due_at', 'text')
        .addColumn('assignee_user_id', 'text')
        .addColumn('entity_type', 'text')
        .addColumn('entity_id', 'text')
        .addColumn('completed_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('crm_tasks_tenant_id_idx')
        .on('crm_tasks')
        .column('tenant_id')
        .execute();

      await db.schema
        .createTable('crm_tags')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('color', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('crm_tags_tenant_name_idx')
        .on('crm_tags')
        .columns(['tenant_id', 'name'])
        .unique()
        .execute();

      await db.schema
        .createTable('crm_taggables')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('tag_id', 'text', (c) => c.notNull())
        .addColumn('entity_type', 'text', (c) => c.notNull())
        .addColumn('entity_id', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('crm_taggables_tenant_entity_idx')
        .on('crm_taggables')
        .columns(['tenant_id', 'entity_type', 'entity_id'])
        .execute();
      await db.schema
        .createIndex('crm_taggables_tenant_tag_idx')
        .on('crm_taggables')
        .columns(['tenant_id', 'tag_id'])
        .execute();

      await db.schema
        .createTable('crm_timeline_events')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('entity_type', 'text', (c) => c.notNull())
        .addColumn('entity_id', 'text', (c) => c.notNull())
        .addColumn('event_type', 'text', (c) => c.notNull())
        .addColumn('actor', 'text', (c) => c.notNull())
        .addColumn('data', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('crm_timeline_events_tenant_entity_idx')
        .on('crm_timeline_events')
        .columns(['tenant_id', 'entity_type', 'entity_id'])
        .execute();

      await db.schema
        .createTable('crm_attachments')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('entity_type', 'text', (c) => c.notNull())
        .addColumn('entity_id', 'text', (c) => c.notNull())
        .addColumn('file_id', 'text', (c) => c.notNull())
        .addColumn('filename', 'text', (c) => c.notNull())
        .addColumn('mime_type', 'text')
        .addColumn('size_bytes', 'integer')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('crm_attachments_tenant_entity_idx')
        .on('crm_attachments')
        .columns(['tenant_id', 'entity_type', 'entity_id'])
        .execute();

      await db.schema
        .createTable('crm_source_attributions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('entity_type', 'text', (c) => c.notNull())
        .addColumn('entity_id', 'text', (c) => c.notNull())
        .addColumn('source', 'text', (c) => c.notNull())
        .addColumn('medium', 'text')
        .addColumn('campaign', 'text')
        .addColumn('detail', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('crm_source_attributions_tenant_entity_idx')
        .on('crm_source_attributions')
        .columns(['tenant_id', 'entity_type', 'entity_id'])
        .execute();
    },
  },
  {
    name: 'crm.0004_owned_next_action_queue',
    up: async (db) => {
      await db.schema.alterTable('crm_leads').addColumn('next_action', 'text').execute();
      await db.schema.alterTable('crm_leads').addColumn('next_action_due_at', 'text').execute();
      await db.schema.alterTable('crm_leads')
        .addColumn('next_action_revision', 'integer', (c) => c.notNull().defaultTo(0)).execute();
      await db.schema.createIndex('crm_leads_tenant_next_action_due_idx')
        .on('crm_leads').columns(['tenant_id', 'next_action_due_at']).execute();
      await db.schema.alterTable('crm_lead_stages')
        .addColumn('is_closed', 'integer', (c) => c.notNull().defaultTo(0)).execute();
      // Existing won/lost semantics remain closed; custom pipelines opt in explicitly.
      const tenants = await db.selectFrom('tenants').select('id').execute();
      for (const tenant of tenants) await db.updateTable('crm_lead_stages').set({ is_closed: 1 })
        .where('tenant_id', '=', tenant.id).where('key', 'in', ['won', 'lost']).execute();
      await db.schema.createTable('crm_next_action_completions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('lead_id', 'text', (c) => c.notNull())
        .addColumn('idempotency_key', 'text', (c) => c.notNull())
        .addColumn('revision', 'integer', (c) => c.notNull())
        .addColumn('action', 'text', (c) => c.notNull())
        .addColumn('due_at', 'text')
        .addColumn('owner_user_id', 'text')
        .addColumn('note', 'text')
        .addColumn('actor', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema.createIndex('crm_next_action_completions_tenant_key_idx')
        .on('crm_next_action_completions').columns(['tenant_id', 'idempotency_key']).unique().execute();
      await db.schema.createIndex('crm_next_action_completions_tenant_lead_idx')
        .on('crm_next_action_completions').columns(['tenant_id', 'lead_id']).execute();
    },
  },
];
