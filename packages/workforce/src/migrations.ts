import type { Migration } from '@blacklabel/db';

/**
 * workforce migrations. Append-only — never edit or reorder a shipped
 * migration; new change = new entry appended to this array.
 */
export const workforceMigrations: Migration[] = [
  {
    name: 'workforce.0001_rbac',
    up: async (db) => {
      // roles
      await db.schema
        .createTable('workforce_roles')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('key', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('builtin', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('workforce_roles_tenant_id_key_idx')
        .on('workforce_roles')
        .columns(['tenant_id', 'key'])
        .execute();

      // role -> permission grants
      await db.schema
        .createTable('workforce_role_permissions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('role_id', 'text', (c) => c.notNull())
        .addColumn('permission', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('workforce_role_permissions_tenant_id_role_id_idx')
        .on('workforce_role_permissions')
        .columns(['tenant_id', 'role_id'])
        .execute();

      // user -> role assignments
      await db.schema
        .createTable('workforce_user_roles')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('user_id', 'text', (c) => c.notNull())
        .addColumn('role_id', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('workforce_user_roles_tenant_id_user_id_idx')
        .on('workforce_user_roles')
        .columns(['tenant_id', 'user_id'])
        .execute();

      // invitations
      await db.schema
        .createTable('workforce_invitations')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('email', 'text', (c) => c.notNull())
        .addColumn('role_id', 'text', (c) => c.notNull())
        .addColumn('token_hash', 'text', (c) => c.notNull())
        .addColumn('expires_at', 'text', (c) => c.notNull())
        .addColumn('accepted_at', 'text')
        .addColumn('revoked', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('workforce_invitations_tenant_id_idx')
        .on('workforce_invitations')
        .column('tenant_id')
        .execute();

      // per-tenant session policy (singleton per tenant)
      await db.schema
        .createTable('workforce_session_policies')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('max_age_hours', 'integer', (c) => c.notNull())
        .addColumn('sessions_invalidated_after', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('workforce_session_policies_tenant_id_idx')
        .on('workforce_session_policies')
        .column('tenant_id')
        .execute();
    },
  },
  {
    name: 'workforce.0002_scheduling_exports_handoffs',
    up: async (db) => {
      // schedules
      await db.schema
        .createTable('workforce_schedules')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('user_id', 'text', (c) => c.notNull())
        .addColumn('starts_at', 'text', (c) => c.notNull())
        .addColumn('ends_at', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('show_ref', 'text')
        .addColumn('note', 'text')
        .addColumn('published', 'integer', (c) => c.notNull())
        .addColumn('overridden', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('workforce_schedules_tenant_id_user_id_idx')
        .on('workforce_schedules')
        .columns(['tenant_id', 'user_id'])
        .execute();

      // time exports (payroll adapter output — no pay math)
      await db.schema
        .createTable('workforce_time_exports')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('adapter', 'text', (c) => c.notNull())
        .addColumn('row_count', 'integer', (c) => c.notNull())
        .addColumn('payload', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('workforce_time_exports_tenant_id_idx')
        .on('workforce_time_exports')
        .column('tenant_id')
        .execute();

      // shift handoffs
      await db.schema
        .createTable('workforce_handoffs')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tenant_id', 'text', (c) => c.notNull())
        .addColumn('from_user', 'text', (c) => c.notNull())
        .addColumn('to_user', 'text')
        .addColumn('shift_ref', 'text')
        .addColumn('body', 'text', (c) => c.notNull())
        .addColumn('open_items', 'text', (c) => c.notNull())
        .addColumn('acknowledged', 'integer', (c) => c.notNull())
        .addColumn('acknowledged_at', 'text')
        .addColumn('acknowledged_by', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex('workforce_handoffs_tenant_id_idx')
        .on('workforce_handoffs')
        .column('tenant_id')
        .execute();
    },
  },
];
