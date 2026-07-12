import { describe, expect, it } from 'vitest';
import { asCoreDb, coreMigrations, createTenant, EventBus } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { crmMigrations, seedCrm, type CrmDatabase } from '@blacklabel/crm';

async function freshDb() {
  const db = createTestDb<CrmDatabase>();
  await runMigrations(db, [...coreMigrations, ...crmMigrations]);
  return db;
}

describe('seedCrm', () => {
  it('creates realistic sample data scoped to the tenant', async () => {
    const db = await freshDb();
    const tenant = await createTenant(asCoreDb(db), { name: 'Seeded Tenant' });
    const summary = await seedCrm(db, tenant.id);

    expect(summary.customers).toBeGreaterThan(0);
    expect(summary.leads).toBeGreaterThan(0);

    const counts = {
      companies: await db.selectFrom('crm_companies').selectAll().where('tenant_id', '=', tenant.id).execute(),
      customers: await db.selectFrom('crm_customers').selectAll().where('tenant_id', '=', tenant.id).execute(),
      contacts: await db.selectFrom('crm_contacts').selectAll().where('tenant_id', '=', tenant.id).execute(),
      leads: await db.selectFrom('crm_leads').selectAll().where('tenant_id', '=', tenant.id).execute(),
      deals: await db.selectFrom('crm_deals').selectAll().where('tenant_id', '=', tenant.id).execute(),
      jobs: await db.selectFrom('crm_jobs').selectAll().where('tenant_id', '=', tenant.id).execute(),
      notes: await db.selectFrom('crm_notes').selectAll().where('tenant_id', '=', tenant.id).execute(),
      tasks: await db.selectFrom('crm_tasks').selectAll().where('tenant_id', '=', tenant.id).execute(),
      tags: await db.selectFrom('crm_tags').selectAll().where('tenant_id', '=', tenant.id).execute(),
      stages: await db
        .selectFrom('crm_lead_stages')
        .selectAll()
        .where('tenant_id', '=', tenant.id)
        .orderBy('sort_order')
        .execute(),
    };
    expect(counts.companies).toHaveLength(summary.companies);
    expect(counts.customers).toHaveLength(summary.customers);
    expect(counts.contacts).toHaveLength(summary.contacts);
    expect(counts.leads).toHaveLength(summary.leads);
    expect(counts.deals).toHaveLength(summary.deals);
    expect(counts.jobs).toHaveLength(summary.jobs);
    expect(counts.notes).toHaveLength(summary.notes);
    expect(counts.tasks).toHaveLength(summary.tasks);
    expect(counts.tags).toHaveLength(summary.tags);
    expect(counts.stages.map((s) => s.key)).toEqual([
      'new',
      'contacted',
      'qualified',
      'quoted',
      'won',
      'lost',
    ]);

    // A won lead exists (pipeline was walked) and timeline events were generated.
    expect(counts.leads.some((l) => l.stage === 'won')).toBe(true);
    const timeline = await db
      .selectFrom('crm_timeline_events')
      .selectAll()
      .where('tenant_id', '=', tenant.id)
      .execute();
    expect(timeline.length).toBeGreaterThan(10);
    expect(timeline.some((t) => t.event_type === 'stage_changed')).toBe(true);

    // Every seeded row carries the tenant id (no leakage).
    for (const rows of Object.values(counts)) {
      for (const row of rows) {
        expect((row as { tenant_id: string }).tenant_id).toBe(tenant.id);
      }
    }
  });

  it('seeding two tenants keeps them fully isolated and emits events on the given bus', async () => {
    const db = await freshDb();
    const t1 = await createTenant(asCoreDb(db), { name: 'Seed One' });
    const t2 = await createTenant(asCoreDb(db), { name: 'Seed Two' });
    const bus = new EventBus();
    const leadEvents: any[] = [];
    bus.on('crm.lead.created', (e) => {
      leadEvents.push(e);
    });

    const s1 = await seedCrm(db, t1.id, bus);
    await seedCrm(db, t2.id, bus);

    expect(leadEvents.length).toBe(s1.leads * 2);
    expect(leadEvents.every((e) => e.tenantId === t1.id || e.tenantId === t2.id)).toBe(true);

    const t1Customers = await db
      .selectFrom('crm_customers')
      .selectAll()
      .where('tenant_id', '=', t1.id)
      .execute();
    const all = await db.selectFrom('crm_customers').selectAll().execute();
    expect(all.length).toBe(t1Customers.length * 2);
  });
});
