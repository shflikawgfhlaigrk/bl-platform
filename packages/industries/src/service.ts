import type { Kysely } from 'kysely';
import { ApiError, asCoreDb, audit, id, nowIso, type Contracts, type EventBus } from '@blacklabel/core';
import type {
  IndustryConfig,
  IndustryTemplateLine,
  IndustryWorkflow,
} from './config';
import { getIndustryConfig } from './registry';
import type { IndustriesDatabase } from './schema';
import { industryRuntimeReport, type IndustryRuntimeInstaller, type IndustryRuntimeReport } from './runtime';

/**
 * Tenant-scoped industry application logic.
 *
 * `applyIndustry` is idempotent and safe to re-run: rows are keyed by
 * (tenant_id, key); re-applying the same industry updates in place (ids are
 * stable), and switching industries removes defaults that are not part of
 * the new config.
 */

export interface AppliedLeadStage {
  id: string;
  key: string;
  label: string;
  sortOrder: number;
}

export interface AppliedQuoteTemplate {
  id: string;
  key: string;
  name: string;
  description: string | null;
  lines: IndustryTemplateLine[];
}

export interface AppliedAppointmentType {
  id: string;
  key: string;
  label: string;
  durationMinutes: number;
  description: string | null;
}

export interface AppliedDashboardWidget {
  id: string;
  key: string;
  title: string;
  type: string;
  config: Record<string, unknown> | null;
  sortOrder: number;
}

export interface AppliedWorkflow {
  id: string;
  key: string;
  name: string;
  trigger: string;
  definition: IndustryWorkflow;
  enabled: boolean;
}

/** The materialized industry state for a tenant. */
export interface AppliedIndustry {
  runtime: IndustryRuntimeReport;
  industryKey: string;
  appliedAt: string;
  terminology: Record<string, string>;
  leadStages: AppliedLeadStage[];
  quoteTemplates: AppliedQuoteTemplate[];
  appointmentTypes: AppliedAppointmentType[];
  dashboardWidgets: AppliedDashboardWidget[];
  workflows: AppliedWorkflow[];
}

export interface ApplyIndustryOptions {
  /** Actual module provisioning supplied by the composition root, with per-component receipts. */
  installRuntime?: IndustryRuntimeInstaller;
  /** Emits `industries.industry.applied` after the write when provided. */
  events?: EventBus;
  /** Audit actor — a user id or "system" (default). */
  actor?: string;
  /**
   * Cross-module contracts. When `createAppointmentType` is wired, applying an
   * industry also provisions real bookable scheduling_appointment_types from
   * the industry's appointment defaults (idempotent). Absent it, only the
   * industries_appointment_types read-model is written (back-compat).
   */
  contracts?: Contracts;
}

/**
 * Reconcile one `industries_*` table with the desired default rows for a
 * tenant. Rows are matched by `key`: existing rows are updated in place
 * (stable ids), missing rows are inserted, stale rows (from a previously
 * applied industry) are deleted. Every statement filters by tenant_id.
 */
async function syncKeyedTable(
  trx: Kysely<any>,
  table: string,
  tenantId: string,
  desired: Array<{ key: string } & Record<string, unknown>>,
): Promise<void> {
  const existing: Array<{ id: string; key: string }> = await trx
    .selectFrom(table)
    .select(['id', 'key'])
    .where('tenant_id', '=', tenantId)
    .execute();

  const desiredKeys = new Set(desired.map((item) => item.key));
  const staleIds = existing.filter((row) => !desiredKeys.has(row.key)).map((row) => row.id);
  if (staleIds.length > 0) {
    await trx
      .deleteFrom(table)
      .where('tenant_id', '=', tenantId)
      .where('id', 'in', staleIds)
      .execute();
  }

  const idByKey = new Map(existing.map((row) => [row.key, row.id]));
  for (const item of desired) {
    const existingId = idByKey.get(item.key);
    if (existingId !== undefined) {
      await trx
        .updateTable(table)
        .set(item)
        .where('tenant_id', '=', tenantId)
        .where('id', '=', existingId)
        .execute();
    } else {
      await trx
        .insertInto(table)
        .values({ id: id(), tenant_id: tenantId, created_at: nowIso(), ...item })
        .execute();
    }
  }
}

/**
 * Seed a tenant with an industry's defaults. Idempotent (see module doc).
 * Emits `industries.industry.applied` when `options.events` is provided and
 * writes an audit entry for every application.
 */
async function applyIndustryOnce(
  db: Kysely<IndustriesDatabase>,
  tenantId: string,
  industryKey: string,
  options: ApplyIndustryOptions = {},
): Promise<AppliedIndustry> {
  const config = getIndustryConfig(industryKey);
  if (!config) {
    throw ApiError.notFound(`unknown industry: ${industryKey}`);
  }
  const actor = options.actor ?? 'system';
  const appliedAt = nowIso();
  let settingsId = '';
  let previousIndustryKey: string | undefined;

  await db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('industries_tenant_settings')
      .select(['id','industry_key'])
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    if (existing) {
      previousIndustryKey=existing.industry_key;
      settingsId = existing.id;
      await trx
        .updateTable('industries_tenant_settings')
        .set({
          industry_key: config.key,
          terminology: JSON.stringify(config.terminology),
          applied_at: appliedAt,
        })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', existing.id)
        .execute();
    } else {
      settingsId = id();
      await trx
        .insertInto('industries_tenant_settings')
        .values({
          id: settingsId,
          tenant_id: tenantId,
          industry_key: config.key,
          terminology: JSON.stringify(config.terminology),
          applied_at: appliedAt,
          created_at: nowIso(),
        })
        .execute();
    }

    const anyTrx = trx as Kysely<any>;
    await syncKeyedTable(
      anyTrx,
      'industries_lead_stages',
      tenantId,
      config.leadStages.map((stage, index) => ({
        key: stage.key,
        label: stage.label,
        sort_order: index,
      })),
    );
    await syncKeyedTable(
      anyTrx,
      'industries_quote_templates',
      tenantId,
      config.quoteTemplates.map((template) => ({
        key: template.key,
        name: template.name,
        description: template.description ?? null,
        lines: JSON.stringify(template.lines),
      })),
    );
    await syncKeyedTable(
      anyTrx,
      'industries_appointment_types',
      tenantId,
      config.appointmentTypes.map((type) => ({
        key: type.key,
        label: type.label,
        duration_minutes: type.durationMinutes,
        description: type.description ?? null,
      })),
    );
    await syncKeyedTable(
      anyTrx,
      'industries_dashboard_widgets',
      tenantId,
      config.dashboardWidgets.map((widget, index) => ({
        key: widget.key,
        title: widget.title,
        widget_type: widget.type,
        config: widget.config === undefined ? null : JSON.stringify(widget.config),
        sort_order: index,
      })),
    );
    await syncKeyedTable(
      anyTrx,
      'industries_workflow_definitions',
      tenantId,
      config.workflows.map((workflow) => ({
        key: workflow.key,
        name: workflow.name,
        trigger: workflow.trigger,
        definition: JSON.stringify(workflow),
        enabled: 1,
      })),
    );
  });

  // Bridge to scheduling: turn the industry's appointment defaults into real
  // bookable appointment types (idempotent per name). Runs AFTER the industries
  // transaction commits so it never nests SQLite transactions. Best-effort:
  // scheduling being unwired (contract absent) leaves the read-model intact.
  const createType = options.contracts?.createAppointmentType;
  if (createType) {
    for (const type of config.appointmentTypes) {
      await createType.createAppointmentType({
        tenantId,
        name: type.label,
        durationMinutes: type.durationMinutes,
      });
    }
  }

  if(options.installRuntime)await options.installRuntime({tenantId,actor,config,previousIndustryKey});

  await audit(
    asCoreDb(db),
    tenantId,
    actor,
    'industries.industry.applied',
    'industries.industry',
    settingsId,
    { industryKey: config.key },
  );

  if (options.events) {
    await options.events.emit(tenantId, 'industries.industry.applied', {
      industryKey: config.key,
    });
  }

  const applied = await getAppliedIndustry(db, tenantId);
  // Just written inside this call — always present.
  return applied as AppliedIndustry;
}

const applications=new WeakMap<object,Set<string>>();
/** Concurrent applies fail explicitly instead of racing or duplicating module targets. */
export async function applyIndustry(db:Kysely<IndustriesDatabase>,tenantId:string,industryKey:string,options:ApplyIndustryOptions={}):Promise<AppliedIndustry>{
  let active=applications.get(db);if(!active){active=new Set();applications.set(db,active);}
  if(active.has(tenantId))throw ApiError.conflict('Industry setup is already being applied for this company.');
  active.add(tenantId);
  try{return await applyIndustryOnce(db,tenantId,industryKey,options);}finally{active.delete(tenantId);}
}

/** The applied industry state for a tenant, or undefined if none applied. */
export async function getAppliedIndustry(
  db: Kysely<IndustriesDatabase>,
  tenantId: string,
): Promise<AppliedIndustry | undefined> {
  const settings = await db
    .selectFrom('industries_tenant_settings')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
  if (!settings) return undefined;

  const stages = await db
    .selectFrom('industries_lead_stages')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('sort_order')
    .orderBy('id')
    .execute();
  const templates = await db
    .selectFrom('industries_quote_templates')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('key')
    .orderBy('id')
    .execute();
  const appointmentTypes = await db
    .selectFrom('industries_appointment_types')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('key')
    .orderBy('id')
    .execute();
  const widgets = await db
    .selectFrom('industries_dashboard_widgets')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('sort_order')
    .orderBy('id')
    .execute();
  const workflows = await db
    .selectFrom('industries_workflow_definitions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('key')
    .orderBy('id')
    .execute();

  return {
    runtime: await industryRuntimeReport(db,tenantId,settings.industry_key),
    industryKey: settings.industry_key,
    appliedAt: settings.applied_at,
    terminology: JSON.parse(settings.terminology) as Record<string, string>,
    leadStages: stages.map((row) => ({
      id: row.id,
      key: row.key,
      label: row.label,
      sortOrder: row.sort_order,
    })),
    quoteTemplates: templates.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      lines: JSON.parse(row.lines) as IndustryTemplateLine[],
    })),
    appointmentTypes: appointmentTypes.map((row) => ({
      id: row.id,
      key: row.key,
      label: row.label,
      durationMinutes: row.duration_minutes,
      description: row.description,
    })),
    dashboardWidgets: widgets.map((row) => ({
      id: row.id,
      key: row.key,
      title: row.title,
      type: row.widget_type,
      config: row.config === null ? null : (JSON.parse(row.config) as Record<string, unknown>),
      sortOrder: row.sort_order,
    })),
    workflows: workflows.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      trigger: row.trigger,
      definition: JSON.parse(row.definition) as IndustryWorkflow,
      enabled: row.enabled === 1,
    })),
  };
}

/**
 * The tenant's terminology map (core-term -> display-term), or undefined if
 * no industry has been applied.
 */
export async function getTerminology(
  db: Kysely<IndustriesDatabase>,
  tenantId: string,
): Promise<Record<string, string> | undefined> {
  const settings = await db
    .selectFrom('industries_tenant_settings')
    .select(['terminology'])
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
  if (!settings) return undefined;
  return JSON.parse(settings.terminology) as Record<string, string>;
}

export type { IndustryConfig };
