/**
 * @blacklabel/dashboard — Owner Dashboard / Analytics module.
 *
 * The ONE package allowed to read across other modules' tables
 * (/CONVENTIONS.md §9) — strictly read-only aggregation SELECTs. Owns only
 * `dashboard_widget_configs` and `dashboard_alert_rules`.
 *
 * Module-internal events emitted (all `dashboard.*`, per §8 naming rules):
 *   - `dashboard.config.updated`   { widgetKeys: string[] | null, reset?: true }
 *   - `dashboard.alert.created`    { alertId, metric }
 *   - `dashboard.alert.updated`    { alertId }
 *   - `dashboard.alert.deleted`    { alertId }
 *   - `dashboard.alert.triggered`  { alertId, metric, value, threshold, direction }
 */

// Migrations
export { dashboardMigrations } from './migrations';

// Router factory
export { dashboardRouter } from './router';

// Seed helper
export { seedDashboard } from './seed';

// Public catalog/constants (so UIs & the api app can enumerate widgets/KPIs)
export {
  WIDGET_CATALOG,
  WIDGET_KEYS,
  KPI_DEFINITIONS,
  METRIC_KEYS,
  CLOSED_TASK_STATUSES,
  APPROVED_QUOTE_STATUSES,
} from './service';

// Owner dashboard (retail sales analytics + deterministic forecast)
export { collectOwnerDashboardData } from './owner';
export { renderOwnerDashboardPage } from './owner-html';
export type {
  OwnerDashboardData,
  OwnerForecast,
  OwnerWeekPoint,
  OwnerMoneyStat,
  OwnerForecastBacktestWeek,
} from './owner';

// Public types
export type {
  DashboardDatabase,
  DashboardWidgetConfigRow,
  DashboardAlertRuleRow,
  AlertDirection,
  BillingInvoiceReadRow,
  CrmLeadReadRow,
  SchedulingAppointmentReadRow,
  QuotingQuoteReadRow,
  WorkflowsTaskReadRow,
  PortalEmployeeTimeEntryReadRow,
  PortalEmployeeWorkLogReadRow,
  ReviewsResponseReadRow,
  RetailPaymentReadRow,
  RetailOrderLineReadRow,
  RetailRefundReadRow,
  RetailImportRunReadRow,
  CrmCustomerReadRow,
  InventoryStockLevelReadRow,
} from './schema';
export type {
  DateRange,
  WidgetDefinition,
  KpiDefinition,
  KpiUnit,
  RevenueSummary,
  LeadsBySource,
  AppointmentsSummary,
  QuoteConversion,
  OpenTasksSummary,
  EmployeeActivity,
  ReviewsSummary,
  WebsiteTrafficPlaceholder,
  CampaignPerformancePlaceholder,
  ActivityEntry,
  MetricValue,
  ExportSummary,
  ExportMetricRow,
  EffectiveWidget,
  WidgetConfiguration,
  WidgetConfigInput,
  AlertRule,
  AlertRuleInput,
  AlertRulePatch,
  AlertEvaluation,
  DashboardPageData,
} from './service';
