import { createHmac } from 'node:crypto';
import { ApiError } from '@blacklabel/core';

/**
 * Pure template rendering + unsubscribe-token helpers. NO code eval — a
 * template is fixed text with {{placeholder}} tokens substituted from a plain
 * vars map. An unknown placeholder renders as empty string; a MISSING required
 * placeholder is rejected upstream (see validateVars).
 */

export const UNSUBSCRIBE_PLACEHOLDER = 'unsubscribe_url';
export const POSTAL_PLACEHOLDER = 'postal_address';

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export type Vars = Record<string, string | number | null | undefined>;

/** Substitute {{key}} tokens. Pure; unknown keys → "". */
export function render(template: string, vars: Vars): string {
  return (template ?? '').replace(TOKEN_RE, (_m, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** The distinct placeholder keys referenced by a template string. */
export function placeholdersIn(template: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(TOKEN_RE.source, 'g');
  while ((m = re.exec(template ?? '')) !== null) out.add(m[1]!);
  return [...out];
}

/**
 * Assert every required placeholder is supplied a (non-empty) value. Throws
 * ApiError 400 naming the first missing key. Used at send/queue time.
 */
export function validateVars(required: string[], vars: Vars): void {
  for (const key of required) {
    const v = vars[key];
    if (v === undefined || v === null || String(v).trim() === '') {
      throw ApiError.badRequest(`missing required placeholder "${key}"`, { key });
    }
  }
}

/** HMAC-SHA256(secret, sendId), base64url — the unsubscribe token. */
export function unsubscribeToken(sendId: string, secret: string): string {
  return createHmac('sha256', secret).update(sendId).digest('base64url');
}

/** Constant-ish token check (compares the recomputed HMAC). */
export function verifyUnsubscribeToken(sendId: string, secret: string, token: string): boolean {
  if (!token) return false;
  const expected = unsubscribeToken(sendId, secret);
  return expected.length === token.length && timingSafeEqualStr(expected, token);
}

function timingSafeEqualStr(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length && i < b.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Build the public unsubscribe URL for a send. */
export function unsubscribeUrl(baseUrl: string, sendId: string, secret: string): string {
  const token = unsubscribeToken(sendId, secret);
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}send=${encodeURIComponent(sendId)}&token=${encodeURIComponent(token)}`;
}
