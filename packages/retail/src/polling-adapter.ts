import { ApiError } from '@blacklabel/core';
import type { ImportBatch, ImportKind } from './contract';

/**
 * Adapter 2 — API POLLING (built, NEVER wired to a live transport in this
 * module or its tests).
 *
 * ┌─ FOUNDER GATE ────────────────────────────────────────────────────────┐
 * │ Enabling real polling is a founder decision: it requires a LEAST-       │
 * │ PRIVILEGE, READ-ONLY Square token (PROMPT.md §6 gate #5 / §1 item 1 —   │
 * │ "NEVER call the Square API"). This module NEVER constructs a live       │
 * │ connection to connect.squareup.com. The HTTP transport is an INJECTED  │
 * │ function; the integrator supplies a real (read-only) transport only     │
 * │ after the founder approves and arms it. Absent a transport, /imports/   │
 * │ poll returns 501. No `fetch`/`http`/`https` import appears anywhere.    │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Incremental semantics (Square list endpoints):
 *   - Persisted cursor = an ISO **watermark** (max updated_at seen), NOT the
 *     transient pagination cursor.
 *   - Each run re-scans from `watermark - overlapSeconds` (the OVERLAP
 *     WINDOW) so late-arriving / edited records are re-pulled; duplicates
 *     dedup downstream (idempotent upsert → skipped_duplicates).
 *   - Within a run, pages are followed via the response cursor until null.
 *   - HTTP 429 is honored: the client sleeps `retryAfterMs` and retries.
 */

export interface PollRequest {
  source: 'square_api';
  kind: ImportKind;
  /** Pagination cursor within a run (null = first page). */
  cursor: string | null;
  /** Overlap-adjusted lower time bound (null = full scan). */
  beginTime: string | null;
  limit: number;
  /** 0-based retry attempt for this page. */
  attempt: number;
}

export interface PollResponse {
  /** HTTP-ish status; default 200. 429 triggers a retry-after wait. */
  status?: number;
  records?: unknown[];
  /** Next-page cursor; null/absent ends pagination. */
  cursor?: string | null;
  /** Retry-after in ms (429 only). */
  retryAfterMs?: number;
}

export type PollTransport = (req: PollRequest) => Promise<PollResponse>;

export interface PollResult {
  batch: ImportBatch;
  /** New persisted watermark (ISO), or null if nothing was seen. */
  newCursor: string | null;
  pagesFetched: number;
  rateLimitWaits: number;
}

export interface SquarePollingClientOptions {
  transport: PollTransport;
  /** Injected so tests never really wait. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Re-scan window applied to the watermark on each run. */
  overlapSeconds?: number;
  /** Page size requested from the provider. */
  limit?: number;
  /** Max 429 retries per page before failing. */
  maxRetries?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function subtractSeconds(iso: string, seconds: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t - seconds * 1000).toISOString();
}

function recordTimestamp(record: unknown): string | null {
  if (record && typeof record === 'object') {
    const r = record as Record<string, unknown>;
    const ts = r.updated_at ?? r.created_at ?? r.calculated_at;
    if (typeof ts === 'string' && ts.length > 0) return ts;
  }
  return null;
}

export class SquarePollingClient {
  private readonly transport: PollTransport;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly overlapSeconds: number;
  private readonly limit: number;
  private readonly maxRetries: number;

  constructor(opts: SquarePollingClientOptions) {
    this.transport = opts.transport;
    this.sleep = opts.sleep ?? defaultSleep;
    this.overlapSeconds = opts.overlapSeconds ?? 0;
    this.limit = opts.limit ?? 200;
    this.maxRetries = opts.maxRetries ?? 5;
  }

  /**
   * Poll one kind, following pagination to the end, honoring 429s, and
   * applying the overlap window to `savedCursor` (the persisted watermark).
   */
  async poll(kind: ImportKind, savedCursor: string | null): Promise<PollResult> {
    const beginTime =
      savedCursor && this.overlapSeconds > 0
        ? subtractSeconds(savedCursor, this.overlapSeconds)
        : savedCursor;

    const records: unknown[] = [];
    let cursor: string | null = null;
    let pagesFetched = 0;
    let rateLimitWaits = 0;
    let watermark: string | null = savedCursor;

    do {
      const resp = await this.fetchPage(
        { source: 'square_api', kind, cursor, beginTime, limit: this.limit, attempt: 0 },
        () => {
          rateLimitWaits += 1;
        },
      );
      pagesFetched += 1;
      const page = resp.records ?? [];
      for (const rec of page) {
        records.push(rec);
        const ts = recordTimestamp(rec);
        if (ts && (watermark === null || ts > watermark)) watermark = ts;
      }
      cursor = resp.cursor ?? null;
    } while (cursor);

    return {
      batch: {
        source: 'square_api',
        kind,
        records,
        sourceMeta: {
          cursor: watermark ?? undefined,
          fetchedAt: new Date().toISOString(),
        },
      },
      newCursor: watermark,
      pagesFetched,
      rateLimitWaits,
    };
  }

  private async fetchPage(req: PollRequest, onWait: () => void): Promise<PollResponse> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const resp = await this.transport({ ...req, attempt });
      if ((resp.status ?? 200) === 429) {
        onWait();
        await this.sleep(resp.retryAfterMs ?? 1000);
        continue;
      }
      return resp;
    }
    throw ApiError.badRequest(
      `Square polling gave up after ${this.maxRetries} rate-limit retries for kind "${req.kind}"`,
    );
  }
}
