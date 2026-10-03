import { sql, type Kysely, type Migration } from '@blacklabel/db';

async function hasColumn(db: Kysely<any>, table: string, column: string): Promise<boolean> {
  const result = await sql<{ name: string }>`
    SELECT name
    FROM pragma_table_info(${sql.lit(table)})
    WHERE name = ${column}
  `.execute(db);
  return result.rows.length > 0;
}

async function addColumnIfMissing(
  db: Kysely<any>,
  table: string,
  column: string,
  add: () => Promise<unknown>,
): Promise<void> {
  if (await hasColumn(db, table, column)) return;
  try {
    await add();
  } catch (error) {
    // SQLite has no ALTER TABLE ... ADD COLUMN IF NOT EXISTS. Re-check after
    // the statement so a concurrent connection that won the DDL race is
    // treated as success, while unrelated failures still surface.
    if (await hasColumn(db, table, column)) return;
    throw error;
  }
}

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
  {
    name: 'orders.0002_pos_payment_attempts',
    up: async (db) => {
      // Compatibility columns: all pre-POS orders receive a deterministic,
      // stable receipt number before the tenant-unique index is installed.
      await addColumnIfMissing(db, 'orders_orders', 'tip_cents', () => db.schema
        .alterTable('orders_orders')
        .addColumn('tip_cents', 'integer', (c) => c.notNull().defaultTo(0))
        .execute());
      await addColumnIfMissing(db, 'orders_orders', 'receipt_number', () => db.schema
        .alterTable('orders_orders').addColumn('receipt_number', 'text').execute());
      await addColumnIfMissing(db, 'orders_orders', 'register_id', () => db.schema
        .alterTable('orders_orders').addColumn('register_id', 'text').execute());
      await addColumnIfMissing(db, 'orders_orders', 'device_id', () => db.schema
        .alterTable('orders_orders').addColumn('device_id', 'text').execute());
      await addColumnIfMissing(db, 'orders_orders', 'cashier_id', () => db.schema
        .alterTable('orders_orders').addColumn('cashier_id', 'text').execute());
      await addColumnIfMissing(db, 'orders_orders', 'cash_session_id', () => db.schema
        .alterTable('orders_orders').addColumn('cash_session_id', 'text').execute());
      await addColumnIfMissing(db, 'orders_refunds', 'cash_session_id', () => db.schema
        .alterTable('orders_refunds').addColumn('cash_session_id', 'text').execute());
      await addColumnIfMissing(db, 'orders_refunds', 'idempotency_key', () => db.schema
        .alterTable('orders_refunds').addColumn('idempotency_key', 'text').execute());
      const existingRefunds = await db
        .selectFrom('orders_refunds')
        .select(['id', 'tenant_id'])
        .orderBy('tenant_id')
        .orderBy('id')
        .execute();
      for (const refund of existingRefunds) {
        await db
          .updateTable('orders_refunds')
          .set({ idempotency_key: `legacy:${refund.id}` })
          .where('tenant_id', '=', refund.tenant_id)
          .where('id', '=', refund.id)
          .where('idempotency_key', 'is', null)
          .execute();
      }
      await db.schema
        .createIndex('orders_refunds_tenant_idem_unique_idx')
        .ifNotExists()
        .on('orders_refunds')
        .columns(['tenant_id', 'idempotency_key'])
        .unique()
        .execute();
      await addColumnIfMissing(db, 'orders_tenders', 'cash_received_cents', () => db.schema
        .alterTable('orders_tenders').addColumn('cash_received_cents', 'integer').execute());
      await addColumnIfMissing(db, 'orders_tenders', 'change_due_cents', () => db.schema
        .alterTable('orders_tenders').addColumn('change_due_cents', 'integer').execute());
      const existingCashTenders = await db
        .selectFrom('orders_tenders')
        .select(['id', 'tenant_id', 'amount_cents'])
        .where('kind', '=', 'cash')
        .orderBy('tenant_id')
        .orderBy('id')
        .execute();
      for (const tender of existingCashTenders) {
        await db
          .updateTable('orders_tenders')
          .set({
            cash_received_cents: sql<number>`coalesce(cash_received_cents, ${tender.amount_cents})`,
            change_due_cents: sql<number>`coalesce(change_due_cents, 0)`,
          })
          .where('tenant_id', '=', tender.tenant_id)
          .where('id', '=', tender.id)
          .execute();
      }
      const existingOrders = await db
        .selectFrom('orders_orders')
        .select(['id', 'tenant_id'])
        .orderBy('tenant_id')
        .orderBy('id')
        .execute();
      for (const order of existingOrders) {
        await db
          .updateTable('orders_orders')
          .set({ receipt_number: `LEGACY-${order.id}` })
          .where('tenant_id', '=', order.tenant_id)
          .where('id', '=', order.id)
          .where('receipt_number', 'is', null)
          .execute();
      }
      await db.schema
        .createIndex('orders_orders_tenant_receipt_unique_idx')
        .ifNotExists()
        .on('orders_orders')
        .columns(['tenant_id', 'receipt_number'])
        .unique()
        .execute();

      await db.schema
        .createTable('orders_payment_attempts')
        .ifNotExists()
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('order_id', 'text', (c) => c.notNull())
        .addColumn('checkout_session_id', 'text')
        .addColumn('provider', 'text', (c) => c.notNull())
        .addColumn('provider_ref', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('amount_cents', 'integer', (c) => c.notNull())
        .addColumn('idempotency_key', 'text', (c) => c.notNull())
        .addColumn('reader_id', 'text')
        .addColumn('provider_data', 'text')
        .addColumn('failure_code', 'text')
        .addColumn('failure_message', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .addColumn('processing_at', 'text')
        .addColumn('succeeded_at', 'text')
        .addColumn('failed_at', 'text')
        .addColumn('canceled_at', 'text')
        .execute();
      await db.schema
        .createIndex('orders_payment_attempts_tenant_id_idx')
        .ifNotExists()
        .on('orders_payment_attempts')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('orders_payment_attempts_tenant_order_idx')
        .ifNotExists()
        .on('orders_payment_attempts')
        .columns(['tenant_id', 'order_id'])
        .execute();
      await db.schema
        .createIndex('orders_payment_attempts_tenant_idem_unique_idx')
        .ifNotExists()
        .on('orders_payment_attempts')
        .columns(['tenant_id', 'idempotency_key'])
        .unique()
        .execute();
      await db.schema
        .createIndex('orders_payment_attempts_tenant_provider_ref_idx')
        .ifNotExists()
        .on('orders_payment_attempts')
        .columns(['tenant_id', 'provider', 'provider_ref'])
        .execute();
    },
  },
  {
    name: 'orders.0003_provider_refunds',
    up: async (db) => {
      await addColumnIfMissing(db, 'orders_refunds', 'provider', () => db.schema
        .alterTable('orders_refunds').addColumn('provider', 'text').execute());
      await addColumnIfMissing(db, 'orders_refunds', 'provider_ref', () => db.schema
        .alterTable('orders_refunds').addColumn('provider_ref', 'text').execute());
      await addColumnIfMissing(db, 'orders_refunds', 'provider_status', () => db.schema
        .alterTable('orders_refunds').addColumn('provider_status', 'text').execute());
      await db.schema
        .createIndex('orders_refunds_tenant_provider_ref_unique_idx')
        .ifNotExists()
        .on('orders_refunds')
        .columns(['tenant_id', 'provider', 'provider_ref'])
        .unique()
        .execute();
    },
  },
  {
    name: 'orders.0004_one_active_payment_attempt',
    up: async (db) => {
      await addColumnIfMissing(db, 'orders_payment_attempts', 'active_order_key', () => db.schema
        .alterTable('orders_payment_attempts')
        .addColumn('active_order_key', 'text')
        .execute());

      const active = await db
        .selectFrom('orders_payment_attempts')
        .select(['id', 'tenant_id', 'order_id', 'status'])
        .where('status', 'in', ['pending', 'processing'])
        // Preserve the attempt that is most likely to own externally live
        // provider work. A provider reference outranks local lifecycle state;
        // processing outranks pending; recency and id make the choice stable.
        .orderBy(sql<number>`
          case when nullif(trim(provider_ref), '') is not null then 1 else 0 end
        `, 'desc')
        .orderBy(sql<number>`case when status = 'processing' then 1 else 0 end`, 'desc')
        .orderBy('updated_at', 'desc')
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .execute();
      const claimed = new Set<string>();
      const migratedAt = new Date().toISOString();
      for (const attempt of active) {
        const key = JSON.stringify([attempt.tenant_id, attempt.order_id]);
        if (claimed.has(key)) {
          await db
            .updateTable('orders_payment_attempts')
            .set({
              status: 'failed',
              failed_at: migratedAt,
              updated_at: migratedAt,
              failure_code: 'duplicate_active_attempt',
              failure_message: 'superseded while enforcing one active payment attempt per order',
              active_order_key: null,
            })
            .where('id', '=', attempt.id)
            .execute();
          continue;
        }
        claimed.add(key);
        await db
          .updateTable('orders_payment_attempts')
          .set({ active_order_key: key })
          .where('id', '=', attempt.id)
          .execute();
      }

      await db.schema
        .createIndex('orders_payment_attempts_active_order_unique_idx')
        .ifNotExists()
        .on('orders_payment_attempts')
        .column('active_order_key')
        .unique()
        .execute();
    },
  },
  {
    name: 'orders.0005_async_provider_refunds',
    up: async (db) => {
      await addColumnIfMissing(db, 'orders_refunds', 'active_tender_key', () => db.schema
        .alterTable('orders_refunds')
        .addColumn('active_tender_key', 'text')
        .execute());

      const pending = await db
        .selectFrom('orders_refunds')
        .select(['id', 'tenant_id', 'tender_id', 'status'])
        .where('status', '=', 'pending')
        // A provider-confirmed success must never lose to another pending row.
        // Otherwise preserve a provider-bound refund over a local placeholder,
        // then use creation time and id as deterministic recency tie-breakers.
        .orderBy(sql<number>`case when provider_status = 'succeeded' then 1 else 0 end`, 'desc')
        .orderBy(sql<number>`
          case when nullif(trim(provider_ref), '') is not null then 1 else 0 end
        `, 'desc')
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .execute();
      const claimed = new Set<string>();
      for (const refund of pending) {
        const key = JSON.stringify([refund.tenant_id, refund.tender_id]);
        if (claimed.has(key)) {
          await db
            .updateTable('orders_refunds')
            .set({ status: 'failed', provider_status: 'failed', active_tender_key: null })
            .where('id', '=', refund.id)
            .execute();
          continue;
        }
        claimed.add(key);
        await db
          .updateTable('orders_refunds')
          .set({ active_tender_key: key })
          .where('id', '=', refund.id)
          .execute();
      }

      await db.schema
        .createIndex('orders_refunds_active_tender_unique_idx')
        .ifNotExists()
        .on('orders_refunds')
        .column('active_tender_key')
        .unique()
        .execute();
    },
  },
];
