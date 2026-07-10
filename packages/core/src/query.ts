import { ApiError } from './errors';

/**
 * List-endpoint query helpers. Canonical params: ?limit=&offset=&sort=
 * (sort: "col" asc, "-col" desc, or "col:desc"). Filters are plain
 * `?column=value` params whitelisted by the module.
 */

export interface Pagination {
  limit: number;
  offset: number;
}

export interface PaginationOptions {
  defaultLimit?: number;
  maxLimit?: number;
}

/** Parse & clamp limit/offset. Garbage input falls back to defaults; limit is clamped to [1, maxLimit]. */
export function parsePagination(
  query: Record<string, string | undefined>,
  options: PaginationOptions = {},
): Pagination {
  const { defaultLimit = 50, maxLimit = 200 } = options;
  const rawLimit = query.limit === undefined ? defaultLimit : Number(query.limit);
  const rawOffset = query.offset === undefined ? 0 : Number(query.offset);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), maxLimit)
    : defaultLimit;
  const offset = Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0;
  return { limit, offset };
}

export interface Sort {
  column: string;
  direction: 'asc' | 'desc';
}

/**
 * Parse ?sort= against a whitelist of sortable columns.
 * Throws ApiError 400 on a non-whitelisted column (never interpolate user
 * input into ORDER BY without this).
 */
export function parseSort(
  query: Record<string, string | undefined>,
  allowed: readonly string[],
  fallback?: Sort,
): Sort | undefined {
  const raw = query.sort;
  if (!raw) return fallback;
  let column = raw;
  let direction: 'asc' | 'desc' = 'asc';
  if (raw.startsWith('-')) {
    column = raw.slice(1);
    direction = 'desc';
  } else if (raw.includes(':')) {
    const [c, d] = raw.split(':');
    column = c ?? '';
    direction = d === 'desc' ? 'desc' : 'asc';
  }
  if (!allowed.includes(column)) {
    throw ApiError.badRequest(`cannot sort by "${column}"`, { allowed });
  }
  return { column, direction };
}

/**
 * Extract whitelisted equality filters from query params.
 * Only keys in `allowed` are read; empty strings are ignored.
 */
export function parseFilters(
  query: Record<string, string | undefined>,
  allowed: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of allowed) {
    const value = query[key];
    if (value !== undefined && value !== '') {
      out[key] = value;
    }
  }
  return out;
}
