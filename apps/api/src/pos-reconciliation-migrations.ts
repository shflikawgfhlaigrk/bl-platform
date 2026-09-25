/**
 * Durable, API-owned POS reconciliation state.
 *
 * These tables deliberately live at the composition root: they project facts
 * across orders, inventory, and finance without making any module read a
 * sibling module's tables.
 */
import type { Migration } from '@blacklabel/db';

export type PosReconciliationEffectType =
  | 'inventory_release'
  | 'inventory_sale'
  | 'finance_tender'
  | 'cash_sale'
  | 'finance_refund'
  | 'cash_refund'
  | 'inventory_return';

export type PosReconciliationEffectStatus = 'pending' | 'completed';
export type PosFinanceEntryType = 'payment' | 'refund';

export const posReconciliationMigrations: Migration[] = [
  {
    name: 'api.0004_pos_reconciliation',
    up: async (db) => {
      await db.schema
        .createTable('api_pos_reconciliation_effects')
        .ifNotExists()
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('effect_key', 'text', (c) => c.notNull())
        .addColumn('effect_type', 'text', (c) => c.notNull())
        .addColumn('source_ref', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('attempt_count', 'integer', (c) => c.notNull())
        .addColumn('last_error', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .addColumn('completed_at', 'text')
        .execute();
      await db.schema
        .createIndex('api_pos_reconciliation_effects_tenant_key_idx')
        .ifNotExists()
        .on('api_pos_reconciliation_effects')
        .columns(['tenant_id', 'effect_key'])
        .unique()
        .execute();
      await db.schema
        .createIndex('api_pos_reconciliation_effects_tenant_status_idx')
        .ifNotExists()
        .on('api_pos_reconciliation_effects')
        .columns(['tenant_id', 'status', 'created_at'])
        .execute();
      await db.schema
        .createIndex('api_pos_reconciliation_effects_tenant_source_idx')
        .ifNotExists()
        .on('api_pos_reconciliation_effects')
        .columns(['tenant_id', 'effect_type', 'source_ref'])
        .execute();

      await db.schema
        .createTable('api_pos_finance_entries')
        .ifNotExists()
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('source_key', 'text', (c) => c.notNull())
        .addColumn('entry_type', 'text', (c) => c.notNull())
        .addColumn('order_id', 'text', (c) => c.notNull())
        .addColumn('tender_id', 'text', (c) => c.notNull())
        .addColumn('refund_id', 'text')
        .addColumn('register_id', 'text')
        .addColumn('cashier_id', 'text')
        .addColumn('cash_session_id', 'text')
        .addColumn('tender_kind', 'text', (c) => c.notNull())
        .addColumn('provider', 'text')
        .addColumn('provider_ref', 'text')
        .addColumn('amount_cents', 'integer', (c) => c.notNull())
        // Provider fees are nullable by design. Absence means unknown, never 0.
        .addColumn('fee_cents', 'integer')
        .addColumn('net_cents', 'integer')
        .addColumn('occurred_at', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('api_pos_finance_entries_tenant_source_idx')
        .ifNotExists()
        .on('api_pos_finance_entries')
        .columns(['tenant_id', 'source_key'])
        .unique()
        .execute();
      await db.schema
        .createIndex('api_pos_finance_entries_tenant_occurred_idx')
        .ifNotExists()
        .on('api_pos_finance_entries')
        .columns(['tenant_id', 'occurred_at'])
        .execute();
      await db.schema
        .createIndex('api_pos_finance_entries_tenant_order_idx')
        .ifNotExists()
        .on('api_pos_finance_entries')
        .columns(['tenant_id', 'order_id'])
        .execute();
    },
  },
  {
    name: 'api.0005_pos_cart_facts',
    up: async (db) => {
      // The repository migration runner records completion after `up` returns.
      // Every statement is therefore independently replay-safe so a crash
      // between DDL and bookkeeping can resume without manual repair.
      await db.schema
        .createTable('api_pos_cart_facts')
        .ifNotExists()
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('cart_id', 'text', (c) => c.notNull())
        .addColumn('order_id', 'text', (c) => c.notNull())
        .addColumn('fact_hash', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('api_pos_cart_facts_tenant_cart_idx')
        .ifNotExists()
        .on('api_pos_cart_facts')
        .columns(['tenant_id', 'cart_id'])
        .unique()
        .execute();
      await db.schema
        .createIndex('api_pos_cart_facts_tenant_order_idx')
        .ifNotExists()
        .on('api_pos_cart_facts')
        .columns(['tenant_id', 'order_id'])
        .unique()
        .execute();
    },
  },
];

export interface ApiPosReconciliationEffectRow {
  id: string;
  tenant_id: string;
  effect_key: string;
  effect_type: PosReconciliationEffectType;
  source_ref: string;
  status: PosReconciliationEffectStatus;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ApiPosFinanceEntryRow {
  id: string;
  tenant_id: string;
  source_key: string;
  entry_type: PosFinanceEntryType;
  order_id: string;
  tender_id: string;
  refund_id: string | null;
  register_id: string | null;
  cashier_id: string | null;
  cash_session_id: string | null;
  tender_kind: string;
  provider: string | null;
  provider_ref: string | null;
  amount_cents: number;
  fee_cents: number | null;
  net_cents: number | null;
  occurred_at: string;
  created_at: string;
}

export interface ApiPosCartFactRow {
  id: string;
  tenant_id: string;
  cart_id: string;
  order_id: string;
  fact_hash: string;
  created_at: string;
}

export interface PosReconciliationTables {
  api_pos_reconciliation_effects: ApiPosReconciliationEffectRow;
  api_pos_finance_entries: ApiPosFinanceEntryRow;
  api_pos_cart_facts: ApiPosCartFactRow;
}
