import { describe, expect, it } from 'vitest';
import { asCoreDb, coreMigrations, createTenant } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import {
  portalCustomerMigrations,
  seedPortalCustomer,
  type PortalCustomerDatabase,
} from '@blacklabel/portal-customer';
import { api, setup } from './helpers';

describe('portal-customer migrations', () => {
  it('applies on a fresh test db (after core) and creates all module tables', async () => {
    const db = createTestDb<PortalCustomerDatabase>();
    const result = await runMigrations(db, [...coreMigrations, ...portalCustomerMigrations]);
    expect(result.applied).toContain('portal-customer.0001_portal_tables');

    // Every table is queryable and empty.
    expect(await db.selectFrom('portal_customer_accounts').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('portal_customer_login_tokens').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('portal_customer_sessions').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('portal_customer_messages').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('portal_customer_uploads').selectAll().execute()).toEqual([]);
  });

  it('is idempotent on re-run', async () => {
    const db = createTestDb<PortalCustomerDatabase>();
    const all = [...coreMigrations, ...portalCustomerMigrations];
    await runMigrations(db, all);
    const second = await runMigrations(db, all);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('portal-customer.0001_portal_tables');
  });

  it('seed creates demo accounts with a working session and exchangeable login token', async () => {
    const ctx = await setup();
    const seeded = await seedPortalCustomer(ctx.db, ctx.tenantA);
    expect(seeded.accounts).toHaveLength(2);

    // The seeded session token authenticates on /me.
    const me = await api(ctx.app, ctx.tenantA, 'GET', '/me', undefined, seeded.sessionToken);
    expect(me.status).toBe(200);
    expect(((await me.json()) as any).data.email).toBe('ada@example.com');

    // The seeded login token is exchangeable.
    const exchanged = await api(ctx.app, ctx.tenantA, 'POST', '/auth/exchange', { token: seeded.loginToken });
    expect(exchanged.status).toBe(200);
  });

  it('runs alongside core data (tenants) without interference', async () => {
    const db = createTestDb<PortalCustomerDatabase>();
    await runMigrations(db, [...coreMigrations, ...portalCustomerMigrations]);
    const tenant = await createTenant(asCoreDb(db), { name: 'T' });
    expect(tenant.id).toBeTruthy();
  });
});
