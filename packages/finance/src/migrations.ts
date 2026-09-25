import type { Migration } from '@blacklabel/db';

export const financeMigrations: Migration[] = [
  {
    name: 'finance.0001_payments',
    up: async (db) => {
      await db.schema
        .createTable('finance_payments')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('source_payment_id', 'text', (c) => c.notNull())
        .addColumn('order_ref', 'text')
        .addColumn('amount_cents', 'integer', (c) => c.notNull())
        .addColumn('fee_cents', 'integer', (c) => c.notNull())
        .addColumn('net_cents', 'integer', (c) => c.notNull())
        .addColumn('source_kind', 'text', (c) => c.notNull())
        .addColumn('card_brand', 'text')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('occurred_at', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('finance_payments_tenant_source_idx')
        .on('finance_payments')
        .columns(['tenant_id', 'source_payment_id'])
        .unique()
        .execute();
      await db.schema
        .createIndex('finance_payments_tenant_occurred_idx')
        .on('finance_payments')
        .columns(['tenant_id', 'occurred_at'])
        .execute();
    },
  },
  {
    name: 'finance.0002_refunds',
    up: async (db) => {
      await db.schema
        .createTable('finance_refunds')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('source_refund_id', 'text', (c) => c.notNull())
        .addColumn('payment_ref', 'text', (c) => c.notNull())
        .addColumn('amount_cents', 'integer', (c) => c.notNull())
        .addColumn('occurred_at', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('finance_refunds_tenant_source_idx')
        .on('finance_refunds')
        .columns(['tenant_id', 'source_refund_id'])
        .unique()
        .execute();
      await db.schema
        .createIndex('finance_refunds_tenant_occurred_idx')
        .on('finance_refunds')
        .columns(['tenant_id', 'occurred_at'])
        .execute();
    },
  },
  {
    name: 'finance.0003_payouts',
    up: async (db) => {
      await db.schema
        .createTable('finance_payouts')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('source_payout_id', 'text', (c) => c.notNull())
        .addColumn('amount_cents', 'integer', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('paid_at', 'text', (c) => c.notNull())
        .addColumn('coverage_start', 'text')
        .addColumn('coverage_end', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('finance_payouts_tenant_source_idx')
        .on('finance_payouts')
        .columns(['tenant_id', 'source_payout_id'])
        .unique()
        .execute();
      await db.schema
        .createIndex('finance_payouts_tenant_paid_idx')
        .on('finance_payouts')
        .columns(['tenant_id', 'paid_at'])
        .execute();
    },
  },
  {
    name: 'finance.0004_disputes',
    up: async (db) => {
      await db.schema
        .createTable('finance_disputes')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('source_dispute_id', 'text', (c) => c.notNull())
        .addColumn('payment_ref', 'text')
        .addColumn('amount_cents', 'integer', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('occurred_at', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('finance_disputes_tenant_source_idx')
        .on('finance_disputes')
        .columns(['tenant_id', 'source_dispute_id'])
        .unique()
        .execute();
    },
  },
  {
    name: 'finance.0005_vendor_bill_refs',
    up: async (db) => {
      await db.schema
        .createTable('finance_vendor_bill_refs')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('vendor_bill_ref', 'text', (c) => c.notNull())
        .addColumn('vendor_ref', 'text')
        .addColumn('amount_cents', 'integer', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('occurred_at', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('finance_vendor_bill_refs_tenant_ref_idx')
        .on('finance_vendor_bill_refs')
        .columns(['tenant_id', 'vendor_bill_ref'])
        .unique()
        .execute();
    },
  },
  {
    name: 'finance.0006_payout_matches',
    up: async (db) => {
      await db.schema
        .createTable('finance_payout_matches')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('payout_id', 'text', (c) => c.notNull())
        .addColumn('matched', 'integer', (c) => c.notNull())
        .addColumn('expected_cents', 'integer', (c) => c.notNull())
        .addColumn('actual_cents', 'integer', (c) => c.notNull())
        .addColumn('delta_cents', 'integer', (c) => c.notNull())
        .addColumn('candidate_count', 'integer', (c) => c.notNull())
        .addColumn('coverage_window', 'text', (c) => c.notNull())
        .addColumn('notes', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('finance_payout_matches_tenant_payout_idx')
        .on('finance_payout_matches')
        .columns(['tenant_id', 'payout_id'])
        .execute();
    },
  },
  {
    name: 'finance.0007_cash_sessions',
    up: async (db) => {
      await db.schema
        .createTable('finance_cash_sessions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('location_ref', 'text')
        .addColumn('show_ref', 'text')
        .addColumn('opened_by', 'text', (c) => c.notNull())
        .addColumn('opened_at', 'text', (c) => c.notNull())
        .addColumn('opening_float_cents', 'integer', (c) => c.notNull())
        .addColumn('closed_by', 'text')
        .addColumn('closed_at', 'text')
        .addColumn('expected_cents', 'integer')
        .addColumn('counted_cents', 'integer')
        .addColumn('variance_cents', 'integer')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('note', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('finance_cash_sessions_tenant_status_idx')
        .on('finance_cash_sessions')
        .columns(['tenant_id', 'status'])
        .execute();
    },
  },
  {
    name: 'finance.0008_cash_adjustments',
    up: async (db) => {
      await db.schema
        .createTable('finance_cash_adjustments')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('session_ref', 'text', (c) => c.notNull())
        .addColumn('amount_cents', 'integer', (c) => c.notNull())
        .addColumn('reason', 'text', (c) => c.notNull())
        .addColumn('created_by', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('finance_cash_adjustments_tenant_session_idx')
        .on('finance_cash_adjustments')
        .columns(['tenant_id', 'session_ref'])
        .execute();
    },
  },
  {
    name: 'finance.0009_item_costs',
    up: async (db) => {
      await db.schema
        .createTable('finance_item_costs')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('variation_id', 'text', (c) => c.notNull())
        .addColumn('cost_cents', 'integer', (c) => c.notNull())
        .addColumn('method', 'text', (c) => c.notNull())
        .addColumn('source_ref', 'text')
        .addColumn('effective_from', 'text', (c) => c.notNull())
        .addColumn('effective_to', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('finance_item_costs_tenant_variation_idx')
        .on('finance_item_costs')
        .columns(['tenant_id', 'variation_id', 'effective_from'])
        .execute();
    },
  },
  {
    name: 'finance.0010_liability_snapshots',
    up: async (db) => {
      await db.schema
        .createTable('finance_liability_snapshots')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('outstanding_cents', 'integer', (c) => c.notNull())
        .addColumn('source', 'text', (c) => c.notNull())
        .addColumn('as_of', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('finance_liability_snapshots_tenant_source_idx')
        .on('finance_liability_snapshots')
        .columns(['tenant_id', 'source', 'as_of'])
        .execute();
    },
  },
  {
    name: 'finance.0011_tax_configs',
    up: async (db) => {
      await db.schema
        .createTable('finance_tax_configs')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('jurisdiction', 'text', (c) => c.notNull())
        .addColumn('registered', 'integer', (c) => c.notNull())
        .addColumn('rate_bps', 'integer')
        .addColumn('notes', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text')
        .execute();
      await db.schema
        .createIndex('finance_tax_configs_tenant_jurisdiction_idx')
        .on('finance_tax_configs')
        .columns(['tenant_id', 'jurisdiction'])
        .unique()
        .execute();
    },
  },
  {
    name: 'finance.0012_tax_evidence',
    up: async (db) => {
      await db.schema
        .createTable('finance_tax_evidence')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('source_evidence_id', 'text', (c) => c.notNull())
        .addColumn('order_ref', 'text', (c) => c.notNull())
        .addColumn('jurisdiction_source', 'text', (c) => c.notNull())
        .addColumn('state', 'text')
        .addColumn('amount_cents', 'integer', (c) => c.notNull())
        .addColumn('occurred_at', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('finance_tax_evidence_tenant_source_idx')
        .on('finance_tax_evidence')
        .columns(['tenant_id', 'source_evidence_id'])
        .unique()
        .execute();
      await db.schema
        .createIndex('finance_tax_evidence_tenant_occurred_idx')
        .on('finance_tax_evidence')
        .columns(['tenant_id', 'occurred_at'])
        .execute();
    },
  },
  {
    name: 'finance.0013_pos_cash_drawer_ledger',
    up: async (db) => {
      await db.schema.alterTable('finance_cash_sessions').addColumn('drawer_ref', 'text').execute();
      await db.schema.alterTable('finance_cash_sessions').addColumn('register_ref', 'text').execute();
      await db.schema.alterTable('finance_cash_sessions').addColumn('expected_mode', 'text').execute();
      await db.schema.alterTable('finance_cash_sessions').addColumn('open_scope_key', 'text').execute();
      await db.schema.alterTable('finance_cash_sessions').addColumn('last_activity_at', 'text').execute();
      await db.schema
        .createIndex('finance_cash_sessions_tenant_open_scope_unique_idx')
        .on('finance_cash_sessions')
        .columns(['tenant_id', 'open_scope_key'])
        .unique()
        .execute();

      await db.schema
        .createTable('finance_cash_movements')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('session_ref', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('source_ref', 'text', (c) => c.notNull())
        .addColumn('idempotency_key', 'text', (c) => c.notNull())
        .addColumn('order_ref', 'text')
        .addColumn('tender_ref', 'text')
        .addColumn('amount_cents', 'integer', (c) => c.notNull())
        .addColumn('note', 'text')
        .addColumn('created_by', 'text', (c) => c.notNull())
        .addColumn('occurred_at', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('finance_cash_movements_tenant_session_idx')
        .on('finance_cash_movements')
        .columns(['tenant_id', 'session_ref', 'occurred_at'])
        .execute();
      await db.schema
        .createIndex('finance_cash_movements_tenant_idempotency_unique_idx')
        .on('finance_cash_movements')
        .columns(['tenant_id', 'idempotency_key'])
        .unique()
        .execute();
      await db.schema
        .createIndex('finance_cash_movements_tenant_tender_idx')
        .on('finance_cash_movements')
        .columns(['tenant_id', 'tender_ref'])
        .execute();
    },
  },
];
