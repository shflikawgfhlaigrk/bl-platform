import type { Kysely } from 'kysely';
import { ApiError } from './errors';
import { id, nowIso } from './helpers';
import type { Pagination } from './query';
import type { CoreDatabase, TenantRow, UserRole, UserRow } from './schema';

/* ------------------------------------------------------------------ *
 * Tenants
 * ------------------------------------------------------------------ */

export async function createTenant(
  db: Kysely<CoreDatabase>,
  input: { name: string },
): Promise<TenantRow> {
  if (!input.name || input.name.trim() === '') {
    throw ApiError.badRequest('tenant name is required');
  }
  const row: TenantRow = { id: id(), name: input.name.trim(), created_at: nowIso() };
  await db.insertInto('tenants').values(row).execute();
  return row;
}

export async function getTenant(
  db: Kysely<CoreDatabase>,
  tenantId: string,
): Promise<TenantRow | undefined> {
  return db.selectFrom('tenants').selectAll().where('id', '=', tenantId).executeTakeFirst();
}

export async function listTenants(db: Kysely<CoreDatabase>): Promise<TenantRow[]> {
  return db.selectFrom('tenants').selectAll().orderBy('created_at').orderBy('id').execute();
}

export async function updateTenant(
  db: Kysely<CoreDatabase>,
  tenantId: string,
  patch: { name?: string },
): Promise<TenantRow> {
  if (patch.name !== undefined && patch.name.trim() === '') {
    throw ApiError.badRequest('tenant name cannot be blank');
  }
  if (patch.name !== undefined) {
    const result = await db
      .updateTable('tenants')
      .set({ name: patch.name.trim() })
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) {
      throw ApiError.notFound(`tenant not found: ${tenantId}`);
    }
  }
  const tenant = await getTenant(db, tenantId);
  if (!tenant) throw ApiError.notFound(`tenant not found: ${tenantId}`);
  return tenant;
}

export async function deleteTenant(db: Kysely<CoreDatabase>, tenantId: string): Promise<void> {
  const result = await db.deleteFrom('tenants').where('id', '=', tenantId).executeTakeFirst();
  if (result.numDeletedRows === 0n) {
    throw ApiError.notFound(`tenant not found: ${tenantId}`);
  }
}

/* ------------------------------------------------------------------ *
 * Users (always tenant-scoped)
 * ------------------------------------------------------------------ */

export async function createUser(
  db: Kysely<CoreDatabase>,
  tenantId: string,
  input: { name: string; email: string; role: UserRole },
): Promise<UserRow> {
  if (!input.name || input.name.trim() === '') throw ApiError.badRequest('user name is required');
  if (!input.email || !input.email.includes('@')) throw ApiError.badRequest('valid email is required');
  const row: UserRow = {
    id: id(),
    tenant_id: tenantId,
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    role: input.role,
    created_at: nowIso(),
  };
  await db.insertInto('users').values(row).execute();
  return row;
}

export async function getUser(
  db: Kysely<CoreDatabase>,
  tenantId: string,
  userId: string,
): Promise<UserRow | undefined> {
  return db
    .selectFrom('users')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', userId)
    .executeTakeFirst();
}

export async function listUsers(
  db: Kysely<CoreDatabase>,
  tenantId: string,
  page: Pagination = { limit: 50, offset: 0 },
): Promise<UserRow[]> {
  return db
    .selectFrom('users')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export async function updateUser(
  db: Kysely<CoreDatabase>,
  tenantId: string,
  userId: string,
  patch: { name?: string; email?: string; role?: UserRole },
): Promise<UserRow> {
  const set: Partial<Pick<UserRow, 'name' | 'email' | 'role'>> = {};
  if (patch.name !== undefined) {
    if (patch.name.trim() === '') throw ApiError.badRequest('user name cannot be blank');
    set.name = patch.name.trim();
  }
  if (patch.email !== undefined) {
    if (!patch.email.includes('@')) throw ApiError.badRequest('valid email is required');
    set.email = patch.email.trim().toLowerCase();
  }
  if (patch.role !== undefined) set.role = patch.role;

  if (Object.keys(set).length > 0) {
    const result = await db
      .updateTable('users')
      .set(set)
      .where('tenant_id', '=', tenantId)
      .where('id', '=', userId)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) {
      throw ApiError.notFound(`user not found: ${userId}`);
    }
  }
  const user = await getUser(db, tenantId, userId);
  if (!user) throw ApiError.notFound(`user not found: ${userId}`);
  return user;
}

export async function deleteUser(
  db: Kysely<CoreDatabase>,
  tenantId: string,
  userId: string,
): Promise<void> {
  const result = await db
    .deleteFrom('users')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', userId)
    .executeTakeFirst();
  if (result.numDeletedRows === 0n) {
    throw ApiError.notFound(`user not found: ${userId}`);
  }
}
