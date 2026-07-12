import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
} from 'node:fs';
import { open } from 'node:fs/promises';

/**
 * AES-256-GCM encryption helpers (node:crypto only, no deps).
 *
 * KEY SOURCING (integrator responsibility):
 *   The 32-byte master key is supplied at service construction and is NEVER
 *   stored in the database. The integrator sources it from an environment
 *   variable (e.g. ADMIN_MASTER_KEY, base64 of 32 random bytes) or a file
 *   held OUTSIDE the repo (e.g. ~/.mags/admin.key, chmod 600). Rotating the
 *   key means re-encrypting every credential (rotate() writes a fresh row).
 *
 * STRING FORMAT (credential payloads):
 *   base64( iv[12] || authTag[16] || ciphertext )
 *   — self-describing, single column, tamper-evident (GCM authTag).
 *
 * FILE FORMAT (backups/diagnostics, streaming):
 *   iv[12] || ciphertext... || authTag[16]
 *   — iv is a fixed-size header, authTag a fixed-size trailer, so we can
 *     stream arbitrarily large files without buffering them in memory.
 */

const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const ALGO = 'aes-256-gcm';

/**
 * Normalize a supplied master key to a 32-byte Buffer. Accepts a 32-byte
 * Buffer, a 64-char hex string, or a base64 string that decodes to 32 bytes.
 * Throws on any other shape — a wrong-length key must never silently produce
 * a weak or truncated key.
 */
export function normalizeKey(key: Buffer | string): Buffer {
  if (Buffer.isBuffer(key)) {
    if (key.length !== KEY_LEN) {
      throw new Error(`admin master key must be ${KEY_LEN} bytes, got ${key.length}`);
    }
    return key;
  }
  if (typeof key === 'string') {
    if (/^[0-9a-fA-F]{64}$/.test(key)) {
      return Buffer.from(key, 'hex');
    }
    const b = Buffer.from(key, 'base64');
    if (b.length === KEY_LEN) return b;
    throw new Error(
      `admin master key string must be 64 hex chars or base64 of ${KEY_LEN} bytes`,
    );
  }
  throw new Error('admin master key must be a Buffer or string');
}

/** Encrypt a UTF-8 string → base64(iv||tag||ciphertext). */
export function encryptString(plaintext: string, key: Buffer | string): string {
  const k = normalizeKey(key);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, k, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

/**
 * Decrypt base64(iv||tag||ciphertext) → UTF-8 string. Any tamper (flipped
 * authTag or ciphertext byte) or wrong key throws before any plaintext is
 * returned — GCM verifies the tag inside decipher.final(). No partial output.
 */
export function decryptString(encoded: string, key: Buffer | string): string {
  const k = normalizeKey(key);
  const raw = Buffer.from(encoded, 'base64');
  if (raw.length < IV_LEN + TAG_LEN) {
    throw new Error('admin: ciphertext too short / corrupt');
  }
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, k, iv);
  decipher.setAuthTag(tag);
  // final() throws if the tag does not verify — we never emit partial plaintext.
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Encrypt a JSON-serializable value. */
export function encryptJson(value: unknown, key: Buffer | string): string {
  return encryptString(JSON.stringify(value), key);
}

/** Decrypt to a JSON value. */
export function decryptJson<T = unknown>(encoded: string, key: Buffer | string): T {
  return JSON.parse(decryptString(encoded, key)) as T;
}

/**
 * Stream-encrypt a file: writes iv[12] || ciphertext || authTag[16].
 * fs is used here ONLY for backup/diagnostic artifact work (documented, this
 * package only), never for domain data.
 */
export async function encryptFile(
  srcPath: string,
  destPath: string,
  key: Buffer | string,
): Promise<void> {
  const k = normalizeKey(key);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, k, iv);
  const src = createReadStream(srcPath);
  const dest = createWriteStream(destPath);

  await new Promise<void>((resolve, reject) => {
    dest.on('error', reject);
    src.on('error', reject);
    cipher.on('error', reject);
    // iv header first, then piped ciphertext.
    dest.write(iv, (err) => {
      if (err) return reject(err);
      src.pipe(cipher, { end: false });
      cipher.on('data', (chunk: Buffer | string) => {
        dest.write(chunk);
      });
      src.on('end', () => {
        cipher.end();
      });
      cipher.on('end', () => {
        const tag = cipher.getAuthTag();
        dest.end(tag, () => resolve());
      });
    });
  });
}

/**
 * Stream-decrypt a file produced by encryptFile. Reads the iv header and the
 * authTag trailer, verifies the tag, and throws on any tamper before finishing
 * (final chunk withheld until the tag verifies).
 */
export async function decryptFile(
  srcPath: string,
  destPath: string,
  key: Buffer | string,
): Promise<void> {
  const k = normalizeKey(key);
  const fh = await open(srcPath, 'r');
  try {
    const stat = await fh.stat();
    const size = stat.size;
    if (size < IV_LEN + TAG_LEN) {
      throw new Error('admin: encrypted file too short / corrupt');
    }
    const iv = Buffer.alloc(IV_LEN);
    await fh.read(iv, 0, IV_LEN, 0);
    const tag = Buffer.alloc(TAG_LEN);
    await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);

    const decipher = createDecipheriv(ALGO, k, iv);
    decipher.setAuthTag(tag);

    const ctStart = IV_LEN;
    const ctEnd = size - TAG_LEN - 1; // inclusive
    const dest = createWriteStream(destPath);

    await new Promise<void>((resolve, reject) => {
      dest.on('error', reject);
      decipher.on('error', reject);
      if (ctEnd < ctStart) {
        // Empty plaintext: still verify the tag.
        try {
          decipher.final();
          dest.end(() => resolve());
        } catch (e) {
          reject(e);
        }
        return;
      }
      const src = createReadStream(srcPath, { start: ctStart, end: ctEnd });
      src.on('error', reject);
      src.on('data', (chunk: Buffer | string) => {
        // Binary read stream: chunk is always a Buffer here.
        dest.write(decipher.update(chunk as Buffer));
      });
      src.on('end', () => {
        try {
          dest.write(decipher.final()); // throws on tamper — nothing partial escapes final()
          dest.end(() => resolve());
        } catch (e) {
          reject(e);
        }
      });
    });
  } finally {
    await fh.close();
  }
}

/* ------------------------------------------------------------------ *
 * Masking — the display shape stored in fields_masked (never a secret)
 * ------------------------------------------------------------------ */

const SECRET_KEY_RE = /pass|secret|token|key|credential|apikey|api_key|pwd/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Mask an email local part: "alice@x.com" -> "a***@x.com". */
export function maskEmail(value: string): string {
  const at = value.indexOf('@');
  if (at <= 0) return '***';
  const local = value.slice(0, at);
  const domain = value.slice(at);
  const head = local[0] ?? '';
  return `${head}***${domain}`;
}

/**
 * Compute the display-only masked shape of a credential payload. Secret-named
 * keys collapse to "***"; email-like values keep only the first char + domain;
 * structural values (host, port, region) pass through. The result is safe to
 * store in fields_masked and to return from list endpoints.
 */
export function maskPayload(
  payload: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, rawVal] of Object.entries(payload)) {
    if (SECRET_KEY_RE.test(rawKey)) {
      out[rawKey] = '***';
      continue;
    }
    if (typeof rawVal === 'string') {
      out[rawKey] = EMAIL_RE.test(rawVal) ? maskEmail(rawVal) : rawVal;
    } else if (rawVal === null || rawVal === undefined) {
      out[rawKey] = '';
    } else {
      // numbers/booleans/objects — stringify structurally, never a secret path.
      out[rawKey] = typeof rawVal === 'object' ? '[object]' : String(rawVal);
    }
  }
  return out;
}
