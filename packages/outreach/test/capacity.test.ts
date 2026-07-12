import { describe, expect, it } from 'vitest';
import {
  ageDaysBetween,
  businessDate,
  isQuietHours,
  warmupCapForAge,
  WARMUP_HARD_CEILING,
  DEFAULT_QUIET_HOURS,
} from '../src/capacity';

describe('warmup ramp (mail_capacity.py port)', () => {
  it('day 1 (age 0) caps at 20', () => {
    expect(warmupCapForAge(0)).toBe(20);
    expect(warmupCapForAge(6)).toBe(20); // still week 1
  });

  it('week 2 (age 7) caps at 30, then +10/week', () => {
    expect(warmupCapForAge(7)).toBe(30);
    expect(warmupCapForAge(13)).toBe(30);
    expect(warmupCapForAge(14)).toBe(40);
    expect(warmupCapForAge(21)).toBe(50);
  });

  it('hits the 200/day hard ceiling and never exceeds it', () => {
    expect(warmupCapForAge(126)).toBe(200); // week 19
    expect(warmupCapForAge(9999)).toBe(WARMUP_HARD_CEILING);
  });

  it('override only ever LOWERS the cap (never raises)', () => {
    expect(warmupCapForAge(0, 5)).toBe(5); // override below warmup wins
    expect(warmupCapForAge(0, 500)).toBe(20); // override above warmup ignored
    expect(warmupCapForAge(126, 50)).toBe(50); // caps a warmed sender lower
    expect(warmupCapForAge(0, 0)).toBe(0);
  });

  it('clamps garbage/negative ages to day 0', () => {
    expect(warmupCapForAge(-3)).toBe(20);
    expect(warmupCapForAge(NaN)).toBe(20);
  });
});

describe('business date + age', () => {
  it('buckets an instant into its local business day', () => {
    // 01:00 UTC on the 13th is still the 12th in America/New_York.
    expect(businessDate('2026-07-13T01:00:00.000Z', 'America/New_York')).toBe('2026-07-12');
    expect(businessDate('2026-07-13T15:00:00.000Z', 'America/New_York')).toBe('2026-07-13');
  });

  it('counts whole days between business dates', () => {
    expect(ageDaysBetween('2026-07-01', '2026-07-08')).toBe(7);
    expect(ageDaysBetween('2026-07-08', '2026-07-01')).toBe(0); // clamp
  });
});

describe('quiet hours', () => {
  it('overnight window (default 21:00–08:00 ET)', () => {
    // 04:00 UTC = 00:00 ET → quiet
    expect(isQuietHours('2026-07-13T04:00:00.000Z', DEFAULT_QUIET_HOURS)).toBe(true);
    // 15:00 UTC = 11:00 ET → not quiet
    expect(isQuietHours('2026-07-13T15:00:00.000Z', DEFAULT_QUIET_HOURS)).toBe(false);
    // 02:00 UTC = 22:00 ET (prev day) → quiet
    expect(isQuietHours('2026-07-13T02:00:00.000Z', DEFAULT_QUIET_HOURS)).toBe(true);
  });

  it('same-day window', () => {
    const q = { startHour: 9, endHour: 17, timezone: 'UTC' };
    expect(isQuietHours('2026-07-13T10:00:00.000Z', q)).toBe(true);
    expect(isQuietHours('2026-07-13T18:00:00.000Z', q)).toBe(false);
  });

  it('degenerate window is never quiet', () => {
    expect(isQuietHours('2026-07-13T12:00:00.000Z', { startHour: 8, endHour: 8, timezone: 'UTC' })).toBe(false);
  });
});
