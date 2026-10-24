import type { CoreDatabase } from '@blacklabel/core';

/**
 * Row types for the industries module tables.
 *
 * These tables hold the *applied* industry defaults for a tenant — the
 * materialized output of `applyIndustry(db, tenantId, industryKey)`. They are
 * the documented table contracts other layers (UIs, apps/api) read through
 * the industries REST endpoints. See README.md ("Table contracts").
 *
 * Conventions (see /CONVENTIONS.md):
 * - ids: TEXT, nanoid, generated in code via id()
 * - timestamps: TEXT, ISO-8601 UTC via nowIso()
 * - booleans: INTEGER 0/1
 * - money: INTEGER cents
 * - JSON: serialized TEXT
 */

/** One row per tenant: which industry is applied + the terminology map. */
export interface IndustriesTenantSettingsRow {
  id: string;
  tenant_id: string;
  /** Key of the applied industry config, e.g. "window-cleaning". */
  industry_key: string;
  /** JSON object: core-term -> display-term (e.g. {"job":"Matter"}). */
  terminology: string;
  /** ISO-8601 UTC — when the industry was (last) applied. */
  applied_at: string;
  created_at: string;
}

/** Default CRM lead pipeline stages for the tenant, ordered by sort_order. */
export interface IndustriesLeadStageRow {
  id: string;
  tenant_id: string;
  /** Stable machine key, unique per tenant (e.g. "quoted"). */
  key: string;
  label: string;
  sort_order: number;
  created_at: string;
}

/** Default quote/service templates. `lines` is JSON (integer-cent money). */
export interface IndustriesQuoteTemplateRow {
  id: string;
  tenant_id: string;
  key: string;
  name: string;
  description: string | null;
  /** JSON array: [{ description, quantity, unitPriceCents }]. */
  lines: string;
  created_at: string;
}

/** Default appointment types (durations in whole minutes). */
export interface IndustriesAppointmentTypeRow {
  id: string;
  tenant_id: string;
  key: string;
  label: string;
  duration_minutes: number;
  description: string | null;
  created_at: string;
}

/** Default dashboard widget set, ordered by sort_order. */
export interface IndustriesDashboardWidgetRow {
  id: string;
  tenant_id: string;
  key: string;
  title: string;
  /** Widget kind: "metric" | "list" | "chart" | "feed". */
  widget_type: string;
  /** JSON object of widget-specific config, or null. */
  config: string | null;
  sort_order: number;
  created_at: string;
}

/** Default workflow automations (workflow-definition JSON). */
export interface IndustriesWorkflowDefinitionRow {
  id: string;
  tenant_id: string;
  key: string;
  name: string;
  /** Triggering platform event, `module.entity.verb`. */
  trigger: string;
  /** Full workflow-definition JSON: { key, name, trigger, actions }. */
  definition: string;
  /** Boolean 0/1. */
  enabled: number;
  created_at: string;
}

export interface IndustriesDatabase extends CoreDatabase {
  industries_runtime_receipts: {
    id: string; tenant_id: string; industry_key: string; component_key: string;
    target_type: string; target_id: string | null; href: string; status: string;
    detail: string; snapshot_json: string; created_at: string; updated_at: string;
  };
  industries_tenant_settings: IndustriesTenantSettingsRow;
  industries_lead_stages: IndustriesLeadStageRow;
  industries_quote_templates: IndustriesQuoteTemplateRow;
  industries_appointment_types: IndustriesAppointmentTypeRow;
  industries_dashboard_widgets: IndustriesDashboardWidgetRow;
  industries_workflow_definitions: IndustriesWorkflowDefinitionRow;
}
