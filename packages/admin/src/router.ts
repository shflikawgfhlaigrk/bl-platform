import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  ApiError,
  asCoreDb,
  errorHandler,
  parsePagination,
  tenantMiddleware,
  type ModuleDeps,
  type TenantEnv,
} from '@blacklabel/core';
import type { AdminDatabase } from './schema';
import {
  CredentialsService,
  CREDENTIAL_PROVIDERS,
  type CredentialTester,
} from './credentials';
import { HealthService } from './health';
import { SettingsService } from './settings';
import {
  BackupService,
  type BackupProvider,
  type CountProbe,
  type RetentionPolicy,
} from './backups';
import { assembleDiagnostics, exportAuditCsv, type DiagnosticsInput } from './diagnostics';
import { listJobs } from './jobs';

/**
 * admin router dependencies. Extends the standard ModuleDeps with the pieces
 * admin genuinely needs and that only the integrator can supply:
 *  - masterKey: the AES-256-GCM key (env/file, NEVER in the DB)
 *  - tester: real SMTP/IMAP connection tester (founder-clicked)
 *  - healthService: probes registered by the integrator
 *  - backupProvider: file ops (absent → backup routes return 501)
 *  - diagnostics/countProbe/retention: optional wiring for the ops routes
 *
 * DEVIATION (documented): CONVENTIONS §6 specifies ModuleDeps<DB>; admin needs
 * these extra injected capabilities, so it accepts a superset. apps/api wires
 * them; the router still returns Hono<TenantEnv> and never creates its own db.
 */
export interface AdminRouterDeps extends ModuleDeps<AdminDatabase> {
  masterKey: Buffer | string;
  tester?: CredentialTester;
  healthService?: HealthService;
  backupProvider?: BackupProvider;
  countProbe?: CountProbe;
  retention?: RetentionPolicy;
  /** Static bits for the diagnostic bundle (version, migrations, counter). */
  diagnostics?: {
    version: string;
    migrations?: string[];
    tableRowCounts?: () => Promise<Record<string, number>>;
    emailAllowlist?: readonly string[];
  };
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw ApiError.badRequest('invalid JSON body');
  }
}

function actorOf(c: Context): string {
  const header = c.req.header('x-user-id');
  return header && header.trim() !== '' ? header.trim() : 'system';
}

const providerEnum = z.enum(
  CREDENTIAL_PROVIDERS as unknown as [string, ...string[]],
);

const saveCredentialSchema = z.object({
  name: z.string().trim().min(1),
  provider: providerEnum,
  payload: z.record(z.unknown()),
  expiresAt: z.string().min(1).nullable().optional(),
});

const rotateSchema = z.object({
  payload: z.record(z.unknown()),
  expiresAt: z.string().min(1).nullable().optional(),
});

const retentionSchema = z.object({
  keepLast: z.number().int().min(0),
  keepWeeklyForWeeks: z.number().int().min(0),
});

export function adminRouter(deps: AdminRouterDeps): Hono<TenantEnv> {
  const { db, events } = deps;
  const credentials = new CredentialsService(db, events, deps.masterKey);
  const settings = new SettingsService(db);
  const health = deps.healthService;
  const backups = new BackupService(db, deps.backupProvider);

  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(db)));

  /* ---------------- credentials ---------------- */

  app.post('/credentials', async (c) => {
    const body = saveCredentialSchema.parse(await jsonBody(c));
    const masked = await credentials.save(c.get('tenantId'), actorOf(c), {
      name: body.name,
      provider: body.provider as never,
      payload: body.payload,
      expiresAt: body.expiresAt ?? null,
    });
    return c.json({ data: masked }, 201);
  });

  app.get('/credentials', async (c) => {
    const page = parsePagination(c.req.query());
    const includeArchived = c.req.query('archived') === 'true';
    const list = await credentials.list(c.get('tenantId'), page, { includeArchived });
    return c.json({ data: list, limit: page.limit, offset: page.offset });
  });

  app.get('/credentials/expiring', async (c) => {
    const days = Number(c.req.query('days') ?? '14');
    if (!Number.isFinite(days) || days < 0) throw ApiError.badRequest('invalid "days"');
    const now = c.req.query('now') ?? new Date().toISOString();
    const list = await credentials.credentialsExpiringSoon(c.get('tenantId'), now, days);
    return c.json({ data: list });
  });

  app.post('/credentials/:id/rotate', async (c) => {
    const body = rotateSchema.parse(await jsonBody(c));
    const masked = await credentials.rotate(
      c.get('tenantId'),
      actorOf(c),
      c.req.param('id'),
      body.payload,
      { expiresAt: body.expiresAt ?? null },
    );
    return c.json({ data: masked }, 201);
  });

  app.delete('/credentials/:id', async (c) => {
    const res = await credentials.delete(c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: res });
  });

  // Explicit test only — NO auto-schedule. 501 when no tester wired.
  app.post('/credentials/:id/test', async (c) => {
    if (!deps.tester) throw new ApiError(501, 'connection tester not configured', 'not_implemented');
    const res = await credentials.testConnection(
      c.get('tenantId'),
      actorOf(c),
      c.req.param('id'),
      deps.tester,
    );
    return c.json({ data: res });
  });

  /* ---------------- settings ---------------- */

  app.get('/settings', async (c) => {
    const s = await settings.get(c.get('tenantId'));
    return c.json({ data: s });
  });

  app.put('/settings', async (c) => {
    const s = await settings.update(c.get('tenantId'), actorOf(c), await jsonBody(c));
    return c.json({ data: s });
  });

  /* ---------------- health ---------------- */

  app.post('/health/run', async (c) => {
    if (!health) throw new ApiError(501, 'health probes not configured', 'not_implemented');
    const report = await health.runHealth(c.get('tenantId'), actorOf(c));
    return c.json({ data: report }, 201);
  });

  app.get('/health/runs', async (c) => {
    if (!health) throw new ApiError(501, 'health probes not configured', 'not_implemented');
    const page = parsePagination(c.req.query());
    const runs = await health.listRuns(c.get('tenantId'), page);
    return c.json({ data: runs, limit: page.limit, offset: page.offset });
  });

  /* ---------------- backups ---------------- */

  const publicBackup = (row: import('./schema').AdminBackupRow) => {
    const { path: _path, detail: _detail, ...metadata } = row;
    return { ...metadata, scope: 'single-tenant-database' };
  };

  app.post('/backups/run', async (c) => {
    if (!backups.hasProvider) throw new ApiError(501, 'backup provider not configured', 'not_implemented');
    await backups.assertHttpScope(c.get('tenantId'));
    const body = z.object({ encrypted: z.literal(true).default(true) }).strict().parse(await jsonBody(c));
    const row = await backups.runBackup(
      c.get('tenantId'),
      actorOf(c),
      { countProbe: deps.countProbe, encrypted: body.encrypted },
      async (payload) => {
        await events.emit(c.get('tenantId'), 'admin.backup.failed', { v: 1, ...payload });
      },
    );
    return c.json({ data: publicBackup(row) }, 201);
  });

  app.get('/backups', async (c) => {
    const page = parsePagination(c.req.query());
    const list = await backups.list(c.get('tenantId'), page);
    return c.json({ data: list.map(publicBackup), limit: page.limit, offset: page.offset });
  });

  app.post('/backups/:id/verify', async (c) => {
    if (!backups.hasProvider) throw new ApiError(501, 'backup provider not configured', 'not_implemented');
    await backups.assertHttpScope(c.get('tenantId'));
    const row = await backups.verifyExisting(
      c.get('tenantId'),
      actorOf(c),
      c.req.param('id'),
      { countProbe: deps.countProbe },
      async (payload) => {
        await events.emit(c.get('tenantId'), 'admin.backup.failed', { v: 1, ...payload });
      },
    );
    return c.json({ data: publicBackup(row) });
  });

  app.post('/backups/prune', async (c) => {
    if (!backups.hasProvider) throw new ApiError(501, 'backup provider not configured', 'not_implemented');
    await backups.assertHttpScope(c.get('tenantId'));
    const body = deps.retention ?? retentionSchema.parse(await jsonBody(c));
    const res = await backups.prune(c.get('tenantId'), actorOf(c), body);
    return c.json({ data: res });
  });

  app.get('/backups/:id/download', async (c) => {
    if (!backups.hasProvider) throw new ApiError(501, 'backup provider not configured', 'not_implemented');
    const bytes = await backups.download(c.get('tenantId'), c.req.param('id'));
    c.header('Content-Type', 'application/octet-stream');
    c.header('Content-Disposition', 'attachment; filename="blacklabel-backup.blbackup"');
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(new Uint8Array(bytes));
  });

  /* ---------------- diagnostics + audit export + jobs ---------------- */

  app.get('/diagnostics', async (c) => {
    const d = deps.diagnostics;
    const input: DiagnosticsInput = {
      version: d?.version ?? '0.0.0',
      settings: await settings.get(c.get('tenantId')),
      migrations: d?.migrations,
      tableRowCounts: d?.tableRowCounts ? await d.tableRowCounts() : undefined,
      health: health ? await health.listRuns(c.get('tenantId'), { limit: 1, offset: 0 }) : undefined,
      emailAllowlist: d?.emailAllowlist,
    };
    const bundle = assembleDiagnostics(input);
    c.header('content-type', 'application/json');
    c.header('content-disposition', 'attachment; filename="diagnostics.json"');
    return c.body(JSON.stringify(bundle, null, 2));
  });

  app.get('/audit/export', async (c) => {
    const { actor, entity, from, to } = c.req.query();
    const csv = await exportAuditCsv(db, c.get('tenantId'), {
      actor,
      entityType: entity,
      from,
      to,
    });
    c.header('content-type', 'text/csv');
    c.header('content-disposition', 'attachment; filename="audit.csv"');
    return c.body(csv);
  });

  app.get('/jobs', async (c) => {
    const page = parsePagination(c.req.query());
    const jobs = await listJobs(db, c.get('tenantId'), page);
    return c.json({ data: jobs, limit: page.limit, offset: page.offset });
  });

  return app;
}
