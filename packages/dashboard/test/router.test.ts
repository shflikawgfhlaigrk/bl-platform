import { describe, expect, it } from 'vitest';
import { asCoreDb, createTenant, parseCsv } from '@blacklabel/core';
import { KPI_DEFINITIONS, WIDGET_CATALOG } from '../src/service';
import { seedDashboard } from '../src/seed';
import { FEB, createSourceTables, headers, seedSources, seedTenantB, setup } from './fixtures';

describe('tenant middleware wiring', () => {
  it('400s without x-tenant-id and 404s on unknown tenant', async () => {
    const { app } = await setup();
    const missing = await app.request('/widgets/revenue');
    expect(missing.status).toBe(400);
    const unknown = await app.request('/widgets/revenue', { headers: { 'x-tenant-id': 'nope' } });
    expect(unknown.status).toBe(404);
  });

  it('rejects invalid from/to params with 400', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request('/widgets/revenue?from=garbage', { headers: headers(tenantA) });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error.code).toBe('bad_request');
  });
});

describe('aggregation endpoints through the router', () => {
  it('serves each widget with the canonical envelope, range echo and tenant scoping', async () => {
    const { app, db, tenantA, tenantB, expected } = await (async () => {
      const ctx = await setup();
      await createSourceTables(ctx.db);
      const expected = await seedSources(ctx.db, ctx.tenantA.id, 'a');
      await seedTenantB(ctx.db, ctx.tenantB.id);
      return { ...ctx, expected };
    })();

    const revenue = await app.request(`/widgets/revenue?from=${FEB.from}&to=${FEB.to}`, { headers: headers(tenantA) });
    expect(revenue.status).toBe(200);
    const revenueBody = (await revenue.json() as any).data;
    expect(revenueBody.key).toBe('revenue');
    expect(revenueBody.range.from).toBe('2026-02-01T00:00:00.000Z');
    expect(revenueBody.paidCents).toBe(expected.inv2TotalCents);

    const leads = await app.request('/widgets/leads-by-source', { headers: headers(tenantB) });
    expect((await leads.json() as any).data.totalLeads).toBe(1); // B sees only its own lead

    const conversion = await app.request('/widgets/quote-conversion', { headers: headers(tenantA) });
    expect((await conversion.json() as any).data.conversionBps).toBe(4000);

    const tasks = await app.request('/widgets/open-tasks', { headers: headers(tenantA) });
    expect((await tasks.json() as any).data.open).toBe(3);

    const activity = await app.request('/widgets/employee-activity', { headers: headers(tenantA) });
    expect((await activity.json() as any).data.timeEntries.totalMinutes).toBe(180);

    const reviews = await app.request('/widgets/reviews', { headers: headers(tenantA) });
    expect((await reviews.json() as any).data.averageRating).toBe(3.75);

    const appointments = await app.request('/widgets/appointments', { headers: headers(tenantA) });
    expect((await appointments.json() as any).data.completed).toBe(3);
    void db;
  });

  it('placeholder widgets return the documented {placeholder:true} contracts', async () => {
    const { app, tenantA } = await setup();
    const traffic = (await (await app.request('/widgets/website-traffic', { headers: headers(tenantA) })).json() as any).data;
    expect(traffic).toMatchObject({
      key: 'website_traffic',
      placeholder: true,
      available: false,
      metrics: { visits: null, uniqueVisitors: null, topPages: [] },
    });
    expect(traffic.contract).toMatch(/topPages/);

    const campaigns = (await (await app.request('/widgets/campaign-performance', { headers: headers(tenantA) })).json() as any).data;
    expect(campaigns).toMatchObject({
      key: 'campaign_performance',
      placeholder: true,
      metrics: { totalSpendCents: null, totalLeads: null, campaigns: [] },
    });
  });

  it('serves recent activity with a limit param', async () => {
    const { app, tenantA } = await setup();
    // Config mutations write audit entries → they appear on the timeline.
    await app.request('/config', {
      method: 'PUT',
      headers: headers(tenantA),
      body: JSON.stringify({ widgets: [{ widgetKey: 'revenue' }] }),
    });
    const res = await app.request('/widgets/recent-activity?limit=5', { headers: headers(tenantA) });
    const { entries } = (await res.json() as any).data;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]).toMatchObject({ action: 'dashboard.widget_config.updated', entityType: 'dashboard.widget_config' });
  });
});

describe('KPI definitions endpoint', () => {
  it('returns machine-readable name/description/formula/unit for every metric', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request('/kpis', { headers: headers(tenantA) });
    const kpis = (await res.json() as any).data;
    expect(kpis).toHaveLength(KPI_DEFINITIONS.length);
    for (const kpi of kpis) {
      expect(kpi.key).toBeTruthy();
      expect(kpi.name).toBeTruthy();
      expect(kpi.description).toBeTruthy();
      expect(kpi.formula).toBeTruthy();
      expect(['cents', 'count', 'bps', 'rating', 'minutes']).toContain(kpi.unit);
    }
    const revenue = kpis.find((k: { key: string }) => k.key === 'revenue_cents');
    expect(revenue.formula).toMatch(/SUM\(billing_invoices\.total_cents\)/);
  });

  it('exposes the widget catalog', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request('/widgets', { headers: headers(tenantA) });
    const catalog = (await res.json() as any).data;
    expect(catalog).toHaveLength(WIDGET_CATALOG.length);
    expect(catalog.map((w: { key: string }) => w.key)).toContain('leads_by_source');
  });
});

describe('export summary', () => {
  it('returns a JSON rollup of every KPI over the range', async () => {
    const { app, db, tenantA } = await setup();
    await createSourceTables(db);
    const expected = await seedSources(db, tenantA.id, 'a');

    const res = await app.request('/export', { headers: headers(tenantA) });
    expect(res.status).toBe(200);
    const summary = (await res.json() as any).data;
    expect(summary.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(summary.metrics).toHaveLength(KPI_DEFINITIONS.length);
    const byKey = Object.fromEntries(summary.metrics.map((m: { key: string }) => [m.key, m]));
    expect(byKey.revenue_cents.value).toBe(expected.paidCents);
    expect(byKey.open_tasks.value).toBe(3);
    expect(byKey.reviews_avg_rating.value).toBe(3.75);
    expect(byKey.revenue_cents.available).toBe(true);
  });

  it('returns CSV when ?format=csv and 400s on unknown formats', async () => {
    const { app, db, tenantA } = await setup();
    await createSourceTables(db);
    const expected = await seedSources(db, tenantA.id, 'a');

    const res = await app.request('/export?format=csv', { headers: headers(tenantA) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const rows = parseCsv(await res.text());
    expect(rows).toHaveLength(KPI_DEFINITIONS.length);
    const revenue = rows.find((r) => r.key === 'revenue_cents');
    expect(revenue).toBeDefined();
    expect(Number(revenue!.value)).toBe(expected.paidCents);

    const bad = await app.request('/export?format=xml', { headers: headers(tenantA) });
    expect(bad.status).toBe(400);
  });

  it('date-filters the export', async () => {
    const { app, db, tenantA } = await setup();
    await createSourceTables(db);
    const expected = await seedSources(db, tenantA.id, 'a');
    const res = await app.request(`/export?from=${FEB.from}&to=${FEB.to}`, { headers: headers(tenantA) });
    const byKey = Object.fromEntries(
      ((await res.json() as any).data.metrics as { key: string; value: number }[]).map((m) => [m.key, m]),
    );
    expect(byKey.revenue_cents.value).toBe(expected.inv2TotalCents);
    expect(byKey.leads_created.value).toBe(2);
    expect(byKey.quote_conversion_bps.value).toBe(3333);
  });
});

describe('server-rendered HTML dashboard', () => {
  it('renders live numbers for the tenant', async () => {
    const { app, db, tenantA } = await setup();
    await createSourceTables(db);
    const expected = await seedSources(db, tenantA.id, 'a');

    const res = await app.request('/', { headers: headers(tenantA) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Alpha Services');
    // Paid revenue rendered as dollars, formatted to the cent.
    const dollars = (expected.paidCents / 100).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    expect(html).toContain(`$${dollars}`);
    expect(html).toContain('Leads by source');
    expect(html).toContain('referral');
    expect(html).toContain('40.0%'); // quote conversion
  });

  it('renders only the tenant\'s enabled widgets, in configured order', async () => {
    const { app, db, tenantA } = await setup();
    await createSourceTables(db);
    await seedSources(db, tenantA.id, 'a');
    await app.request('/config', {
      method: 'PUT',
      headers: headers(tenantA),
      body: JSON.stringify({
        widgets: [
          { widgetKey: 'reviews' },
          { widgetKey: 'revenue', enabled: false },
        ],
      }),
    });
    const html = await (await app.request('/', { headers: headers(tenantA) })).text();
    expect(html).toContain('Reviews summary');
    expect(html).not.toContain('Revenue summary'); // disabled
    expect(html).not.toContain('Leads by source'); // not in saved config
  });

  it('escapes HTML in dynamic values', async () => {
    const { app, db } = await setup();
    const evil = await createTenant(asCoreDb(db), { name: '<script>alert(1)</script>' });
    const html = await (await app.request('/', { headers: headers(evil) })).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('seed helper', () => {
  it('seeds a saved config and alert rules for the tenant only', async () => {
    const { app, db, tenantA, tenantB } = await setup();
    await seedDashboard(db, tenantA.id);

    const aConfig = (await (await app.request('/config', { headers: headers(tenantA) })).json() as any).data;
    expect(aConfig.configured).toBe(true);
    expect(aConfig.widgets).toHaveLength(WIDGET_CATALOG.length);

    const aAlerts = (await (await app.request('/alerts', { headers: headers(tenantA) })).json() as any).data;
    expect(aAlerts).toHaveLength(2);

    const bConfig = (await (await app.request('/config', { headers: headers(tenantB) })).json() as any).data;
    expect(bConfig.configured).toBe(false);
    const bAlerts = (await (await app.request('/alerts', { headers: headers(tenantB) })).json() as any).data;
    expect(bAlerts).toEqual([]);
  });
});
