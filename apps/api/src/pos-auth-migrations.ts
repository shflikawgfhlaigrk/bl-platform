/** Durable, API-owned authentication state for the local POS register. */
import type { Migration } from '@blacklabel/db';

export const posAuthMigrations: Migration[] = [
  {
    name: 'api.0006_pos_auth',
    up: async (db) => {
      await db.schema
        .createTable('api_pos_credentials')
        .ifNotExists()
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('user_id', 'text', (c) => c.notNull())
        .addColumn('pin_salt', 'text', (c) => c.notNull())
        .addColumn('pin_hash', 'text', (c) => c.notNull())
        .addColumn('failed_attempts', 'integer', (c) => c.notNull())
        .addColumn('locked_until', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('api_pos_credentials_tenant_user_idx')
        .ifNotExists()
        .on('api_pos_credentials')
        .columns(['tenant_id', 'user_id'])
        .unique()
        .execute();

      await db.schema
        .createTable('api_pos_sessions')
        .ifNotExists()
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('user_id', 'text', (c) => c.notNull())
        .addColumn('token_hash', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('last_seen_at', 'text', (c) => c.notNull())
        .addColumn('expires_at', 'text', (c) => c.notNull())
        .addColumn('revoked_at', 'text')
        .execute();
      await db.schema
        .createIndex('api_pos_sessions_token_idx')
        .ifNotExists()
        .on('api_pos_sessions')
        .column('token_hash')
        .unique()
        .execute();
      await db.schema
        .createIndex('api_pos_sessions_tenant_user_idx')
        .ifNotExists()
        .on('api_pos_sessions')
        .columns(['tenant_id', 'user_id', 'created_at'])
        .execute();
    },
  },
];

export interface ApiPosCredentialRow {
  id: string;
  tenant_id: string;
  user_id: string;
  pin_salt: string;
  pin_hash: string;
  failed_attempts: number;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiPosSessionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface PosAuthTables {
  api_pos_credentials: ApiPosCredentialRow;
  api_pos_sessions: ApiPosSessionRow;
}
