import {
  createHash,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyLike,
} from 'node:crypto';
import { CLIENT_OPS_CATALOG, type ClientOpsCatalog } from './catalog';

function canonicalValue(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON does not support non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('canonical JSON does not support circular values');
    seen.add(value);
    const encoded = `[${value.map((item) => canonicalValue(item, seen)).join(',')}]`;
    seen.delete(value);
    return encoded;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('canonical JSON does not support circular values');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('canonical JSON supports only plain objects and arrays');
    }
    seen.add(value);
    const object = value as Record<string, unknown>;
    const encoded = `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(object[key], seen)}`)
      .join(',')}}`;
    seen.delete(value);
    return encoded;
  }
  throw new TypeError(`canonical JSON does not support ${typeof value}`);
}

/** Stable JSON encoding with recursively sorted object keys and preserved array order. */
export function canonicalManifestJson(manifest: unknown = CLIENT_OPS_CATALOG): string {
  return canonicalValue(manifest, new Set());
}

/** Lowercase hexadecimal SHA-256 of the canonical manifest bytes. */
export function manifestSha256(manifest: unknown = CLIENT_OPS_CATALOG): string {
  return createHash('sha256').update(canonicalManifestJson(manifest), 'utf8').digest('hex');
}

export interface ManifestSignature {
  algorithm: 'Ed25519';
  digestAlgorithm: 'SHA-256';
  manifestSha256: string;
  signature: string;
}

/**
 * Sign the canonical manifest bytes with an Ed25519 private key. Ed25519
 * signatures are deterministic for a given key and message.
 */
export function signManifest(
  manifest: ClientOpsCatalog,
  privateKey: KeyLike,
): ManifestSignature {
  const canonical = canonicalManifestJson(manifest);
  return {
    algorithm: 'Ed25519',
    digestAlgorithm: 'SHA-256',
    manifestSha256: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    signature: cryptoSign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64url'),
  };
}

/** Verify both the declared digest and Ed25519 signature without throwing. */
export function verifyManifest(
  manifest: ClientOpsCatalog,
  envelope: ManifestSignature,
  publicKey: KeyLike,
): boolean {
  try {
    if (envelope.algorithm !== 'Ed25519' || envelope.digestAlgorithm !== 'SHA-256') return false;
    if (!/^[a-f0-9]{64}$/.test(envelope.manifestSha256)) return false;
    const canonical = canonicalManifestJson(manifest);
    const actualDigest = createHash('sha256').update(canonical, 'utf8').digest();
    const declaredDigest = Buffer.from(envelope.manifestSha256, 'hex');
    if (actualDigest.length !== declaredDigest.length || !timingSafeEqual(actualDigest, declaredDigest)) return false;
    return cryptoVerify(
      null,
      Buffer.from(canonical, 'utf8'),
      publicKey,
      Buffer.from(envelope.signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

export const CLIENT_OPS_MANIFEST_SHA256 = manifestSha256(CLIENT_OPS_CATALOG);
