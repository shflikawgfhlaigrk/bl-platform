/**
 * Small pure formatting helpers shared by the browser views and the tests.
 * No DOM, no framework. Dates in, plain human strings out.
 */

/** Escape a string for safe insertion as HTML text/attribute content. */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

/** Sort helper: lower number = more urgent. Unknown priorities sort last. */
export function priorityRank(priority) {
  return PRIORITY_ORDER[priority] ?? 99;
}

export function priorityLabel(priority) {
  if (!priority) return 'Normal';
  return String(priority).replace(/^\w/, (c) => c.toUpperCase());
}

/** ISO -> "Jul 12, 2026" (UTC-stable, locale-free). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${formatDate(iso)} ${hh}:${mm} UTC`;
}

/**
 * Coarse relative age, e.g. "just now", "5 min ago", "3 hr ago", "2 days ago".
 * @param {string} iso
 * @param {number} [nowMs] injectable clock for tests
 */
export function relativeTime(iso, nowMs = Date.now()) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return String(iso);
  const secs = Math.round((nowMs - then) / 1000);
  if (secs < 0) return 'in the future';
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} mo ago`;
  return `${Math.round(months / 12)} yr ago`;
}

/** "Data as of Jul 12, 2026" (or a friendly fallback when unknown). */
export function dataAsOf(iso) {
  return iso ? `Data as of ${formatDate(iso)}` : 'Data as of — (not yet loaded)';
}

/** Truncate for compact table cells without breaking HTML (escape after). */
export function truncate(value, max = 60) {
  const s = value === null || value === undefined ? '' : String(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
