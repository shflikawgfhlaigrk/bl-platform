/**
 * Deterministic exponential backoff for the outbox dispatcher.
 *
 * Schedule (base 60s, factor 5): after the k-th attempt FAILS the next attempt
 * is delayed by  BASE * FACTOR^(k-1)  seconds, capped at MAX:
 *
 *   attempts=1 → 60s      (1m)
 *   attempts=2 → 300s     (5m)
 *   attempts=3 → 1500s    (25m)
 *   attempts=4 → 7500s    (125m)
 *   ...capped at MAX_BACKOFF_SECONDS.
 *
 * No randomness — the same attempt count always yields the same delay, so
 * tests and audits are reproducible.
 */

export const BASE_BACKOFF_SECONDS = 60;
export const BACKOFF_FACTOR = 5;
/** Cap so the delay never runs away (24h). */
export const MAX_BACKOFF_SECONDS = 86_400;

/** Delay in seconds before the next attempt, given attempts made so far (>=1). */
export function backoffSeconds(attempts: number): number {
  const k = Math.max(1, Math.trunc(attempts));
  // Compute in floating point then clamp; exponent kept modest by the cap check.
  const raw = BASE_BACKOFF_SECONDS * Math.pow(BACKOFF_FACTOR, k - 1);
  if (!Number.isFinite(raw) || raw > MAX_BACKOFF_SECONDS) return MAX_BACKOFF_SECONDS;
  return Math.round(raw);
}
