/**
 * Deterministic email/phone normalization + a small stable hash.
 * Pure functions — no DB, no clock, no randomness — so identity resolution
 * and segment membership are reproducible.
 */

/**
 * Email normalization rule (documented + stable):
 *   trim surrounding whitespace, lowercase the whole address.
 * We intentionally do NOT strip dots or "+tags" — that is provider-specific
 * and would over-merge distinct addresses. Empty/whitespace -> null.
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const t = raw.trim().toLowerCase();
  return t === '' ? null : t;
}

/**
 * Phone normalization rule (documented + stable, "E.164-ish digits"):
 *   1. drop everything except ASCII digits,
 *   2. drop a leading international "00" prefix,
 *   3. if exactly 10 digits remain, assume NANP and prepend "1",
 *   4. store the digit string with no "+" (E.164 without the plus).
 * Empty -> null. Non-NANP / already-country-coded numbers pass straight
 * through as their digit string, so international numbers are preserved.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10) d = `1${d}`;
  return d === '' ? null : d;
}

/** Normalize a suppression value by its scope. */
export function normalizeSuppressionValue(scope: 'email' | 'phone', value: string): string | null {
  return scope === 'email' ? normalizeEmail(value) : normalizePhone(value);
}

/** Stable JSON stringify: object keys sorted recursively, arrays preserved. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Deterministic 32-bit FNV-1a hash of a string, returned as 8-char hex.
 * No crypto dependency; used to fingerprint segment evaluation inputs so
 * "same inputs -> same members" is provable.
 */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    // h *= 16777619 (FNV prime), kept in 32-bit via >>> 0
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Hash any JSON-able value stably. */
export function hashInputs(value: unknown): string {
  return fnv1a(stableStringify(value));
}
