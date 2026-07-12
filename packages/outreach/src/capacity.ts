import { DateTime } from 'luxon';

/**
 * Deterministic warmup-cap + quiet-hours math, ported from
 * ProjectUtah/utah/mail_capacity.py to pure TypeScript (no DB, no clock, no
 * network — every input is a parameter, so it is trivially unit-testable).
 *
 * ── WARMUP RAMP (the deliverability-safe daily send ceiling) ──────────────
 * A brand-new sender must not blast its full volume on day one — that wrecks
 * domain reputation. The cap ramps by WEEK from a cold floor to a hard ceiling:
 *
 *   week 1  (days  1–7,  ageDays 0–6)   →  20/day     (WARMUP_START)
 *   week 2  (days  8–14, ageDays 7–13)  →  30/day     (+WARMUP_STEP_PER_WEEK)
 *   week 3  (ageDays 14–20)             →  40/day
 *   …       +10/day each subsequent week
 *   week 19+ (ageDays >= 126)           → 200/day     (HARD_CEILING, capped)
 *
 * Formula:  cap = min(200, 20 + floor(ageDays / 7) * 10)
 * `ageDays` = whole days since the tenant's FIRST successful send (0 = today's
 * the first day → cap 20). A per-tenant `daily_cap_override` only ever LOWERS
 * the cap (never raises it), so a reputation-sensitive tenant can be pinned to a
 * conservative volume forever. This mirrors mail_capacity.safe_daily_cap()'s
 * warmup/steady/max_cap layering; the platform tightens the +20/day ramp to the
 * +10/week schedule the build spec pins (day-1 20, week-2 30, ceiling 200).
 */
export const WARMUP_START = 20;
export const WARMUP_STEP_PER_WEEK = 10;
export const WARMUP_HARD_CEILING = 200;

/** The warmup-safe daily cap for a sender `ageDays` days past its first send. */
export function warmupCapForAge(ageDays: number, dailyCapOverride?: number | null): number {
  const age = Number.isFinite(ageDays) ? Math.max(0, Math.trunc(ageDays)) : 0;
  const weekIndex = Math.floor(age / 7);
  let cap = Math.min(WARMUP_HARD_CEILING, WARMUP_START + weekIndex * WARMUP_STEP_PER_WEEK);
  if (dailyCapOverride !== undefined && dailyCapOverride !== null) {
    const override = Math.trunc(dailyCapOverride);
    if (Number.isFinite(override) && override >= 0) {
      cap = Math.min(cap, override); // override only ever lowers — never uncaps
    }
  }
  return cap;
}

/** The business-day bucket (YYYY-MM-DD) an instant falls into, in `timezone`. */
export function businessDate(iso: string, timezone: string): string {
  const dt = DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone);
  return dt.isValid ? dt.toISODate()! : DateTime.fromISO(iso).toISODate() ?? iso.slice(0, 10);
}

/** Whole days between two YYYY-MM-DD business dates (clamped at 0). */
export function ageDaysBetween(firstDate: string, today: string): number {
  const a = DateTime.fromISO(firstDate);
  const b = DateTime.fromISO(today);
  if (!a.isValid || !b.isValid) return 0;
  return Math.max(0, Math.floor(b.diff(a, 'days').days));
}

export interface QuietHours {
  startHour: number;
  endHour: number;
  timezone: string;
}

export const DEFAULT_QUIET_HOURS: QuietHours = {
  startHour: 21,
  endHour: 8,
  timezone: 'America/New_York',
};

/**
 * True when `iso` falls inside the quiet-hours window (local to the window's
 * timezone). Supports overnight windows (start > end, e.g. 21:00–08:00 = quiet
 * when hour >= 21 OR hour < 8) and same-day windows (start <= hour < end).
 * A degenerate window (start === end) is never quiet.
 */
export function isQuietHours(iso: string, quiet: QuietHours): boolean {
  const dt = DateTime.fromISO(iso, { zone: 'utc' }).setZone(quiet.timezone);
  const hour = dt.isValid ? dt.hour : new Date(iso).getUTCHours();
  const { startHour: s, endHour: e } = quiet;
  if (s === e) return false;
  if (s < e) return hour >= s && hour < e;
  return hour >= s || hour < e; // overnight
}
