/**
 * Row types for the core tables. All modules extend this map:
 *
 *   export interface CrmDatabase extends CoreDatabase {
 *     crm_leads: CrmLeadRow;
 *   }
 *
 * Conventions (see /CONVENTIONS.md):
 * - ids: TEXT, nanoid, generated in code via id()
 * - timestamps: TEXT, ISO-8601 UTC via nowIso()
 * - booleans: INTEGER 0/1
 * - money: INTEGER cents
 */

export type UserRole = 'owner' | 'admin' | 'member';

export type CustomFieldKind = 'text' | 'number' | 'boolean' | 'date' | 'select';

export interface TenantRow {
  id: string;
  name: string;
  created_at: string;
}

export interface UserRow {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  role: UserRole;
  created_at: string;
}

export interface AuditLogRow {
  id: string;
  tenant_id: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
  /** JSON-serialized diff/context, or null. */
  diff: string | null;
  created_at: string;
}

export interface CustomFieldDefinitionRow {
  id: string;
  tenant_id: string;
  /** Entity the field attaches to, e.g. "crm.lead", "billing.invoice". */
  entity_type: string;
  /** Machine key, /^[a-z][a-z0-9_]*$/, unique per (tenant, entity_type). */
  key: string;
  label: string;
  kind: CustomFieldKind;
  created_at: string;
}

export interface CoreDatabase {
  tenants: TenantRow;
  users: UserRow;
  audit_log: AuditLogRow;
  custom_field_definitions: CustomFieldDefinitionRow;
}
