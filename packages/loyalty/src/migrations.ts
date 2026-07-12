import type { Migration } from '@blacklabel/db';

/**
 * Loyalty migrations. Append-only — never edit or reorder a shipped migration.
 * Every table carries tenant_id and an index that starts with tenant_id.
 */
export const loyaltyMigrations: Migration[] = [
  {
    name: 'loyalty.0001_programs_accounts_ledger',
    up: async (db) => {
      await db.schema
        .createTable('loyalty_programs')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('rules', 'text', (c) => c.notNull())
        .addColumn('reward_kind', 'text', (c) => c.notNull())
        .addColumn('reward_value', 'integer', (c) => c.notNull())
        .addColumn('expiry_months', 'integer')
        .addColumn('daily_earn_cap', 'integer')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('loyalty_programs_tenant_id_idx')
        .on('loyalty_programs')
        .column('tenant_id')
        .execute();

      await db.schema
        .createTable('loyalty_accounts')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('program_id', 'text', (c) => c.notNull())
        .addColumn('profile_id', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('loyalty_accounts_tenant_id_idx')
        .on('loyalty_accounts')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('loyalty_accounts_tenant_program_profile_uq')
        .unique()
        .on('loyalty_accounts')
        .columns(['tenant_id', 'program_id', 'profile_id'])
        .execute();

      await db.schema
        .createTable('loyalty_ledger')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('account_id', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('amount', 'integer', (c) => c.notNull())
        .addColumn('order_id', 'text')
        .addColumn('idempotency_key', 'text')
        .addColumn('trace', 'text', (c) => c.notNull())
        .addColumn('reason', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('loyalty_ledger_tenant_id_idx')
        .on('loyalty_ledger')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('loyalty_ledger_tenant_account_idx')
        .on('loyalty_ledger')
        .columns(['tenant_id', 'account_id'])
        .execute();
      // idempotency_key UNIQUE per tenant (multiple NULLs allowed by SQLite).
      await db.schema
        .createIndex('loyalty_ledger_tenant_idem_uq')
        .unique()
        .on('loyalty_ledger')
        .columns(['tenant_id', 'idempotency_key'])
        .execute();
    },
  },
  {
    name: 'loyalty.0002_gift_cards_store_credit_redemptions',
    up: async (db) => {
      await db.schema
        .createTable('loyalty_gift_cards')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('code', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('initial_cents', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('loyalty_gift_cards_tenant_id_idx')
        .on('loyalty_gift_cards')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('loyalty_gift_cards_tenant_code_uq')
        .unique()
        .on('loyalty_gift_cards')
        .columns(['tenant_id', 'code'])
        .execute();

      await db.schema
        .createTable('loyalty_gift_card_ledger')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('gift_card_id', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('amount_cents', 'integer', (c) => c.notNull())
        .addColumn('order_id', 'text')
        .addColumn('reason', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('loyalty_gift_card_ledger_tenant_id_idx')
        .on('loyalty_gift_card_ledger')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('loyalty_gift_card_ledger_tenant_card_idx')
        .on('loyalty_gift_card_ledger')
        .columns(['tenant_id', 'gift_card_id'])
        .execute();

      await db.schema
        .createTable('loyalty_store_credit_ledger')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('profile_id', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('amount_cents', 'integer', (c) => c.notNull())
        .addColumn('order_id', 'text')
        .addColumn('reason', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('loyalty_store_credit_ledger_tenant_id_idx')
        .on('loyalty_store_credit_ledger')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('loyalty_store_credit_ledger_tenant_profile_idx')
        .on('loyalty_store_credit_ledger')
        .columns(['tenant_id', 'profile_id'])
        .execute();

      await db.schema
        .createTable('loyalty_redemptions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('account_id', 'text', (c) => c.notNull())
        .addColumn('program_id', 'text', (c) => c.notNull())
        .addColumn('ledger_id', 'text', (c) => c.notNull())
        .addColumn('reference', 'text', (c) => c.notNull())
        .addColumn('reward_kind', 'text', (c) => c.notNull())
        .addColumn('reward_value', 'integer', (c) => c.notNull())
        .addColumn('amount', 'integer', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('order_id', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('loyalty_redemptions_tenant_id_idx')
        .on('loyalty_redemptions')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('loyalty_redemptions_tenant_reference_uq')
        .unique()
        .on('loyalty_redemptions')
        .columns(['tenant_id', 'reference'])
        .execute();
      await db.schema
        .createIndex('loyalty_redemptions_tenant_account_idx')
        .on('loyalty_redemptions')
        .columns(['tenant_id', 'account_id'])
        .execute();
    },
  },
];
