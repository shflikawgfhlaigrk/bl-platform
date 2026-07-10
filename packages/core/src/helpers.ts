import { nanoid } from 'nanoid';

/** New entity id. TEXT column, generated in code — never AUTOINCREMENT. */
export function id(): string {
  return nanoid();
}

/** Current instant as ISO-8601 UTC text, e.g. "2026-07-10T18:04:05.123Z". */
export function nowIso(): string {
  return new Date().toISOString();
}
