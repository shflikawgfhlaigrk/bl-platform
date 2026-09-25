/**
 * Local-register authentication.
 *
 * Browser traffic receives an opaque, server-issued HttpOnly cookie after a
 * workforce operator proves their PIN. Only a SHA-256 token digest and a
 * scrypt PIN verifier are stored. The existing header/default-owner lane is
 * intentionally left to non-browser local tools and tests; browser requests
 * never inherit it.
 */
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import {
  ApiError,
  asCoreDb,
  createUser,
  errorHandler,
  getTenant,
  getUser,
  id,
  listUsers,
  nowIso,
  tenantMiddleware,
  type CoreDatabase,
  type TenantEnv,
  type UserRow,
} from '@blacklabel/core';
import {
  assignRole,
  can,
  listUserPermissions,
  listUserRoles,
  type WorkforceDatabase,
  type WorkforcePermission,
} from '@blacklabel/workforce';
import type { PosAuthTables } from './pos-auth-migrations';

export const POS_SESSION_COOKIE = 'mags_pos_session';
const DEFAULT_SESSION_HOURS = 720;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
const SESSION_TOUCH_MS = 5 * 60 * 1000;
const PIN_SCRYPT_BYTES = 32;

export type PosAuthDatabase = CoreDatabase & WorkforceDatabase & PosAuthTables;

export interface PosOperator {
  id: string;
  name: string;
  roles: string[];
  pinConfigured: boolean;
}

export interface PosSessionIdentity extends PosOperator {
  permissions: WorkforcePermission[];
  canManageOperators: boolean;
  expiresAt: string;
}

export interface PosAuthService {
  /** Resolve only a valid server-issued session cookie. */
  resolveSessionUserId: (c: Context, tenantId: string) => Promise<string | undefined>;
  /** Reject browser API traffic without a valid server-issued session. */
  browserGuard: MiddlewareHandler;
  router: Hono<TenantEnv>;
}

const pinSchema = z.string().regex(/^\d{4}$/, 'PIN must be exactly 4 digits');
const signInSchema = z.object({ userId: z.string().trim().min(1), pin: pinSchema });
const bootstrapSchema = z.object({ pin: pinSchema });
const setPinSchema = z.object({ pin: pinSchema });
const createOperatorSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email(),
  role: z.enum(['cashier', 'manager']),
  pin: pinSchema,
});

function tokenHash(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function pinDigest(pin: string, salt: string): Buffer {
  return scryptSync(pin, Buffer.from(salt, 'base64'), PIN_SCRYPT_BYTES, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

function makePinCredential(pin: string): { pin_salt: string; pin_hash: string } {
  const pin_salt = randomBytes(16).toString('base64');
  return { pin_salt, pin_hash: pinDigest(pin, pin_salt).toString('hex') };
}

function verifyPin(pin: string, salt: string, expectedHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = pinDigest(pin, salt);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function isBrowserApiRequest(c: Context): boolean {
  return Boolean(
    c.req.header('sec-fetch-site')
      || c.req.header('sec-fetch-mode')
      || c.req.header('sec-fetch-dest')
      || c.req.header('origin'),
  );
}

function authExemptPath(path: string): boolean {
  return path === '/api/health' || path === '/api/pos/auth' || path.startsWith('/api/pos/auth/');
}

function noStore(c: Context): void {
  c.header('cache-control', 'no-store');
  c.header('pragma', 'no-cache');
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw ApiError.badRequest('invalid JSON body');
  }
}

/** Build the shared resolver, browser guard, and buyer-facing auth routes. */
export function createPosAuth(db: Kysely<PosAuthDatabase>, options: {
  requireAllRequests?: boolean; bootstrapEnabled?: boolean; paymentWebhookPaths?: readonly string[];
} = {}): PosAuthService {
  const workforceDb = db as unknown as Kysely<WorkforceDatabase>;
  async function sessionHours(tenantId: string): Promise<number> {
    const policy = await db
      .selectFrom('workforce_session_policies')
      .select(['max_age_hours'])
      .where('tenant_id', '=', tenantId)
      .orderBy('id')
      .executeTakeFirst();
    const hours = policy?.max_age_hours ?? DEFAULT_SESSION_HOURS;
    return Number.isFinite(hours) && hours > 0 ? Math.trunc(hours) : DEFAULT_SESSION_HOURS;
  }

  async function sessionPolicy(tenantId: string): Promise<{ invalidatedAfter: string | null }> {
    const policy = await db
      .selectFrom('workforce_session_policies')
      .select('sessions_invalidated_after')
      .where('tenant_id', '=', tenantId)
      .orderBy('id')
      .executeTakeFirst();
    return { invalidatedAfter: policy?.sessions_invalidated_after ?? null };
  }

  async function resolveSession(c: Context, tenantId: string) {
    const raw = getCookie(c, POS_SESSION_COOKIE);
    if (!raw) return undefined;
    const row = await db
      .selectFrom('api_pos_sessions')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('token_hash', '=', tokenHash(raw))
      .executeTakeFirst();
    if (!row || row.revoked_at) return undefined;

    const now = nowIso();
    const policy = await sessionPolicy(tenantId);
    const invalidated = policy.invalidatedAfter !== null && row.created_at <= policy.invalidatedAfter;
    if (row.expires_at <= now || invalidated) {
      await db
        .updateTable('api_pos_sessions')
        .set({ revoked_at: now })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', row.id)
        .execute();
      return undefined;
    }
    const user = await getUser(asCoreDb(db), tenantId, row.user_id);
    if (!user) return undefined;
    if (Date.parse(now) - Date.parse(row.last_seen_at) >= SESSION_TOUCH_MS) {
      await db
        .updateTable('api_pos_sessions')
        .set({ last_seen_at: now })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', row.id)
        .execute();
    }
    return { row, user, raw };
  }

  async function requireSession(c: Context, tenantId: string) {
    const resolved = await resolveSession(c, tenantId);
    if (!resolved) throw ApiError.unauthorized('Sign in to the register to continue.');
    return resolved;
  }

  async function operatorRoles(tenantId: string, userId: string): Promise<string[]> {
    return (await listUserRoles(workforceDb, tenantId, userId)).map((role) => role.key);
  }

  async function isRegisterOperator(tenantId: string, userId: string): Promise<boolean> {
    const [read, write] = await Promise.all([
      can(workforceDb, tenantId, userId, 'orders.read'),
      can(workforceDb, tenantId, userId, 'orders.write'),
    ]);
    return read && write;
  }

  async function operatorFor(tenantId: string, user: UserRow): Promise<PosOperator> {
    const [roles, credential] = await Promise.all([
      operatorRoles(tenantId, user.id),
      db
        .selectFrom('api_pos_credentials')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('user_id', '=', user.id)
        .executeTakeFirst(),
    ]);
    return { id: user.id, name: user.name, roles, pinConfigured: Boolean(credential) };
  }

  async function listOperators(tenantId: string): Promise<PosOperator[]> {
    const users: UserRow[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await listUsers(asCoreDb(db), tenantId, { limit: 100, offset });
      users.push(...page);
      if (page.length < 100) break;
    }
    const eligible: UserRow[] = [];
    for (const user of users) {
      if (await isRegisterOperator(tenantId, user.id)) eligible.push(user);
    }
    return Promise.all(eligible.map((user) => operatorFor(tenantId, user)));
  }

  async function identityFor(
    tenantId: string,
    user: UserRow,
    expiresAt: string,
  ): Promise<PosSessionIdentity> {
    const [operator, permissions] = await Promise.all([
      operatorFor(tenantId, user),
      listUserPermissions(workforceDb, tenantId, user.id),
    ]);
    return {
      ...operator,
      permissions,
      canManageOperators: permissions.includes('workforce.admin'),
      expiresAt,
    };
  }

  async function setSessionCookie(c: Context, tenantId: string, user: UserRow): Promise<PosSessionIdentity> {
    const raw = randomBytes(32).toString('base64url');
    const now = nowIso();
    const maxAgeSeconds = (await sessionHours(tenantId)) * 60 * 60;
    const expiresAt = new Date(Date.parse(now) + maxAgeSeconds * 1000).toISOString();
    await db
      .insertInto('api_pos_sessions')
      .values({
        id: id(),
        tenant_id: tenantId,
        user_id: user.id,
        token_hash: tokenHash(raw),
        created_at: now,
        last_seen_at: now,
        expires_at: expiresAt,
        revoked_at: null,
      })
      .execute();
    setCookie(c, POS_SESSION_COOKIE, raw, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      secure: new URL(c.req.url).protocol === 'https:',
      maxAge: maxAgeSeconds,
    });
    return identityFor(tenantId, user, expiresAt);
  }

  async function savePin(tenantId: string, userId: string, pin: string): Promise<void> {
    const verifier = makePinCredential(pin);
    const now = nowIso();
    const existing = await db
      .selectFrom('api_pos_credentials')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (existing) {
      await db
        .updateTable('api_pos_credentials')
        .set({
          ...verifier,
          failed_attempts: 0,
          locked_until: null,
          updated_at: now,
        })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', existing.id)
        .execute();
      return;
    }
    await db
      .insertInto('api_pos_credentials')
      .values({
        id: id(),
        tenant_id: tenantId,
        user_id: userId,
        ...verifier,
        failed_attempts: 0,
        locked_until: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  async function recordFailedPin(tenantId: string, credential: PosAuthTables['api_pos_credentials']) {
    const now = nowIso();
    const lockedUntil = new Date(Date.parse(now) + LOCKOUT_MS).toISOString();
    // Compute the counter from the row at UPDATE time, not from the credential
    // snapshot loaded before scrypt. SQLite serializes these writes, so parallel
    // wrong-PIN requests cannot overwrite one another with the same count.
    // Requests already in flight when the fifth failure locks the credential
    // preserve that active lock instead of clearing it.
    await db
      .updateTable('api_pos_credentials')
      .set({
        failed_attempts: sql<number>`case
          when locked_until is not null and locked_until > ${now} then failed_attempts
          when locked_until is not null and locked_until <= ${now} then 1
          when failed_attempts + 1 >= ${MAX_FAILED_ATTEMPTS} then 0
          else failed_attempts + 1
        end`,
        locked_until: sql<string | null>`case
          when locked_until is not null and locked_until > ${now} then locked_until
          when locked_until is not null and locked_until <= ${now} then null
          when failed_attempts + 1 >= ${MAX_FAILED_ATTEMPTS} then ${lockedUntil}
          else null
        end`,
        updated_at: now,
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', credential.id)
      .execute();
  }

  const router = new Hono<TenantEnv>();
  router.onError(errorHandler);
  router.use('*', tenantMiddleware(asCoreDb(db)));
  router.use('*', async (c, next) => {
    noStore(c);
    await next();
  });

  router.get('/operators', async (c) => {
    const tenantId = c.get('tenantId');
    const [operators, credential] = await Promise.all([
      listOperators(tenantId),
      db
        .selectFrom('api_pos_credentials')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst(),
    ]);
    return c.json({ data: { operators, bootstrapRequired: !credential } });
  });

  router.post('/bootstrap', async (c) => {
    if (options.bootstrapEnabled === false) throw ApiError.forbidden('Owner access is provisioned on the venue server.');
    const tenantId = c.get('tenantId');
    const { pin } = bootstrapSchema.parse(await jsonBody(c));
    const existing = await db
      .selectFrom('api_pos_credentials')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    if (existing) throw ApiError.conflict('Register access is already initialized. Sign in instead.');

    const users = await listUsers(asCoreDb(db), tenantId, { limit: 100, offset: 0 });
    const owner = users.find((user) => user.role === 'owner');
    if (!owner || !(await can(workforceDb, tenantId, owner.id, 'workforce.admin'))) {
      throw ApiError.conflict('Register setup requires the seeded owner account.');
    }
    try {
      await savePin(tenantId, owner.id, pin);
    } catch (error) {
      const winner = await db
        .selectFrom('api_pos_credentials')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      if (winner) throw ApiError.conflict('Register access was initialized by another request. Sign in instead.');
      throw error;
    }
    return c.json({ data: await setSessionCookie(c, tenantId, owner) }, 201);
  });

  router.post('/session', async (c) => {
    const tenantId = c.get('tenantId');
    const { userId, pin } = signInSchema.parse(await jsonBody(c));
    const [user, credential, eligible] = await Promise.all([
      getUser(asCoreDb(db), tenantId, userId),
      db
        .selectFrom('api_pos_credentials')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('user_id', '=', userId)
        .executeTakeFirst(),
      isRegisterOperator(tenantId, userId),
    ]);
    if (!user || !credential || !eligible) throw ApiError.unauthorized('Incorrect operator or PIN.');
    if (credential.locked_until && credential.locked_until > nowIso()) {
      throw ApiError.unauthorized(`Operator is temporarily locked until ${credential.locked_until}.`);
    }
    if (!verifyPin(pin, credential.pin_salt, credential.pin_hash)) {
      await recordFailedPin(tenantId, credential);
      throw ApiError.unauthorized('Incorrect operator or PIN.');
    }
    const verifiedAt = nowIso();
    const reset = await db
      .updateTable('api_pos_credentials')
      .set({ failed_attempts: 0, locked_until: null, updated_at: verifiedAt })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', credential.id)
      .where((eb) => eb.or([
        eb('locked_until', 'is', null),
        eb('locked_until', '<=', verifiedAt),
      ]))
      .executeTakeFirst();
    // A fifth parallel failure can install the lock while this request is
    // doing the expensive scrypt comparison. Never let the stale successful
    // snapshot clear a lock that won that race.
    if (reset.numUpdatedRows === 0n) {
      const current = await db
        .selectFrom('api_pos_credentials')
        .select('locked_until')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', credential.id)
        .executeTakeFirst();
      throw ApiError.unauthorized(
        current?.locked_until
          ? `Operator is temporarily locked until ${current.locked_until}.`
          : 'Incorrect operator or PIN.',
      );
    }
    return c.json({ data: await setSessionCookie(c, tenantId, user) }, 201);
  });

  router.get('/session', async (c) => {
    const tenantId = c.get('tenantId');
    const session = await requireSession(c, tenantId);
    return c.json({ data: await identityFor(tenantId, session.user, session.row.expires_at) });
  });

  router.delete('/session', async (c) => {
    const tenantId = c.get('tenantId');
    const raw = getCookie(c, POS_SESSION_COOKIE);
    if (raw) {
      await db
        .updateTable('api_pos_sessions')
        .set({ revoked_at: nowIso() })
        .where('tenant_id', '=', tenantId)
        .where('token_hash', '=', tokenHash(raw))
        .execute();
    }
    deleteCookie(c, POS_SESSION_COOKIE, { path: '/' });
    return c.json({ data: { signedOut: true } });
  });

  router.put('/operators/:userId/pin', async (c) => {
    const tenantId = c.get('tenantId');
    const session = await requireSession(c, tenantId);
    const targetId = c.req.param('userId');
    const { pin } = setPinSchema.parse(await jsonBody(c));
    const manages = await can(workforceDb, tenantId, session.user.id, 'workforce.admin');
    if (session.user.id !== targetId && !manages) {
      throw ApiError.forbidden('Only an owner can set another operator PIN.');
    }
    const target = await getUser(asCoreDb(db), tenantId, targetId);
    if (!target || !(await isRegisterOperator(tenantId, target.id))) {
      throw ApiError.notFound('Register operator not found.');
    }
    await savePin(tenantId, target.id, pin);
    const currentToken = getCookie(c, POS_SESSION_COOKIE);
    let revoke = db
      .updateTable('api_pos_sessions')
      .set({ revoked_at: nowIso() })
      .where('tenant_id', '=', tenantId)
      .where('user_id', '=', target.id)
      .where('revoked_at', 'is', null);
    if (target.id === session.user.id && currentToken) {
      revoke = revoke.where('token_hash', '!=', tokenHash(currentToken));
    }
    await revoke.execute();
    return c.json({ data: await operatorFor(tenantId, target) });
  });

  router.post('/operators', async (c) => {
    const tenantId = c.get('tenantId');
    const session = await requireSession(c, tenantId);
    if (!(await can(workforceDb, tenantId, session.user.id, 'workforce.admin'))) {
      throw ApiError.forbidden('Only an owner can add a register operator.');
    }
    const body = createOperatorSchema.parse(await jsonBody(c));
    const role = await db
      .selectFrom('workforce_roles')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('key', '=', body.role)
      .executeTakeFirst();
    if (!role) throw ApiError.conflict('Built-in workforce roles are not initialized.');
    const user = await db.transaction().execute(async (trx) => {
      const created = await createUser(asCoreDb(trx), tenantId, {
        name: body.name,
        email: body.email,
        role: 'member',
      });
      await assignRole(trx as unknown as Kysely<WorkforceDatabase>, tenantId, session.user.id, created.id, role.id);
      return created;
    });
    await savePin(tenantId, user.id, body.pin);
    return c.json({ data: await operatorFor(tenantId, user) }, 201);
  });

  const browserGuard: MiddlewareHandler = async (c, next) => {
    if ((!options.requireAllRequests && !isBrowserApiRequest(c)) || authExemptPath(c.req.path)) return next();
    if (options.requireAllRequests && c.req.method === 'POST' && options.paymentWebhookPaths?.includes(c.req.path)) return next();
    const tenantId = c.req.header('x-tenant-id')?.trim();
    // Preserve the canonical tenant-header/unknown-tenant errors downstream.
    if (!tenantId) return next();
    if (!(await getTenant(asCoreDb(db), tenantId))) return next();
    const resolved = await resolveSession(c, tenantId);
    if (!resolved) throw ApiError.unauthorized('Sign in to the register to continue.');
    const expectedActor = c.req.header('x-pos-expected-user-id')?.trim();
    if (expectedActor && expectedActor !== resolved.user.id) {
      throw ApiError.conflict('This queued change belongs to a different register operator. Sign in as that operator to retry it.');
    }
    // Module routers historically consume x-user-id for audit attribution.
    // Replace any browser-supplied value with the validated session identity so
    // every downstream route sees one canonical actor, not a spoofable header.
    c.req.raw.headers.set('x-user-id', resolved.user.id);
    await next();
  };

  return {
    resolveSessionUserId: async (c, tenantId) => (await resolveSession(c, tenantId))?.user.id,
    browserGuard,
    router,
  };
}
