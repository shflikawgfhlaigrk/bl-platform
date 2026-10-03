import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { SqliteBackupProvider } from '../../api/src/admin-wiring';
import { acquireStartupLock } from '../../api/src/startup-lock';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const metadata = ['identity.json', 'settings.enc', 'admin.key', 'access.token'];
const allowed = (name: string) => metadata.includes(name) || name === 'platform.db' || /^files\/[A-Za-z0-9_-]+$/.test(name);

/** Caller holds the runtime's request queue while database and vault are captured. */
export async function backupBusiness(dataRoot: string) {
  const backupDir = path.join(dataRoot, 'backups'); await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
  const stage = await fs.mkdtemp(path.join(backupDir, '.pending-'));
  try {
    const database = new SqliteBackupProvider(path.join(dataRoot, 'platform.db'));
    const snapshot = await database.create(stage); await fs.rename(snapshot.path, path.join(stage, 'platform.db'));
    for (const file of metadata) await fs.copyFile(path.join(dataRoot, file), path.join(stage, file));
    await fs.mkdir(path.join(stage, 'files'));
    const names = [...metadata, 'platform.db'];
    for (const entry of await fs.readdir(path.join(dataRoot, 'files'), { withFileTypes: true }).catch(() => [])) {
      const name = `files/${entry.name}`;
      if (!entry.isFile() || !allowed(name)) throw new Error('Vault contains an unsupported filesystem entry.');
      await fs.copyFile(path.join(dataRoot, name), path.join(stage, name)); names.push(name);
    }
    const files = await Promise.all(names.sort().map(async (name) => { const bytes = await fs.readFile(path.join(stage, name)); return { name, bytes: bytes.length, sha256: hash(bytes) }; }));
    const manifest = { brand: 'BlackLabel', kind: 'business-backup', version: 1, createdAt: new Date().toISOString(), files };
    await fs.writeFile(path.join(stage, 'backup.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const name = `blacklabel-business-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.tar.gz`;
    const archive = path.join(backupDir, name);
    execFileSync('/usr/bin/tar', ['-czf', archive, '-C', stage, 'backup.json', ...names]);
    await fs.chmod(archive, 0o600);
    const bytes = await fs.readFile(archive);
    return { name, bytes: bytes.length, sha256: hash(bytes) };
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

export async function restoreBusiness(archive: string, dataRoot: string) {
  await fs.mkdir(path.dirname(dataRoot), { recursive: true, mode: 0o700 });
  const release = await acquireStartupLock(path.join(dataRoot, 'platform.db'), { timeoutMs: 1000 });
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'blacklabel-business-restore-'));
  try {
    const entries = execFileSync('/usr/bin/tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
    if (new Set(entries).size !== entries.length || entries.some((entry) => entry !== 'backup.json' && !allowed(entry))) throw new Error('Backup contains unexpected paths.');
    const kinds = execFileSync('/usr/bin/tar', ['-tvzf', archive], { encoding: 'utf8' }).trim().split('\n');
    if (kinds.some((row) => !row.startsWith('-'))) throw new Error('Backup must contain ordinary files only.');
    execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', stage]);
    const manifest = JSON.parse(await fs.readFile(path.join(stage, 'backup.json'), 'utf8'));
    if (manifest.brand !== 'BlackLabel' || manifest.kind !== 'business-backup' || manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('Unrecognized backup format.');
    const expected = new Set<string>();
    for (const row of manifest.files) {
      if (!allowed(row.name) || expected.has(row.name)) throw new Error('Invalid backup manifest path.');
      expected.add(row.name);
      const bytes = await fs.readFile(path.join(stage, row.name));
      if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw new Error(`Backup integrity mismatch: ${row.name}`);
    }
    if (entries.length !== expected.size + 1 || [...metadata, 'platform.db'].some((name) => !expected.has(name))) throw new Error('Backup is incomplete.');
    const checked = await new SqliteBackupProvider(path.join(stage, 'platform.db')).integrityCheck(path.join(stage, 'platform.db'));
    if (!checked.ok) throw new Error('Restored database failed its integrity check.');
    const previous = `${dataRoot}.before-restore-${Date.now()}`;
    const promote = `${dataRoot}.restore-${randomUUID()}`;
    await fs.mkdir(promote, { mode: 0o700 });
    for (const name of expected) { await fs.mkdir(path.dirname(path.join(promote, name)), { recursive: true, mode: 0o700 }); await fs.copyFile(path.join(stage, name), path.join(promote, name)); await fs.chmod(path.join(promote, name), 0o600); }
    let moved = false;
    try {
      if (await fs.stat(dataRoot).catch(() => null)) { await fs.rename(dataRoot, previous); moved = true; }
      await fs.rename(promote, dataRoot);
    } catch (error) { if (moved) await fs.rename(previous, dataRoot); throw error; }
    return { restored: true, files: expected.size, previousData: moved ? previous : null };
  } finally { await release(); await fs.rm(stage, { recursive: true, force: true }); }
}
