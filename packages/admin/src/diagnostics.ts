import type { Kysely } from 'kysely';
import { serializeCsv } from '@blacklabel/core';
import type { AdminDatabase } from './schema';
import { redact, type RedactOptions } from './redaction';

type Db = Kysely<AdminDatabase>;

/**
 * Inputs the integrator assembles for a diagnostic bundle. Everything is
 * OPTIONAL — the bundle degrades to what is available. NO credentials, ever;
 * settings are included as business identity (postal ok), which is public.
 */
export interface DiagnosticsInput {
  version: string;
  health?: unknown;
  /** Business identity settings — postal ok, but NEVER credentials. */
  settings?: unknown;
  /** Applied migration names. */
  migrations?: string[];
  /** Injected row counts per table, e.g. { admin_credentials: 3 }. */
  tableRowCounts?: Record<string, number>;
  /** Recent operator-facing errors (already trimmed by the caller). */
  recentErrors?: unknown[];
  /** Emails allowed through the redactor (e.g. business contact address). */
  emailAllowlist?: readonly string[];
}

export interface DiagnosticBundle {
  version: string;
  generatedAt: string;
  health: unknown;
  settings: unknown;
  migrations: string[];
  tableRowCounts: Record<string, number>;
  recentErrors: unknown[];
}

/**
 * Assemble a diagnostic bundle with an explicit REDACTION pass: secret-named
 * keys and email strings (outside the allowlist) are stripped recursively.
 * The bundle is safe to hand to a support engineer.
 */
export function assembleDiagnostics(input: DiagnosticsInput): DiagnosticBundle {
  const opts: RedactOptions = { emailAllowlist: input.emailAllowlist };
  // Only the sections that can carry arbitrary integrator data go through the
  // redactor. version/generatedAt/migrations/tableRowCounts are structurally
  // safe (string/timestamp/migration-names/integer counts) — redacting them
  // would wrongly strip e.g. the `admin_credentials` row COUNT (a non-secret
  // integer) just because its table-name key matches /credential/i.
  return {
    version: input.version,
    generatedAt: new Date().toISOString(),
    health: redact(input.health ?? null, opts),
    settings: redact(input.settings ?? null, opts),
    migrations: input.migrations ?? [],
    tableRowCounts: input.tableRowCounts ?? {},
    recentErrors: redact(input.recentErrors ?? [], opts),
  };
}

/* ------------------------------------------------------------------ *
 * Audit export — READ core's audit_log (never write it; writes go via
 * core's audit()). Core exports listAuditEntries (by entity) only, so for a
 * filtered actor/entity/date-range export we READ audit_log with a tenant-
 * scoped select. If core later exports a filtered helper, swap to it.
 * ------------------------------------------------------------------ */

export interface AuditExportFilters {
  actor?: string;
  entityType?: string;
  /** Inclusive ISO lower/upper bounds on created_at. */
  from?: string;
  to?: string;
}

export async function exportAuditCsv(
  db: Db,
  tenantId: string,
  filters: AuditExportFilters = {},
): Promise<string> {
  let q = db
    .selectFrom('audit_log')
    .select(['id', 'actor', 'action', 'entity_type', 'entity_id', 'created_at'])
    .where('tenant_id', '=', tenantId);
  if (filters.actor) q = q.where('actor', '=', filters.actor);
  if (filters.entityType) q = q.where('entity_type', '=', filters.entityType);
  if (filters.from) q = q.where('created_at', '>=', filters.from);
  if (filters.to) q = q.where('created_at', '<=', filters.to);
  const rows = await q.orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
  return serializeCsv(
    rows as unknown as Record<string, unknown>[],
    ['id', 'actor', 'action', 'entity_type', 'entity_id', 'created_at'],
  );
}
