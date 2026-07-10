import { describe, expect, it } from 'vitest';
import {
  ApiError,
  coreMigrations,
  createTenant,
  createUser,
  deleteTenant,
  deleteUser,
  getTenant,
  getUser,
  listTenants,
  listUsers,
  updateTenant,
  updateUser,
  type CoreDatabase,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';

async function setup() {
  const db = createTestDb<CoreDatabase>();
  await runMigrations(db, coreMigrations);
  return db;
}

describe('tenant CRUD', () => {
  it('creates, reads, updates and deletes tenants', async () => {
    const db = await setup();
    const t = await createTenant(db, { name: 'Acme' });
    expect(t.id).toBeTruthy();
    expect(await getTenant(db, t.id)).toEqual(t);

    const updated = await updateTenant(db, t.id, { name: 'Acme LLC' });
    expect(updated.name).toBe('Acme LLC');

    expect((await listTenants(db)).map((x) => x.id)).toContain(t.id);

    await deleteTenant(db, t.id);
    expect(await getTenant(db, t.id)).toBeUndefined();
  });

  it('throws ApiError 404 for missing tenants and 400 for blank names', async () => {
    const db = await setup();
    await expect(updateTenant(db, 'missing', { name: 'x' })).rejects.toMatchObject({ status: 404 });
    await expect(deleteTenant(db, 'missing')).rejects.toMatchObject({ status: 404 });
    await expect(createTenant(db, { name: '   ' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('user CRUD (tenant-scoped)', () => {
  it('creates, reads, updates, lists and deletes users within a tenant', async () => {
    const db = await setup();
    const t = await createTenant(db, { name: 'Acme' });
    const u = await createUser(db, t.id, { name: 'Mia', email: 'MIA@Acme.com', role: 'admin' });
    expect(u.email).toBe('mia@acme.com'); // normalized
    expect(u.tenant_id).toBe(t.id);

    const fetched = await getUser(db, t.id, u.id);
    expect(fetched).toEqual(u);

    const updated = await updateUser(db, t.id, u.id, { role: 'member' });
    expect(updated.role).toBe('member');

    expect((await listUsers(db, t.id)).map((x) => x.id)).toEqual([u.id]);

    await deleteUser(db, t.id, u.id);
    expect(await getUser(db, t.id, u.id)).toBeUndefined();
  });

  it('rejects invalid input', async () => {
    const db = await setup();
    const t = await createTenant(db, { name: 'Acme' });
    await expect(
      createUser(db, t.id, { name: '', email: 'a@b.c', role: 'member' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      createUser(db, t.id, { name: 'x', email: 'not-an-email', role: 'member' }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('tenant isolation (denial tests)', () => {
  it('users of tenant A are invisible and immutable from tenant B', async () => {
    const db = await setup();
    const a = await createTenant(db, { name: 'Tenant A' });
    const b = await createTenant(db, { name: 'Tenant B' });
    const userA = await createUser(db, a.id, { name: 'Ana', email: 'ana@a.com', role: 'owner' });

    // read denial
    expect(await getUser(db, b.id, userA.id)).toBeUndefined();
    expect(await listUsers(db, b.id)).toEqual([]);

    // write denial
    await expect(updateUser(db, b.id, userA.id, { name: 'Hacked' })).rejects.toMatchObject({
      status: 404,
    });
    await expect(deleteUser(db, b.id, userA.id)).rejects.toMatchObject({ status: 404 });

    // and tenant A is untouched
    const stillThere = await getUser(db, a.id, userA.id);
    expect(stillThere?.name).toBe('Ana');
  });

  it('denial errors are ApiError instances (canonical envelope-compatible)', async () => {
    const db = await setup();
    const b = await createTenant(db, { name: 'Tenant B' });
    try {
      await deleteUser(db, b.id, 'ghost');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(404);
    }
  });
});
