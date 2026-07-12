import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { setup, headers } from './fixtures';
import type { DashboardDatabase } from '../src/schema';
import { collectOwnerDashboardData } from '../src/owner';

/**
 * Owner dashboard tests. The dashboard only READS the retail and crm tables,
 * so (per this suite's convention) tests create minimal fixture tables
 * matching the read contracts in schema.ts.
 *
 * The sales fixture is engineered so the forecast is exactly checkable:
 * every week's gross is 1.10 × the same week 364 days earlier, so the trend
 * factor is 1.10 and backtest misses are rounding-level only.
 */

async function createRetailSourceTables(db: Kysely<DashboardDatabase>): Promise<void> {
  await db.schema
    .createTable('retail_payments')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('source_id', 'text') // extra beyond the read contract
    .addColumn('paid_at', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('amount_cents', 'integer', (c) => c.notNull())
    .addColumn('fee_cents', 'integer')
    .addColumn('customer_source_id', 'text')
    .addColumn('order_source_id', 'text')
    .execute();
  await db.schema
    .createTable('retail_order_lines')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('source_order_id', 'text', (c) => c.notNull())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('quantity', 'real', (c) => c.notNull())
    .addColumn('total_cents', 'integer', (c) => c.notNull())
    .addColumn('category_name', 'text')
    .execute();
  await db.schema
    .createTable('retail_refunds')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('refunded_at', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('amount_cents', 'integer', (c) => c.notNull())
    .execute();
  await db.schema
    .createTable('retail_import_runs')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('source', 'text', (c) => c.notNull())
    .addColumn('finished_at', 'text', (c) => c.notNull())
    .addColumn('payments_inserted', 'integer', (c) => c.notNull())
    .addColumn('lines_inserted', 'integer', (c) => c.notNull())
    .addColumn('refunds_inserted', 'integer', (c) => c.notNull())
    .addColumn('completed_gross_cents_after', 'integer', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema
    .createTable('crm_customers')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('email', 'text')
    .addColumn('phone', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
  // inventory_stock_levels deliberately NOT created — module not shipped;
  // the owner page must degrade to the honest "not yet counted" state.
}

/** Saturdays only, weekly, growth-locked 1.10× year over year. */
interface Seeded {
  totalCents: number;
  weeks: { saturday: string; amountCents: number }[];
}

function isoSaturday(weekIndex: number): string {
  // Week 0 Saturday = 2024-01-06 (UTC noon → same date in America/New_York).
  const base = Date.UTC(2024, 0, 6, 17, 0, 0);
  return new Date(base + weekIndex * 7 * 24 * 3600 * 1000).toISOString();
}

async function seedSales(
  db: Kysely<DashboardDatabase>,
  tenantId: string,
  weekCount: number,
): Promise<Seeded> {
  const amounts: number[] = [];
  for (let i = 0; i < weekCount; i += 1) {
    amounts.push(i < 52 ? 50000 + i * 1000 : Math.round(amounts[i - 52] * 1.1));
  }
  const weeks = amounts.map((amountCents, i) => ({ saturday: isoSaturday(i), amountCents }));

  const rows = weeks.map((w, i) => ({
    id: `p_${tenantId}_${i}`,
    tenant_id: tenantId,
    paid_at: w.saturday,
    status: 'COMPLETED',
    amount_cents: w.amountCents,
    fee_cents: Math.round(w.amountCents * 0.02),
    customer_source_id: i % 3 === 0 ? 'cust_repeat' : i % 3 === 1 ? `cust_${i}` : null,
    order_source_id: `ord_${i}`,
  }));
  for (let i = 0; i < rows.length; i += 100) {
    await db.insertInto('retail_payments').values(rows.slice(i, i + 100)).execute();
  }
  // One failed payment that must be excluded everywhere.
  await db
    .insertInto('retail_payments')
    .values({
      id: `p_${tenantId}_failed`,
      tenant_id: tenantId,
      paid_at: isoSaturday(weekCount - 1),
      status: 'FAILED',
      amount_cents: 999999,
      fee_cents: null,
      customer_source_id: null,
      order_source_id: null,
    })
    .execute();

  const lines = weeks.slice(-8).map((w, i) => ({
    id: `l_${tenantId}_${i}`,
    tenant_id: tenantId,
    source_order_id: `ord_${weekCount - 8 + i}`,
    name: i % 2 === 0 ? 'Ellany Elastic Belt' : 'LeMieux Saddle Pad',
    quantity: 1,
    total_cents: w.amountCents,
    category_name: i % 2 === 0 ? 'Belts' : 'Saddle Pads',
  }));
  await db.insertInto('retail_order_lines').values(lines).execute();

  return { totalCents: amounts.reduce((a, b) => a + b, 0), weeks };
}

async function ownerSetup(weekCount = 130) {
  const ctx = await setup();
  await createRetailSourceTables(ctx.db);
  const seeded = await seedSales(ctx.db, ctx.tenantA.id, weekCount);
  await ctx.db
    .insertInto('crm_customers')
    .values([
      { id: 'c1', tenant_id: ctx.tenantA.id, email: 'a@x.com', phone: null, created_at: '2024-01-01T00:00:00.000Z' },
      { id: 'c2', tenant_id: ctx.tenantA.id, email: null, phone: '555-1', created_at: '2024-01-01T00:00:00.000Z' },
      { id: 'c3', tenant_id: ctx.tenantA.id, email: '', phone: null, created_at: '2024-01-01T00:00:00.000Z' },
    ])
    .execute();
  await ctx.db
    .insertInto('retail_refunds')
    .values({
      id: 'r1',
      tenant_id: ctx.tenantA.id,
      refunded_at: seeded.weeks[weekCount - 1].saturday,
      status: 'COMPLETED',
      amount_cents: 5000,
    })
    .execute();
  await ctx.db
    .insertInto('retail_import_runs')
    .values({
      id: 'run1',
      tenant_id: ctx.tenantA.id,
      source: 'square-ledger',
      finished_at: '2026-07-12T00:00:00.000Z',
      payments_inserted: weekCount,
      lines_inserted: 8,
      refunds_inserted: 1,
      completed_gross_cents_after: seeded.totalCents,
      created_at: '2026-07-12T00:00:00.000Z',
    })
    .execute();
  return { ...ctx, seeded };
}

describe('owner dashboard analytics', () => {
  it('computes all-time gross to the cent, excluding non-completed payments', async () => {
    const { db, tenantA, seeded } = await ownerSetup();
    const d = await collectOwnerDashboardData(db, tenantA.id);
    expect(d.available).toBe(true);
    expect(d.allTime.grossCents).toBe(seeded.totalCents);
    expect(d.allTime.paymentCount).toBe(seeded.weeks.length);
    expect(d.allTime.averageTicketCents).toBe(
      Math.round(seeded.totalCents / seeded.weeks.length),
    );
  });

  it('buckets Saturdays as Saturday in shop time and shows 100% Saturday share', async () => {
    const { db, tenantA } = await ownerSetup();
    const d = await collectOwnerDashboardData(db, tenantA.id);
    const saturday = d.dayOfWeek.find((r) => r.weekday === 'Saturday');
    expect(saturday?.paymentSharePct).toBe(100);
    expect(d.dayOfWeek.filter((r) => r.paymentCount > 0)).toHaveLength(1);
  });

  it('data-as-of is the max payment timestamp, never the wall clock', async () => {
    const { db, tenantA, seeded } = await ownerSetup();
    const d = await collectOwnerDashboardData(db, tenantA.id);
    expect(d.dataAsOf).toBe(seeded.weeks[seeded.weeks.length - 1].saturday);
  });

  it('YTD compares against the same period last year and is exact', async () => {
    const { db, tenantA, seeded } = await ownerSetup();
    const d = await collectOwnerDashboardData(db, tenantA.id);
    expect(d.ytd).not.toBeNull();
    const year = d.ytd!.year;
    const inYear = (iso: string, y: number) => iso.startsWith(String(y));
    // Saturdays at 17:00 UTC are the same calendar date in America/New_York,
    // so a UTC-year filter matches the shop-time bucketing exactly here.
    const expectYtd = seeded.weeks
      .filter((w) => inYear(w.saturday, year) && w.saturday <= d.dataAsOf!)
      .reduce((a, w) => a + w.amountCents, 0);
    expect(d.ytd!.grossCents).toBe(expectYtd);
    expect(d.ytd!.lastYearGrossCents).not.toBeNull();
    expect(d.ytd!.pctChange).not.toBeNull();
  });

  it('top items/categories come from lines of completed orders only', async () => {
    const { db, tenantA } = await ownerSetup();
    const d = await collectOwnerDashboardData(db, tenantA.id);
    expect(d.topItems12mo.length).toBeGreaterThan(0);
    const names = d.topItems12mo.map((i) => i.name);
    expect(names).toContain('Ellany Elastic Belt');
    expect(d.topCategories12mo.map((c) => c.name)).toContain('Belts');
  });

  it('reports customers, repeat rate, refunds, and fees from real rows', async () => {
    const { db, tenantA, seeded } = await ownerSetup();
    const d = await collectOwnerDashboardData(db, tenantA.id);
    expect(d.customers.available).toBe(true);
    expect(d.customers.total).toBe(3);
    expect(d.customers.withEmail).toBe(1); // blank string does not count
    expect(d.customers.repeatRatePct).not.toBeNull();
    expect(d.refunds.allTimeCount).toBe(1);
    expect(d.refunds.allTimeCents).toBe(5000);
    const expectedFees = seeded.weeks.reduce((a, w) => a + Math.round(w.amountCents * 0.02), 0);
    expect(d.fees.totalCents).toBe(expectedFees);
    expect(d.fees.effectiveBps).toBe(Math.round((expectedFees / seeded.totalCents) * 10000));
  });

  it('inventory degrades to an honest not-yet-counted state when the module is absent', async () => {
    const { db, tenantA } = await ownerSetup();
    const d = await collectOwnerDashboardData(db, tenantA.id);
    expect(d.inventory).toEqual({ available: false });
    expect(d.outreach).toEqual({ configured: false });
  });
});

describe('owner forecast (deterministic, backtested)', () => {
  it('produces a forecast with a ~1.10 trend and near-zero backtest error on the locked fixture', async () => {
    const { db, tenantA } = await ownerSetup(130);
    const d = await collectOwnerDashboardData(db, tenantA.id);
    expect(d.forecast.available).toBe(true);
    if (!d.forecast.available) return;
    expect(d.forecast.growthFactorPct).toBeGreaterThan(109);
    expect(d.forecast.growthFactorPct).toBeLessThan(111);
    expect(d.forecast.backtest.mapePct).not.toBeNull();
    expect(d.forecast.backtest.mapePct!).toBeLessThan(1);
    expect(d.forecast.weekly.length).toBeGreaterThan(0);
    // Monthly rollup equals the sum of its weeks.
    const weeklySum = d.forecast.weekly.reduce((a, w) => a + w.forecastCents, 0);
    const monthlySum = d.forecast.monthly.reduce((a, m) => a + m.forecastCents, 0);
    expect(monthlySum).toBe(weeklySum);
    // Every forecast week cites its real basis week from a year earlier.
    for (const w of d.forecast.weekly) {
      expect(w.basisWeekEnding < w.weekEnding).toBe(true);
    }
  });

  it('refuses to forecast when history is too short, with an honest reason', async () => {
    const { db, tenantA } = await ownerSetup(40); // < 86 weeks
    const d = await collectOwnerDashboardData(db, tenantA.id);
    expect(d.forecast.available).toBe(false);
    if (d.forecast.available) return;
    expect(d.forecast.reason).toMatch(/history/i);
  });
});

describe('owner dashboard router + isolation', () => {
  it('serves the HTML page and the JSON twin', async () => {
    const { app, tenantA } = await ownerSetup();
    const page = await app.request('/owner', { headers: headers(tenantA) });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Owner Dashboard');
    expect(html).toContain('Rest-of-year forecast');
    expect(html).toContain('not yet counted');

    const json = await app.request('/owner.json', { headers: headers(tenantA) });
    expect(json.status).toBe(200);
    expect((((await json.json()) as any).data as any).available).toBe(true);
  });

  it('renders an honest empty page for a tenant with no sales', async () => {
    const { app, db, tenantB } = await ownerSetup();
    const d = await collectOwnerDashboardData(db, tenantB.id);
    expect(d.available).toBe(false);
    const page = await app.request('/owner', { headers: headers(tenantB) });
    const html = await page.text();
    expect(html).toContain('No sales data yet');
  });

  it('does not crash when the retail tables do not exist at all', async () => {
    const { db, tenantA, app } = await setup(); // no source tables created
    const d = await collectOwnerDashboardData(db, tenantA.id);
    expect(d.available).toBe(false);
    const page = await app.request('/owner', { headers: headers(tenantA) });
    expect(page.status).toBe(200);
  });

  it('requires the tenant header', async () => {
    const { app } = await ownerSetup();
    const res = await app.request('/owner');
    expect(res.status).toBe(400);
  });
});
