import { identityCredentials } from '../../../apps/api/src/identity';
const credentials = identityCredentials(Buffer.alloc(32, 9));
const owners = new Map<string,string>();
import type { Hono } from 'hono';
import {
  EventBus,
  asCoreDb,
  coreMigrations,
  createTenant,
  createUser,
  type PlatformEvent,
  type TenantEnv,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import {
  MemoryStorageProvider,
  filesMigrations,
  filesRouter,
  type FilesDatabase,
} from '@blacklabel/files';

export interface TestContext {
  db: ReturnType<typeof createTestDb<FilesDatabase>>;
  app: Hono<TenantEnv>;
  events: EventBus;
  storage: MemoryStorageProvider;
  /** Every event emitted during the test, in order. */
  emitted: PlatformEvent[];
  tenantA: { id: string };
  tenantB: { id: string };
  users: {
    owner: { id: string };
    admin: { id: string };
    member1: { id: string };
    member2: { id: string };
  };
}

export async function setup(): Promise<TestContext> {
  const db = createTestDb<FilesDatabase>();
  await runMigrations(db, [...coreMigrations, ...filesMigrations]);

  const core = asCoreDb(db);
  const tenantA = await createTenant(core, { name: 'Tenant A' });
  const tenantB = await createTenant(core, { name: 'Tenant B' });

  const owner = await createUser(core, tenantA.id, {
    name: 'Olive Owner',
    email: 'owner@a.test',
    role: 'owner',
  });
  const admin = await createUser(core, tenantA.id, {
    name: 'Ada Admin',
    email: 'admin@a.test',
    role: 'admin',
  });
  const member1 = await createUser(core, tenantA.id, {
    name: 'Mia Member',
    email: 'member1@a.test',
    role: 'member',
  });
  const member2 = await createUser(core, tenantA.id, {
    name: 'Max Member',
    email: 'member2@a.test',
    role: 'member',
  });

  const ownerB = await createUser(core, tenantB.id, {name:'Owner B',email:'owner@b.test',role:'owner'});
  owners.set(tenantA.id,owner.id); owners.set(tenantB.id,ownerB.id);
  const events = new EventBus();
  const emitted: PlatformEvent[] = [];
  events.on('*', (event) => {
    emitted.push(event);
  });

  const storage = new MemoryStorageProvider();
  const app = filesRouter({ db, events, contracts: {}, storage, authenticatedUserId: c => {
    const raw = c.req.header('authorization') || '';
    const p = raw.startsWith('Bearer ') ? credentials.verify(raw.slice(7)) : undefined;
    return p && p.tenantId === c.req.header('x-tenant-id') ? p.userId : undefined;
  } });

  return {
    db,
    app,
    events,
    storage,
    emitted,
    tenantA,
    tenantB,
    users: { owner, admin, member1, member2 },
  };
}

export function headers(tenantId: string, userId?: string): Record<string, string> {
  return {
    'x-tenant-id': tenantId,
    'content-type': 'application/json',
    authorization: 'Bearer ' + credentials.issue(tenantId,userId || owners.get(tenantId) || 'unknown'),
    ...(userId ? { 'x-user-id': userId } : {}),
  };
}

export const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

export interface UploadOptions {
  name: string;
  mime: string;
  content: string;
  userId?: string;
  folder_id?: string | null;
  visibility?: 'private' | 'tenant' | 'public';
  tags?: string[];
}

/** Drive the full two-step upload through the router; returns the file JSON. */
export async function uploadViaApi(
  app: Hono<TenantEnv>,
  tenantId: string,
  opts: UploadOptions,
): Promise<{ session: any; file: any }> {
  const h = headers(tenantId, opts.userId);
  const initRes = await app.request('/uploads', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({
      name: opts.name,
      mime: opts.mime,
      folder_id: opts.folder_id ?? null,
      visibility: opts.visibility,
      tags: opts.tags,
    }),
  });
  if (initRes.status !== 201) {
    throw new Error(`upload init failed (${initRes.status}): ${await initRes.text()}`);
  }
  const session = ((await initRes.json()) as any).data;
  const completeRes = await app.request(`/uploads/${session.id}/complete`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ content_base64: b64(opts.content) }),
  });
  if (completeRes.status !== 201) {
    throw new Error(`upload complete failed (${completeRes.status}): ${await completeRes.text()}`);
  }
  const file = ((await completeRes.json()) as any).data;
  return { session, file };
}
