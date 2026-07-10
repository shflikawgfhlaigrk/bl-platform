import type { Kysely } from 'kysely';
import { ApiError } from './errors';
import { id, nowIso } from './helpers';
import type { CoreDatabase, CustomFieldDefinitionRow, CustomFieldKind } from './schema';

export const CUSTOM_FIELD_KINDS: readonly CustomFieldKind[] = [
  'text',
  'number',
  'boolean',
  'date',
  'select',
];

const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Define a tenant-scoped custom field for an entity type (e.g. "crm.lead").
 * Modules store the VALUES themselves (recommended: a TEXT JSON `custom`
 * column keyed by definition key); core only owns the definitions.
 */
export async function defineCustomField(
  db: Kysely<CoreDatabase>,
  tenantId: string,
  input: { entityType: string; key: string; label: string; kind: CustomFieldKind },
): Promise<CustomFieldDefinitionRow> {
  if (!KEY_PATTERN.test(input.key)) {
    throw ApiError.badRequest(`invalid custom field key "${input.key}" (want ${KEY_PATTERN})`);
  }
  if (!CUSTOM_FIELD_KINDS.includes(input.kind)) {
    throw ApiError.badRequest(`invalid custom field kind "${input.kind}"`, {
      allowed: CUSTOM_FIELD_KINDS,
    });
  }
  if (!input.entityType || !input.label) {
    throw ApiError.badRequest('entityType and label are required');
  }
  const existing = await db
    .selectFrom('custom_field_definitions')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('entity_type', '=', input.entityType)
    .where('key', '=', input.key)
    .executeTakeFirst();
  if (existing) {
    throw ApiError.conflict(
      `custom field "${input.key}" already defined for ${input.entityType}`,
    );
  }
  const row: CustomFieldDefinitionRow = {
    id: id(),
    tenant_id: tenantId,
    entity_type: input.entityType,
    key: input.key,
    label: input.label,
    kind: input.kind,
    created_at: nowIso(),
  };
  await db.insertInto('custom_field_definitions').values(row).execute();
  return row;
}

export async function listCustomFields(
  db: Kysely<CoreDatabase>,
  tenantId: string,
  entityType?: string,
): Promise<CustomFieldDefinitionRow[]> {
  let qb = db
    .selectFrom('custom_field_definitions')
    .selectAll()
    .where('tenant_id', '=', tenantId);
  if (entityType !== undefined) {
    qb = qb.where('entity_type', '=', entityType);
  }
  return qb.orderBy('entity_type').orderBy('key').execute();
}

export async function deleteCustomField(
  db: Kysely<CoreDatabase>,
  tenantId: string,
  fieldId: string,
): Promise<void> {
  const result = await db
    .deleteFrom('custom_field_definitions')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', fieldId)
    .executeTakeFirst();
  if (result.numDeletedRows === 0n) {
    throw ApiError.notFound(`custom field not found: ${fieldId}`);
  }
}
