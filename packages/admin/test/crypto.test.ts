import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encryptString,
  decryptString,
  encryptJson,
  decryptJson,
  encryptFile,
  decryptFile,
  maskEmail,
  maskPayload,
  normalizeKey,
} from '../src/crypto';

const KEY = randomBytes(32);

describe('AES-256-GCM string round-trip + tamper detection', () => {
  it('round-trips a secret payload', () => {
    const secret = JSON.stringify({ host: 'smtp.x.com', pass: 'hunter2' });
    const enc = encryptString(secret, KEY);
    expect(enc).not.toContain('hunter2');
    expect(decryptString(enc, KEY)).toBe(secret);
  });

  it('round-trips JSON', () => {
    const value = { user: 'a@x.com', apiKey: 'sk_live_abc' };
    const enc = encryptJson(value, KEY);
    expect(decryptJson(enc, KEY)).toEqual(value);
  });

  it('throws (no partial plaintext) when the authTag byte is flipped', () => {
    const enc = encryptString('top secret', KEY);
    const raw = Buffer.from(enc, 'base64');
    raw[12] ^= 0xff; // authTag starts at offset 12
    const tampered = raw.toString('base64');
    expect(() => decryptString(tampered, KEY)).toThrow();
  });

  it('throws when a ciphertext byte is flipped', () => {
    const enc = encryptString('top secret payload here', KEY);
    const raw = Buffer.from(enc, 'base64');
    raw[raw.length - 1] ^= 0x01; // last ciphertext byte
    expect(() => decryptString(raw.toString('base64'), KEY)).toThrow();
  });

  it('throws with the wrong key', () => {
    const enc = encryptString('top secret', KEY);
    const wrong = randomBytes(32);
    expect(() => decryptString(enc, wrong)).toThrow();
  });

  it('normalizeKey rejects wrong-length keys', () => {
    expect(() => normalizeKey(randomBytes(16))).toThrow();
    expect(() => normalizeKey('short')).toThrow();
    // hex + base64 forms of a 32-byte key are accepted.
    expect(normalizeKey(KEY.toString('hex'))).toHaveLength(32);
    expect(normalizeKey(KEY.toString('base64'))).toHaveLength(32);
  });
});

describe('encryptFile / decryptFile streaming round-trip + tamper', () => {
  it('round-trips a real temp file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'admin-crypto-'));
    try {
      const src = join(dir, 'plain.txt');
      const enc = join(dir, 'cipher.bin');
      const out = join(dir, 'restored.txt');
      const contents = 'row-of-record\n'.repeat(5000); // > one chunk
      await writeFile(src, contents, 'utf8');

      await encryptFile(src, enc, KEY);
      const encBytes = await readFile(enc);
      expect(encBytes.includes(Buffer.from('row-of-record'))).toBe(false);

      await decryptFile(enc, out, KEY);
      expect(await readFile(out, 'utf8')).toBe(contents);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('decryptFile throws when the ciphertext is tampered', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'admin-crypto-'));
    try {
      const src = join(dir, 'plain.txt');
      const enc = join(dir, 'cipher.bin');
      const out = join(dir, 'restored.txt');
      await writeFile(src, 'sensitive-data-block', 'utf8');
      await encryptFile(src, enc, KEY);

      const bytes = await readFile(enc);
      bytes[20] ^= 0xff; // flip a ciphertext byte (past the 12-byte iv header)
      await writeFile(enc, bytes);

      await expect(decryptFile(enc, out, KEY)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('masking', () => {
  it('masks an email local part', () => {
    expect(maskEmail('alice@x.com')).toBe('a***@x.com');
  });

  it('masks secrets, masks emails, passes through structural fields', () => {
    const masked = maskPayload({
      host: 'smtp.x.com',
      port: 587,
      user: 'alice@x.com',
      password: 'hunter2',
      apiKey: 'sk_live_abc',
    });
    expect(masked).toEqual({
      host: 'smtp.x.com',
      port: '587',
      user: 'a***@x.com',
      password: '***',
      apiKey: '***',
    });
  });
});
