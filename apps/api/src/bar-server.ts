/** ONE Club's persistent, fixed-tenant server. Run behind a local HTTPS proxy. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createDb } from '@blacklabel/db';
import { asCoreDb, createTenant } from '@blacklabel/core';
import { createLocation } from '@blacklabel/inventory';
import { LocalDiskStorageProvider } from '@blacklabel/files';
import { createApp, type PlatformDatabase } from './app';
import { createPosAuth } from './pos-auth';
import { CONFIG_KEYS, getConfig, setConfig } from './config';
import { securityHeaders } from './security';
import { SqliteBackupProvider, makeCountProbe } from './admin-wiring';
import { withStartupLock } from './startup-lock';
import { venueGateway } from './venue-gateway';
import type { Kysely } from 'kysely';
import type { ApiDatabase } from './migrations';
import type { PosAuthDatabase } from './pos-auth';

const storage = path.resolve(process.env.ONECLUB_STORAGE_DIR || '.storage/one-club-live');
const origin = new URL(process.env.ONECLUB_ORIGIN || 'http://127.0.0.1:8480');
if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname)) {
  throw new Error('Use an HTTPS venue origin for iPad access. The server itself listens on loopback behind that proxy.');
}
if (origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash) throw new Error('ONECLUB_ORIGIN must be only the server origin.');
mkdirSync(storage, { recursive: true, mode: 0o700 }); chmodSync(storage, 0o700);
const dbPath = path.join(storage, 'platform.db');
const keyPath = path.join(storage, 'admin.key');
if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
const db = createDb<PlatformDatabase>(dbPath);
const configDb = db as unknown as Kysely<ApiDatabase>;
const { platform, tenantId } = await withStartupLock(dbPath, async () => {
  const platform = await createApp({ db, posNetworkMode: true, includeCheckoutSimulator: false,
    adminMasterKey: readFileSync(keyPath), storage: new LocalDiskStorageProvider(path.join(storage, 'files')),
    backupProvider: new SqliteBackupProvider(dbPath), countProbe: makeCountProbe(db as never), dbPath, storageDir: storage,
    // Processor wiring belongs here once the venue's actual provider is known.
    posProcessorStatus: async () => ({ connected: false, code: 'venue_processor_access_required', readers: [] }),
  });
  const tenants = await db.selectFrom('tenants').select(['id']).orderBy('created_at').orderBy('id').execute();
  if (tenants.length > 1) throw new Error('This dedicated server requires a single venue database.');
  const tenantId = tenants[0]?.id || (await createTenant(asCoreDb(db), { name: 'ONE Club' })).id;
  await platform.seedTenant(tenantId, { ownerName: 'Club Manager' });
  if (!await getConfig(configDb, tenantId, CONFIG_KEYS.defaultLocation)) {
    const location = await createLocation(db as never, tenantId, 'system', { name: 'ONE Club bar', kind: 'warehouse' });
    await setConfig(configDb, tenantId, CONFIG_KEYS.defaultLocation, location.id);
  }
  const credential = await db.selectFrom('api_pos_credentials').select('id').where('tenant_id', '=', tenantId).executeTakeFirst();
  if (!credential) {
    const pinFile = process.env.ONECLUB_OWNER_PIN_FILE;
    if (!pinFile) throw new Error('First start requires ONECLUB_OWNER_PIN_FILE containing the chosen four-digit manager PIN.');
    const pin = readFileSync(pinFile, 'utf8').trim();
    if (!/^\d{4}$/.test(pin)) throw new Error('The manager PIN file must contain exactly four digits.');
    const provision = await createPosAuth(db as unknown as Kysely<PosAuthDatabase>).router.request('/bootstrap', { method: 'POST',
      headers: { 'x-tenant-id': tenantId, 'content-type': 'application/json' }, body: JSON.stringify({ pin }) });
    if (!provision.ok) throw new Error(`Owner provisioning failed (${provision.status}).`);
  }
  return { platform, tenantId };
});

const outer = new Hono(); outer.use('*', securityHeaders());
outer.get('/', c => c.html(readFileSync('apps/ui/public/index.html', 'utf8').replace('<body>', '<body data-pos-profile="bar">')));
outer.use('/*', serveStatic({ root: './apps/ui/public' })); outer.route('/', platform.app);
const port = Number(process.env.ONECLUB_PORT || 8480);
const fetch = venueGateway({ origin: origin.origin, tenantId, fetch: request => outer.fetch(request) });
const server = serve({ hostname: '127.0.0.1', port, fetch });
console.log(`ONE Club server listening on 127.0.0.1:${port}; configured app address ${origin.origin}. Card reader awaits venue setup.`);
function shutdown() {
  platform.detachEngine(); server.close(() => { void db.destroy().then(() => process.exit(0)); });
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
