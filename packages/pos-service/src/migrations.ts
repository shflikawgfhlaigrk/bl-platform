import type { Migration } from '@blacklabel/db';

export const posServiceMigrations: Migration[] = [
  {
    name: 'pos-service.0001_merchants_webhook_events',
    up: async (db) => {
      await db.schema
        .createTable('pos_service_merchants')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('version', 'integer', (c) => c.notNull())
        .addColumn('livemode', 'integer', (c) => c.notNull())
        .addColumn('purchase_ref', 'text', (c) => c.notNull())
        .addColumn('stripe_account_id', 'text')
        .addColumn('stage', 'text', (c) => c.notNull())
        .addColumn('blocked_code', 'text')
        .addColumn('record', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('pos_service_merchants_tenant_id_idx')
        .on('pos_service_merchants')
        .column('tenant_id')
        .execute();
      // One merchant per purchase, and one merchant per Stripe account, inside a tenant.
      await db.schema
        .createIndex('pos_service_merchants_tenant_purchase_ref_idx')
        .on('pos_service_merchants')
        .columns(['tenant_id', 'purchase_ref'])
        .unique()
        .execute();
      await db.schema
        .createIndex('pos_service_merchants_tenant_account_idx')
        .on('pos_service_merchants')
        .columns(['tenant_id', 'stripe_account_id'])
        .unique()
        .execute();
      await db.schema
        .createIndex('pos_service_merchants_tenant_created_idx')
        .on('pos_service_merchants')
        .columns(['tenant_id', 'created_at', 'id'])
        .execute();

      await db.schema
        .createTable('pos_service_webhook_events')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('event_id', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('pos_service_webhook_events_tenant_event_idx')
        .on('pos_service_webhook_events')
        .columns(['tenant_id', 'event_id'])
        .unique()
        .execute();
    },
  },
];
