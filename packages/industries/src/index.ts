/**
 * @blacklabel/industries — configuration-first industry support.
 *
 * A new industry = ONE config file in src/configs/ — zero forked code.
 * See README.md for the config format, table contracts, and REST API.
 *
 * Events emitted by this module (module.entity.verb):
 *   - `industries.industry.applied`  payload: { industryKey }
 */

// Migrations
export { industriesMigrations } from './migrations';

// Router factory
export { industriesRouter } from './router';

// Config format: schema, loader, typed error, terminology helpers
export {
  CORE_TERMS,
  IndustryConfigError,
  industryConfigSchema,
  parseIndustryConfig,
  termFor,
  validateIndustryConfig,
} from './config';
export type {
  ConfigViolation,
  CoreTerm,
  IndustryAppointmentType,
  IndustryConfig,
  IndustryDashboardWidget,
  IndustryLeadStage,
  IndustryQuoteTemplate,
  IndustryTemplateLine,
  IndustryWorkflow,
  IndustryWorkflowAction,
} from './config';

// Registry of shipped configs
export { getIndustryConfig, listIndustries } from './registry';
export type { IndustrySummary } from './registry';

// Service
export { applyIndustry, getAppliedIndustry, getTerminology } from './service';
export type {
  AppliedAppointmentType,
  AppliedDashboardWidget,
  AppliedIndustry,
  AppliedLeadStage,
  AppliedQuoteTemplate,
  AppliedWorkflow,
  ApplyIndustryOptions,
} from './service';

// Seed helper
export { seedIndustries } from './seed';

// Row types + database map
export type {
  IndustriesAppointmentTypeRow,
  IndustriesDashboardWidgetRow,
  IndustriesDatabase,
  IndustriesLeadStageRow,
  IndustriesQuoteTemplateRow,
  IndustriesTenantSettingsRow,
  IndustriesWorkflowDefinitionRow,
} from './schema';
