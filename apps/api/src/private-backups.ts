import { constants, openSync, closeSync, fstatSync, lstatSync, mkdirSync, chmodSync, realpathSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { normalizeKey, type BackupProvider } from '@blacklabel/admin';

const MAGIC = Buffer.from('BLBKP01\n');
const inside = (root: string, target: string) => target === root || target.startsWith(root + path.sep);

export interface PrivateBackupOptions {
  /** Server-owned directory, never a request field. */
  directory?: string;
  key?: Buffer | string;
  staticRoots?: readonly string[];
}

/** Private AES-256-GCM database snapshots for single-tenant installations. */
export class SqliteBackupProvider implements BackupProvider {
  readonly supportsEncryption = true;
  readonly scope = 'single-tenant-database' as const;
  private readonly directory: string;
  private readonly key?: Buffer;
  private readonly temps = new Set<string>();

  constructor(private readonly livePath: string, private readonly options: PrivateBackupOptions = {}) {
    this.directory = path.resolve(options.directory ?? path.join(path.dirname(livePath), 'backups'));
    if (options.key) this.key = createHash('sha256').update('BlackLabel database backup v1\0').update(normalizeKey(options.key)).digest();
  }

  private privateRoot(): string {
    for (const root of this.options.staticRoots ?? []) {
      if (inside(path.resolve(root), this.directory)) throw new Error('backup directory overlaps a static root');
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error('backup directory cannot be a symlink');
    const actual = realpathSync(this.directory);
    for (const root of this.options.staticRoots ?? []) {
      if (inside(realpathSync(root), actual)) throw new Error('backup directory overlaps a static root');
    }
    chmodSync(actual, 0o700);
    return actual;
  }

  private requireKey(): Buffer {
    if (!this.key) throw new Error('backup encryption key is not configured');
    return this.key;
  }

  private artifactBytes(file: string): Buffer {
    const root = this.privateRoot();
    // macOS exposes the same temporary directory through /var and /private/var.
    // Resolve the parent only, retaining O_NOFOLLOW on the artifact itself.
    const target = path.join(realpathSync(path.dirname(path.resolve(file))), path.basename(file));
    if (path.dirname(target) !== root || !/^backup-[a-f0-9-]+\.blbackup$/.test(path.basename(target))) {
      throw new Error('backup artifact is outside the private directory');
    }
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFile()) throw new Error('backup artifact is not a regular file');
      const bytes = readFileSync(fd);
      if (bytes.length < MAGIC.length + 28 || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('invalid encrypted backup format');
      return bytes;
    } finally { closeSync(fd); }
  }

  async create(destDir?: string, options?: { encrypted?: boolean; tenantId?: string }) {
    if (destDir !== undefined) throw new Error('backup destinations are server controlled');
    if (options?.encrypted === false) throw new Error('database backups require encryption');
    const key = this.requireKey();
    const root = this.privateRoot();
    const uuid = randomUUID();
    const temporary = path.join(root, `.snapshot-${uuid}.sqlite`);
    const dest = path.join(root, `backup-${uuid}.blbackup`);
    const db = new Database(this.livePath, { readonly: true, fileMustExist: true });
    try {
      db.prepare('VACUUM INTO ?').run(temporary);
      chmodSync(temporary, 0o600);
      // Refuse a race that adds a second tenant after HTTP scope resolution.
      const snapshot = new Database(temporary, { readonly: true, fileMustExist: true });
      try {
        const tenants = snapshot.prepare('SELECT id FROM tenants LIMIT 2').all() as Array<{ id: string }>;
        if (tenants.length !== 1 || (options?.tenantId && tenants[0].id !== options.tenantId)) throw new Error('backup tenant does not match the single-tenant database');
      } finally { snapshot.close(); }
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(MAGIC);
      const bytes = Buffer.concat([MAGIC, iv, cipher.update(readFileSync(temporary)), cipher.final(), cipher.getAuthTag()]);
      writeFileSync(dest, bytes, { flag: 'wx', mode: 0o600 });
      return { path: dest, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), encrypted: true };
    } finally {
      db.close();
      try { unlinkSync(temporary); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
  }

  async readArtifact(file: string): Promise<Uint8Array> { return this.artifactBytes(file); }

  async restoreToTemp(file: string): Promise<{ tempPath: string }> {
    const bytes = this.artifactBytes(file);
    const decipher = createDecipheriv('aes-256-gcm', this.requireKey(), bytes.subarray(MAGIC.length, MAGIC.length + 12));
    decipher.setAAD(MAGIC); decipher.setAuthTag(bytes.subarray(-16));
    // Authentication must finish before any plaintext file is created.
    const plain = Buffer.concat([decipher.update(bytes.subarray(MAGIC.length + 12, -16)), decipher.final()]);
    const tempPath = path.join(this.privateRoot(), `.verify-${randomUUID()}.sqlite`);
    writeFileSync(tempPath, plain, { flag: 'wx', mode: 0o600 }); this.temps.add(tempPath);
    return { tempPath };
  }

  async integrityCheck(tempPath: string) {
    if (!this.temps.has(tempPath)) throw new Error('unknown backup verification file');
    const db = new Database(tempPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string };
      return { ok: row?.integrity_check === 'ok', detail: { integrity_check: row?.integrity_check } };
    } finally { db.close(); }
  }

  async cleanupTemp(tempPath: string) {
    if (!this.temps.delete(tempPath)) throw new Error('unknown backup verification file');
    unlinkSync(tempPath);
  }

  async delete(file: string) { this.artifactBytes(file); unlinkSync(file); }
}
