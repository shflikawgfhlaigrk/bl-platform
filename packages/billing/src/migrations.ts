import type { Migration } from '@blacklabel/db';

/**
 * Billing module migrations. Append-only — never edit or reorder a shipped
 * migration. Run after coreMigrations:
 *
 *   await runMigrations(db, [...coreMigrations, ...billingMigrations]);
 */
export const billingMigrations: Migration[] = [
  {
    name: 'billing.0001_billing_tables',
    up: async (db) => {
      await db.schema
        .createTable('billing_accounts')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('customer_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('email', 'text')
        .addColumn('phone', 'text')
        .addColumn('address', 'text')
        .addColumn('notes', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('billing_accounts_tenant_id_idx')
        .on('billing_accounts')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('billing_accounts_tenant_customer_idx')
        .on('billing_accounts')
        .columns(['tenant_id', 'customer_id'])
        .execute();

      await db.schema
        .createTable('billing_invoices')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('billing_account_id', 'text')
        .addColumn('customer_id', 'text', (c) => c.notNull())
        .addColumn('number', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('discount_bps', 'integer')
        .addColumn('discount_fixed_cents', 'integer')
        .addColumn('tax_bps', 'integer')
        .addColumn('subtotal_cents', 'integer', (c) => c.notNull())
        .addColumn('discount_cents', 'integer', (c) => c.notNull())
        .addColumn('tax_cents', 'integer', (c) => c.notNull())
        .addColumn('total_cents', 'integer', (c) => c.notNull())
        .addColumn('paid_cents', 'integer', (c) => c.notNull())
        .addColumn('due_at', 'text')
        .addColumn('sent_at', 'text')
        .addColumn('paid_at', 'text')
        .addColumn('voided_at', 'text')
        .addColumn('memo', 'text')
        .addColumn('source_entity_type', 'text')
        .addColumn('source_entity_id', 'text')
        .addColumn('portal_visible', 'integer', (c) => c.notNull())
        .addColumn('custom', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('billing_invoices_tenant_id_idx')
        .on('billing_invoices')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('billing_invoices_tenant_number_unique_idx')
        .on('billing_invoices')
        .columns(['tenant_id', 'number'])
        .unique()
        .execute();
      await db.schema
        .createIndex('billing_invoices_tenant_customer_idx')
        .on('billing_invoices')
        .columns(['tenant_id', 'customer_id'])
        .execute();
      await db.schema
        .createIndex('billing_invoices_tenant_status_idx')
        .on('billing_invoices')
        .columns(['tenant_id', 'status'])
        .execute();

      await db.schema
        .createTable('billing_invoice_lines')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('invoice_id', 'text', (c) => c.notNull())
        .addColumn('position', 'integer', (c) => c.notNull())
        .addColumn('description', 'text', (c) => c.notNull())
        .addColumn('quantity', 'real', (c) => c.notNull())
        .addColumn('unit_price_cents', 'integer', (c) => c.notNull())
        .addColumn('discount_bps', 'integer')
        .addColumn('discount_fixed_cents', 'integer')
        .addColumn('line_total_cents', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('billing_invoice_lines_tenant_id_idx')
        .on('billing_invoice_lines')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('billing_invoice_lines_tenant_invoice_idx')
        .on('billing_invoice_lines')
        .columns(['tenant_id', 'invoice_id'])
        .execute();

      await db.schema
        .createTable('billing_payments')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('invoice_id', 'text', (c) => c.notNull())
        .addColumn('amount_cents', 'integer', (c) => c.notNull())
        .addColumn('method', 'text', (c) => c.notNull())
        .addColumn('provider', 'text')
        .addColumn('provider_ref', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('note', 'text')
        .addColumn('received_at', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('billing_payments_tenant_id_idx')
        .on('billing_payments')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('billing_payments_tenant_invoice_idx')
        .on('billing_payments')
        .columns(['tenant_id', 'invoice_id'])
        .execute();

      await db.schema
        .createTable('billing_subscriptions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('customer_id', 'text', (c) => c.notNull())
        .addColumn('billing_account_id', 'text')
        .addColumn('plan_name', 'text', (c) => c.notNull())
        .addColumn('amount_cents', 'integer', (c) => c.notNull())
        .addColumn('tax_bps', 'integer')
        .addColumn('interval', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('next_invoice_at', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('billing_subscriptions_tenant_id_idx')
        .on('billing_subscriptions')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('billing_subscriptions_tenant_status_next_idx')
        .on('billing_subscriptions')
        .columns(['tenant_id', 'status', 'next_invoice_at'])
        .execute();

      await db.schema
        .createTable('billing_memberships')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('customer_id', 'text', (c) => c.notNull())
        .addColumn('plan_key', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('subscription_id', 'text')
        .addColumn('started_at', 'text', (c) => c.notNull())
        .addColumn('ends_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('billing_memberships_tenant_id_idx')
        .on('billing_memberships')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('billing_memberships_tenant_customer_idx')
        .on('billing_memberships')
        .columns(['tenant_id', 'customer_id'])
        .execute();

      await db.schema
        .createTable('billing_invoice_counters')
        .addColumn('tenant_id', 'text', (c) => c.primaryKey())
        .addColumn('next_seq', 'integer', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('billing_webhook_events')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('provider', 'text', (c) => c.notNull())
        .addColumn('event_type', 'text')
        .addColumn('payload', 'text', (c) => c.notNull())
        .addColumn('outcome', 'text')
        .addColumn('processed', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('billing_webhook_events_tenant_id_idx')
        .on('billing_webhook_events')
        .column('tenant_id')
        .execute();
    },
  },
  {
    name: 'billing.0002_subscription_period_receipts',
    up: async db => {
      await db.schema.createTable('billing_subscription_periods')
        .addColumn('id', 'text', c => c.primaryKey()).addColumn('tenant_id', 'text', c => c.notNull())
        .addColumn('subscription_id', 'text', c => c.notNull()).addColumn('period_start', 'text', c => c.notNull())
        .addColumn('invoice_id', 'text', c => c.notNull()).addColumn('created_at', 'text', c => c.notNull()).execute();
      await db.schema.createIndex('billing_subscription_periods_tenant_period_idx').on('billing_subscription_periods')
        .columns(['tenant_id', 'subscription_id', 'period_start']).unique().execute();
    },
  },
  {
    name: 'billing.0003_collection_receipts',
    up: async db => {
      await db.schema.createTable('billing_source_receipts')
        .addColumn('id', 'text', c => c.primaryKey()).addColumn('tenant_id', 'text', c => c.notNull())
        .addColumn('source_entity_type', 'text', c => c.notNull()).addColumn('source_entity_id', 'text', c => c.notNull())
        .addColumn('input_hash', 'text', c => c.notNull()).addColumn('invoice_id', 'text', c => c.notNull()).addColumn('created_at', 'text', c => c.notNull()).execute();
      await db.schema.createIndex('billing_source_receipts_tenant_source_idx').on('billing_source_receipts').columns(['tenant_id', 'source_entity_type', 'source_entity_id']).unique().execute();
      await db.schema.createTable('billing_payment_receipts')
        .addColumn('id', 'text', c => c.primaryKey()).addColumn('tenant_id', 'text', c => c.notNull())
        .addColumn('receipt_ref', 'text', c => c.notNull()).addColumn('input_hash', 'text', c => c.notNull())
        .addColumn('invoice_id', 'text', c => c.notNull()).addColumn('payment_id', 'text', c => c.notNull()).addColumn('created_at', 'text', c => c.notNull()).execute();
      await db.schema.createIndex('billing_payment_receipts_tenant_reference_idx').on('billing_payment_receipts').columns(['tenant_id', 'receipt_ref']).unique().execute();
      await db.schema.createTable('billing_collection_plans')
        .addColumn('id', 'text', c => c.primaryKey()).addColumn('tenant_id', 'text', c => c.notNull()).addColumn('invoice_id', 'text', c => c.notNull())
        .addColumn('deposit_cents', 'integer', c => c.notNull()).addColumn('deposit_due_at', 'text').addColumn('balance_due_at', 'text')
        .addColumn('reminders_enabled', 'integer', c => c.notNull()).addColumn('opted_out', 'integer', c => c.notNull())
        .addColumn('created_at', 'text', c => c.notNull()).addColumn('updated_at', 'text', c => c.notNull()).execute();
      await db.schema.createIndex('billing_collection_plans_tenant_invoice_idx').on('billing_collection_plans').columns(['tenant_id', 'invoice_id']).unique().execute();
      await db.schema.createTable('billing_reminder_receipts')
        .addColumn('id', 'text', c => c.primaryKey()).addColumn('tenant_id', 'text', c => c.notNull()).addColumn('invoice_id', 'text', c => c.notNull())
        .addColumn('operation_key', 'text', c => c.notNull()).addColumn('stage', 'text', c => c.notNull()).addColumn('amount_cents', 'integer', c => c.notNull())
        .addColumn('status', 'text', c => c.notNull()).addColumn('message', 'text').addColumn('reason', 'text').addColumn('delivery_reference', 'text')
        .addColumn('created_at', 'text', c => c.notNull()).addColumn('updated_at', 'text', c => c.notNull()).execute();
      await db.schema.createIndex('billing_reminder_receipts_tenant_operation_idx').on('billing_reminder_receipts').columns(['tenant_id', 'operation_key']).unique().execute();
    },
  },
];
