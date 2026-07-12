import type { Migration } from '@blacklabel/db';

/**
 * Append-only. Never edit/reorder a shipped migration — add a new one.
 * Every tenant_id-bearing table carries a tenant_id index (compound indexes
 * starting with tenant_id satisfy the rule). No AUTOINCREMENT, no triggers, no
 * views, no ON CONFLICT — uniqueness is enforced by check-then-insert in the
 * service (a duplicate (recipient,subject) becomes a recorded blocked row, so a
 * DB-level unique index would be wrong here).
 */
export const outreachMigrations: Migration[] = [
  {
    name: 'outreach.0001_settings',
    up: async (db) => {
      await db.schema
        .createTable('outreach_settings')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('armed', 'integer', (c) => c.notNull())
        .addColumn('postal_address', 'text')
        .addColumn('from_name', 'text')
        .addColumn('from_email', 'text')
        .addColumn('reply_to', 'text')
        .addColumn('provider_credential_ref', 'text')
        .addColumn('quiet_hours', 'text', (c) => c.notNull())
        .addColumn('daily_cap_override', 'integer')
        .addColumn('unsubscribe_secret', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('outreach_settings_tenant_id_idx')
        .on('outreach_settings')
        .column('tenant_id')
        .unique()
        .execute();
    },
  },
  {
    name: 'outreach.0002_templates',
    up: async (db) => {
      await db.schema
        .createTable('outreach_templates')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('subject_template', 'text', (c) => c.notNull())
        .addColumn('body_template', 'text', (c) => c.notNull())
        .addColumn('required_placeholders', 'text', (c) => c.notNull())
        .addColumn('unsubscribe_footer_required', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('outreach_templates_tenant_id_idx')
        .on('outreach_templates')
        .column('tenant_id')
        .execute();
    },
  },
  {
    name: 'outreach.0003_campaigns',
    up: async (db) => {
      await db.schema
        .createTable('outreach_campaigns')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('template_id', 'text', (c) => c.notNull())
        .addColumn('audience', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('approved_by', 'text')
        .addColumn('scheduled_at', 'text')
        .addColumn('queued_count', 'integer', (c) => c.notNull())
        .addColumn('sent_count', 'integer', (c) => c.notNull())
        .addColumn('bounced_count', 'integer', (c) => c.notNull())
        .addColumn('replied_count', 'integer', (c) => c.notNull())
        .addColumn('suppressed_skipped_count', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('outreach_campaigns_tenant_id_idx')
        .on('outreach_campaigns')
        .column('tenant_id')
        .execute();
    },
  },
  {
    name: 'outreach.0004_sends',
    up: async (db) => {
      await db.schema
        .createTable('outreach_sends')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('recipient_email_normalized', 'text', (c) => c.notNull())
        .addColumn('subject', 'text', (c) => c.notNull())
        .addColumn('campaign_id', 'text')
        .addColumn('template_id', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('blocked_reason', 'text')
        .addColumn('provider_message_id', 'text')
        .addColumn('body_text', 'text', (c) => c.notNull())
        .addColumn('body_html', 'text')
        .addColumn('recipient_consent', 'integer', (c) => c.notNull())
        .addColumn('sent_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('outreach_sends_tenant_recipient_subject_idx')
        .on('outreach_sends')
        .columns(['tenant_id', 'recipient_email_normalized', 'subject'])
        .execute();
      await db.schema
        .createIndex('outreach_sends_tenant_status_idx')
        .on('outreach_sends')
        .columns(['tenant_id', 'status'])
        .execute();
      await db.schema
        .createIndex('outreach_sends_tenant_campaign_idx')
        .on('outreach_sends')
        .columns(['tenant_id', 'campaign_id'])
        .execute();
    },
  },
  {
    name: 'outreach.0005_capacity',
    up: async (db) => {
      await db.schema
        .createTable('outreach_capacity')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('date', 'text', (c) => c.notNull())
        .addColumn('sent_count', 'integer', (c) => c.notNull())
        .addColumn('cap', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('outreach_capacity_tenant_date_idx')
        .on('outreach_capacity')
        .columns(['tenant_id', 'date'])
        .unique()
        .execute();
    },
  },
  {
    name: 'outreach.0006_inbox',
    up: async (db) => {
      await db.schema
        .createTable('outreach_inbox')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('provider_ref', 'text', (c) => c.notNull())
        .addColumn('from_email', 'text', (c) => c.notNull())
        .addColumn('subject', 'text', (c) => c.notNull())
        .addColumn('body_text', 'text', (c) => c.notNull())
        .addColumn('classification', 'text', (c) => c.notNull())
        .addColumn('matched_send_id', 'text')
        .addColumn('received_at', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('outreach_inbox_tenant_provider_ref_idx')
        .on('outreach_inbox')
        .columns(['tenant_id', 'provider_ref'])
        .unique()
        .execute();
      await db.schema
        .createIndex('outreach_inbox_tenant_from_idx')
        .on('outreach_inbox')
        .columns(['tenant_id', 'from_email'])
        .execute();
    },
  },
  {
    name: 'outreach.0007_reader_state',
    up: async (db) => {
      await db.schema
        .createTable('outreach_reader_state')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('cursor', 'text')
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('outreach_reader_state_tenant_id_idx')
        .on('outreach_reader_state')
        .column('tenant_id')
        .unique()
        .execute();
    },
  },
];
