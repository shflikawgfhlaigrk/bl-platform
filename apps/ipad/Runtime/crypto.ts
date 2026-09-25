// Node-compatible primitives used by the unchanged POS domain services.
import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { scrypt } from '@noble/hashes/scrypt.js';
import { gcm } from '@noble/ciphers/aes.js';
const bytes = (v: any, encoding?: any) => Buffer.from(v, encoding);
export function randomBytes(length: number) {
  const output = Buffer.alloc(length);
  for (let i = 0; i < length; i += 65536) crypto.getRandomValues(output.subarray(i, i + 65536));
  return output;
}
export function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) throw new Error('Unequal digest lengths');
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
function digest(algorithm: string, key?: any) {
  if (algorithm !== 'sha256') throw new Error('Unsupported digest');
  const parts: Uint8Array[] = [];
  return {
    update(value: any, encoding?: any) { parts.push(bytes(value, encoding)); return this; },
    digest(encoding?: any): any {
      const input = Buffer.concat(parts);
      const value = Buffer.from(key === undefined ? sha256(input) : hmac(sha256, bytes(key), input));
      return encoding ? value.toString(encoding) : value;
    },
  };
}
export const createHash = (algorithm: string) => digest(algorithm);
export const createHmac = (algorithm: string, key: any) => digest(algorithm, key);
export const scryptSync = (password: any, salt: any, length: number, options: any = {}) =>
  Buffer.from(scrypt(bytes(password), bytes(salt), { N: options.N ?? 16384, r: options.r ?? 8, p: options.p ?? 1, dkLen: length, maxmem: options.maxmem ?? 67108864 }));
export function createCipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array) {
  if (algorithm !== 'aes-256-gcm' || key.length !== 32) throw new Error('Invalid cipher');
  const parts: Uint8Array[] = []; let tag: Uint8Array;
  return {
    update(value: any, encoding?: any) { parts.push(bytes(value, encoding)); return Buffer.alloc(0); },
    final() { const result = gcm(key, iv).encrypt(Buffer.concat(parts)); tag = result.slice(-16); return Buffer.from(result.slice(0, -16)); },
    getAuthTag() { if (!tag) throw new Error('Cipher not finalized'); return Buffer.from(tag); },
  };
}
export function createDecipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array) {
  if (algorithm !== 'aes-256-gcm' || key.length !== 32) throw new Error('Invalid cipher');
  const parts: Uint8Array[] = []; let tag: Uint8Array;
  return {
    setAuthTag(value: Uint8Array) { tag = value; },
    update(value: any) { parts.push(bytes(value)); return Buffer.alloc(0); },
    final() { if (!tag) throw new Error('Missing authentication tag'); return Buffer.from(gcm(key, iv).decrypt(Buffer.concat([...parts, tag]))); },
  };
}
