import type { Migration } from '@blacklabel/db';

/**
 * Messaging module migrations. Append-only: never edit or reorder an
 * existing entry — add a new one. Run AFTER coreMigrations:
 *
 *   await runMigrations(db, [...coreMigrations, ...messagingMigrations]);
 */
export const messagingMigrations: Migration[] = [
  {
    name: 'messaging.0001_channels',
    up: async (db) => {
      await db.schema
        .createTable('messaging_channels')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('type', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('address', 'text', (c) => c.notNull())
        .addColumn('is_active', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('messaging_channels_tenant_id_idx')
        .on('messaging_channels')
        .column('tenant_id')
        .execute();
    },
  },
  {
    name: 'messaging.0002_conversations',
    up: async (db) => {
      await db.schema
        .createTable('messaging_conversations')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('subject', 'text', (c) => c.notNull())
        .addColumn('channel', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('customer_id', 'text')
        .addColumn('contact_id', 'text')
        .addColumn('assigned_user_id', 'text')
        .addColumn('last_message_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('messaging_conversations_tenant_id_idx')
        .on('messaging_conversations')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('messaging_conversations_tenant_status_idx')
        .on('messaging_conversations')
        .columns(['tenant_id', 'status'])
        .execute();
      await db.schema
        .createIndex('messaging_conversations_tenant_assignee_idx')
        .on('messaging_conversations')
        .columns(['tenant_id', 'assigned_user_id'])
        .execute();
      await db.schema
        .createIndex('messaging_conversations_tenant_customer_idx')
        .on('messaging_conversations')
        .columns(['tenant_id', 'customer_id'])
        .execute();
    },
  },
  {
    name: 'messaging.0003_messages',
    up: async (db) => {
      await db.schema
        .createTable('messaging_messages')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('conversation_id', 'text', (c) => c.notNull())
        .addColumn('direction', 'text', (c) => c.notNull())
        .addColumn('channel', 'text', (c) => c.notNull())
        .addColumn('from_address', 'text')
        .addColumn('to_address', 'text')
        .addColumn('subject', 'text')
        .addColumn('body', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('provider_message_id', 'text')
        .addColumn('failed_reason', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('messaging_messages_tenant_id_idx')
        .on('messaging_messages')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('messaging_messages_tenant_conversation_idx')
        .on('messaging_messages')
        .columns(['tenant_id', 'conversation_id'])
        .execute();
    },
  },
  {
    name: 'messaging.0004_templates',
    up: async (db) => {
      await db.schema
        .createTable('messaging_templates')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('channel', 'text')
        .addColumn('subject', 'text')
        .addColumn('body', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('messaging_templates_tenant_name_unique_idx')
        .on('messaging_templates')
        .columns(['tenant_id', 'name'])
        .unique()
        .execute();
    },
  },
  {
    name: 'messaging.0005_participants',
    up: async (db) => {
      await db.schema
        .createTable('messaging_participants')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('conversation_id', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('ref_id', 'text')
        .addColumn('address', 'text')
        .addColumn('display_name', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('messaging_participants_tenant_conversation_idx')
        .on('messaging_participants')
        .columns(['tenant_id', 'conversation_id'])
        .execute();
      await db.schema
        .createIndex('messaging_participants_tenant_address_idx')
        .on('messaging_participants')
        .columns(['tenant_id', 'address'])
        .execute();
    },
  },
  {
    name: 'messaging.0006_assignments',
    up: async (db) => {
      await db.schema
        .createTable('messaging_assignments')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('conversation_id', 'text', (c) => c.notNull())
        .addColumn('user_id', 'text', (c) => c.notNull())
        .addColumn('assigned_by', 'text', (c) => c.notNull())
        .addColumn('note', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('messaging_assignments_tenant_conversation_idx')
        .on('messaging_assignments')
        .columns(['tenant_id', 'conversation_id'])
        .execute();
    },
  },
  {
    // Front Desk V3: additive columns for the 'call' channel. Nullable, so
    // existing rows and every non-call channel are unaffected.
    name: 'messaging.0007_call_channel_fields',
    up: async (db) => {
      await db.schema.alterTable('messaging_messages').addColumn('recording_url', 'text').execute();
      await db.schema.alterTable('messaging_messages').addColumn('transcript', 'text').execute();
      await db.schema
        .alterTable('messaging_messages')
        .addColumn('duration_seconds', 'integer')
        .execute();
    },
  },
  {
    name: 'messaging.0008_message_seq',
    up: async (db) => {
      // Monotonic per-conversation sequence: strictly orders a thread even when
      // two messages share a created_at millisecond (id is a random nanoid and
      // must not decide chronology). Nullable; pre-0008 rows sort by created_at.
      await db.schema
        .alterTable('messaging_messages')
        .addColumn('seq', 'integer')
        .execute();
      await db.schema
        .createIndex('messaging_messages_tenant_conversation_seq_idx')
        .on('messaging_messages')
        .columns(['tenant_id', 'conversation_id', 'seq'])
        .execute();
    },
  },
];
