/**
 * @blacklabel/api — HTTP entry point (the real, port-binding bootstrap).
 *
 * `app.ts` builds a db-agnostic Hono app (`createApp`). This file is the ONLY
 * place that opens the real file-backed database, wires the real on-disk
 * injections (admin master key, better-sqlite3 backup provider + count probe),
 * optionally serves a built UI from UI_DIR, and binds a loopback TCP port.
 *
 * Run:  npm --workspace @blacklabel/api run start
 * Env:
 *   PORT                     default 8460
 *   PLATFORM_STORAGE_DIR     default ./.storage        (START-MAGS-OS sets this)
 *   PLATFORM_DB_PATH         default <storage>/platform.db (or DB_PATH)
 *   PLATFORM_DEFAULT_TENANT_NAME  single-tenant local mode (owner UI)
 *   UI_DIR                   serve a built UI at / (API stays under /api)
 *   DEFAULT_LOCATION_ID      default inventory location fallback
 *   OWNER_USER_ID            default acting owner id
 *   ADMIN_MASTER_KEY         base64 32 bytes (AES-256-GCM), OR
 *   ADMIN_MASTER_KEY_FILE    path to a key file; else auto-generated ONCE into
 *                            <storage>/admin.key (chmod 600)
 *   CHECKOUT_SIM_SECRET      overrides the derived checkout-simulator secret
 *
 * Loopback only: this process serves one owner's business data on their own
 * machine; it must never listen on an outward-facing interface.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { asCoreDb } from '@blacklabel/core';
import { createDb } from '@blacklabel/db';
import { LocalDiskStorageProvider } from '@blacklabel/files';
import { createApp, type PlatformDatabase } from './app';
import { SqliteBackupProvider, makeCountProbe } from './admin-wiring';
import { securityHeaders } from './security';

const PORT = Number(process.env.PORT ?? 8460);
const STORAGE_DIR = path.resolve(process.env.PLATFORM_STORAGE_DIR ?? '.storage');
const DB_PATH =
  process.env.PLATFORM_DB_PATH ?? process.env.DB_PATH ?? path.join(STORAGE_DIR, 'platform.db');
const DEFAULT_TENANT_NAME = process.env.PLATFORM_DEFAULT_TENANT_NAME;
const UI_DIR = process.env.UI_DIR;

mkdirSync(STORAGE_DIR, { recursive: true });

/** Resolve (or generate once) the admin master key. */
function resolveMasterKey(): Buffer | string {
  if (process.env.ADMIN_MASTER_KEY) return process.env.ADMIN_MASTER_KEY;
  if (process.env.ADMIN_MASTER_KEY_FILE) {
    return readFileSync(process.env.ADMIN_MASTER_KEY_FILE);
  }
  const keyPath = path.join(STORAGE_DIR, 'admin.key');
  if (existsSync(keyPath)) return readFileSync(keyPath);
  const key = randomBytes(32);
  writeFileSync(keyPath, key, { mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    /* best-effort on platforms without chmod */
  }
  // eslint-disable-next-line no-console
  console.log(`[frontdesk/platform] generated a new admin master key at ${keyPath} (chmod 600)`);
  return key;
}

const db = createDb<PlatformDatabase>(DB_PATH);

const platform = await createApp({
  db,
  storage: new LocalDiskStorageProvider(path.join(STORAGE_DIR, 'files')),
  adminMasterKey: resolveMasterKey(),
  backupProvider: new SqliteBackupProvider(DB_PATH),
  countProbe: makeCountProbe(db as never),
  dbPath: DB_PATH,
  storageDir: STORAGE_DIR,
  envDefaultLocationId: process.env.DEFAULT_LOCATION_ID,
  ownerUserIdEnv: process.env.OWNER_USER_ID,
  checkoutSimSecret: process.env.CHECKOUT_SIM_SECRET,
  logSink: (line) => console.log(line), // eslint-disable-line no-console
});
const { app, modules } = platform;

// Single-tenant local mode: seed the named tenant (owner + roles) at boot.
if (DEFAULT_TENANT_NAME) {
  const row = await asCoreDb(db)
    .selectFrom('tenants')
    .select('id')
    .where('name', '=', DEFAULT_TENANT_NAME)
    .orderBy('created_at')
    .orderBy('id')
    .executeTakeFirst();
  if (row) await platform.seedTenant(row.id);
}

// Optional static UI at / (serveStatic falls through to the API app on a miss,
// so /api/* is unaffected). Security headers apply to static responses too.
let entry: { fetch: (req: Request) => Response | Promise<Response> } = app;
if (UI_DIR) {
  const outer = new Hono();
  outer.use('*', securityHeaders());
  outer.use('/*', serveStatic({ root: UI_DIR }));
  outer.route('/', app);
  entry = outer;
}

let cachedTenantId: string | undefined;
async function defaultTenantId(): Promise<string | undefined> {
  if (!DEFAULT_TENANT_NAME) return undefined;
  if (cachedTenantId) return cachedTenantId;
  const row = await asCoreDb(db)
    .selectFrom('tenants')
    .select('id')
    .where('name', '=', DEFAULT_TENANT_NAME)
    .orderBy('created_at')
    .orderBy('id')
    .executeTakeFirst();
  cachedTenantId = row?.id;
  return cachedTenantId;
}

async function fetchHandler(req: Request): Promise<Response> {
  let request = req;
  if (DEFAULT_TENANT_NAME && !request.headers.get('x-tenant-id')) {
    const tenantId = await defaultTenantId();
    if (tenantId) {
      const headers = new Headers(request.headers);
      headers.set('x-tenant-id', tenantId);
      request = new Request(request, { headers });
    }
  }
  return entry.fetch(request);
}

const server = serve({ fetch: fetchHandler, port: PORT, hostname: '127.0.0.1' }, (info) => {
  // eslint-disable-next-line no-console
  console.log(
    `[frontdesk/platform] listening on http://127.0.0.1:${info.port} — ` +
      `${modules.length} modules mounted under /api/*` +
      (UI_DIR ? ` — UI from ${UI_DIR}` : '') +
      (DEFAULT_TENANT_NAME ? ` — single-tenant mode for "${DEFAULT_TENANT_NAME}"` : ''),
  );
});

function shutdown(signal: string): void {
  // eslint-disable-next-line no-console
  console.log(`[frontdesk/platform] ${signal} received — closing`);
  platform.detachEngine();
  server.close(() => {
    db.destroy().finally(() => process.exit(0));
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
