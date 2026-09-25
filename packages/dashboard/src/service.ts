import { DateTime } from 'luxon';
import type { Kysely } from 'kysely';
import {
  ApiError,
  asCoreDb,
  audit,
  id,
  nowIso,
  type EventBus,
} from '@blacklabel/core';
import type {
  AlertDirection,
  DashboardAlertRuleRow,
  DashboardDatabase,
  DashboardWidgetConfigRow,
} from './schema';

/* ================================================================== *
 * Widget catalog & KPI definitions
 * ================================================================== */

export interface WidgetDefinition {
  key: string;
  name: string;
  description: string;
  /** Router path of the widget's aggregation endpoint. */
  path: string;
  /** True for widgets that currently return a documented placeholder shape. */
  placeholder: boolean;
}

/** Default widget set, in default display order. Industry-neutral. */
export const WIDGET_CATALOG: readonly WidgetDefinition[] = [
  {
    key: 'revenue',
    name: 'Revenue summary',
    description: 'Paid revenue and invoice counts by status (from billing).',
    path: '/widgets/revenue',
    placeholder: false,
  },
  {
    key: 'leads_by_source',
    name: 'Leads by source',
    description: 'Lead counts grouped by acquisition source (from crm).',
    path: '/widgets/leads-by-source',
    placeholder: false,
  },
  {
    key: 'appointments',
    name: 'Appointments & jobs',
    description: 'Appointment/job counts by status (from scheduling).',
    path: '/widgets/appointments',
    placeholder: false,
  },
  {
    key: 'jobs', name: 'Jobs', description: 'CRM jobs by recorded status.', path: '/widgets/jobs', placeholder: false,
  },
  {
    key: 'quote_conversion',
    name: 'Quote conversion',
    description: 'Sent → approved conversion rate (from quoting).',
    path: '/widgets/quote-conversion',
    placeholder: false,
  },
  {
    key: 'open_tasks',
    name: 'Open tasks',
    description: 'Tasks not yet in a closed status (from workflows).',
    path: '/widgets/open-tasks',
    placeholder: false,
  },
  {
    key: 'employee_activity',
    name: 'Employee activity',
    description: 'Time entries and work logs per employee (from portal-employee).',
    path: '/widgets/employee-activity',
    placeholder: false,
  },
  {
    key: 'reviews',
    name: 'Reviews summary',
    description: 'Review count, average rating and 1–5 distribution (from reviews).',
    path: '/widgets/reviews',
    placeholder: false,
  },
  {
    key: 'website_traffic',
    name: 'Website traffic',
    description: 'Placeholder until a traffic source is integrated (documented contract).',
    path: '/widgets/website-traffic',
    placeholder: true,
  },
  {
    key: 'campaign_performance',
    name: 'Campaign performance',
    description: 'Placeholder until a campaign source is integrated (documented contract).',
    path: '/widgets/campaign-performance',
    placeholder: true,
  },
  {
    key: 'recent_activity',
    name: 'Recent activity',
    description: 'Latest timeline events across the platform (from the core audit log).',
    path: '/widgets/recent-activity',
    placeholder: false,
  },
  {
    key: 'alerts',
    name: 'Alerts',
    description: 'Metric threshold rules evaluated on demand.',
    path: '/alerts/evaluate',
    placeholder: false,
  },
] as const;

export const WIDGET_KEYS: readonly string[] = WIDGET_CATALOG.map((w) => w.key);

export type KpiUnit = 'cents' | 'count' | 'bps' | 'rating' | 'minutes';

export interface KpiDefinition {
  key: string;
  name: string;
  description: string;
  /** Machine/human-readable formula so the UI can explain the number. */
  formula: string;
  unit: KpiUnit;
  /** Widget key this KPI is surfaced on. */
  widget: string;
}

/**
 * Every scalar metric the dashboard computes. Alert rules reference these
 * keys. "In range" always means `created_at` within [from, to].
 */
export const KPI_DEFINITIONS: readonly KpiDefinition[] = [
  { key: 'jobs_total', name: 'Jobs', description: 'CRM jobs created in the selected period.', formula: 'COUNT(crm_jobs) WHERE created_at IN range', unit: 'count', widget: 'jobs' },
  { key: 'jobs_completed', name: 'Completed jobs', description: 'Completed CRM jobs created in the selected period.', formula: "COUNT(crm_jobs) WHERE status = 'completed' AND created_at IN range", unit: 'count', widget: 'jobs' },
  {
    key: 'revenue_cents',
    name: 'Paid revenue',
    description: 'Total of paid invoices in range, in integer cents.',
    formula: "SUM(billing_invoices.total_cents) WHERE status = 'paid' AND created_at IN range",
    unit: 'cents',
    widget: 'revenue',
  },
  {
    key: 'invoices_paid',
    name: 'Paid invoices',
    description: 'Number of paid invoices in range.',
    formula: "COUNT(billing_invoices) WHERE status = 'paid' AND created_at IN range",
    unit: 'count',
    widget: 'revenue',
  },
  {
    key: 'leads_created',
    name: 'Leads created',
    description: 'Number of leads created in range.',
    formula: 'COUNT(crm_leads) WHERE created_at IN range',
    unit: 'count',
    widget: 'leads_by_source',
  },
  {
    key: 'appointments_total',
    name: 'Appointments',
    description: 'Number of appointments/jobs created in range (any status).',
    formula: 'COUNT(scheduling_appointments) WHERE created_at IN range',
    unit: 'count',
    widget: 'appointments',
  },
  {
    key: 'appointments_completed',
    name: 'Appointments completed',
    description: 'Number of appointments/jobs in range with status "completed".',
    formula: "COUNT(scheduling_appointments) WHERE status = 'completed' AND created_at IN range",
    unit: 'count',
    widget: 'appointments',
  },
  {
    key: 'quotes_sent',
    name: 'Quotes sent',
    description: 'Quotes in range that have left draft (any non-draft status).',
    formula: "COUNT(quoting_quotes) WHERE status != 'draft' AND created_at IN range",
    unit: 'count',
    widget: 'quote_conversion',
  },
  {
    key: 'quotes_approved',
    name: 'Quotes approved',
    description: 'Quotes in range approved by the customer (approved or converted).',
    formula: "COUNT(quoting_quotes) WHERE status IN ('approved','converted') AND created_at IN range",
    unit: 'count',
    widget: 'quote_conversion',
  },
  {
    key: 'quote_conversion_bps',
    name: 'Quote conversion',
    description: 'Sent → approved conversion rate in basis points (10000 = 100%). 0 when nothing sent.',
    formula: 'ROUND(quotes_approved / quotes_sent * 10000); 0 when quotes_sent = 0',
    unit: 'bps',
    widget: 'quote_conversion',
  },
  {
    key: 'open_tasks',
    name: 'Open tasks',
    description: 'Tasks in range not in a closed status.',
    formula:
      "COUNT(workflows_tasks) WHERE status NOT IN ('completed','done','canceled','cancelled','archived') AND created_at IN range",
    unit: 'count',
    widget: 'open_tasks',
  },
  {
    key: 'time_entry_minutes',
    name: 'Tracked minutes',
    description: 'Total minutes across clocked-out time entries in range.',
    formula:
      'SUM(ROUND((clock_out_at - clock_in_at) in minutes)) over portal_employee_time_entries WHERE clock_out_at IS NOT NULL AND created_at IN range',
    unit: 'minutes',
    widget: 'employee_activity',
  },
  {
    key: 'worklogs_count',
    name: 'Work logs',
    description: 'Number of work log entries in range.',
    formula: 'COUNT(portal_employee_work_logs) WHERE created_at IN range',
    unit: 'count',
    widget: 'employee_activity',
  },
  {
    key: 'reviews_count',
    name: 'Reviews',
    description: 'Number of review responses submitted in range.',
    formula: 'COUNT(reviews_responses) WHERE created_at IN range',
    unit: 'count',
    widget: 'reviews',
  },
  {
    key: 'reviews_avg_rating',
    name: 'Average rating',
    description: 'Mean review rating in range, rounded to 2 decimals. 0 when no reviews.',
    formula: 'ROUND(AVG(reviews_responses.rating), 2); 0 when reviews_count = 0',
    unit: 'rating',
    widget: 'reviews',
  },
] as const;

export const METRIC_KEYS: readonly string[] = KPI_DEFINITIONS.map((k) => k.key);

/** Task statuses considered "closed" (everything else counts as open). */
export const CLOSED_TASK_STATUSES: readonly string[] = [
  'completed',
  'done',
  'canceled',
  'cancelled',
  'archived',
];

/** Quote statuses that count as customer-approved. */
export const APPROVED_QUOTE_STATUSES: readonly string[] = ['approved', 'converted'];

/* ================================================================== *
 * Date-range filter (every aggregation endpoint accepts ?from=&to=)
 * ================================================================== */

export interface DateRange {
  /** Inclusive ISO-8601 UTC lower bound on created_at. */
  from?: string;
  /** Inclusive ISO-8601 UTC upper bound on created_at. */
  to?: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse ?from=&to= into a normalized DateRange.
 * - full ISO datetimes are used as-is (normalized to UTC "Z" text)
 * - date-only values expand: from → start of day, to → end of day (UTC)
 * - invalid values or from > to → 400
 */
export function parseDateRange(query: Record<string, string | undefined>): DateRange {
  const parse = (value: string, edge: 'from' | 'to'): string => {
    const dt = DateTime.fromISO(value, { zone: 'utc' });
    if (!dt.isValid) {
      throw ApiError.badRequest(`invalid "${edge}" date: "${value}" (expected ISO-8601)`);
    }
    const adjusted = DATE_ONLY.test(value)
      ? edge === 'from'
        ? dt.startOf('day')
        : dt.endOf('day')
      : dt;
    return adjusted.toJSDate().toISOString();
  };
  const from = query.from ? parse(query.from, 'from') : undefined;
  const to = query.to ? parse(query.to, 'to') : undefined;
  if (from !== undefined && to !== undefined && from > to) {
    throw ApiError.badRequest('"from" must be <= "to"', { from, to });
  }
  return { from, to };
}

/* ================================================================== *
 * Graceful degradation for cross-module reads
 * ================================================================== */

const MISSING_SOURCE = /no such table|no such column/i;

/**
 * Run a cross-module aggregation query. If the source table/column does not
 * exist yet (owning module not migrated), return the fallback with
 * `available: false` instead of erroring — the dashboard must render even on
 * a partially-installed platform. Any other error propagates.
 */
async function safeRead<T>(fn: () => Promise<T>, fallback: T): Promise<{ available: boolean; value: T }> {
  try {
    return { available: true, value: await fn() };
  } catch (err) {
    if (err instanceof Error && MISSING_SOURCE.test(err.message)) {
      return { available: false, value: fallback };
    }
    throw err;
  }
}

type Db = Kysely<DashboardDatabase>;

function toCount(value: unknown): number {
  return Number(value ?? 0);
}

/* ================================================================== *
 * Aggregations (all strictly tenant-scoped, all range-filterable)
 * ================================================================== */

export interface StatusCount {
  status: string;
  count: number;
}

export interface RevenueSummary {
  available: boolean;
  /** All invoices in range regardless of status. */
  invoiceCount: number;
  /** COUNT of paid invoices in range. */
  paidCount: number;
  /** SUM(total_cents) of paid invoices in range. */
  paidCents: number;
  /** Per-status rollup: count + total cents. Sorted by status asc. */
  byStatus: { status: string; count: number; totalCents: number }[];
}

export async function revenueSummary(
  db: Db,
  tenantId: string,
  range: DateRange = {},
): Promise<RevenueSummary> {
  const read = await safeRead(async () => {
    let q = db
      .selectFrom('billing_invoices')
      .select(['status'])
      .select((eb) => eb.fn.count<number>('id').as('count'))
      .select((eb) => eb.fn.sum<number | null>('total_cents').as('total_cents'))
      .where('tenant_id', '=', tenantId);
    if (range.from) q = q.where('created_at', '>=', range.from);
    if (range.to) q = q.where('created_at', '<=', range.to);
    return q.groupBy('status').orderBy('status').execute();
  }, [] as { status: string; count: number; total_cents: number | null }[]);

  const byStatus = read.value
    .map((r) => ({ status: r.status, count: toCount(r.count), totalCents: toCount(r.total_cents) }))
    .sort((a, b) => a.status.localeCompare(b.status));
  const paid = byStatus.find((r) => r.status === 'paid');
  return {
    available: read.available,
    invoiceCount: byStatus.reduce((a, r) => a + r.count, 0),
    paidCount: paid?.count ?? 0,
    paidCents: paid?.totalCents ?? 0,
    byStatus,
  };
}

export interface LeadsBySource {
  available: boolean;
  totalLeads: number;
  /** Sorted by count desc, then source asc. NULL/'' sources appear as "unknown". */
  sources: { source: string; count: number }[];
}

export async function leadsBySource(
  db: Db,
  tenantId: string,
  range: DateRange = {},
): Promise<LeadsBySource> {
  const read = await safeRead(async () => {
    let q = db
      .selectFrom('crm_leads')
      .select(['source'])
      .select((eb) => eb.fn.count<number>('id').as('count'))
      .where('tenant_id', '=', tenantId);
    if (range.from) q = q.where('created_at', '>=', range.from);
    if (range.to) q = q.where('created_at', '<=', range.to);
    return q.groupBy('source').orderBy('source').execute();
  }, [] as { source: string | null; count: number }[]);

  // Merge NULL/'' into "unknown" in code (portable — no SQL COALESCE tricks).
  const merged = new Map<string, number>();
  for (const row of read.value) {
    const key = row.source === null || row.source === '' ? 'unknown' : row.source;
    merged.set(key, (merged.get(key) ?? 0) + toCount(row.count));
  }
  const sources = [...merged.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
  return {
    available: read.available,
    totalLeads: sources.reduce((a, s) => a + s.count, 0),
    sources,
  };
}

export interface AppointmentsSummary {
  available: boolean;
  total: number;
  completed: number;
  /** Sorted by status asc. */
  byStatus: StatusCount[];
}

export async function jobsSummary(db: Db, tenantId: string, range: DateRange = {}): Promise<AppointmentsSummary> {
  const read = await safeRead(async () => {
    let query = db.selectFrom('crm_jobs').select('status').select(eb => eb.fn.count<number>('id').as('count')).where('tenant_id', '=', tenantId);
    if (range.from) query = query.where('created_at', '>=', range.from);
    if (range.to) query = query.where('created_at', '<=', range.to);
    return query.groupBy('status').orderBy('status').execute();
  }, [] as { status: string; count: number }[]);
  const byStatus = read.value.map(row => ({ status: row.status, count: toCount(row.count) }));
  return { available: read.available, total: byStatus.reduce((total, row) => total + row.count, 0), completed: byStatus.find(row => row.status === 'completed')?.count ?? 0, byStatus };
}

export async function appointmentsSummary(
  db: Db,
  tenantId: string,
  range: DateRange = {},
): Promise<AppointmentsSummary> {
  const read = await safeRead(async () => {
    let q = db
      .selectFrom('scheduling_appointments')
      .select(['status'])
      .select((eb) => eb.fn.count<number>('id').as('count'))
      .where('tenant_id', '=', tenantId);
    if (range.from) q = q.where('created_at', '>=', range.from);
    if (range.to) q = q.where('created_at', '<=', range.to);
    return q.groupBy('status').orderBy('status').execute();
  }, [] as { status: string; count: number }[]);

  const byStatus = read.value
    .map((r) => ({ status: r.status, count: toCount(r.count) }))
    .sort((a, b) => a.status.localeCompare(b.status));
  return {
    available: read.available,
    total: byStatus.reduce((a, r) => a + r.count, 0),
    completed: byStatus.find((r) => r.status === 'completed')?.count ?? 0,
    byStatus,
  };
}

export interface QuoteConversion {
  available: boolean;
  /** Quotes in any non-draft status. */
  sent: number;
  /** Quotes in APPROVED_QUOTE_STATUSES. */
  approved: number;
  /** round(approved / sent * 10000); 0 when sent = 0. */
  conversionBps: number;
  /** Sorted by status asc. */
  byStatus: StatusCount[];
}

export async function quoteConversion(
  db: Db,
  tenantId: string,
  range: DateRange = {},
): Promise<QuoteConversion> {
  const read = await safeRead(async () => {
    let q = db
      .selectFrom('quoting_quotes')
      .select(['status'])
      .select((eb) => eb.fn.count<number>('id').as('count'))
      .where('tenant_id', '=', tenantId);
    if (range.from) q = q.where('created_at', '>=', range.from);
    if (range.to) q = q.where('created_at', '<=', range.to);
    return q.groupBy('status').orderBy('status').execute();
  }, [] as { status: string; count: number }[]);

  const byStatus = read.value
    .map((r) => ({ status: r.status, count: toCount(r.count) }))
    .sort((a, b) => a.status.localeCompare(b.status));
  const sent = byStatus.filter((r) => r.status !== 'draft').reduce((a, r) => a + r.count, 0);
  const approved = byStatus
    .filter((r) => APPROVED_QUOTE_STATUSES.includes(r.status))
    .reduce((a, r) => a + r.count, 0);
  return {
    available: read.available,
    sent,
    approved,
    conversionBps: sent === 0 ? 0 : Math.round((approved / sent) * 10000),
    byStatus,
  };
}

export interface OpenTasksSummary {
  available: boolean;
  total: number;
  open: number;
  /** Sorted by status asc. */
  byStatus: StatusCount[];
}

export async function openTasksSummary(
  db: Db,
  tenantId: string,
  range: DateRange = {},
): Promise<OpenTasksSummary> {
  const read = await safeRead(async () => {
    let q = db
      .selectFrom('workflows_tasks')
      .select(['status'])
      .select((eb) => eb.fn.count<number>('id').as('count'))
      .where('tenant_id', '=', tenantId);
    if (range.from) q = q.where('created_at', '>=', range.from);
    if (range.to) q = q.where('created_at', '<=', range.to);
    return q.groupBy('status').orderBy('status').execute();
  }, [] as { status: string; count: number }[]);

  const byStatus = read.value
    .map((r) => ({ status: r.status, count: toCount(r.count) }))
    .sort((a, b) => a.status.localeCompare(b.status));
  return {
    available: read.available,
    total: byStatus.reduce((a, r) => a + r.count, 0),
    open: byStatus
      .filter((r) => !CLOSED_TASK_STATUSES.includes(r.status))
      .reduce((a, r) => a + r.count, 0),
    byStatus,
  };
}

export interface EmployeeActivity {
  /** True when at least one source table exists. */
  available: boolean;
  timeEntries: {
    available: boolean;
    count: number;
    /** Entries with no clock_out_at yet. */
    openCount: number;
    /** Minutes over clocked-out entries; per-entry rounded, negatives clamped to 0. */
    totalMinutes: number;
  };
  worklogs: { available: boolean; count: number };
  /** Per-employee rollup, sorted by minutes desc then employeeId asc. */
  users: { employeeId: string; timeEntryCount: number; minutes: number; worklogCount: number }[];
}

export async function employeeActivity(
  db: Db,
  tenantId: string,
  range: DateRange = {},
): Promise<EmployeeActivity> {
  const entriesRead = await safeRead(async () => {
    let q = db
      .selectFrom('portal_employee_time_entries')
      .select(['id', 'employee_id', 'clock_in_at', 'clock_out_at'])
      .where('tenant_id', '=', tenantId);
    if (range.from) q = q.where('created_at', '>=', range.from);
    if (range.to) q = q.where('created_at', '<=', range.to);
    return q.orderBy('created_at').orderBy('id').execute();
  }, [] as { id: string; employee_id: string; clock_in_at: string; clock_out_at: string | null }[]);

  const worklogsRead = await safeRead(async () => {
    let q = db
      .selectFrom('portal_employee_work_logs')
      .select(['employee_id'])
      .select((eb) => eb.fn.count<number>('id').as('count'))
      .where('tenant_id', '=', tenantId);
    if (range.from) q = q.where('created_at', '>=', range.from);
    if (range.to) q = q.where('created_at', '<=', range.to);
    return q.groupBy('employee_id').orderBy('employee_id').execute();
  }, [] as { employee_id: string; count: number }[]);

  const users = new Map<string, { timeEntryCount: number; minutes: number; worklogCount: number }>();
  const bucket = (employeeId: string) => {
    let u = users.get(employeeId);
    if (!u) {
      u = { timeEntryCount: 0, minutes: 0, worklogCount: 0 };
      users.set(employeeId, u);
    }
    return u;
  };

  let openCount = 0;
  let totalMinutes = 0;
  for (const entry of entriesRead.value) {
    const u = bucket(entry.employee_id);
    u.timeEntryCount += 1;
    if (entry.clock_out_at === null) {
      openCount += 1;
      continue;
    }
    const ms = Date.parse(entry.clock_out_at) - Date.parse(entry.clock_in_at);
    const minutes = Number.isFinite(ms) ? Math.max(Math.round(ms / 60000), 0) : 0;
    u.minutes += minutes;
    totalMinutes += minutes;
  }
  for (const row of worklogsRead.value) {
    bucket(row.employee_id).worklogCount += toCount(row.count);
  }

  return {
    available: entriesRead.available || worklogsRead.available,
    timeEntries: {
      available: entriesRead.available,
      count: entriesRead.value.length,
      openCount,
      totalMinutes,
    },
    worklogs: {
      available: worklogsRead.available,
      count: worklogsRead.value.reduce((a, r) => a + toCount(r.count), 0),
    },
    users: [...users.entries()]
      .map(([employeeId, u]) => ({ employeeId, ...u }))
      .sort((a, b) => b.minutes - a.minutes || a.employeeId.localeCompare(b.employeeId)),
  };
}

export interface ReviewsSummary {
  available: boolean;
  count: number;
  /** Rounded to 2 decimals; null when there are no reviews. */
  averageRating: number | null;
  /** Counts for integer ratings 1..5 (out-of-range ratings ignored here). */
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
}

export async function reviewsSummary(
  db: Db,
  tenantId: string,
  range: DateRange = {},
): Promise<ReviewsSummary> {
  const read = await safeRead(async () => {
    let q = db
      .selectFrom('reviews_responses')
      .select(['rating'])
      .where('tenant_id', '=', tenantId);
    if (range.from) q = q.where('created_at', '>=', range.from);
    if (range.to) q = q.where('created_at', '<=', range.to);
    return q.orderBy('id').execute();
  }, [] as { rating: number }[]);

  const distribution: ReviewsSummary['distribution'] = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  let sum = 0;
  for (const row of read.value) {
    sum += row.rating;
    const key = String(row.rating) as keyof ReviewsSummary['distribution'];
    if (key in distribution) distribution[key] += 1;
  }
  const count = read.value.length;
  return {
    available: read.available,
    count,
    averageRating: count === 0 ? null : Math.round((sum / count) * 100) / 100,
    distribution,
  };
}

/* ------------------------------------------------------------------ *
 * Placeholder widgets — documented contracts
 * ------------------------------------------------------------------ */

export interface WebsiteTrafficPlaceholder {
  placeholder: true;
  available: false;
  metrics: { visits: null; uniqueVisitors: null; topPages: never[] };
  contract: string;
}

/**
 * CONTRACT: once a traffic integration exists this endpoint keeps the same
 * shape with `placeholder: false`, `available: true` and
 * `metrics: { visits: number, uniqueVisitors: number,
 *             topPages: { path: string, visits: number }[] }`,
 * filtered by the same from/to range.
 */
export function websiteTrafficPlaceholder(): WebsiteTrafficPlaceholder {
  return {
    placeholder: true,
    available: false,
    metrics: { visits: null, uniqueVisitors: null, topPages: [] },
    contract:
      'placeholder:false once integrated; metrics becomes { visits: number, uniqueVisitors: number, topPages: [{ path, visits }] } over the requested range',
  };
}

export interface CampaignPerformancePlaceholder {
  placeholder: true;
  available: false;
  metrics: { totalSpendCents: null; totalLeads: null; campaigns: never[] };
  contract: string;
}

/**
 * CONTRACT: once a campaign source exists this endpoint keeps the same shape
 * with `placeholder: false`, `available: true` and
 * `metrics: { totalSpendCents: number, totalLeads: number,
 *             campaigns: { campaignId: string, name: string,
 *                          spendCents: number, leads: number }[] }`,
 * filtered by the same from/to range.
 */
export function campaignPerformancePlaceholder(): CampaignPerformancePlaceholder {
  return {
    placeholder: true,
    available: false,
    metrics: { totalSpendCents: null, totalLeads: null, campaigns: [] },
    contract:
      'placeholder:false once integrated; metrics becomes { totalSpendCents: number, totalLeads: number, campaigns: [{ campaignId, name, spendCents, leads }] } over the requested range',
  };
}

/* ------------------------------------------------------------------ *
 * Recent activity (core audit log = the platform timeline)
 * ------------------------------------------------------------------ */

export interface ActivityEntry {
  id: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
}

export async function recentActivity(
  db: Db,
  tenantId: string,
  range: DateRange = {},
  limit = 20,
): Promise<ActivityEntry[]> {
  let q = asCoreDb(db)
    .selectFrom('audit_log')
    .select(['id', 'actor', 'action', 'entity_type', 'entity_id', 'created_at'])
    .where('tenant_id', '=', tenantId);
  if (range.from) q = q.where('created_at', '>=', range.from);
  if (range.to) q = q.where('created_at', '<=', range.to);
  const rows = await q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
  return rows.map((r) => ({
    id: r.id,
    actor: r.actor,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    createdAt: r.created_at,
  }));
}

/* ================================================================== *
 * Metric computation (shared by alerts + export)
 * ================================================================== */

export interface MetricValue {
  key: string;
  /** Numeric value in the KPI's unit. Unavailable sources report 0. */
  value: number;
  available: boolean;
}

export async function computeMetric(
  db: Db,
  tenantId: string,
  key: string,
  range: DateRange = {},
): Promise<MetricValue> {
  switch (key) {
    case 'jobs_total':
    case 'jobs_completed': {
      const result = await jobsSummary(db, tenantId, range);
      return { key, value: key === 'jobs_total' ? result.total : result.completed, available: result.available };
    }
    case 'revenue_cents': {
      const r = await revenueSummary(db, tenantId, range);
      return { key, value: r.paidCents, available: r.available };
    }
    case 'invoices_paid': {
      const r = await revenueSummary(db, tenantId, range);
      return { key, value: r.paidCount, available: r.available };
    }
    case 'leads_created': {
      const r = await leadsBySource(db, tenantId, range);
      return { key, value: r.totalLeads, available: r.available };
    }
    case 'appointments_total': {
      const r = await appointmentsSummary(db, tenantId, range);
      return { key, value: r.total, available: r.available };
    }
    case 'appointments_completed': {
      const r = await appointmentsSummary(db, tenantId, range);
      return { key, value: r.completed, available: r.available };
    }
    case 'quotes_sent': {
      const r = await quoteConversion(db, tenantId, range);
      return { key, value: r.sent, available: r.available };
    }
    case 'quotes_approved': {
      const r = await quoteConversion(db, tenantId, range);
      return { key, value: r.approved, available: r.available };
    }
    case 'quote_conversion_bps': {
      const r = await quoteConversion(db, tenantId, range);
      return { key, value: r.conversionBps, available: r.available };
    }
    case 'open_tasks': {
      const r = await openTasksSummary(db, tenantId, range);
      return { key, value: r.open, available: r.available };
    }
    case 'time_entry_minutes': {
      const r = await employeeActivity(db, tenantId, range);
      return { key, value: r.timeEntries.totalMinutes, available: r.timeEntries.available };
    }
    case 'worklogs_count': {
      const r = await employeeActivity(db, tenantId, range);
      return { key, value: r.worklogs.count, available: r.worklogs.available };
    }
    case 'reviews_count': {
      const r = await reviewsSummary(db, tenantId, range);
      return { key, value: r.count, available: r.available };
    }
    case 'reviews_avg_rating': {
      const r = await reviewsSummary(db, tenantId, range);
      return { key, value: r.averageRating ?? 0, available: r.available };
    }
    default:
      throw ApiError.badRequest(`unknown metric: "${key}"`, { allowed: METRIC_KEYS });
  }
}

/* ================================================================== *
 * Export summary (single JSON/CSV rollup)
 * ================================================================== */

export interface ExportMetricRow extends Record<string, unknown> {
  key: string;
  name: string;
  unit: KpiUnit;
  value: number;
  available: boolean;
}

export interface ExportSummary {
  generatedAt: string;
  range: DateRange;
  metrics: ExportMetricRow[];
}

export async function exportSummary(
  db: Db,
  tenantId: string,
  range: DateRange = {},
): Promise<ExportSummary> {
  const metrics: ExportMetricRow[] = [];
  for (const kpi of KPI_DEFINITIONS) {
    const m = await computeMetric(db, tenantId, kpi.key, range);
    metrics.push({ key: kpi.key, name: kpi.name, unit: kpi.unit, value: m.value, available: m.available });
  }
  return { generatedAt: nowIso(), range, metrics };
}

/* ================================================================== *
 * Widget configuration
 * ================================================================== */

export interface EffectiveWidget {
  widgetKey: string;
  name: string;
  description: string;
  path: string;
  placeholder: boolean;
  position: number;
  enabled: boolean;
  settings: Record<string, unknown>;
}

export interface WidgetConfiguration {
  /** False when the tenant has no rows and the catalog defaults apply. */
  configured: boolean;
  widgets: EffectiveWidget[];
}

function catalogEntry(key: string): WidgetDefinition {
  const def = WIDGET_CATALOG.find((w) => w.key === key);
  if (!def) throw ApiError.badRequest(`unknown widget key: "${key}"`, { allowed: WIDGET_KEYS });
  return def;
}

/**
 * Effective per-tenant configuration: the tenant's saved rows when any
 * exist (a widget absent from the saved set is simply not shown), otherwise
 * the full catalog enabled in default order.
 */
export async function getWidgetConfiguration(db: Db, tenantId: string): Promise<WidgetConfiguration> {
  const rows = await db
    .selectFrom('dashboard_widget_configs')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('position')
    .orderBy('id')
    .execute();

  if (rows.length === 0) {
    return {
      configured: false,
      widgets: WIDGET_CATALOG.map((def, index) => ({
        widgetKey: def.key,
        name: def.name,
        description: def.description,
        path: def.path,
        placeholder: def.placeholder,
        position: index,
        enabled: true,
        settings: {},
      })),
    };
  }

  return {
    configured: true,
    widgets: rows.map((row) => {
      const def = catalogEntry(row.widget_key);
      return {
        widgetKey: row.widget_key,
        name: def.name,
        description: def.description,
        path: def.path,
        placeholder: def.placeholder,
        position: row.position,
        enabled: row.enabled === 1,
        settings: JSON.parse(row.settings) as Record<string, unknown>,
      };
    }),
  };
}

export interface WidgetConfigInput {
  widgetKey: string;
  enabled?: boolean;
  settings?: Record<string, unknown>;
}

/**
 * Replace the tenant's widget configuration. Array order = display order.
 * Validates keys against the catalog and rejects duplicates. Audited; emits
 * `dashboard.config.updated`.
 */
export async function setWidgetConfiguration(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  widgets: WidgetConfigInput[],
): Promise<WidgetConfiguration> {
  if (widgets.length === 0) {
    throw ApiError.badRequest('widgets must not be empty (DELETE /config to reset to defaults)');
  }
  const seen = new Set<string>();
  for (const w of widgets) {
    catalogEntry(w.widgetKey); // throws 400 on unknown key
    if (seen.has(w.widgetKey)) {
      throw ApiError.badRequest(`duplicate widget key: "${w.widgetKey}"`);
    }
    seen.add(w.widgetKey);
  }

  const now = nowIso();
  const rows: DashboardWidgetConfigRow[] = widgets.map((w, index) => ({
    id: id(),
    tenant_id: tenantId,
    widget_key: w.widgetKey,
    position: index,
    enabled: w.enabled === false ? 0 : 1,
    settings: JSON.stringify(w.settings ?? {}),
    created_at: now,
    updated_at: now,
  }));

  await db.deleteFrom('dashboard_widget_configs').where('tenant_id', '=', tenantId).execute();
  await db.insertInto('dashboard_widget_configs').values(rows).execute();

  await audit(asCoreDb(db), tenantId, actor, 'dashboard.widget_config.updated', 'dashboard.widget_config', 'config', {
    widgetKeys: rows.map((r) => r.widget_key),
  });
  await events.emit(tenantId, 'dashboard.config.updated', {
    widgetKeys: rows.map((r) => r.widget_key),
  });

  return getWidgetConfiguration(db, tenantId);
}

/** Clear saved configuration → catalog defaults apply again. Audited + event. */
export async function resetWidgetConfiguration(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
): Promise<WidgetConfiguration> {
  await db.deleteFrom('dashboard_widget_configs').where('tenant_id', '=', tenantId).execute();
  await audit(asCoreDb(db), tenantId, actor, 'dashboard.widget_config.reset', 'dashboard.widget_config', 'config');
  await events.emit(tenantId, 'dashboard.config.updated', { widgetKeys: null, reset: true });
  return getWidgetConfiguration(db, tenantId);
}

/* ================================================================== *
 * Alert rules (metric + threshold + direction, evaluated on demand)
 * ================================================================== */

export interface AlertRule {
  id: string;
  name: string;
  metric: string;
  threshold: number;
  direction: AlertDirection;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

function toAlertRule(row: DashboardAlertRuleRow): AlertRule {
  return {
    id: row.id,
    name: row.name,
    metric: row.metric,
    threshold: row.threshold,
    direction: row.direction as AlertDirection,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertMetricKey(metric: string): void {
  if (!METRIC_KEYS.includes(metric)) {
    throw ApiError.badRequest(`unknown metric: "${metric}"`, { allowed: METRIC_KEYS });
  }
}

export interface AlertRuleInput {
  name: string;
  metric: string;
  threshold: number;
  direction: AlertDirection;
  enabled?: boolean;
}

export async function createAlertRule(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  input: AlertRuleInput,
): Promise<AlertRule> {
  assertMetricKey(input.metric);
  const now = nowIso();
  const row: DashboardAlertRuleRow = {
    id: id(),
    tenant_id: tenantId,
    name: input.name.trim(),
    metric: input.metric,
    threshold: input.threshold,
    direction: input.direction,
    enabled: input.enabled === false ? 0 : 1,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('dashboard_alert_rules').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'dashboard.alert_rule.created', 'dashboard.alert_rule', row.id, {
    metric: row.metric,
    threshold: row.threshold,
    direction: row.direction,
  });
  await events.emit(tenantId, 'dashboard.alert.created', { alertId: row.id, metric: row.metric });
  return toAlertRule(row);
}

export async function listAlertRules(
  db: Db,
  tenantId: string,
  page: { limit: number; offset: number } = { limit: 50, offset: 0 },
): Promise<AlertRule[]> {
  const rows = await db
    .selectFrom('dashboard_alert_rules')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
  return rows.map(toAlertRule);
}

export async function getAlertRule(db: Db, tenantId: string, alertId: string): Promise<AlertRule> {
  const row = await db
    .selectFrom('dashboard_alert_rules')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', alertId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`alert rule not found: ${alertId}`);
  return toAlertRule(row);
}

export interface AlertRulePatch {
  name?: string;
  metric?: string;
  threshold?: number;
  direction?: AlertDirection;
  enabled?: boolean;
}

export async function updateAlertRule(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  alertId: string,
  patch: AlertRulePatch,
): Promise<AlertRule> {
  const set: Partial<DashboardAlertRuleRow> = {};
  if (patch.name !== undefined) {
    if (patch.name.trim() === '') throw ApiError.badRequest('alert name cannot be blank');
    set.name = patch.name.trim();
  }
  if (patch.metric !== undefined) {
    assertMetricKey(patch.metric);
    set.metric = patch.metric;
  }
  if (patch.threshold !== undefined) set.threshold = patch.threshold;
  if (patch.direction !== undefined) set.direction = patch.direction;
  if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0;

  if (Object.keys(set).length > 0) {
    set.updated_at = nowIso();
    const result = await db
      .updateTable('dashboard_alert_rules')
      .set(set)
      .where('tenant_id', '=', tenantId)
      .where('id', '=', alertId)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) {
      throw ApiError.notFound(`alert rule not found: ${alertId}`);
    }
    await audit(asCoreDb(db), tenantId, actor, 'dashboard.alert_rule.updated', 'dashboard.alert_rule', alertId, {
      patch: { ...patch },
    });
    await events.emit(tenantId, 'dashboard.alert.updated', { alertId });
  }
  return getAlertRule(db, tenantId, alertId);
}

export async function deleteAlertRule(
  db: Db,
  events: EventBus,
  tenantId: string,
  actor: string,
  alertId: string,
): Promise<void> {
  const result = await db
    .deleteFrom('dashboard_alert_rules')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', alertId)
    .executeTakeFirst();
  if (result.numDeletedRows === 0n) {
    throw ApiError.notFound(`alert rule not found: ${alertId}`);
  }
  await audit(asCoreDb(db), tenantId, actor, 'dashboard.alert_rule.deleted', 'dashboard.alert_rule', alertId);
  await events.emit(tenantId, 'dashboard.alert.deleted', { alertId });
}

export interface AlertEvaluation {
  alertId: string;
  name: string;
  metric: string;
  threshold: number;
  direction: AlertDirection;
  /** Current metric value over the requested range. */
  value: number;
  /** False when the metric's source tables are missing (never triggers). */
  available: boolean;
  triggered: boolean;
}

/**
 * Evaluate all ENABLED rules against the current aggregations.
 * 'above' triggers when value > threshold; 'below' when value < threshold
 * (strict inequalities). Unavailable metrics never trigger.
 * When an EventBus is supplied, emits `dashboard.alert.triggered` per hit.
 */
export async function evaluateAlertRules(
  db: Db,
  tenantId: string,
  range: DateRange = {},
  events?: EventBus,
): Promise<AlertEvaluation[]> {
  const rules = await db
    .selectFrom('dashboard_alert_rules')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('enabled', '=', 1)
    .orderBy('created_at')
    .orderBy('id')
    .execute();

  const evaluations: AlertEvaluation[] = [];
  for (const row of rules) {
    const metric = await computeMetric(db, tenantId, row.metric, range);
    const direction = row.direction as AlertDirection;
    const triggered =
      metric.available &&
      (direction === 'above' ? metric.value > row.threshold : metric.value < row.threshold);
    evaluations.push({
      alertId: row.id,
      name: row.name,
      metric: row.metric,
      threshold: row.threshold,
      direction,
      value: metric.value,
      available: metric.available,
      triggered,
    });
    if (triggered && events) {
      await events.emit(tenantId, 'dashboard.alert.triggered', {
        alertId: row.id,
        metric: row.metric,
        value: metric.value,
        threshold: row.threshold,
        direction,
      });
    }
  }
  return evaluations;
}

/* ================================================================== *
 * Full page bundle (for the server-rendered HTML dashboard)
 * ================================================================== */

export interface DashboardPageData {
  tenantName: string;
  range: DateRange;
  /** Enabled widgets in display order. */
  widgets: EffectiveWidget[];
  revenue: RevenueSummary;
  leadsBySource: LeadsBySource;
  appointments: AppointmentsSummary;
  jobs?: AppointmentsSummary;
  quoteConversion: QuoteConversion;
  openTasks: OpenTasksSummary;
  employeeActivity: EmployeeActivity;
  reviews: ReviewsSummary;
  websiteTraffic: WebsiteTrafficPlaceholder;
  campaignPerformance: CampaignPerformancePlaceholder;
  recentActivity: ActivityEntry[];
  alerts: AlertEvaluation[];
}

export async function collectDashboardData(
  db: Db,
  tenantId: string,
  range: DateRange = {},
): Promise<DashboardPageData> {
  const tenant = await asCoreDb(db)
    .selectFrom('tenants')
    .select('name')
    .where('id', '=', tenantId)
    .executeTakeFirst();
  const config = await getWidgetConfiguration(db, tenantId);
  return {
    tenantName: tenant?.name ?? tenantId,
    range,
    widgets: config.widgets.filter((w) => w.enabled),
    revenue: await revenueSummary(db, tenantId, range),
    leadsBySource: await leadsBySource(db, tenantId, range),
    appointments: await appointmentsSummary(db, tenantId, range),
    jobs: await jobsSummary(db, tenantId, range),
    quoteConversion: await quoteConversion(db, tenantId, range),
    openTasks: await openTasksSummary(db, tenantId, range),
    employeeActivity: await employeeActivity(db, tenantId, range),
    reviews: await reviewsSummary(db, tenantId, range),
    websiteTraffic: websiteTrafficPlaceholder(),
    campaignPerformance: campaignPerformancePlaceholder(),
    recentActivity: await recentActivity(db, tenantId, range, 10),
    // No EventBus here: page renders must not emit alert events.
    alerts: await evaluateAlertRules(db, tenantId, range),
  };
}
