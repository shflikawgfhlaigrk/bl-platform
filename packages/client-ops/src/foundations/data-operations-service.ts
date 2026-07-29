import type {
  FoundationAdapterReadiness,
  FoundationInvocationRequest,
  FoundationInvocationResult,
  FoundationVerificationRequest,
  FoundationVerificationResult,
  ServiceFoundationAdapter,
} from '../adapters';

/**
 * Data Operations Service (service `data-operations-service`, capability
 * `client_ops.data.execute_job`, owned source `BlackLabelPropertyHarvest.jobs`).
 *
 *   invokeBoundary : "Run one checkpointed, versioned import, transform, enrichment, or delivery slice."
 *   verifyBoundary : "Return source range, accepted and rejected counts, destination readback, and the next checkpoint."
 *
 * This adapter runs ONE real, checkpointed, READ-ONLY slice over an owned data
 * source produced by the property-harvest jobs. In production that source is the
 * `national_property_records` table on psql :5433 (db `blacklabel`) — the imported
 * payload of the `BlackLabelPropertyHarvest.jobs` (`harvest_runs`) ledger. It
 * resumes from an explicit checkpoint cursor, counts accepted vs rejected records
 * against a versioned quality gate, performs an independent read-only readback of
 * the accepted rows, and returns the next checkpoint. It NEVER writes, deletes, or
 * mutates any live table.
 *
 * Anti-vapor guarantee: every count comes from rows the injected reader actually
 * returned — never invented. If no reader is wired (source unreachable) the adapter
 * reports readiness `'declared'` and `invoke()` returns `status: 'failed'`, so the
 * runner fails the run honestly instead of minting a completion receipt over
 * fabricated output.
 *
 * Source access is injectable: the constructor takes a reader function/dep so a test
 * can supply a deterministic reader while production wires the real psql source via
 * `createNationalPropertyRecordsReader()` / `createDataOperationsAdapter()`.
 */

/** Default owned source table the property-harvest jobs import into. */
export const DEFAULT_DATA_SOURCE = 'national_property_records';
/** Versioned mapping / quality-gate identity recorded on every receipt. */
export const DATA_OPERATIONS_MAPPING_VERSION = 'property-harvest.records.v1';
export const DEFAULT_SLICE_LIMIT = 500;
export const MAX_SLICE_LIMIT = 5000;
const MAX_REJECT_SAMPLES = 50;
const SAFE_SOURCE = /^[a-z_][a-z0-9_]*$/;

/** A single row a checkpointed read returned, already tagged by the quality gate. */
export interface DataSliceRow {
  /** Monotonic checkpoint key (primary-key id). The cursor advances past this value. */
  checkpoint: number;
  /** True when the row passed the versioned quality gate at read time. */
  accepted: boolean;
  /** Machine-readable reason present only when `accepted === false`. */
  rejectReason?: string;
}

/** One read-only page of a checkpointed slice over an owned source. */
export interface DataSourceSlice {
  /** Logical source identifier actually read (e.g. `national_property_records`). */
  source: string;
  /** Rows read in this slice, ascending by checkpoint. */
  rows: DataSliceRow[];
  /** Highest checkpoint that currently exists in the source (range ceiling); null when unknown/empty. */
  sourceCeiling: number | null;
  /**
   * Independent, read-only readback: number of accepted rows the source re-confirms
   * present in (afterCheckpoint, throughCheckpoint]. Proves the slice is real and
   * stable rather than a returned literal. Must equal the counted accepted rows.
   */
  readbackAcceptedCount: number;
}

export interface DataSliceRequest {
  source: string;
  /** Read rows whose checkpoint is strictly greater than this value. */
  afterCheckpoint: number;
  /** Maximum rows to read in this slice. */
  limit: number;
}

/** Injected, READ-ONLY access to the owned data source. Production wires psql; tests supply a deterministic fn. */
export type DataSourceReader = (request: DataSliceRequest) => Promise<DataSourceSlice>;

export interface DataOperationsAdapterOptions {
  /** Read-only source accessor. When null/omitted the adapter is `'declared'` and cannot execute. */
  reader?: DataSourceReader | null;
  /** Source used when the run input does not name one. */
  defaultSource?: string;
  /** Slice size used when the run input does not request one. */
  defaultLimit?: number;
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SLICE_LIMIT;
  const int = Math.floor(value);
  if (int < 1) return 1;
  if (int > MAX_SLICE_LIMIT) return MAX_SLICE_LIMIT;
  return int;
}

function coerceRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function toCheckpoint(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return fallback;
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return fallback;
}

interface ResolvedSliceParams {
  source: string;
  afterCheckpoint: number;
  limit: number;
}

/** Defensive: run input is `unknown`; extract only an integer cursor / limit / allowlisted source. */
function resolveSliceParams(input: unknown, defaultSource: string, defaultLimit: number): ResolvedSliceParams {
  const record = coerceRecord(input);
  const requestedSource = record.source;
  const source =
    typeof requestedSource === 'string' && SAFE_SOURCE.test(requestedSource) ? requestedSource : defaultSource;
  const afterCheckpoint = toCheckpoint(record.checkpoint ?? record.afterCheckpoint ?? record.cursor, 0);
  const limit = clampLimit(toNumber(record.limit ?? record.sliceSize, defaultLimit));
  return { source, afterCheckpoint, limit };
}

export class DataOperationsAdapter implements ServiceFoundationAdapter {
  readonly serviceId = 'data-operations-service';
  readonly capabilityId = 'client_ops.data.execute_job';
  readonly ownedSourceIdentifier = 'BlackLabelPropertyHarvest.jobs';

  private readonly reader: DataSourceReader | null;
  private readonly defaultSource: string;
  private readonly defaultLimit: number;

  /** Accepts a reader function directly, or an options object carrying the reader dep. */
  constructor(options: DataOperationsAdapterOptions | DataSourceReader = {}) {
    const opts: DataOperationsAdapterOptions = typeof options === 'function' ? { reader: options } : options;
    this.reader = opts.reader ?? null;
    this.defaultSource = opts.defaultSource ?? DEFAULT_DATA_SOURCE;
    this.defaultLimit = clampLimit(opts.defaultLimit ?? DEFAULT_SLICE_LIMIT);
  }

  /** Ready only when a real source reader is wired; otherwise 'declared' (never fabricate). */
  readiness(): FoundationAdapterReadiness {
    return this.reader ? 'ready' : 'declared';
  }

  async invoke(request: FoundationInvocationRequest): Promise<FoundationInvocationResult> {
    const params = resolveSliceParams(request.input, this.defaultSource, this.defaultLimit);
    const invocationId = `data-job-${request.runId}-${request.actionType}-after${params.afterCheckpoint}`;

    if (!this.reader) {
      // Declared-only: cannot reach a real source ⇒ fail honestly, never invent counts.
      return {
        invocationId,
        status: 'failed',
        output: {
          source: params.source,
          readOnly: true,
          error:
            'data-operations-service adapter has no data source reader wired (readiness=declared); refusing to invent counts',
        },
        externalReferences: [],
      };
    }

    let slice: DataSourceSlice;
    try {
      slice = await this.reader({
        source: params.source,
        afterCheckpoint: params.afterCheckpoint,
        limit: params.limit,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        invocationId,
        status: 'failed',
        output: {
          source: params.source,
          afterCheckpoint: params.afterCheckpoint,
          readOnly: true,
          error: `source read failed: ${message}`,
        },
        externalReferences: [],
      };
    }

    const acceptedRows = slice.rows.filter((row) => row.accepted);
    const rejectedRows = slice.rows.filter((row) => !row.accepted);
    const acceptedCount = acceptedRows.length;
    const rejectedCount = rejectedRows.length;

    const throughCheckpoint =
      slice.rows.length > 0
        ? slice.rows.reduce((max, row) => (row.checkpoint > max ? row.checkpoint : max), params.afterCheckpoint)
        : params.afterCheckpoint;

    const readbackMatches = slice.readbackAcceptedCount === acceptedCount;
    if (!readbackMatches) {
      // Destination/source readback disagrees with the counted accepted rows: a receipt
      // with an unverifiable count is exactly the vapor we forbid. Do NOT claim success.
      return {
        invocationId,
        status: 'failed',
        output: {
          source: params.source,
          readOnly: true,
          sourceRange: {
            afterCheckpoint: params.afterCheckpoint,
            throughCheckpoint,
            sourceCeiling: slice.sourceCeiling,
          },
          accepted: acceptedCount,
          destinationReadback: { confirmedAccepted: slice.readbackAcceptedCount, matchesAccepted: false },
          error: `destination readback mismatch: counted ${acceptedCount} accepted but source re-confirmed ${slice.readbackAcceptedCount}`,
        },
        externalReferences: [],
      };
    }

    const exhausted =
      slice.sourceCeiling !== null ? throughCheckpoint >= slice.sourceCeiling : slice.rows.length < params.limit;

    const output = {
      source: params.source,
      ownedSourceIdentifier: this.ownedSourceIdentifier,
      mappingVersion: DATA_OPERATIONS_MAPPING_VERSION,
      readOnly: true as const,
      sourceRange: {
        afterCheckpoint: params.afterCheckpoint,
        throughCheckpoint,
        sourceCeiling: slice.sourceCeiling,
        sliceSize: slice.rows.length,
        requestedLimit: params.limit,
      },
      accepted: acceptedCount,
      rejected: rejectedCount,
      rejects: rejectedRows
        .slice(0, MAX_REJECT_SAMPLES)
        .map((row) => ({ checkpoint: row.checkpoint, reason: row.rejectReason ?? 'unspecified' })),
      destinationReadback: {
        confirmedAccepted: slice.readbackAcceptedCount,
        matchesAccepted: true,
      },
      nextCheckpoint: throughCheckpoint,
      exhausted,
    };

    return {
      invocationId,
      status: 'completed',
      output,
      externalReferences: [
        `blacklabel://${this.ownedSourceIdentifier}/${params.source}?after=${params.afterCheckpoint}&through=${throughCheckpoint}`,
        `client-ops://data-ops/${params.source}/checkpoint/${throughCheckpoint}`,
      ],
    };
  }

  async verify(request: FoundationVerificationRequest): Promise<FoundationVerificationResult> {
    const checkedAt = new Date().toISOString();
    if (!this.reader) {
      return {
        verified: false,
        evidence: { reason: 'no data source reader wired', invocationId: request.invocationId },
        checkedAt,
      };
    }

    const expected = coerceRecord(request.expected);
    const source =
      typeof expected.source === 'string' && SAFE_SOURCE.test(expected.source) ? expected.source : this.defaultSource;
    const afterCheckpoint = toCheckpoint(expected.afterCheckpoint, 0);
    const throughCheckpoint = toCheckpoint(expected.nextCheckpoint ?? expected.throughCheckpoint, afterCheckpoint);
    const span = throughCheckpoint - afterCheckpoint;
    const limit = clampLimit(span > 0 ? span : this.defaultLimit);

    try {
      const slice = await this.reader({ source, afterCheckpoint, limit });
      const acceptedNow = slice.rows.filter((row) => row.accepted && row.checkpoint <= throughCheckpoint).length;
      const readbackConsistent = slice.readbackAcceptedCount === acceptedNow;
      const expectedAccepted = expected.accepted;
      const matchesExpectation = typeof expectedAccepted === 'number' ? expectedAccepted === acceptedNow : true;
      return {
        verified: readbackConsistent && matchesExpectation,
        evidence: {
          source,
          afterCheckpoint,
          throughCheckpoint,
          acceptedNow,
          readbackAcceptedCount: slice.readbackAcceptedCount,
          expectedAccepted: typeof expectedAccepted === 'number' ? expectedAccepted : null,
          readOnly: true,
        },
        checkedAt,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { verified: false, evidence: { source, afterCheckpoint, error: message }, checkedAt };
    }
  }
}

/** Options for the production psql-backed reader over the owned property-records source. */
export interface NationalPropertyRecordsReaderOptions {
  /** psql database name. Default `blacklabel`. */
  db?: string;
  /** psql host (unix socket dir or hostname). Default `/tmp`. */
  host?: string;
  /** psql port. Default `5433`. */
  port?: number;
  /** psql binary. Default `psql` (resolved on PATH). */
  psqlBin?: string;
  /** Allowlisted source tables the reader may query. Default `[DEFAULT_DATA_SOURCE]`. */
  allowedSources?: string[];
  /** Per-query timeout in ms. Default 20000. */
  timeoutMs?: number;
}

/**
 * Production reader: a real, READ-ONLY, checkpointed slice over the owned
 * `national_property_records` table on psql :5433 (db `blacklabel`) — the imported
 * payload of the `BlackLabelPropertyHarvest.jobs` (`harvest_runs`) ledger.
 *
 * Quality gate (versioned mapping `property-harvest.records.v1`): a record is
 * ACCEPTED iff it has a non-empty `parcel_id` and is not suppressed; otherwise it is
 * REJECTED with reason `missing_parcel_id` or `suppressed`. Only SELECTs run — no
 * writes, deletes, or DDL. Cursor and limit are integer-validated and the source
 * table is allowlisted and shape-checked, so no untrusted string reaches the SQL.
 */
export function createNationalPropertyRecordsReader(
  options: NationalPropertyRecordsReaderOptions = {},
): DataSourceReader {
  const db = options.db ?? 'blacklabel';
  const host = options.host ?? '/tmp';
  const port = options.port ?? 5433;
  const psqlBin = options.psqlBin ?? 'psql';
  const timeoutMs = options.timeoutMs ?? 20000;
  const allowed = new Set(options.allowedSources ?? [DEFAULT_DATA_SOURCE]);

  return async ({ source, afterCheckpoint, limit }) => {
    if (!SAFE_SOURCE.test(source) || !allowed.has(source)) {
      throw new Error(`source not allowlisted for read: ${source}`);
    }
    const after = Math.max(0, Math.floor(afterCheckpoint));
    const lim = clampLimit(limit);

    // Lazy-load node builtins so merely importing the adapter class stays runtime-neutral.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);

    const psql = async (sql: string): Promise<string> => {
      const { stdout } = await run(psqlBin, ['-h', host, '-p', String(port), '-d', db, '-tAc', sql], {
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      });
      return stdout;
    };

    const gate = "parcel_id IS NOT NULL AND parcel_id <> '' AND NOT is_suppressed";
    const sliceSql =
      `SELECT id, (${gate}) AS accepted, ` +
      "CASE WHEN parcel_id IS NULL OR parcel_id = '' THEN 'missing_parcel_id' " +
      "WHEN is_suppressed THEN 'suppressed' ELSE '' END AS reason " +
      `FROM ${source} WHERE id > ${after} ORDER BY id ASC LIMIT ${lim}`;
    const rows = parsePsqlSliceRows(await psql(sliceSql));

    const throughCheckpoint = rows.length > 0 ? rows[rows.length - 1].checkpoint : after;

    const ceilingRaw = (await psql(`SELECT max(id) FROM ${source}`)).trim();
    const sourceCeiling = /^\d+$/.test(ceilingRaw) ? Number.parseInt(ceilingRaw, 10) : null;

    const readbackRaw = (
      await psql(`SELECT count(*) FROM ${source} WHERE id > ${after} AND id <= ${throughCheckpoint} AND ${gate}`)
    ).trim();
    const readbackAcceptedCount = /^\d+$/.test(readbackRaw) ? Number.parseInt(readbackRaw, 10) : 0;

    return { source, rows, sourceCeiling, readbackAcceptedCount };
  };
}

/** Parse `psql -tAc` pipe-delimited output (`id|accepted|reason`) into tagged slice rows. */
function parsePsqlSliceRows(stdout: string): DataSliceRow[] {
  const out: DataSliceRow[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const parts = trimmed.split('|');
    const idPart = parts[0];
    if (!/^\d+$/.test(idPart)) continue;
    const accepted = parts[1] === 't';
    const row: DataSliceRow = { checkpoint: Number.parseInt(idPart, 10), accepted };
    if (!accepted) row.rejectReason = parts[2] && parts[2] !== '' ? parts[2] : 'rejected';
    out.push(row);
  }
  return out;
}

/**
 * Production convenience: a ready `DataOperationsAdapter` wired to the real psql
 * property-records source. Register the result in a `ServiceFoundationRegistry`
 * where the data-operations-service should actually execute.
 */
export function createDataOperationsAdapter(options: NationalPropertyRecordsReaderOptions = {}): DataOperationsAdapter {
  return new DataOperationsAdapter({
    reader: createNationalPropertyRecordsReader(options),
    defaultSource: options.allowedSources?.[0] ?? DEFAULT_DATA_SOURCE,
  });
}
