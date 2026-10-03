import { copyFile, mkdtemp, readFile, rm, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteBackupProvider } from '../apps/api/src/private-backups';

/** Decrypt into a NEW file only; never touches or replaces a running database. */
export async function decryptBackupToFile(artifact: string, key: Buffer | string, destination: string): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'blacklabel-backup-restore-'));
  try {
    const copy = path.join(workspace, `backup-${randomUUID()}.blbackup`);
    await copyFile(artifact, copy, constants.COPYFILE_EXCL); await chmod(copy, 0o600);
    const provider = new SqliteBackupProvider(path.join(workspace, 'unused.sqlite'), { key, directory: workspace });
    const restored = await provider.restoreToTemp(copy);
    if (!(await provider.integrityCheck(restored.tempPath)).ok) throw new Error('restored database failed integrity verification');
    await copyFile(restored.tempPath, destination, constants.COPYFILE_EXCL); await chmod(destination, 0o600);
  } finally { await rm(workspace, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [artifact, keyFile, destination] = process.argv.slice(2);
  if (!artifact || !keyFile || !destination) throw new Error('Usage: decrypt-private-backup.ts ARTIFACT ADMIN_KEY_FILE NEW_DATABASE_FILE');
  const rawKey = await readFile(keyFile);
  await decryptBackupToFile(artifact, rawKey.length === 32 ? rawKey : rawKey.toString().trim(), destination);
  console.log('Decrypted and integrity-verified a new database file. The active database was not changed.');
}
