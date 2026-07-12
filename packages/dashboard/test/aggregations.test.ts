import { describe, expect, it } from 'vitest';
import {
  appointmentsSummary,
  computeMetric,
  employeeActivity,
  leadsBySource,
  openTasksSummary,
  parseDateRange,
  quoteConversion,
  recentActivity,
  reviewsSummary,
  revenueSummary,
} from '../src/service';
import { audit, asCoreDb } from '@blacklabel/core';
import { FEB, createSourceTables, seedSources, seedTenantB, setup } from './fixtures';

async function seededSetup() {
  const ctx = await setup();
  await createSourceTables(ctx.db);
  const expected = await seedSources(ctx.db, ctx.tenantA.id, 'a');
  await seedTenantB(ctx.db, ctx.tenantB.id);
  return { ...ctx, expected };
}

describe('date-range parsing', () => {
  it('expands date-only values and normalizes to UTC Z text', () => {
    const range = parseDateRange({ from: '2026-02-01', to: '2026-02-28' });
    expect(range.from).toBe('2026-02-01T00:00:00.000Z');
    expect(range.to).toBe('2026-02-28T23:59:59.999Z');
  });

  it('rejects garbage and inverted ranges', () => {
    expect(() => parseDateRange({ from: 'not-a-date' })).toThrowError(/invalid "from"/);
    expect(() => parseDateRange({ from: '2026-03-01', to: '2026-01-01' })).toThrowError(/must be <=/);
  });
});

describe('revenue summary (billing)', () => {
  it('sums paid invoices to the cent using core computeTotals-derived fixtures', async () => {
    const { db, tenantA, expected } = await seededSetup();
    const r = await revenueSummary(db, tenantA.id);
    expect(r.available).toBe(true);
    expect(r.paidCents).toBe(expected.paidCents); // exact, to the cent
    expect(r.paidCount).toBe(2);
    expect(r.invoiceCount).toBe(6);
    const statuses = Object.fromEntries(r.byStatus.map((s) => [s.status, s]));
    expect(statuses.sent).toEqual({ status: 'sent', count: 1, totalCents: 50000 });
    expect(statuses.void.count).toBe(1);
    expect(statuses.overdue.count).toBe(1);
  });

  it('applies the from/to filter on created_at', async () => {
    const { db, tenantA, expected } = await seededSetup();
    const r = await revenueSummary(db, tenantA.id, parseDateRange(FEB));
    expect(r.paidCents).toBe(expected.inv2TotalCents);
    expect(r.paidCount).toBe(1);
    expect(r.invoiceCount).toBe(2); // paid Feb + sent Feb
  });

  it('is tenant-scoped', async () => {
    const { db, tenantA, tenantB, expected } = await seededSetup();
    const a = await revenueSummary(db, tenantA.id);
    const b = await revenueSummary(db, tenantB.id);
    expect(a.paidCents).toBe(expected.paidCents);
    expect(b.paidCents).toBe(999);
    expect(b.invoiceCount).toBe(1);
  });
});

describe('leads by source (crm)', () => {
  it('groups by source, merging NULL into "unknown", sorted by count desc', async () => {
    const { db, tenantA } = await seededSetup();
    const r = await leadsBySource(db, tenantA.id);
    expect(r.totalLeads).toBe(6);
    expect(r.sources).toEqual([
      { source: 'referral', count: 3 },
      { source: 'web', count: 2 },
      { source: 'unknown', count: 1 },
    ]);
  });

  it('date-filters and stays tenant-scoped', async () => {
    const { db, tenantA, tenantB } = await seededSetup();
    const feb = await leadsBySource(db, tenantA.id, parseDateRange(FEB));
    expect(feb.totalLeads).toBe(2);
    expect(feb.sources).toEqual([{ source: 'web', count: 2 }]);
    const b = await leadsBySource(db, tenantB.id);
    expect(b.totalLeads).toBe(1);
  });
});

describe('appointments (scheduling)', () => {
  it('counts by status with completed extracted', async () => {
    const { db, tenantA } = await seededSetup();
    const r = await appointmentsSummary(db, tenantA.id);
    expect(r.total).toBe(6);
    expect(r.completed).toBe(3);
    expect(r.byStatus).toEqual([
      { status: 'canceled', count: 1 },
      { status: 'completed', count: 3 },
      { status: 'scheduled', count: 2 },
    ]);
  });

  it('date-filters', async () => {
    const { db, tenantA } = await seededSetup();
    const r = await appointmentsSummary(db, tenantA.id, parseDateRange(FEB));
    expect(r.total).toBe(3);
    expect(r.completed).toBe(3);
  });
});

describe('quote conversion (quoting)', () => {
  it('computes sent → approved conversion in bps', async () => {
    const { db, tenantA } = await seededSetup();
    const r = await quoteConversion(db, tenantA.id);
    expect(r.sent).toBe(5); // everything non-draft
    expect(r.approved).toBe(2); // approved + converted
    expect(r.conversionBps).toBe(4000);
  });

  it('date-filters and returns 0 bps when nothing sent', async () => {
    const { db, tenantA, tenantB } = await seededSetup();
    const feb = await quoteConversion(db, tenantA.id, parseDateRange(FEB));
    expect(feb.sent).toBe(3);
    expect(feb.approved).toBe(1);
    expect(feb.conversionBps).toBe(3333);
    const b = await quoteConversion(db, tenantB.id); // tenant B has no quotes
    expect(b.sent).toBe(0);
    expect(b.conversionBps).toBe(0);
  });
});

describe('open tasks (workflows)', () => {
  it('counts non-closed statuses as open', async () => {
    const { db, tenantA } = await seededSetup();
    const r = await openTasksSummary(db, tenantA.id);
    expect(r.total).toBe(6);
    expect(r.open).toBe(3); // open ×2 + in_progress ×1
  });

  it('date-filters', async () => {
    const { db, tenantA } = await seededSetup();
    const r = await openTasksSummary(db, tenantA.id, parseDateRange(FEB));
    expect(r.open).toBe(2);
    expect(r.total).toBe(3);
  });
});

describe('employee activity (portal-employee)', () => {
  it('computes minutes from started/ended, tracks open entries and worklogs per user', async () => {
    const { db, tenantA } = await seededSetup();
    const r = await employeeActivity(db, tenantA.id);
    expect(r.available).toBe(true);
    expect(r.timeEntries).toEqual({ available: true, count: 4, openCount: 1, totalMinutes: 180 });
    expect(r.worklogs).toEqual({ available: true, count: 3 });
    expect(r.users).toEqual([
      { employeeId: 'u-emp1', timeEntryCount: 3, minutes: 150, worklogCount: 2 },
      { employeeId: 'u-emp2', timeEntryCount: 1, minutes: 30, worklogCount: 1 },
    ]);
  });

  it('date-filters both sources', async () => {
    const { db, tenantA } = await seededSetup();
    const r = await employeeActivity(db, tenantA.id, parseDateRange(FEB));
    expect(r.timeEntries.count).toBe(2);
    expect(r.timeEntries.totalMinutes).toBe(120);
    expect(r.worklogs.count).toBe(2);
  });
});

describe('reviews summary (reviews)', () => {
  it('computes count, 2-decimal average and 1..5 distribution', async () => {
    const { db, tenantA } = await seededSetup();
    const r = await reviewsSummary(db, tenantA.id);
    expect(r.count).toBe(4);
    expect(r.averageRating).toBe(3.75);
    expect(r.distribution).toEqual({ '1': 0, '2': 1, '3': 0, '4': 2, '5': 1 });
  });

  it('date-filters and reports null average when empty', async () => {
    const { db, tenantA, tenantB } = await seededSetup();
    const feb = await reviewsSummary(db, tenantA.id, parseDateRange(FEB));
    expect(feb.count).toBe(2);
    expect(feb.averageRating).toBe(4);
    const b = await reviewsSummary(db, tenantB.id);
    expect(b.count).toBe(0);
    expect(b.averageRating).toBeNull();
  });
});

describe('recent activity (core audit log)', () => {
  it('returns latest entries newest-first, tenant-scoped, respecting limit and range', async () => {
    const { db, tenantA, tenantB } = await setup();
    const core = asCoreDb(db);
    // Explicit timestamps so ordering is deterministic (audit() stamps "now").
    const mkRow = (tid: string, actor: string, action: string, entityType: string, entityId: string, createdAt: string) => ({
      id: `audit-${entityId}`,
      tenant_id: tid,
      actor,
      action,
      entity_type: entityType,
      entity_id: entityId,
      diff: null,
      created_at: createdAt,
    });
    await core
      .insertInto('audit_log')
      .values([
        mkRow(tenantA.id, 'u1', 'crm.lead.created', 'crm.lead', 'l1', '2026-07-01T10:00:00.000Z'),
        mkRow(tenantA.id, 'u1', 'quoting.quote.approved', 'quoting.quote', 'q1', '2026-07-02T10:00:00.000Z'),
        mkRow(tenantA.id, 'u2', 'billing.invoice.paid', 'billing.invoice', 'i1', '2026-07-03T10:00:00.000Z'),
      ])
      .execute();
    await audit(core, tenantB.id, 'ub', 'reviews.review.submitted', 'reviews.review', 'r1');

    const entries = await recentActivity(db, tenantA.id, {}, 2);
    expect(entries).toHaveLength(2);
    expect(entries[0].action).toBe('billing.invoice.paid');
    expect(entries[1].action).toBe('quoting.quote.approved');

    const bEntries = await recentActivity(db, tenantB.id);
    expect(bEntries).toHaveLength(1);
    expect(bEntries[0].actor).toBe('ub');

    const none = await recentActivity(db, tenantA.id, { to: '2000-01-01T00:00:00.000Z' });
    expect(none).toEqual([]);
  });
});

describe('graceful degradation when source modules are absent', () => {
  it('every aggregation reports available:false with zeroed data instead of erroring', async () => {
    const { db, tenantA } = await setup(); // NO source tables created
    const revenue = await revenueSummary(db, tenantA.id);
    expect(revenue).toEqual({ available: false, invoiceCount: 0, paidCount: 0, paidCents: 0, byStatus: [] });
    expect((await leadsBySource(db, tenantA.id)).available).toBe(false);
    expect((await appointmentsSummary(db, tenantA.id)).available).toBe(false);
    expect((await quoteConversion(db, tenantA.id)).available).toBe(false);
    expect((await openTasksSummary(db, tenantA.id)).available).toBe(false);
    const activity = await employeeActivity(db, tenantA.id);
    expect(activity.available).toBe(false);
    expect(activity.timeEntries.totalMinutes).toBe(0);
    const reviews = await reviewsSummary(db, tenantA.id);
    expect(reviews).toEqual({
      available: false,
      count: 0,
      averageRating: null,
      distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
    });
  });
});

describe('computeMetric', () => {
  it('maps every KPI key to the right aggregation value', async () => {
    const { db, tenantA, expected } = await seededSetup();
    expect((await computeMetric(db, tenantA.id, 'revenue_cents')).value).toBe(expected.paidCents);
    expect((await computeMetric(db, tenantA.id, 'invoices_paid')).value).toBe(2);
    expect((await computeMetric(db, tenantA.id, 'leads_created')).value).toBe(6);
    expect((await computeMetric(db, tenantA.id, 'appointments_total')).value).toBe(6);
    expect((await computeMetric(db, tenantA.id, 'appointments_completed')).value).toBe(3);
    expect((await computeMetric(db, tenantA.id, 'quotes_sent')).value).toBe(5);
    expect((await computeMetric(db, tenantA.id, 'quotes_approved')).value).toBe(2);
    expect((await computeMetric(db, tenantA.id, 'quote_conversion_bps')).value).toBe(4000);
    expect((await computeMetric(db, tenantA.id, 'open_tasks')).value).toBe(3);
    expect((await computeMetric(db, tenantA.id, 'time_entry_minutes')).value).toBe(180);
    expect((await computeMetric(db, tenantA.id, 'worklogs_count')).value).toBe(3);
    expect((await computeMetric(db, tenantA.id, 'reviews_count')).value).toBe(4);
    expect((await computeMetric(db, tenantA.id, 'reviews_avg_rating')).value).toBe(3.75);
  });

  it('rejects unknown metric keys', async () => {
    const { db, tenantA } = await setup();
    await expect(computeMetric(db, tenantA.id, 'nonsense')).rejects.toThrowError(/unknown metric/);
  });
});
