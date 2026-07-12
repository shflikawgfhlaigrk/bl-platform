import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  asCoreDb,
  errorHandler,
  listAuditEntries,
  tenantMiddleware,
  type TenantEnv,
} from '@blacklabel/core';
import {
  BUILTIN_ROLE_PERMISSIONS,
  WORKFORCE_PERMISSIONS,
  can,
  requirePermission,
} from '@blacklabel/workforce';
import { body, del, get, makeUser, post, seed, setup, type TestContext } from './helpers';

describe('workforce RBAC: built-in matrix seeding', () => {
  it('seeds all built-in roles idempotently with the least-privilege matrix', async () => {
    const ctx = await setup();
    const first = await seed(ctx, ctx.tenantA);
    expect(first.createdRoleKeys.sort()).toEqual(
      ['accountant_readonly', 'cashier', 'fulfillment', 'inventory', 'manager', 'owner', 'purchasing'].sort(),
    );
    // Re-seed: no new roles, ids stable, no duplicate permission grants.
    const second = await seed(ctx, ctx.tenantA);
    expect(second.createdRoleKeys).toEqual([]);
    expect(second.roleIds).toEqual(first.roleIds);

    const grantRows = await ctx.db
      .selectFrom('workforce_role_permissions')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantA)
      .execute();
    // owner has every permission exactly once.
    const ownerGrants = grantRows.filter((r) => r.role_id === first.roleIds.owner);
    expect(ownerGrants.map((r) => r.permission).sort()).toEqual([...WORKFORCE_PERMISSIONS].sort());
    // No duplicate (role_id, permission) rows after two seeds.
    const seen = new Set<string>();
    for (const r of grantRows) {
      const key = `${r.role_id}:${r.permission}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('matrix expectations: cashier / inventory / purchasing least-privilege', async () => {
    const ctx = await setup();
    await seed(ctx, ctx.tenantA);
    const cashier = await ctx.db
      .selectFrom('workforce_roles')
      .select('id')
      .where('tenant_id', '=', ctx.tenantA)
      .where('key', '=', 'cashier')
      .executeTakeFirstOrThrow();

    expect(await can(ctx.db, ctx.tenantA, '__none__', 'orders.write')).toBe(false); // no user yet

    // cashier: orders.read/write + inventory.read + customers.read, nothing else
    expect(BUILTIN_ROLE_PERMISSIONS.cashier).toEqual([
      'orders.read',
      'orders.write',
      'inventory.read',
      'customers.read',
    ]);
    // inventory role: full inventory + catalog.read
    expect(BUILTIN_ROLE_PERMISSIONS.inventory).toContain('inventory.transfer');
    expect(BUILTIN_ROLE_PERMISSIONS.inventory).toContain('catalog.read');
    expect(BUILTIN_ROLE_PERMISSIONS.inventory).not.toContain('orders.write');
    // purchasing: approve + read catalog/inventory
    expect(BUILTIN_ROLE_PERMISSIONS.purchasing).toContain('purchasing.approve');
    expect(BUILTIN_ROLE_PERMISSIONS.purchasing).toContain('catalog.read');
    expect(cashier.id).toBeTruthy();
  });

  it('accountant_readonly has ONLY .read permissions — NO write anywhere', async () => {
    const ctx = await setup();
    await seed(ctx, ctx.tenantA);
    const perms = BUILTIN_ROLE_PERMISSIONS.accountant_readonly;
    // Every permission is a *.read
    for (const p of perms) expect(p.endsWith('.read')).toBe(true);
    // Explicitly no mutating permission of any shape
    for (const banned of [
      'catalog.write',
      'inventory.write',
      'inventory.count',
      'inventory.transfer',
      'orders.write',
      'orders.refund',
      'customers.write',
      'customers.export',
      'purchasing.write',
      'purchasing.approve',
      'shows.write',
      'shows.close',
      'finance.write',
      'finance.close',
      'outreach.write',
      'outreach.arm',
      'workforce.admin',
      'admin.admin',
      'automation.admin',
      'storefront.publish',
    ] as const) {
      expect(perms).not.toContain(banned);
    }
    // It DOES include finance.read (finance exports run behind finance.read).
    expect(perms).toContain('finance.read');
  });
});

describe('workforce RBAC: can() union + user assignment', () => {
  it('unions permissions across multiple roles', async () => {
    const ctx = await setup();
    const { roleIds } = await seed(ctx, ctx.tenantA);
    const userId = await makeUser(ctx, ctx.tenantA, { name: 'Multi', email: 'multi@a.com' });

    // Assign cashier + inventory: union covers orders.write AND inventory.transfer.
    await post(ctx, ctx.tenantA, `/users/${userId}/roles`, { roleId: roleIds.cashier });
    await post(ctx, ctx.tenantA, `/users/${userId}/roles`, { roleId: roleIds.inventory });

    expect(await can(ctx.db, ctx.tenantA, userId, 'orders.write')).toBe(true); // from cashier
    expect(await can(ctx.db, ctx.tenantA, userId, 'inventory.transfer')).toBe(true); // from inventory
    expect(await can(ctx.db, ctx.tenantA, userId, 'catalog.read')).toBe(true); // from inventory
    // Neither role grants finance.close.
    expect(await can(ctx.db, ctx.tenantA, userId, 'finance.close')).toBe(false);
    // Unknown permission strings never resolve true.
    expect(await can(ctx.db, ctx.tenantA, userId, 'made.up')).toBe(false);
  });

  it('assign is idempotent + unassign removes the grant; both audited', async () => {
    const ctx = await setup();
    const { roleIds } = await seed(ctx, ctx.tenantA);
    const userId = await makeUser(ctx, ctx.tenantA, { name: 'U', email: 'u@a.com' });

    await post(ctx, ctx.tenantA, `/users/${userId}/roles`, { roleId: roleIds.cashier });
    await post(ctx, ctx.tenantA, `/users/${userId}/roles`, { roleId: roleIds.cashier }); // dup
    const rows = await ctx.db
      .selectFrom('workforce_user_roles')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantA)
      .where('user_id', '=', userId)
      .execute();
    expect(rows).toHaveLength(1);

    const del = await ctx.app.request(`/users/${userId}/roles/${roleIds.cashier}`, {
      method: 'DELETE',
      headers: { 'x-tenant-id': ctx.tenantA },
    });
    expect(del.status).toBe(200);
    expect(await can(ctx.db, ctx.tenantA, userId, 'orders.write')).toBe(false);

    const audits = await listAuditEntries(
      asCoreDb(ctx.db),
      ctx.tenantA,
      'workforce.user_role',
      userId,
    );
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('workforce.user_role.assigned');
    expect(actions).toContain('workforce.user_role.unassigned');
  });

  it('GET /can reflects the union and is tenant-scoped', async () => {
    const ctx = await setup();
    const { roleIds } = await seed(ctx, ctx.tenantA);
    const userId = await makeUser(ctx, ctx.tenantA, { name: 'C', email: 'c@a.com' });
    await post(ctx, ctx.tenantA, `/users/${userId}/roles`, { roleId: roleIds.purchasing });

    const yes = await get(ctx, ctx.tenantA, `/can?userId=${userId}&permission=purchasing.approve`);
    expect((await body(yes)).data.allowed).toBe(true);
    const no = await get(ctx, ctx.tenantA, `/can?userId=${userId}&permission=finance.close`);
    expect((await body(no)).data.allowed).toBe(false);
  });
});

/* ----------------------------------------------------------------- *
 * permissionMiddleware — journey 18: cross-role denial, 403 envelope
 * ----------------------------------------------------------------- */

function guardedApp(ctx: TestContext, actingUserId: () => string) {
  const guard = requirePermission(ctx.db);
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(ctx.db)));
  const getUserId = () => actingUserId();
  app.use('/purchasing/*', guard(getUserId, 'purchasing.approve'));
  app.get('/purchasing/pos', (c) => c.json({ data: 'approved-po-view' }));
  app.use('/customers/export', guard(getUserId, 'customers.export'));
  app.get('/customers/export', (c) => c.json({ data: 'customer-export' }));
  app.use('/finance/*', guard(getUserId, 'finance.close'));
  app.get('/finance/close', (c) => c.json({ data: 'cash-close' }));
  app.use('/admin/*', guard(getUserId, 'admin.admin'));
  app.get('/admin/creds', (c) => c.json({ data: 'credentials' }));
  return app;
}

describe('permissionMiddleware — journey 18 cross-role denial', () => {
  it('allows the owner and denies a cashier across purchasing/customers-export/finance/admin', async () => {
    const ctx = await setup();
    const { roleIds } = await seed(ctx, ctx.tenantA);
    const owner = await makeUser(ctx, ctx.tenantA, { name: 'Owner', email: 'owner@a.com' });
    const cashier = await makeUser(ctx, ctx.tenantA, { name: 'Cashier', email: 'cash@a.com' });
    await post(ctx, ctx.tenantA, `/users/${owner}/roles`, { roleId: roleIds.owner });
    await post(ctx, ctx.tenantA, `/users/${cashier}/roles`, { roleId: roleIds.cashier });

    let acting = owner;
    const app = guardedApp(ctx, () => acting);
    const req = (path: string) =>
      app.request(path, { headers: { 'x-tenant-id': ctx.tenantA } });

    // Owner passes every guarded route.
    for (const path of ['/purchasing/pos', '/customers/export', '/finance/close', '/admin/creds']) {
      expect((await req(path)).status).toBe(200);
    }

    // Cashier is denied on all four, with the canonical 403 forbidden envelope.
    acting = cashier;
    for (const path of ['/purchasing/pos', '/customers/export', '/finance/close', '/admin/creds']) {
      const res = await req(path);
      expect(res.status).toBe(403);
      const env = (await res.json()) as any;
      expect(env.error.code).toBe('forbidden');
      expect(env.error.message).toMatch(/missing permission/);
    }
  });

  it('accountant_readonly is denied customers.export AND every write route (read-only proof)', async () => {
    const ctx = await setup();
    const { roleIds } = await seed(ctx, ctx.tenantA);
    const acct = await makeUser(ctx, ctx.tenantA, { name: 'Acct', email: 'acct@a.com' });
    await post(ctx, ctx.tenantA, `/users/${acct}/roles`, { roleId: roleIds.accountant_readonly });

    const app = guardedApp(ctx, () => acct);
    for (const path of ['/purchasing/pos', '/customers/export', '/finance/close', '/admin/creds']) {
      const res = await app.request(path, { headers: { 'x-tenant-id': ctx.tenantA } });
      expect(res.status).toBe(403);
    }
  });

  it('401 when no acting user resolves', async () => {
    const ctx = await setup();
    await seed(ctx, ctx.tenantA);
    const app = guardedApp(ctx, () => '');
    const res = await app.request('/purchasing/pos', { headers: { 'x-tenant-id': ctx.tenantA } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.code).toBe('unauthorized');
  });
});

describe('workforce RBAC: tenant isolation', () => {
  it('roles + user grants do not leak across tenants', async () => {
    const ctx = await setup();
    const a = await seed(ctx, ctx.tenantA);
    await seed(ctx, ctx.tenantB);
    const userA = await makeUser(ctx, ctx.tenantA, { name: 'A', email: 'a@a.com' });
    await post(ctx, ctx.tenantA, `/users/${userA}/roles`, { roleId: a.roleIds.owner });

    // can() for tenant A's user under tenant B never resolves true.
    expect(await can(ctx.db, ctx.tenantA, userA, 'admin.admin')).toBe(true);
    expect(await can(ctx.db, ctx.tenantB, userA, 'admin.admin')).toBe(false);

    // Tenant B cannot fetch tenant A's role.
    const cross = await get(ctx, ctx.tenantB, `/roles/${a.roleIds.owner}`);
    expect(cross.status).toBe(404);

    // Tenant B's role list is its own freshly-seeded set (different ids).
    const bRoles = (await body(await get(ctx, ctx.tenantB, '/roles'))).data;
    expect(bRoles.map((r: any) => r.id)).not.toContain(a.roleIds.owner);
  });

  it('built-in roles cannot be deleted; custom roles can', async () => {
    const ctx = await setup();
    const { roleIds } = await seed(ctx, ctx.tenantA);
    const delBuiltin = await del(ctx, ctx.tenantA, `/roles/${roleIds.owner}`);
    expect(delBuiltin.status).toBe(409);

    const custom = (await body(
      await post(ctx, ctx.tenantA, '/roles', { key: 'floor_lead', name: 'Floor Lead' }),
    )).data;
    expect(custom.builtin).toBe(false);
    const delCustom = await del(ctx, ctx.tenantA, `/roles/${custom.id}`);
    expect(delCustom.status).toBe(200);
  });

  it('grant/revoke permission on a role is audited before/after', async () => {
    const ctx = await setup();
    const custom = (await body(
      await post(ctx, ctx.tenantA, '/roles', { key: 'runner', name: 'Runner' }),
    )).data;
    await post(ctx, ctx.tenantA, `/roles/${custom.id}/permissions`, { permission: 'orders.read' });
    const revoke = await del(ctx, ctx.tenantA, `/roles/${custom.id}/permissions/orders.read`);
    expect(revoke.status).toBe(200);

    const audits = await listAuditEntries(
      asCoreDb(ctx.db),
      ctx.tenantA,
      'workforce.role_permission',
      custom.id,
    );
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('workforce.role_permission.granted');
    expect(actions).toContain('workforce.role_permission.revoked');
    const granted = audits.find((a) => a.action === 'workforce.role_permission.granted')!;
    const diff = JSON.parse(granted.diff!);
    expect(diff.before).not.toContain('orders.read');
    expect(diff.after).toContain('orders.read');
  });

  it('rejects an unknown permission on grant (400)', async () => {
    const ctx = await setup();
    const custom = (await body(
      await post(ctx, ctx.tenantA, '/roles', { key: 'x', name: 'X' }),
    )).data;
    const res = await post(ctx, ctx.tenantA, `/roles/${custom.id}/permissions`, {
      permission: 'not.real',
    });
    expect(res.status).toBe(400);
  });
});
