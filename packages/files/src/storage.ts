/**
 * Storage adapters for the files module.
 *
 * SECURITY MODEL
 * - Storage keys are ALWAYS server-generated random ids (`newStorageKey()`).
 *   They are never derived from user input (filenames, folder names, ...).
 * - Every adapter validates keys against STORAGE_KEY_PATTERN before touching
 *   any backend, so path traversal ("../", absolute paths, separators) is
 *   rejected up front.
 * - Keys are secrets of the storage layer: routers must never echo them in
 *   API responses or URLs. Downloads go through `/files/:id/content`.
 */
import { mkdir, readFile, unlink, writeFile, access } from 'node:fs/promises';
import * as path from 'node:path';
import { id } from '@blacklabel/core';

export type StorageErrorCode = 'invalid_key' | 'not_found' | 'not_implemented';

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

/**
 * The adapter contract. Implementations MUST:
 * - accept only keys matching STORAGE_KEY_PATTERN (throw StorageError
 *   'invalid_key' otherwise, BEFORE any backend access)
 * - throw StorageError 'not_found' from get() for missing keys
 * - make delete() idempotent (deleting a missing key is a no-op)
 */
export interface StorageProvider {
  /** Adapter identifier, e.g. "local-disk", "memory", "s3". */
  readonly kind: string;
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

/**
 * Keys are 32–128 chars of the nanoid alphabet. No separators, no dots — a
 * valid key can never escape the storage root.
 */
export const STORAGE_KEY_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

/** Generate a fresh opaque storage key (two nanoids, 42 chars). */
export function newStorageKey(): string {
  return `${id()}${id()}`;
}

/** Validate a storage key; throws StorageError('invalid_key') on anything unsafe. */
export function assertStorageKey(key: string): void {
  if (typeof key !== 'string' || !STORAGE_KEY_PATTERN.test(key)) {
    throw new StorageError(
      'invalid_key',
      'invalid storage key: keys are server-generated random ids (no paths, dots, or separators)',
    );
  }
}

/**
 * Local-disk adapter. Writes each object as `<rootDir>/<key>`.
 * Default root is `.storage/files` inside the repo working directory.
 */
export class LocalDiskStorageProvider implements StorageProvider {
  readonly kind = 'local-disk';
  private readonly root: string;
  private rootReady = false;

  constructor(rootDir = '.storage/files') {
    this.root = path.resolve(rootDir);
  }

  /** Validate the key, then resolve it and prove containment in the root. */
  private resolvePath(key: string): string {
    assertStorageKey(key);
    const abs = path.resolve(this.root, key);
    // Defense in depth: even though the pattern forbids separators, verify
    // the resolved path is a direct child of the root.
    if (abs !== path.join(this.root, key) || !abs.startsWith(this.root + path.sep)) {
      throw new StorageError('invalid_key', 'storage key escapes the storage root');
    }
    return abs;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const file = this.resolvePath(key);
    if (!this.rootReady) {
      await mkdir(this.root, { recursive: true });
      this.rootReady = true;
    }
    await writeFile(file, data);
  }

  async get(key: string): Promise<Uint8Array> {
    const file = this.resolvePath(key);
    try {
      return new Uint8Array(await readFile(file));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StorageError('not_found', `no stored object for key`);
      }
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    const file = this.resolvePath(key);
    try {
      await access(file);
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    const file = this.resolvePath(key);
    try {
      await unlink(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

/**
 * In-memory adapter — used by tests (tests never write to disk) and useful
 * for ephemeral environments.
 */
export class MemoryStorageProvider implements StorageProvider {
  readonly kind = 'memory';
  private readonly objects = new Map<string, Uint8Array>();

  async put(key: string, data: Uint8Array): Promise<void> {
    assertStorageKey(key);
    this.objects.set(key, new Uint8Array(data));
  }

  async get(key: string): Promise<Uint8Array> {
    assertStorageKey(key);
    const data = this.objects.get(key);
    if (!data) throw new StorageError('not_found', 'no stored object for key');
    return new Uint8Array(data);
  }

  async exists(key: string): Promise<boolean> {
    assertStorageKey(key);
    return this.objects.has(key);
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    this.objects.delete(key);
  }

  /** Number of stored objects (test helper). */
  size(): number {
    return this.objects.size;
  }
}

export interface S3StorageConfig {
  bucket: string;
  region?: string;
  /** Custom endpoint for S3-compatible stores (Cloudflare R2, MinIO, ...). */
  endpoint?: string;
  /** Optional object-key prefix, e.g. "files/". */
  prefix?: string;
}

/**
 * S3/R2-ready adapter — INTENTIONAL STUB (per module spec). No SDK dependency
 * ships in this repo, so every method throws StorageError('not_implemented').
 *
 * CONTRACT for the real implementation (wired by the integration layer):
 * - object key  = `${config.prefix ?? ''}${key}` after assertStorageKey(key)
 * - put()       -> PutObject  (content-type is NOT stored here; mime lives in
 *                  files_assets metadata)
 * - get()       -> GetObject; map NoSuchKey/404 to StorageError('not_found')
 * - exists()    -> HeadObject; 404 -> false
 * - delete()    -> DeleteObject; missing keys are a successful no-op
 * - Buckets must be PRIVATE. Never build public URLs from storage keys;
 *   serving goes through the router's id-based `/files/:id/content` route
 *   (or presigned URLs minted by the integrator — still keyed by file id).
 */
export class S3StorageProvider implements StorageProvider {
  readonly kind = 's3';
  readonly config: S3StorageConfig;

  constructor(config: S3StorageConfig) {
    this.config = config;
  }

  private unimplemented(): never {
    throw new StorageError(
      'not_implemented',
      'S3StorageProvider is a stub documenting the adapter contract — wire a real S3/R2 client in the integration layer',
    );
  }

  async put(key: string, _data: Uint8Array): Promise<void> {
    assertStorageKey(key);
    this.unimplemented();
  }

  async get(key: string): Promise<Uint8Array> {
    assertStorageKey(key);
    this.unimplemented();
  }

  async exists(key: string): Promise<boolean> {
    assertStorageKey(key);
    this.unimplemented();
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    this.unimplemented();
  }
}
