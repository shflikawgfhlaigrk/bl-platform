import type { Migration } from '@blacklabel/db';

/**
 * Orders module migrations. Append-only — never edit or reorder a shipped
 * migration. Run after coreMigrations:
 *
 *   await runMigrations(db, [...coreMigrations, ...ordersMigrations]);
 */
export const ordersMigrations: Migration[] = [
  {
    name: 'orders.0001_orders_tables',
    up: async (db) => {
      /* -------------------- orders_orders -------------------- */
      await db.schema
        .createTable('orders_orders')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('channel', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('customer_id', 'text')
        .addColumn('show_id', 'text')
        .addColumn('source', 'text', (c) => c.notNull())
        .addColumn('source_order_id', 'text')
        .addColumn('discount_bps', 'integer')
        .addColumn('discount_fixed_cents', 'integer')
        .addColumn('tax_bps', 'integer')
        .addColumn('subtotal_cents', 'integer', (c) => c.notNull())
        .addColumn('discount_cents', 'integer', (c) => c.notNull())
        .addColumn('tax_cents', 'integer', (c) => c.notNull())
        .addColumn('total_cents', 'integer', (c) => c.notNull())
        .addColumn('note', 'text')
        .addColumn('sent', 'integer', (c) => c.notNull())
        .addColumn('sent_at', 'text')
        .addColumn('reserved_at', 'text')
        .addColumn('paid_at', 'text')
        .addColumn('fulfilled_at', 'text')
        .addColumn('canceled_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('orders_orders_tenant_id_idx')
        .on('orders_orders')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('orders_orders_tenant_status_idx')
        .on('orders_orders')
        .columns(['tenant_id', 'status'])
        .execute();
      await db.schema
        .createIndex('orders_orders_tenant_customer_idx')
        .on('orders_orders')
        .columns(['tenant_id', 'customer_id'])
        .execute();
      // External idempotency: (tenant, source_order_id) unique WHEN present.
      // SQLite treats NULLs as distinct, so many NULL source_order_ids coexist.
      await db.schema
        .createIndex('orders_orders_tenant_source_order_unique_idx')
        .on('orders_orders')
        .columns(['tenant_id', 'source_order_id'])
        .unique()
        .execute();

      /* -------------------- orders_lines -------------------- */
      await db.schema
        .createTable('orders_lines')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('order_id', 'text', (c) => c.notNull())
        .addColumn('position', 'integer', (c) => c.notNull())
        .addColumn('variation_id', 'text')
        .addColumn('location_id', 'text')
        .addColumn('description', 'text', (c) => c.notNull())
        .addColumn('qty', 'real', (c) => c.notNull())
        .addColumn('unit_price_cents', 'integer', (c) => c.notNull())
        .addColumn('discount', 'text')
        .addColumn('line_total_cents', 'integer', (c) => c.notNull())
        .addColumn('fulfillment_state', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('orders_lines_tenant_id_idx')
        .on('orders_lines')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('orders_lines_tenant_order_idx')
        .on('orders_lines')
        .columns(['tenant_id', 'order_id'])
        .execute();

      /* -------------------- orders_tenders -------------------- */
      await db.schema
        .createTable('orders_tenders')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('order_id', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('amount_cents', 'integer', (c) => c.notNull())
        .addColumn('provider', 'text')
        .addColumn('provider_ref', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('refunded_cents', 'integer', (c) => c.notNull())
        .addColumn('idempotency_key', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('orders_tenders_tenant_id_idx')
        .on('orders_tenders')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('orders_tenders_tenant_order_idx')
        .on('orders_tenders')
        .columns(['tenant_id', 'order_id'])
        .execute();
      await db.schema
        .createIndex('orders_tenders_tenant_idem_unique_idx')
        .on('orders_tenders')
        .columns(['tenant_id', 'idempotency_key'])
        .unique()
        .execute();

      /* -------------------- orders_refunds -------------------- */
      await db.schema
        .createTable('orders_refunds')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('order_id', 'text', (c) => c.notNull())
        .addColumn('tender_id', 'text', (c) => c.notNull())
        .addColumn('amount_cents', 'integer', (c) => c.notNull())
        .addColumn('reason', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('orders_refunds_tenant_id_idx')
        .on('orders_refunds')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('orders_refunds_tenant_order_idx')
        .on('orders_refunds')
        .columns(['tenant_id', 'order_id'])
        .execute();

      /* -------------------- orders_refund_lines -------------------- */
      await db.schema
        .createTable('orders_refund_lines')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('refund_id', 'text', (c) => c.notNull())
        .addColumn('line_id', 'text', (c) => c.notNull())
        .addColumn('qty', 'real', (c) => c.notNull())
        .addColumn('disposition', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('orders_refund_lines_tenant_id_idx')
        .on('orders_refund_lines')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('orders_refund_lines_tenant_refund_idx')
        .on('orders_refund_lines')
        .columns(['tenant_id', 'refund_id'])
        .execute();

      /* -------------------- orders_fulfillments -------------------- */
      await db.schema
        .createTable('orders_fulfillments')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('order_id', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('address', 'text')
        .addColumn('tracking', 'text')
        .addColumn('staged_at', 'text')
        .addColumn('shipped_at', 'text')
        .addColumn('completed_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('orders_fulfillments_tenant_id_idx')
        .on('orders_fulfillments')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('orders_fulfillments_tenant_order_idx')
        .on('orders_fulfillments')
        .columns(['tenant_id', 'order_id'])
        .execute();

      /* -------------------- orders_fulfillment_lines -------------------- */
      await db.schema
        .createTable('orders_fulfillment_lines')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('fulfillment_id', 'text', (c) => c.notNull())
        .addColumn('line_id', 'text', (c) => c.notNull())
        .addColumn('qty', 'real', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('orders_fulfillment_lines_tenant_id_idx')
        .on('orders_fulfillment_lines')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('orders_fulfillment_lines_tenant_fulfillment_idx')
        .on('orders_fulfillment_lines')
        .columns(['tenant_id', 'fulfillment_id'])
        .execute();

      /* -------------------- orders_checkout_sessions -------------------- */
      await db.schema
        .createTable('orders_checkout_sessions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('order_id', 'text', (c) => c.notNull())
        .addColumn('provider', 'text', (c) => c.notNull())
        .addColumn('provider_session_ref', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('amount_cents', 'integer', (c) => c.notNull())
        .addColumn('return_url', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('completed_at', 'text')
        .execute();
      await db.schema
        .createIndex('orders_checkout_sessions_tenant_id_idx')
        .on('orders_checkout_sessions')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('orders_checkout_sessions_tenant_order_idx')
        .on('orders_checkout_sessions')
        .columns(['tenant_id', 'order_id'])
        .execute();
      await db.schema
        .createIndex('orders_checkout_sessions_tenant_ref_unique_idx')
        .on('orders_checkout_sessions')
        .columns(['tenant_id', 'provider_session_ref'])
        .unique()
        .execute();

      /* -------------------- orders_webhook_events -------------------- */
      await db.schema
        .createTable('orders_webhook_events')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('provider', 'text', (c) => c.notNull())
        .addColumn('event_ref', 'text', (c) => c.notNull())
        .addColumn('signature_valid', 'integer', (c) => c.notNull())
        .addColumn('payload', 'text', (c) => c.notNull())
        .addColumn('processed', 'integer', (c) => c.notNull())
        .addColumn('outcome', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('orders_webhook_events_tenant_id_idx')
        .on('orders_webhook_events')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('orders_webhook_events_tenant_ref_unique_idx')
        .on('orders_webhook_events')
        .columns(['tenant_id', 'event_ref'])
        .unique()
        .execute();
    },
  },
];
