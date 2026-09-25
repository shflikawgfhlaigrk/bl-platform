/**
 * apps/api-owned tables (composition-root config + wiring bookkeeping).
 *
 * The integrator owns a tiny amount of its own persistent state that no single
 * module should own:
 *   - `api_config`  — per-tenant operational config the wiring needs, most
 *     importantly the DEFAULT / quarantine / damaged inventory location ids and
 *     the seeded owner user id. Never business data; never secrets.
 *   - `api_event_dedupe` — a deterministic idempotency ledger for cross-module
 *     event handlers whose underlying service call is NOT natively idempotent
 *     (inventory `reserve`, transfer ship/receive). Check-then-insert on the
 *     handler's derived key makes every handler replay-tolerant (a duplicated or
 *     replayed domain event never performs the effect twice).
 *   - `api_pos_order_claims` — proof that a register order passed the POS
 *     server-side catalog, tax, customer, location, and provenance checks.
 *
 * Both tables are tenant-scoped and follow every CONVENTIONS rule (text ids,
 * ISO timestamps, tenant_id index, portable SQL, no ON CONFLICT).
 */
import type { Migration } from '@blacklabel/db';

export const apiMigrations: Migration[] = [
  {
    name: 'api.0001_config',
    up: async (db) => {
      await db.schema
        .createTable('api_config')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('key', 'text', (c) => c.notNull())
        .addColumn('value', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('api_config_tenant_id_idx')
        .on('api_config')
        .column('tenant_id')
        .execute();
      // One value per (tenant, key).
      await db.schema
        .createIndex('api_config_tenant_key_idx')
        .on('api_config')
        .columns(['tenant_id', 'key'])
        .unique()
        .execute();
    },
  },
  {
    name: 'api.0002_event_dedupe',
    up: async (db) => {
      await db.schema
        .createTable('api_event_dedupe')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('dedupe_key', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('api_event_dedupe_tenant_id_idx')
        .on('api_event_dedupe')
        .column('tenant_id')
        .execute();
      await db.schema
        .createIndex('api_event_dedupe_tenant_key_idx')
        .on('api_event_dedupe')
        .columns(['tenant_id', 'dedupe_key'])
        .unique()
        .execute();
    },
  },
  {
    name: 'api.0003_pos_order_claims',
    up: async (db) => {
      await db.schema
        .createTable('api_pos_order_claims')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('order_id', 'text', (c) => c.notNull())
        .addColumn('cart_id', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('api_pos_order_claims_tenant_order_idx')
        .on('api_pos_order_claims')
        .columns(['tenant_id', 'order_id'])
        .unique()
        .execute();
      await db.schema
        .createIndex('api_pos_order_claims_tenant_cart_idx')
        .on('api_pos_order_claims')
        .columns(['tenant_id', 'cart_id'])
        .unique()
        .execute();
    },
  },
];

/** Row shapes for the api-owned tables (the composition root's private DB view). */
export interface ApiConfigRow {
  id: string;
  tenant_id: string;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

export interface ApiEventDedupeRow {
  id: string;
  tenant_id: string;
  dedupe_key: string;
  created_at: string;
}

export interface ApiPosOrderClaimRow {
  id: string;
  tenant_id: string;
  order_id: string;
  cart_id: string;
  created_at: string;
}

export interface ApiDatabase {
  api_config: ApiConfigRow;
  api_event_dedupe: ApiEventDedupeRow;
  api_pos_order_claims: ApiPosOrderClaimRow;
}
