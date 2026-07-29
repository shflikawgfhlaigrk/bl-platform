import { ApiError } from '@blacklabel/core';

const SECRET_KEY_PATTERN = /(^|_)(pass(word|wd)?|passphrase|secret|token|api_?key|private_?key|signing_?key|session(_?key)?|credential(s)?|auth(entication|orization)?|bearer|cookie(s)?)(_|$)/;

function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function keyContainsSecret(key: string): boolean {
  const normalized = normalizeKey(key);
  return SECRET_KEY_PATTERN.test(normalized)
    || normalized.includes('apikey') || normalized.includes('privatekey')
    || normalized.includes('accesstoken') || normalized.includes('refreshtoken')
    || normalized.includes('clientsecret') || normalized.includes('signingkey');
}

function inspect(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw ApiError.badRequest('connector metadata must not contain circular values');
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspect(item, `${path}[${index}]`, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw ApiError.badRequest('connector metadata supports only plain JSON objects and arrays');
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (keyContainsSecret(key)) {
        throw ApiError.badRequest(`connector metadata contains prohibited secret field: ${path}.${key}`, {
          field: `${path}.${key}`,
          use: 'credentialRef',
        });
      }
      inspect(child, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

/** Reject recursively nested secret-shaped keys before metadata persistence. */
export function assertSafeConnectorMetadata(metadata: Record<string, unknown>): void {
  inspect(metadata, 'metadata', new Set());
}
