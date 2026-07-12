import type { Migration } from '@blacklabel/db';

/**
 * portal-customer migrations. Append-only — never edit or reorder an entry
 * after it ships; add a new one instead.
 */
export const portalCustomerMigrations: Migration[] = [
  {
    name: 'portal-customer.0001_portal_tables',
    up: async (db) => {
      await db.schema
        .createTable('portal_customer_accounts')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('customer_id', 'text', (c) => c.notNull())
        .addColumn('email', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('phone', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('portal_customer_accounts_tenant_id_idx')
        .on('portal_customer_accounts')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('portal_customer_accounts_tenant_email_uq')
        .unique()
        .on('portal_customer_accounts')
        .columns(['tenant_id', 'email'])
        .execute();
      await db.schema
        .createIndex('portal_customer_accounts_tenant_customer_idx')
        .on('portal_customer_accounts')
        .columns(['tenant_id', 'customer_id'])
        .execute();

      await db.schema
        .createTable('portal_customer_login_tokens')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('account_id', 'text', (c) => c.notNull())
        .addColumn('token', 'text', (c) => c.notNull())
        .addColumn('expires_at', 'text', (c) => c.notNull())
        .addColumn('used_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('portal_customer_login_tokens_tenant_token_idx')
        .on('portal_customer_login_tokens')
        .columns(['tenant_id', 'token'])
        .execute();

      await db.schema
        .createTable('portal_customer_sessions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('account_id', 'text', (c) => c.notNull())
        .addColumn('token', 'text', (c) => c.notNull())
        .addColumn('expires_at', 'text', (c) => c.notNull())
        .addColumn('revoked', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('portal_customer_sessions_tenant_token_idx')
        .on('portal_customer_sessions')
        .columns(['tenant_id', 'token'])
        .execute();

      await db.schema
        .createTable('portal_customer_messages')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('account_id', 'text', (c) => c.notNull())
        .addColumn('customer_id', 'text', (c) => c.notNull())
        .addColumn('subject', 'text')
        .addColumn('body', 'text', (c) => c.notNull())
        .addColumn('relayed_message_id', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('portal_customer_messages_tenant_account_idx')
        .on('portal_customer_messages')
        .columns(['tenant_id', 'account_id'])
        .execute();

      await db.schema
        .createTable('portal_customer_uploads')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('account_id', 'text', (c) => c.notNull())
        .addColumn('customer_id', 'text', (c) => c.notNull())
        .addColumn('file_id', 'text')
        .addColumn('file_name', 'text', (c) => c.notNull())
        .addColumn('content_type', 'text', (c) => c.notNull())
        .addColumn('size_bytes', 'integer', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('related_entity_type', 'text')
        .addColumn('related_entity_id', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('portal_customer_uploads_tenant_account_idx')
        .on('portal_customer_uploads')
        .columns(['tenant_id', 'account_id'])
        .execute();
    },
  },
];
