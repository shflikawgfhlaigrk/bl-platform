/**
 * @blacklabel/api — HTTP entry point (the real, port-binding bootstrap).
 *
 * `app.ts` builds a db-agnostic Hono app (`createApp`). This file is the ONLY
 * place that opens the real file-backed database, wires a real on-disk storage
 * provider for the files module, runs every migration, and binds a TCP port.
 *
 * Run:  npm --workspace @blacklabel/api run start
 * Env:  PORT (default 8460), PLATFORM_STORAGE_DIR (default ./.storage),
 *       PLATFORM_DB_PATH (default <storage>/platform.db)
 *
 * Everything below stays boring on purpose: no framework magic, no globals,
 * no background timers. One db, one app, one listener.
 */
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { serve } from '@hono/node-server';
import { asCoreDb } from '@blacklabel/core';
import { createDb } from '@blacklabel/db';
import { LocalDiskStorageProvider } from '@blacklabel/files';
import { createApp, type PlatformDatabase } from './app';

const PORT = Number(process.env.PORT ?? 8460);
const STORAGE_DIR = path.resolve(process.env.PLATFORM_STORAGE_DIR ?? '.storage');
const DB_PATH = process.env.PLATFORM_DB_PATH ?? path.join(STORAGE_DIR, 'platform.db');
/**
 * Local single-tenant mode: when set, browser requests that arrive WITHOUT an
 * x-tenant-id header get the named tenant's id injected server-side (the
 * tenant contract itself is untouched — modules still only trust the header),
 * and GET / redirects to the owner dashboard. This is for owner-facing local
 * deployments (one business, one machine, loopback only).
 */
const DEFAULT_TENANT_NAME = process.env.PLATFORM_DEFAULT_TENANT_NAME;

// Storage roots are created up front so the first request never races a mkdir.
mkdirSync(STORAGE_DIR, { recursive: true });

const db = createDb<PlatformDatabase>(DB_PATH);

const { app, modules } = await createApp({
  db,
  storage: new LocalDiskStorageProvider(path.join(STORAGE_DIR, 'files')),
});

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
  if (DEFAULT_TENANT_NAME) {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/owner')) {
      return Response.redirect(new URL('/api/dashboard/owner', url).toString(), 302);
    }
    if (!request.headers.get('x-tenant-id')) {
      const tenantId = await defaultTenantId();
      if (tenantId) {
        const headers = new Headers(request.headers);
        headers.set('x-tenant-id', tenantId);
        request = new Request(request, { headers });
      }
    }
  }
  return app.fetch(request);
}

// Loopback only: this process serves one owner's business data on their own
// machine; it must never listen on an outward-facing interface.
const server = serve({ fetch: fetchHandler, port: PORT, hostname: '127.0.0.1' }, (info) => {
  // eslint-disable-next-line no-console
  console.log(
    `[frontdesk/platform] listening on http://127.0.0.1:${info.port} — ` +
      `${modules.length} modules mounted under /api/*` +
      (DEFAULT_TENANT_NAME ? ` — single-tenant mode for "${DEFAULT_TENANT_NAME}"` : ''),
  );
});

// Clean shutdown so `.db-wal` is checkpointed and the port is released.
function shutdown(signal: string): void {
  // eslint-disable-next-line no-console
  console.log(`[frontdesk/platform] ${signal} received — closing`);
  server.close(() => {
    db.destroy().finally(() => process.exit(0));
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
