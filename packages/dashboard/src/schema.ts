import type { CoreDatabase } from '@blacklabel/core';

/**
 * Dashboard module schema.
 *
 * OWNED TABLES (created by dashboardMigrations):
 *   - dashboard_widget_configs  per-tenant widget layout/settings
 *   - dashboard_alert_rules     metric threshold alert rules
 *
 * CROSS-MODULE READ CONTRACTS:
 * The dashboard is THE ONE package allowed to read across other modules'
 * tables (see /CONVENTIONS.md §9), and it is strictly READ-ONLY over them —
 * aggregation SELECTs only, never insert/update/delete, never a migration
 * that touches them. The `*ReadRow` interfaces below document the MINIMUM
 * column contract the dashboard depends on; the owning modules may (and do)
 * have more columns. If a source table or column does not exist yet (module
 * not migrated/installed), every aggregation degrades gracefully by
 * reporting `available: false` with zeroed data instead of erroring.
 */

/* ------------------------------------------------------------------ *
 * Owned tables
 * ------------------------------------------------------------------ */

export interface DashboardWidgetConfigRow {
  id: string;
  tenant_id: string;
  /** One of the WIDGET_CATALOG keys, e.g. "revenue", "leads_by_source". */
  widget_key: string;
  /** 0-based display order. */
  position: number;
  /** boolean as integer 0/1. */
  enabled: number;
  /** JSON-serialized widget settings object. */
  settings: string;
  created_at: string;
  updated_at: string;
}

export type AlertDirection = 'above' | 'below';

export interface DashboardAlertRuleRow {
  id: string;
  tenant_id: string;
  name: string;
  /** A KPI key from KPI_DEFINITIONS, e.g. "revenue_cents", "open_tasks". */
  metric: string;
  /** Numeric threshold in the metric's unit (cents, count, bps, ...). */
  threshold: number;
  /** 'above' → triggered when value > threshold; 'below' → value < threshold. */
  direction: string;
  /** boolean as integer 0/1. */
  enabled: number;
  created_at: string;
  updated_at: string;
}

/* ------------------------------------------------------------------ *
 * Cross-module read contracts (read-only, minimum columns)
 * ------------------------------------------------------------------ */

/** billing: revenue summary. Paid revenue = SUM(total_cents) WHERE status='paid'. */
export interface BillingInvoiceReadRow {
  id: string;
  tenant_id: string;
  status: string;
  total_cents: number;
  created_at: string;
}

/** crm: source attribution. NULL/empty source is reported as "unknown". */
export interface CrmLeadReadRow {
  id: string;
  tenant_id: string;
  source: string | null;
  created_at: string;
}

/** scheduling: appointment/job counts by status. */
export interface SchedulingAppointmentReadRow {
  id: string;
  tenant_id: string;
  status: string;
  created_at: string;
}

/** quoting: conversion = approved-ish / sent-ish (see KPI formulas in README). */
export interface QuotingQuoteReadRow {
  id: string;
  tenant_id: string;
  status: string;
  created_at: string;
}

/** workflows: open tasks = status NOT IN the closed set (see README). */
export interface WorkflowsTaskReadRow {
  id: string;
  tenant_id: string;
  status: string;
  created_at: string;
}

/** portal-employee: time entries; minutes computed in code from clock in/out. */
export interface PortalEmployeeTimeEntryReadRow {
  id: string;
  tenant_id: string;
  employee_id: string;
  clock_in_at: string;
  /** Null while the entry is open (clocked in, not yet out). */
  clock_out_at: string | null;
  created_at: string;
}

/** portal-employee: work logs (notes/status updates on assignments). */
export interface PortalEmployeeWorkLogReadRow {
  id: string;
  tenant_id: string;
  employee_id: string;
  created_at: string;
}

/** reviews: submitted review responses (count, average, 1..5 distribution). */
export interface ReviewsResponseReadRow {
  id: string;
  tenant_id: string;
  rating: number;
  created_at: string;
}

/** retail: imported POS payments (owner dashboard sales analytics). */
export interface RetailPaymentReadRow {
  id: string;
  tenant_id: string;
  paid_at: string;
  status: string;
  amount_cents: number;
  fee_cents: number | null;
  customer_source_id: string | null;
  order_source_id: string | null;
}

/** retail: imported POS order lines (top items/categories). */
export interface RetailOrderLineReadRow {
  id: string;
  tenant_id: string;
  source_order_id: string;
  name: string;
  quantity: number;
  total_cents: number;
  category_name: string | null;
}

/** retail: imported POS refunds. */
export interface RetailRefundReadRow {
  id: string;
  tenant_id: string;
  refunded_at: string;
  status: string;
  amount_cents: number;
}

/** retail: append-only import-run ledger (data-freshness panel). */
export interface RetailImportRunReadRow {
  id: string;
  tenant_id: string;
  source: string;
  finished_at: string;
  payments_inserted: number;
  lines_inserted: number;
  refunds_inserted: number;
  completed_gross_cents_after: number;
  created_at: string;
}

/** crm: customer contact coverage (email/phone presence KPIs). */
export interface CrmCustomerReadRow {
  id: string;
  tenant_id: string;
  email: string | null;
  phone: string | null;
  created_at: string;
}

/**
 * inventory: stock levels. The inventory module does not exist yet — this
 * contract lets the owner dashboard degrade to an honest "not yet counted"
 * state via safeRead until it ships.
 */
export interface InventoryStockLevelReadRow {
  id: string;
  tenant_id: string;
  on_hand: number;
  updated_at: string;
}

/* ------------------------------------------------------------------ *
 * Database map
 * ------------------------------------------------------------------ */

export interface DashboardDatabase extends CoreDatabase {
  // owned
  dashboard_widget_configs: DashboardWidgetConfigRow;
  dashboard_alert_rules: DashboardAlertRuleRow;
  // cross-module read contracts (read-only)
  billing_invoices: BillingInvoiceReadRow;
  crm_leads: CrmLeadReadRow;
  scheduling_appointments: SchedulingAppointmentReadRow;
  quoting_quotes: QuotingQuoteReadRow;
  workflows_tasks: WorkflowsTaskReadRow;
  portal_employee_time_entries: PortalEmployeeTimeEntryReadRow;
  portal_employee_work_logs: PortalEmployeeWorkLogReadRow;
  reviews_responses: ReviewsResponseReadRow;
  retail_payments: RetailPaymentReadRow;
  retail_order_lines: RetailOrderLineReadRow;
  retail_refunds: RetailRefundReadRow;
  retail_import_runs: RetailImportRunReadRow;
  crm_customers: CrmCustomerReadRow;
  inventory_stock_levels: InventoryStockLevelReadRow;
}
