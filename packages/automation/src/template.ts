import { getPath } from './conditions';

/**
 * Render an action template against an event payload.
 *
 * A template is any JSON value. String leaves may contain `{{path}}` tokens:
 *   - A string that is EXACTLY one token ("{{totalCents}}") is replaced by the
 *     raw payload value, PRESERVING its type (number stays a number).
 *   - A string with embedded tokens ("order {{orderId}} paid") is interpolated
 *     to a string; missing paths render as "".
 * Objects and arrays are rendered recursively. Non-string leaves pass through.
 */

const FULL_TOKEN = /^\{\{\s*([^}]+?)\s*\}\}$/;
const EMBEDDED_TOKEN = /\{\{\s*([^}]+?)\s*\}\}/g;

function renderString(str: string, payload: unknown): unknown {
  const full = str.match(FULL_TOKEN);
  if (full) {
    return getPath(payload, full[1] as string);
  }
  return str.replace(EMBEDDED_TOKEN, (_m, path: string) => {
    const v = getPath(payload, path.trim());
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

export function renderTemplate(template: unknown, payload: unknown): unknown {
  if (typeof template === 'string') return renderString(template, payload);
  if (Array.isArray(template)) return template.map((t) => renderTemplate(t, payload));
  if (template && typeof template === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template as Record<string, unknown>)) {
      out[k] = renderTemplate(v, payload);
    }
    return out;
  }
  return template;
}

/**
 * Stable stringify (sorted keys) — used to derive deterministic idempotency
 * keys from a rendered payload so identical effects collapse to one.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}
