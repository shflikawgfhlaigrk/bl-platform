import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LocalDiskStorageProvider,
  MemoryStorageProvider,
  S3StorageProvider,
  STORAGE_KEY_PATTERN,
  StorageError,
  assertStorageKey,
  newStorageKey,
} from '@blacklabel/files';

const TRAVERSAL_KEYS = [
  '../escape',
  '..',
  '.',
  'a/b',
  'a\\b',
  '/etc/passwd',
  'C:\\windows\\system32',
  '....//....//etc/passwd',
  '..%2f..%2fetc%2fpasswd',
  'valid-looking/../../../../etc/passwd',
  '.hidden-dotfile-key-000000000000000000',
  '',
  'short',
];

describe('storage keys', () => {
  it('newStorageKey generates unique, pattern-conformant, path-free keys', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const key = newStorageKey();
      expect(key).toMatch(STORAGE_KEY_PATTERN);
      expect(key).not.toMatch(/[/\\.]/);
      keys.add(key);
    }
    expect(keys.size).toBe(200);
  });

  it('assertStorageKey rejects every traversal/path-like key', () => {
    for (const key of TRAVERSAL_KEYS) {
      expect(() => assertStorageKey(key), `key should be rejected: ${JSON.stringify(key)}`).toThrow(
        StorageError,
      );
    }
    expect(() => assertStorageKey(newStorageKey())).not.toThrow();
  });
});

describe('LocalDiskStorageProvider', () => {
  // A root path that must NEVER be created: every operation below is
  // rejected by key validation before any disk access happens.
  const root = path.join(
    process.cwd(),
    `.files-test-root-never-created-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  it('rejects path-traversal keys on put/get/exists/delete before touching disk', async () => {
    const provider = new LocalDiskStorageProvider(root);
    for (const key of TRAVERSAL_KEYS) {
      await expect(provider.put(key, new Uint8Array([1]))).rejects.toMatchObject({
        name: 'StorageError',
        code: 'invalid_key',
      });
      await expect(provider.get(key)).rejects.toMatchObject({ code: 'invalid_key' });
      await expect(provider.exists(key)).rejects.toMatchObject({ code: 'invalid_key' });
      await expect(provider.delete(key)).rejects.toMatchObject({ code: 'invalid_key' });
    }
    // No write ever happened — the root directory was never even created.
    expect(existsSync(root)).toBe(false);
  });
});

describe('MemoryStorageProvider', () => {
  it('round-trips put/get/exists/delete and 404s on missing keys', async () => {
    const provider = new MemoryStorageProvider();
    const key = newStorageKey();
    const payload = new TextEncoder().encode('hello vault');

    expect(await provider.exists(key)).toBe(false);
    await provider.put(key, payload);
    expect(await provider.exists(key)).toBe(true);
    expect(Buffer.from(await provider.get(key)).toString('utf8')).toBe('hello vault');

    await provider.delete(key);
    expect(await provider.exists(key)).toBe(false);
    await expect(provider.get(key)).rejects.toMatchObject({ code: 'not_found' });
    // delete is idempotent
    await expect(provider.delete(key)).resolves.toBeUndefined();
  });

  it('also enforces key validation (no traversal keys in any adapter)', async () => {
    const provider = new MemoryStorageProvider();
    await expect(provider.put('../x', new Uint8Array())).rejects.toMatchObject({
      code: 'invalid_key',
    });
  });
});

describe('S3StorageProvider (spec-mandated stub)', () => {
  it('documents the contract and throws not_implemented on valid keys', async () => {
    const provider = new S3StorageProvider({ bucket: 'vault', endpoint: 'https://r2.example' });
    expect(provider.kind).toBe('s3');
    const key = newStorageKey();
    await expect(provider.put(key, new Uint8Array([1]))).rejects.toMatchObject({
      code: 'not_implemented',
    });
    await expect(provider.get(key)).rejects.toMatchObject({ code: 'not_implemented' });
    // ... but still validates keys FIRST
    await expect(provider.get('../x')).rejects.toMatchObject({ code: 'invalid_key' });
  });
});
