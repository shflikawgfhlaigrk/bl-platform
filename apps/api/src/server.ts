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
import { createDb } from '@blacklabel/db';
import { LocalDiskStorageProvider } from '@blacklabel/files';
import { createApp, type PlatformDatabase } from './app';

const PORT = Number(process.env.PORT ?? 8460);
const STORAGE_DIR = path.resolve(process.env.PLATFORM_STORAGE_DIR ?? '.storage');
const DB_PATH = process.env.PLATFORM_DB_PATH ?? path.join(STORAGE_DIR, 'platform.db');

// Storage roots are created up front so the first request never races a mkdir.
mkdirSync(STORAGE_DIR, { recursive: true });

const db = createDb<PlatformDatabase>(DB_PATH);

const { app, modules } = await createApp({
  db,
  storage: new LocalDiskStorageProvider(path.join(STORAGE_DIR, 'files')),
});

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  // eslint-disable-next-line no-console
  console.log(
    `[frontdesk/platform] listening on http://127.0.0.1:${info.port} — ` +
      `${modules.length} modules mounted under /api/*`,
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
