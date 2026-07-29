import { existsSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import {
  clientOpsMigrations,
  registerProductionFoundations,
  type ClientOpsDatabase,
} from '@blacklabel/client-ops';
import { asCoreDb, coreMigrations, createTenant, EventBus } from '@blacklabel/core';
import { createDb, runMigrations } from '@blacklabel/db';
import { createClientOpsHttpApp, withBearerAuth, withDefaultTenant } from './app';
import { seedClientOpsProductStarter } from './demo';

const port = Number(process.env.PORT ?? 8470);
const storageDir = path.resolve(process.env.CLIENT_OPS_STORAGE_DIR ?? '.storage/client-ops');
const dbPath = path.resolve(process.env.CLIENT_OPS_DB_PATH ?? path.join(storageDir, 'client-ops.db'));
const demoMode = ['1', 'true'].includes((process.env.CLIENT_OPS_DEMO_MODE ?? '').toLowerCase());
const tenantName = process.env.CLIENT_OPS_TENANT_NAME ?? 'Black Label Client Operations';
const authToken = (process.env.CLIENT_OPS_AUTH_TOKEN ?? '').trim() || undefined;
const defaultUiDir = fileURLToPath(new URL('../../client-ops-ui/public/', import.meta.url));
const uiDir = path.resolve(process.env.CLIENT_OPS_UI_DIR ?? defaultUiDir);

mkdirSync(storageDir, { recursive: true });
if (!existsSync(uiDir)) throw new Error(`Client Operations UI not found: ${uiDir}`);

const db = createDb<ClientOpsDatabase>(dbPath);
await runMigrations(db, [...coreMigrations, ...clientOpsMigrations]);
let tenant = await asCoreDb(db).selectFrom('tenants').selectAll()
  .where('name', '=', tenantName).orderBy('created_at').orderBy('id').executeTakeFirst();
tenant ??= await createTenant(asCoreDb(db), { name: tenantName });

const events = new EventBus();
if (demoMode) await seedClientOpsProductStarter(db, events, tenant.id);

// Real own-infra execution adapters (Workflow OS, HQ, Data Operations, Sales
// Operator). Capabilities without a connected adapter stay honest: 501 on invoke.
const registry = registerProductionFoundations();

const api = createClientOpsHttpApp({
  db,
  events,
  tenantId: tenant.id,
  tenantName: tenant.name,
  environment: demoMode ? 'Opt-in demonstration' : 'Production onboarding',
  registry,
});
const outer = new Hono();
outer.use('*', async (c, next) => {
  await next();
  c.res.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'",
  );
  c.res.headers.set('Referrer-Policy', 'no-referrer');
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
});
outer.use('/*', serveStatic({ root: uiDir }));
outer.route('/', api);

// Auth is OUTERMOST: an unauthenticated caller is rejected before tenant injection.
const fetch = withBearerAuth(
  withDefaultTenant((request) => outer.fetch(request), tenant.id),
  authToken,
);
const server = serve({ hostname: '127.0.0.1', port, fetch }, (info) => {
  console.log(`[client-ops] listening on http://127.0.0.1:${info.port}`); // eslint-disable-line no-console
  console.log(`[client-ops] tenant "${tenant.name}" (${tenant.id}) — UI ${uiDir}`); // eslint-disable-line no-console
  console.log(`[client-ops] bearer auth ${authToken ? 'ENABLED' : 'disabled (loopback only — set CLIENT_OPS_AUTH_TOKEN before exposing)'}`); // eslint-disable-line no-console
  console.log(`[client-ops] execution foundations connected: ${registry.list().filter((f) => f.connected).map((f) => f.serviceId).join(', ')}`); // eslint-disable-line no-console
});

function shutdown(signal: string): void {
  console.log(`[client-ops] ${signal} received — closing`); // eslint-disable-line no-console
  server.close(() => db.destroy().finally(() => process.exit(0)));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
