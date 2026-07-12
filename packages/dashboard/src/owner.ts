import { DateTime } from 'luxon';
import type { Kysely } from 'kysely';
import { asCoreDb } from '@blacklabel/core';
import type { DashboardDatabase } from './schema';

/**
 * Owner dashboard — retail sales analytics over the imported POS facts
 * (retail_* tables) plus crm contact coverage. Everything here is
 * deterministic: no AI, no wall-clock — "today" is always the data-as-of
 * date (MAX(paid_at)), so the same data renders the same page forever.
 *
 * Day/week/month bucketing happens in the shop's local time zone, computed
 * from the UTC timestamps (same semantics as MagsTack weekly_report.py).
 * Weeks end on Sunday — this is a Saturday-show business.
 */

const SHOP_TZ = 'America/New_York';

type Db = Kysely<DashboardDatabase>;

/* Same graceful degradation as service.ts: a missing source table renders
 * an honest "not available" state instead of a 500. */
const MISSING_SOURCE = /no such table|no such column/i;

async function safeRead<T>(
  fn: () => Promise<T>,
  fallback: T,
): Promise<{ available: boolean; value: T }> {
  try {
    return { available: true, value: await fn() };
  } catch (err) {
    if (err instanceof Error && MISSING_SOURCE.test(err.message)) {
      return { available: false, value: fallback };
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * Local-time helpers (deterministic, luxon)
 * ------------------------------------------------------------------ */

/** UTC ISO timestamp → local (shop) calendar date "YYYY-MM-DD". */
function localDateOf(isoUtc: string): string {
  return DateTime.fromISO(isoUtc, { zone: 'utc' }).setZone(SHOP_TZ).toISODate() as string;
}

/** Local date "YYYY-MM-DD" → ISO weekday 1(Mon)..7(Sun). */
function weekdayOf(localDate: string): number {
  return DateTime.fromISO(localDate, { zone: SHOP_TZ }).weekday;
}

/** Sunday on or after the local date (the date's week-ending Sunday). */
function weekEndingOf(localDate: string): string {
  const dt = DateTime.fromISO(localDate, { zone: SHOP_TZ });
  return dt.plus({ days: (7 - dt.weekday) % 7 }).toISODate() as string;
}

function addDays(localDate: string, days: number): string {
  return DateTime.fromISO(localDate, { zone: SHOP_TZ }).plus({ days }).toISODate() as string;
}

/** Start of the local date, as a UTC ISO string (lexicographic range bound). */
function utcBound(localDate: string): string {
  return DateTime.fromISO(localDate, { zone: SHOP_TZ })
    .startOf('day')
    .toUTC()
    .toISO() as string;
}

const WEEKDAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/* ------------------------------------------------------------------ *
 * Result shapes
 * ------------------------------------------------------------------ */

export interface OwnerMoneyStat {
  grossCents: number;
  paymentCount: number;
  averageTicketCents: number | null;
}

export interface OwnerWeekPoint {
  weekEnding: string;
  grossCents: number;
  paymentCount: number;
  /** True when data stops before this week's Sunday (week still open). */
  partial: boolean;
}

export interface OwnerForecastBacktestWeek {
  weekEnding: string;
  actualCents: number;
  forecastCents: number;
  /** |actual-forecast|/actual, percent; null when the actual was $0. */
  errorPct: number | null;
}

export type OwnerForecast =
  | { available: false; reason: string }
  | {
      available: true;
      method: string;
      /** Recent-trend multiplier applied to same-week-last-year, percent. */
      growthFactorPct: number;
      backtest: {
        weeks: OwnerForecastBacktestWeek[];
        /** Mean abs pct error across backtest weeks with non-zero actuals. */
        mapePct: number | null;
        zeroActualWeeks: number;
      };
      weekly: {
        weekEnding: string;
        forecastCents: number;
        basisWeekEnding: string;
        basisCents: number;
      }[];
      monthly: { month: string; forecastCents: number; weeks: number }[];
    };

export interface OwnerDashboardData {
  tenantName: string;
  timezone: string;
  /** False until the retail tables exist AND hold >=1 completed payment. */
  available: boolean;
  dataAsOf: string | null;
  dataAsOfLocalDate: string | null;
  dataFirstLocalDate: string | null;
  allTime: OwnerMoneyStat;
  ytd: {
    year: number;
    grossCents: number;
    throughLocalDate: string;
    lastYearGrossCents: number | null;
    lastYearThroughLocalDate: string;
    pctChange: number | null;
  } | null;
  yearly: { year: number; grossCents: number; paymentCount: number }[];
  weeklyTrend: OwnerWeekPoint[];
  dayOfWeek: {
    weekday: string;
    paymentCount: number;
    grossCents: number;
    paymentSharePct: number;
    grossSharePct: number;
  }[];
  topItems12mo: { name: string; quantity: number; revenueCents: number }[];
  topItemsAllTime: { name: string; quantity: number; revenueCents: number }[];
  topCategories12mo: { name: string; revenueCents: number }[];
  refunds: {
    available: boolean;
    allTimeCount: number;
    allTimeCents: number;
    last12moCount: number;
    last12moCents: number;
  };
  fees: {
    totalCents: number;
    effectiveBps: number | null;
    paymentsWithFeeData: number;
    paymentsTotal: number;
  };
  customers: {
    available: boolean;
    total: number;
    withEmail: number;
    withPhone: number;
    emailPct: number | null;
    repeatRatePct: number | null;
    identifiedPaymentPct: number | null;
  };
  imports: {
    available: boolean;
    runCount: number;
    lastRun: {
      source: string;
      finishedAt: string;
      paymentsInserted: number;
      linesInserted: number;
      refundsInserted: number;
      completedGrossCentsAfter: number;
    } | null;
  };
  inventory:
    | { available: false }
    | { available: true; trackedItems: number; unitsOnHand: number; oversoldItems: number };
  /** Outreach ships fully cold: nothing configured, nothing sends. */
  outreach: { configured: false };
  forecast: OwnerForecast;
}

/* ------------------------------------------------------------------ *
 * Forecast engine (deterministic, backtested)
 * ------------------------------------------------------------------ */

const TREND_WEEKS = 26;
const BACKTEST_WEEKS = 8;
const YEAR_OFFSET_DAYS = 364; // 52 weeks — keeps weekdays aligned

/**
 * gross(weekEnding − 364d) × trend, where trend = (sum of the TREND_WEEKS
 * completed weeks before the anchor) / (sum of the same weeks a year
 * earlier). Returns null when the required history is missing or the
 * denominator is not positive.
 */
function forecastWeek(
  weeks: Map<string, { grossCents: number }>,
  firstWeek: string,
  anchorWeekEnding: string,
  targetWeekEnding: string,
): { forecastCents: number; basisWeekEnding: string; basisCents: number; trend: number } | null {
  const basisWeek = addDays(targetWeekEnding, -YEAR_OFFSET_DAYS);
  if (basisWeek < firstWeek) return null;
  const basis = weeks.get(basisWeek);
  if (!basis) return null;

  let recent = 0;
  let prior = 0;
  for (let i = 1; i <= TREND_WEEKS; i += 1) {
    const w = addDays(anchorWeekEnding, -7 * (i - 1));
    const p = addDays(w, -YEAR_OFFSET_DAYS);
    if (p < firstWeek) return null;
    recent += weeks.get(w)?.grossCents ?? 0;
    prior += weeks.get(p)?.grossCents ?? 0;
  }
  if (prior <= 0) return null;
  const trend = recent / prior;
  return {
    forecastCents: Math.round(basis.grossCents * trend),
    basisWeekEnding: basisWeek,
    basisCents: basis.grossCents,
    trend,
  };
}

function buildForecast(
  weekMap: Map<string, { grossCents: number; paymentCount: number }>,
  firstWeek: string,
  lastCompletedWeek: string,
  asOfLocalDate: string,
): OwnerForecast {
  const historyWeeks =
    (DateTime.fromISO(lastCompletedWeek).diff(DateTime.fromISO(firstWeek), 'weeks').weeks ?? 0) + 1;
  if (historyWeeks < TREND_WEEKS + 52 + BACKTEST_WEEKS) {
    return {
      available: false,
      reason: `Not enough history to forecast honestly (needs ~${TREND_WEEKS + 52 + BACKTEST_WEEKS} weeks, have ${Math.floor(historyWeeks)}).`,
    };
  }

  // Backtest: forecast each of the last BACKTEST_WEEKS completed weeks using
  // only data strictly before that week, then compare to what happened.
  const backtestWeeks: OwnerForecastBacktestWeek[] = [];
  let zeroActualWeeks = 0;
  for (let i = BACKTEST_WEEKS - 1; i >= 0; i -= 1) {
    const target = addDays(lastCompletedWeek, -7 * i);
    const anchor = addDays(target, -7);
    const fc = forecastWeek(weekMap, firstWeek, anchor, target);
    if (!fc) {
      return {
        available: false,
        reason: `Backtest could not run for the week ending ${target} (missing prior-year data).`,
      };
    }
    const actual = weekMap.get(target)?.grossCents ?? 0;
    let errorPct: number | null = null;
    if (actual > 0) {
      errorPct = Math.round((Math.abs(actual - fc.forecastCents) / actual) * 1000) / 10;
    } else {
      zeroActualWeeks += 1;
    }
    backtestWeeks.push({
      weekEnding: target,
      actualCents: actual,
      forecastCents: fc.forecastCents,
      errorPct,
    });
  }
  const errs = backtestWeeks.map((w) => w.errorPct).filter((e): e is number => e !== null);
  const mapePct =
    errs.length > 0 ? Math.round((errs.reduce((a, b) => a + b, 0) / errs.length) * 10) / 10 : null;
  if (mapePct === null) {
    return {
      available: false,
      reason: 'Every backtest week had $0 in sales — the typical error cannot be measured, so no forecast is shown.',
    };
  }

  // Forward projection: every week ending after data-as-of, through year-end.
  const year = Number(asOfLocalDate.slice(0, 4));
  const yearEnd = `${year}-12-31`;
  const weekly: {
    weekEnding: string;
    forecastCents: number;
    basisWeekEnding: string;
    basisCents: number;
  }[] = [];
  let trendPct = 0;
  let w = weekEndingOf(addDays(asOfLocalDate, 1));
  if (w <= asOfLocalDate) w = addDays(w, 7);
  for (; w <= yearEnd; w = addDays(w, 7)) {
    const fc = forecastWeek(weekMap, firstWeek, lastCompletedWeek, w);
    if (!fc) {
      return {
        available: false,
        reason: `Missing prior-year data for the week ending ${w} — refusing to guess.`,
      };
    }
    trendPct = Math.round(fc.trend * 1000) / 10;
    weekly.push({
      weekEnding: w,
      forecastCents: fc.forecastCents,
      basisWeekEnding: fc.basisWeekEnding,
      basisCents: fc.basisCents,
    });
  }
  if (weekly.length === 0) {
    return { available: false, reason: 'No forecastable weeks remain this year.' };
  }

  const monthly = new Map<string, { forecastCents: number; weeks: number }>();
  for (const wk of weekly) {
    const month = wk.weekEnding.slice(0, 7);
    const m = monthly.get(month) ?? { forecastCents: 0, weeks: 0 };
    m.forecastCents += wk.forecastCents;
    m.weeks += 1;
    monthly.set(month, m);
  }

  return {
    available: true,
    method:
      `Same week last year × recent trend (last ${TREND_WEEKS} weeks vs the same ${TREND_WEEKS} weeks a year earlier). ` +
      `Backtested on the last ${BACKTEST_WEEKS} completed weeks.`,
    growthFactorPct: trendPct,
    backtest: { weeks: backtestWeeks, mapePct, zeroActualWeeks },
    weekly,
    monthly: [...monthly.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([month, m]) => ({ month, ...m })),
  };
}

/* ------------------------------------------------------------------ *
 * Collector
 * ------------------------------------------------------------------ */

function pct(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

export async function collectOwnerDashboardData(
  db: Db,
  tenantId: string,
): Promise<OwnerDashboardData> {
  const tenant = await asCoreDb(db)
    .selectFrom('tenants')
    .select('name')
    .where('id', '=', tenantId)
    .executeTakeFirst();
  const tenantName = tenant?.name ?? tenantId;

  const paymentsRead = await safeRead(
    () =>
      db
        .selectFrom('retail_payments')
        .select(['paid_at', 'amount_cents', 'fee_cents', 'customer_source_id'])
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'COMPLETED')
        .orderBy('paid_at')
        .orderBy('id')
        .execute(),
    [] as { paid_at: string; amount_cents: number; fee_cents: number | null; customer_source_id: string | null }[],
  );
  const payments = paymentsRead.value;

  const empty: OwnerDashboardData = {
    tenantName,
    timezone: SHOP_TZ,
    available: false,
    dataAsOf: null,
    dataAsOfLocalDate: null,
    dataFirstLocalDate: null,
    allTime: { grossCents: 0, paymentCount: 0, averageTicketCents: null },
    ytd: null,
    yearly: [],
    weeklyTrend: [],
    dayOfWeek: [],
    topItems12mo: [],
    topItemsAllTime: [],
    topCategories12mo: [],
    refunds: { available: false, allTimeCount: 0, allTimeCents: 0, last12moCount: 0, last12moCents: 0 },
    fees: { totalCents: 0, effectiveBps: null, paymentsWithFeeData: 0, paymentsTotal: 0 },
    customers: {
      available: false,
      total: 0,
      withEmail: 0,
      withPhone: 0,
      emailPct: null,
      repeatRatePct: null,
      identifiedPaymentPct: null,
    },
    imports: { available: false, runCount: 0, lastRun: null },
    inventory: { available: false },
    outreach: { configured: false },
    forecast: { available: false, reason: 'No sales data imported yet.' },
  };
  if (!paymentsRead.available || payments.length === 0) return empty;

  /* ---- core rollups from the completed payments ---- */
  const dataAsOf = payments[payments.length - 1].paid_at;
  const asOfLocal = localDateOf(dataAsOf);
  const firstLocal = localDateOf(payments[0].paid_at);

  let gross = 0;
  let fees = 0;
  let feeCount = 0;
  let identified = 0;
  const perCustomer = new Map<string, number>();
  const perYear = new Map<number, { grossCents: number; paymentCount: number }>();
  const perWeekday = WEEKDAY_LABELS.map(() => ({ paymentCount: 0, grossCents: 0 }));
  const weekMap = new Map<string, { grossCents: number; paymentCount: number }>();

  for (const p of payments) {
    gross += p.amount_cents;
    if (p.fee_cents !== null) {
      fees += p.fee_cents;
      feeCount += 1;
    }
    if (p.customer_source_id) {
      identified += 1;
      perCustomer.set(p.customer_source_id, (perCustomer.get(p.customer_source_id) ?? 0) + 1);
    }
    const local = localDateOf(p.paid_at);
    const year = Number(local.slice(0, 4));
    const y = perYear.get(year) ?? { grossCents: 0, paymentCount: 0 };
    y.grossCents += p.amount_cents;
    y.paymentCount += 1;
    perYear.set(year, y);
    const wd = perWeekday[weekdayOf(local) - 1];
    wd.paymentCount += 1;
    wd.grossCents += p.amount_cents;
    const we = weekEndingOf(local);
    const wk = weekMap.get(we) ?? { grossCents: 0, paymentCount: 0 };
    wk.grossCents += p.amount_cents;
    wk.paymentCount += 1;
    weekMap.set(we, wk);
  }

  // Continuous week series (zero-sale weeks exist as real $0 weeks).
  const firstWeek = weekEndingOf(firstLocal);
  const asOfWeek = weekEndingOf(asOfLocal);
  for (let w = firstWeek; w <= asOfWeek; w = addDays(w, 7)) {
    if (!weekMap.has(w)) weekMap.set(w, { grossCents: 0, paymentCount: 0 });
  }
  const lastCompletedWeek = asOfWeek <= asOfLocal ? asOfWeek : addDays(asOfWeek, -7);

  /* ---- YTD vs same period last year (calendar, clamped day) ---- */
  const asOfDt = DateTime.fromISO(asOfLocal, { zone: SHOP_TZ });
  const year = asOfDt.year;
  const lyThrough = asOfDt.minus({ years: 1 }).toISODate() as string;
  const sumRange = (fromLocal: string, toLocal: string): number => {
    const lo = utcBound(fromLocal);
    const hi = utcBound(addDays(toLocal, 1));
    let s = 0;
    for (const p of payments) {
      if (p.paid_at >= lo && p.paid_at < hi) s += p.amount_cents;
    }
    return s;
  };
  const ytdGross = sumRange(`${year}-01-01`, asOfLocal);
  // Honest "no data" when our records start after the comparison window ends.
  const lyGross = lyThrough >= firstLocal ? sumRange(`${year - 1}-01-01`, lyThrough) : null;
  const ytd = {
    year,
    grossCents: ytdGross,
    throughLocalDate: asOfLocal,
    lastYearGrossCents: lyGross,
    lastYearThroughLocalDate: lyThrough,
    pctChange:
      lyGross !== null && lyGross > 0
        ? Math.round(((ytdGross - lyGross) / lyGross) * 1000) / 10
        : null,
  };

  /* ---- weekly trend: last 12 completed weeks + the open partial week ---- */
  const weeklyTrend: OwnerWeekPoint[] = [];
  for (let i = 11; i >= 0; i -= 1) {
    const w = addDays(lastCompletedWeek, -7 * i);
    if (w < firstWeek) continue;
    const v = weekMap.get(w) ?? { grossCents: 0, paymentCount: 0 };
    weeklyTrend.push({ weekEnding: w, ...v, partial: false });
  }
  if (asOfWeek > lastCompletedWeek) {
    const v = weekMap.get(asOfWeek) ?? { grossCents: 0, paymentCount: 0 };
    weeklyTrend.push({ weekEnding: asOfWeek, ...v, partial: true });
  }

  /* ---- top items / categories (SQL over the lines of completed orders) ---- */
  const trailingFrom = addDays(asOfLocal, -(YEAR_OFFSET_DAYS - 1));
  const trailingLo = utcBound(trailingFrom);
  const trailingHi = utcBound(addDays(asOfLocal, 1));

  const completedOrders = (range?: { lo: string; hi: string }) => {
    let q = db
      .selectFrom('retail_payments')
      .select('order_source_id')
      .distinct()
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'COMPLETED')
      .where('order_source_id', 'is not', null);
    if (range) q = q.where('paid_at', '>=', range.lo).where('paid_at', '<', range.hi);
    return q;
  };

  const topItemsQuery = (range?: { lo: string; hi: string }) =>
    db
      .selectFrom('retail_order_lines')
      .select((eb) => [
        'name',
        eb.fn.sum<number>('quantity').as('quantity'),
        eb.fn.sum<number>('total_cents').as('revenue'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('source_order_id', 'in', completedOrders(range))
      .groupBy('name')
      .orderBy('revenue', 'desc')
      .orderBy('name')
      .limit(10)
      .execute();

  const topItems12moRead = await safeRead(
    () => topItemsQuery({ lo: trailingLo, hi: trailingHi }),
    [] as { name: string; quantity: number; revenue: number }[],
  );
  const topItemsAllRead = await safeRead(
    () => topItemsQuery(),
    [] as { name: string; quantity: number; revenue: number }[],
  );
  const topCategoriesRead = await safeRead(
    () =>
      db
        .selectFrom('retail_order_lines')
        .select((eb) => [
          'category_name',
          eb.fn.sum<number>('total_cents').as('revenue'),
        ])
        .where('tenant_id', '=', tenantId)
        .where('source_order_id', 'in', completedOrders({ lo: trailingLo, hi: trailingHi }))
        .groupBy('category_name')
        .orderBy('revenue', 'desc')
        .orderBy('category_name')
        .limit(10)
        .execute(),
    [] as { category_name: string | null; revenue: number }[],
  );

  const asTopItems = (rows: { name: string; quantity: number; revenue: number }[]) =>
    rows.map((r) => ({
      name: r.name,
      quantity: Math.round(Number(r.quantity) * 100) / 100,
      revenueCents: Number(r.revenue),
    }));

  /* ---- refunds ---- */
  const refundsRead = await safeRead(
    () =>
      db
        .selectFrom('retail_refunds')
        .select(['refunded_at', 'amount_cents'])
        .where('tenant_id', '=', tenantId)
        .execute(),
    [] as { refunded_at: string; amount_cents: number }[],
  );
  let refundAllCount = 0;
  let refundAllCents = 0;
  let refund12Count = 0;
  let refund12Cents = 0;
  for (const r of refundsRead.value) {
    refundAllCount += 1;
    refundAllCents += r.amount_cents;
    if (r.refunded_at >= trailingLo && r.refunded_at < trailingHi) {
      refund12Count += 1;
      refund12Cents += r.amount_cents;
    }
  }

  /* ---- customers (crm coverage + retail repeat rate) ---- */
  const crmRead = await safeRead(
    () =>
      db
        .selectFrom('crm_customers')
        .select(['email', 'phone'])
        .where('tenant_id', '=', tenantId)
        .execute(),
    [] as { email: string | null; phone: string | null }[],
  );
  const totalCustomers = crmRead.value.length;
  const withEmail = crmRead.value.filter((c) => c.email && c.email.trim() !== '').length;
  const withPhone = crmRead.value.filter((c) => c.phone && c.phone.trim() !== '').length;
  const buyers = perCustomer.size;
  const repeatBuyers = [...perCustomer.values()].filter((n) => n >= 2).length;

  /* ---- imports ---- */
  const importsRead = await safeRead(
    () =>
      db
        .selectFrom('retail_import_runs')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .execute(),
    [] as DashboardDatabase['retail_import_runs'][],
  );
  const lastRun = importsRead.value[0] ?? null;

  /* ---- inventory (module not shipped yet → honest empty state) ---- */
  const inventoryRead = await safeRead(
    () =>
      db
        .selectFrom('inventory_stock_levels')
        .select(['on_hand'])
        .where('tenant_id', '=', tenantId)
        .execute(),
    [] as { on_hand: number }[],
  );
  const inventory: OwnerDashboardData['inventory'] = inventoryRead.available
    ? {
        available: true,
        trackedItems: inventoryRead.value.length,
        unitsOnHand: inventoryRead.value.reduce((a, r) => a + Math.max(0, r.on_hand), 0),
        oversoldItems: inventoryRead.value.filter((r) => r.on_hand < 0).length,
      }
    : { available: false };

  const totalPaymentGross = gross;
  const totalDow = perWeekday.reduce(
    (a, d) => ({ paymentCount: a.paymentCount + d.paymentCount, grossCents: a.grossCents + d.grossCents }),
    { paymentCount: 0, grossCents: 0 },
  );

  return {
    tenantName,
    timezone: SHOP_TZ,
    available: true,
    dataAsOf,
    dataAsOfLocalDate: asOfLocal,
    dataFirstLocalDate: firstLocal,
    allTime: {
      grossCents: gross,
      paymentCount: payments.length,
      averageTicketCents: payments.length > 0 ? Math.round(gross / payments.length) : null,
    },
    ytd,
    yearly: [...perYear.entries()]
      .sort(([a], [b]) => a - b)
      .map(([y, v]) => ({ year: y, ...v })),
    weeklyTrend,
    dayOfWeek: WEEKDAY_LABELS.map((label, i) => ({
      weekday: label,
      paymentCount: perWeekday[i].paymentCount,
      grossCents: perWeekday[i].grossCents,
      paymentSharePct: pct(perWeekday[i].paymentCount, totalDow.paymentCount) ?? 0,
      grossSharePct: pct(perWeekday[i].grossCents, totalDow.grossCents) ?? 0,
    })),
    topItems12mo: asTopItems(topItems12moRead.value),
    topItemsAllTime: asTopItems(topItemsAllRead.value),
    topCategories12mo: topCategoriesRead.value.map((r) => ({
      name: r.category_name ?? '(no category)',
      revenueCents: Number(r.revenue),
    })),
    refunds: {
      available: refundsRead.available,
      allTimeCount: refundAllCount,
      allTimeCents: refundAllCents,
      last12moCount: refund12Count,
      last12moCents: refund12Cents,
    },
    fees: {
      totalCents: fees,
      effectiveBps: totalPaymentGross > 0 ? Math.round((fees / totalPaymentGross) * 10000) : null,
      paymentsWithFeeData: feeCount,
      paymentsTotal: payments.length,
    },
    customers: {
      available: crmRead.available,
      total: totalCustomers,
      withEmail,
      withPhone,
      emailPct: pct(withEmail, totalCustomers),
      repeatRatePct: pct(repeatBuyers, buyers),
      identifiedPaymentPct: pct(identified, payments.length),
    },
    imports: {
      available: importsRead.available,
      runCount: importsRead.value.length,
      lastRun: lastRun
        ? {
            source: lastRun.source,
            finishedAt: lastRun.finished_at,
            paymentsInserted: lastRun.payments_inserted,
            linesInserted: lastRun.lines_inserted,
            refundsInserted: lastRun.refunds_inserted,
            completedGrossCentsAfter: lastRun.completed_gross_cents_after,
          }
        : null,
    },
    inventory,
    outreach: { configured: false },
    forecast: buildForecast(weekMap, firstWeek, lastCompletedWeek, asOfLocal),
  };
}
