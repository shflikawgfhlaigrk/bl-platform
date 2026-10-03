/** Snapshot and restore-verify the venue database; never replaces a live DB. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { SqliteBackupProvider } from '../apps/api/src/admin-wiring';

const storage = path.resolve(process.env.ONECLUB_STORAGE_DIR || '.storage/one-club-live');
if (!existsSync(path.join(storage, 'platform.db')) || !existsSync(path.join(storage, 'admin.key'))) throw new Error('The venue database and encryption key must exist before backup.');
const dest = path.resolve(process.env.ONECLUB_BACKUP_DIR || path.join(storage, 'backups'), new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(dest, { recursive: true, mode: 0o700 });
const backup = await new SqliteBackupProvider(path.join(storage, 'platform.db')).create(dest);
copyFileSync(path.join(storage, 'admin.key'), path.join(dest, 'admin.key'));
const restored = new Database(backup.path, { readonly: true, fileMustExist: true });
const tables = ['api_bar_documents', 'api_bar_commands', 'orders_orders', 'orders_tenders', 'orders_refunds', 'finance_cash_sessions', 'api_pos_credentials'];
try {
  const integrity = restored.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error('Backup integrity check failed.');
  const counts = Object.fromEntries(tables.map(table => [table, (restored.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n]));
  writeFileSync(path.join(dest, 'receipt.json'), JSON.stringify({ createdAt: new Date().toISOString(), database: path.basename(backup.path), databaseSha256: backup.sha256,
    keySha256: createHash('sha256').update(readFileSync(path.join(dest, 'admin.key'))).digest('hex'), integrity, counts }, null, 2), { mode: 0o600 });
  console.log(`Verified database and key backup: ${dest}`);
} finally { restored.close(); }
