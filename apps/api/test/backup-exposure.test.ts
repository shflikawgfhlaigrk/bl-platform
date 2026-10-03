import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { asCoreDb, createTenant, errorHandler } from '@blacklabel/core';
import { createDb } from '@blacklabel/db';
import { BackupService, type AdminDatabase } from '@blacklabel/admin';
import { createApp, type PlatformDatabase } from '../src/app';
import { SqliteBackupProvider } from '../src/admin-wiring';
import { privateStaticFiles } from '../src/private-static';
import { decryptBackupToFile } from '../../../scripts/decrypt-private-backup';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'platform-backup-')); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const ui = path.join(dir, 'ui'); await mkdir(ui); await writeFile(path.join(ui, 'index.html'), '<p>Public fixture</p>');
  const file = path.join(dir, 'live.sqlite'); const db = createDb<PlatformDatabase>(file); cleanup.push(() => db.destroy());
  const key = Buffer.alloc(32, 7);
  const provider = new SqliteBackupProvider(file, { key, staticRoots: [ui] });
  const platform = await createApp({ db, backupProvider: provider, adminMasterKey: Buffer.alloc(32, 7), disableRateLimit: true });
  const tenant = await createTenant(asCoreDb(db), { name: 'Single tenant fixture' }); const owner = await platform.seedTenant(tenant.id);
  let cookie = '';
  const call = (method: string, url: string, body?: unknown) => platform.app.request(url, { method, headers: { 'x-tenant-id': tenant.id, cookie, 'x-mags-csrf': '1', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const boot = await call('POST', '/api/pos/auth/bootstrap', { pin: '2468' }); expect(boot.status).toBe(201); cookie = boot.headers.get('set-cookie')!.split(';')[0];
  return { dir, ui, file, db, provider, platform, tenant, owner, call, key };
}

it('rejects caller-selected public backup destinations before any artifact or record', async () => {
  const f = await fixture();
  const r = await f.call('POST', '/api/admin/backups/run', { destDir: f.ui });
  expect(r.status).toBe(400);
  expect(await readdir(f.ui)).toEqual(['index.html']);
  expect(await f.db.selectFrom('admin_backups').selectAll().execute()).toEqual([]);
});

it('refuses to label an unencrypted provider artifact as encrypted', async () => {
  const f = await fixture(); const create = vi.fn(async () => ({ path: '/fixture-only/plain.sqlite', bytes: 1, sha256: 'fixture' }));
  const svc = new BackupService(f.db as unknown as import('kysely').Kysely<AdminDatabase>, { create, restoreToTemp: async () => ({ tempPath: '/fixture' }), integrityCheck: async () => ({ ok: true }) });
  await expect(svc.runBackup(f.tenant.id, f.owner.ownerUserId, { destDir: f.ui, encrypted: true }, async () => {})).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});

it('denies complete database backups through a tenant endpoint when another tenant exists', async () => {
  const f = await fixture(); await createTenant(asCoreDb(f.db), { name: 'Other private tenant' });
  const r = await f.call('POST', '/api/admin/backups/run', { destDir: f.ui });
  expect(r.status).toBe(403);
  expect(await readdir(f.ui)).toEqual(['index.html']);
});

it('does not serve a database artifact from the public UI root', async () => {
  const f = await fixture(); await writeFile(path.join(f.ui, 'backup.sqlite'), await readFile(f.file));
  await writeFile(path.join(f.ui, 'disguised.jpg'), await readFile(f.file));
  await writeFile(path.join(f.ui, 'secret.key'), 'fixture-only');
  await symlink(f.file, path.join(f.ui, 'linked.js'));
  const outer = new Hono(); outer.use('/*', privateStaticFiles(f.ui)); outer.route('/', f.platform.app);
  for (const url of ['/backup.sqlite', '/backup.sqlite-wal', '/disguised.jpg', '/secret.key', '/linked.js', '/%2esecret', '/backup%2esqlite']) {
    expect((await outer.request(url)).status, url).toBe(403);
  }
  const index = await outer.request('/'); expect(index.status).toBe(200); expect(await index.text()).toBe('<p>Public fixture</p>');
  const head = await outer.request('/index.html', { method: 'HEAD' }); expect(head.status).toBe(200); expect(await head.text()).toBe('');
  expect((await outer.request('/api/health')).status).toBe(200);
  const store = await outer.request('/store/no-such-tenant'); expect(store.status).not.toBe(403);
});

it('creates private encrypted bytes, verifies their restore and offers only a session-authenticated download', async () => {
  const f = await fixture(); const run = await f.call('POST', '/api/admin/backups/run', {});
  expect(run.status).toBe(201); const body = await run.json() as any;
  expect(body.data).toMatchObject({ status: 'verified', encrypted: 1, scope: 'single-tenant-database' }); expect(body.data.path).toBeUndefined();
  const row = await f.db.selectFrom('admin_backups').selectAll().where('id', '=', body.data.id).executeTakeFirstOrThrow();
  const bytes = await readFile(row.path); expect(bytes.subarray(0, 8).toString()).toBe('BLBKP01\n'); expect(bytes.includes(Buffer.from(f.tenant.name))).toBe(false);
  expect((await stat(row.path)).mode & 0o777).toBe(0o600); expect((await stat(path.dirname(row.path))).mode & 0o777).toBe(0o700);
  expect(await readdir(path.dirname(row.path))).toEqual([path.basename(row.path)]);
  const restored = await f.provider.restoreToTemp(row.path);
  expect(await f.provider.integrityCheck(restored.tempPath)).toMatchObject({ ok: true });
  const copy = new Database(restored.tempPath, { readonly: true });
  try { expect(copy.prepare('SELECT name FROM tenants').get()).toEqual({ name: f.tenant.name }); } finally { copy.close(); }
  await f.provider.cleanupTemp(restored.tempPath);
  const downloaded = await f.call('GET', `/api/admin/backups/${row.id}/download`); expect(downloaded.status).toBe(200);
  expect(downloaded.headers.get('cache-control')).toBe('no-store'); expect(Buffer.from(await downloaded.arrayBuffer()).equals(bytes)).toBe(true);
  const unsigned = await f.platform.app.request(`/api/admin/backups/${row.id}/download`, { headers: { 'x-tenant-id': f.tenant.id, 'x-user-id': f.owner.ownerUserId } });
  expect(unsigned.status).toBe(401);
  await createTenant(asCoreDb(f.db), { name: 'New other tenant' });
  expect((await f.call('GET', `/api/admin/backups/${row.id}/download`)).status).toBe(403);
  expect((await f.call('POST', `/api/admin/backups/${row.id}/verify`, {})).status).toBe(403);
});

it('rejects plaintext requests, wrong keys, corrupt ciphertext, symlink artifacts and public-root configuration', async () => {
  const f = await fixture();
  expect((await f.call('POST', '/api/admin/backups/run', { encrypted: false })).status).toBe(400);
  await expect(f.provider.create(f.ui)).rejects.toThrow('server controlled');
  const badRoot = new SqliteBackupProvider(f.file, { key: f.key, directory: path.join(f.ui, 'backups'), staticRoots: [f.ui] });
  await expect(badRoot.create()).rejects.toThrow('static root');
  const created = await f.provider.create(); const backupDir = path.dirname(created.path);
  const wrong = new SqliteBackupProvider(f.file, { key: Buffer.alloc(32, 8) });
  await expect(wrong.restoreToTemp(created.path)).rejects.toThrow();
  expect(await readdir(backupDir)).toEqual([path.basename(created.path)]);
  const bytes = await readFile(created.path); bytes[30] ^= 1; await writeFile(created.path, bytes);
  await expect(f.provider.restoreToTemp(created.path)).rejects.toThrow();
  expect(await readdir(backupDir)).toEqual([path.basename(created.path)]);
  const link = path.join(backupDir, 'backup-deadbeef.blbackup'); await symlink(created.path, link);
  await expect(f.provider.readArtifact(link)).rejects.toThrow();
});

it('restores a downloaded artifact into a new verified file and preserves existing user files', async () => {
  const f = await fixture();
  await expect(f.provider.create(undefined, { tenantId: 'different-tenant' })).rejects.toThrow('tenant');
  const created = await f.provider.create();
  const destination = path.join(f.dir, 'recovered.sqlite');
  await decryptBackupToFile(created.path, f.key, destination);
  const copy = new Database(destination, { readonly: true });
  try { expect(copy.prepare('SELECT name FROM tenants').get()).toEqual({ name: f.tenant.name }); } finally { copy.close(); }
  const before = await readFile(destination);
  await expect(decryptBackupToFile(created.path, f.key, destination)).rejects.toThrow();
  expect((await readFile(destination)).equals(before)).toBe(true);
  const failed = path.join(f.dir, 'wrong-key.sqlite');
  await expect(decryptBackupToFile(created.path, Buffer.alloc(32, 8), failed)).rejects.toThrow();
  await expect(stat(failed)).rejects.toMatchObject({ code: 'ENOENT' });
});
