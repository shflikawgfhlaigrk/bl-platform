import { DateTime } from 'luxon';
import type { RuleSchedule } from './schema';

/** Minutes-of-day from an "HH:mm" string; NaN-safe (bad input → -1). */
function minutesOfDay(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return -1;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return -1;
  return h * 60 + min;
}

/**
 * Is `nowIso` (UTC) inside the rule's schedule?
 *
 * The instant is converted to the schedule timezone (luxon). It matches when it
 * falls inside ANY window: the local weekday is in `days` (or `days` omitted)
 * AND the local time-of-day is in [start, end). A schedule with no windows
 * never matches. A null schedule is treated as "always" by the caller — this
 * function is only called when a schedule exists.
 */
export function isWithinSchedule(schedule: RuleSchedule, nowIso: string): boolean {
  const dt = DateTime.fromISO(nowIso, { zone: 'utc' }).setZone(schedule.timezone);
  if (!dt.isValid) return false;
  const weekday = dt.weekday; // 1=Mon .. 7=Sun
  const minutes = dt.hour * 60 + dt.minute;

  for (const w of schedule.windows) {
    if (w.days && w.days.length > 0 && !w.days.includes(weekday)) continue;
    const start = minutesOfDay(w.start);
    const end = minutesOfDay(w.end);
    if (start < 0 || end < 0) continue;
    if (minutes >= start && minutes < end) return true;
  }
  return false;
}
