import type { Kysely } from 'kysely';
import { id, nowIso } from './helpers';
import type { AuditLogRow, CoreDatabase } from './schema';

/**
 * Append an audit log entry. Call this from every mutating service
 * operation, AFTER the write succeeds.
 *
 * - actor: user id, or "system" / "workflow:<id>" for machine actors
 * - action: "<module>.<entity>.<verb>" (same shape as event names)
 * - diff: any JSON-serializable value (stored as TEXT), e.g. { before, after }
 */
export async function audit(
  db: Kysely<CoreDatabase>,
  tenantId: string,
  actor: string,
  action: string,
  entityType: string,
  entityId: string,
  diff?: unknown,
): Promise<AuditLogRow> {
  const row: AuditLogRow = {
    id: id(),
    tenant_id: tenantId,
    actor,
    action,
    entity_type: entityType,
    entity_id: entityId,
    diff: diff === undefined ? null : JSON.stringify(diff),
    created_at: nowIso(),
  };
  await db.insertInto('audit_log').values(row).execute();
  return row;
}

/** Read audit entries for one entity, newest first. */
export async function listAuditEntries(
  db: Kysely<CoreDatabase>,
  tenantId: string,
  entityType: string,
  entityId: string,
): Promise<AuditLogRow[]> {
  return db
    .selectFrom('audit_log')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('entity_type', '=', entityType)
    .where('entity_id', '=', entityId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
}
