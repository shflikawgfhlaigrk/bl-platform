import { describe, expect, it } from 'vitest';
import {
  ApiError,
  EventBus,
  asCoreDb,
  coreMigrations,
  createTenant,
  type PlatformEvent,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import {
  applyIndustry,
  getAppliedIndustry,
  getIndustryConfig,
  getTerminology,
  industriesMigrations,
  seedIndustries,
  type IndustriesDatabase,
} from '@blacklabel/industries';

async function setup() {
  const db = createTestDb<IndustriesDatabase>();
  await runMigrations(db, [...coreMigrations, ...industriesMigrations]);
  const events = new EventBus();
  const tenantA = await createTenant(asCoreDb(db), { name: 'Tenant A' });
  const tenantB = await createTenant(asCoreDb(db), { name: 'Tenant B' });
  return { db, events, tenantA, tenantB };
}

describe('migrations', () => {
  it('apply on a fresh db and are idempotent on re-run', async () => {
    const db = createTestDb<IndustriesDatabase>();
    const first = await runMigrations(db, [...coreMigrations, ...industriesMigrations]);
    expect(first.applied).toContain('industries.0001_industry_defaults');

    const second = await runMigrations(db, [...coreMigrations, ...industriesMigrations]);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('industries.0001_industry_defaults');
  });
});

describe('applyIndustry', () => {
  it('rejects concurrent applications to the same company instead of duplicating setup',async()=>{
    const {db,tenantA}=await setup();
    const first=applyIndustry(db,tenantA.id,'service-delivery');
    await expect(applyIndustry(db,tenantA.id,'hvac')).rejects.toMatchObject({status:409});
    expect((await first).industryKey).toBe('service-delivery');
  });
  it('seeds every defaults table from the config', async () => {
    const { db, tenantA } = await setup();
    const config = getIndustryConfig('window-cleaning')!;
    const applied = await applyIndustry(db, tenantA.id, 'window-cleaning');

    expect(applied.industryKey).toBe('window-cleaning');
    expect(applied.terminology).toEqual(config.terminology);
    expect(applied.leadStages.map((s) => s.key)).toEqual(config.leadStages.map((s) => s.key));
    expect(applied.leadStages.map((s) => s.sortOrder)).toEqual(
      config.leadStages.map((_, i) => i),
    );
    expect(applied.quoteTemplates).toHaveLength(config.quoteTemplates.length);
    expect(applied.appointmentTypes).toHaveLength(config.appointmentTypes.length);
    expect(applied.dashboardWidgets).toHaveLength(config.dashboardWidgets.length);
    expect(applied.workflows).toHaveLength(config.workflows.length);

    const template = applied.quoteTemplates.find((t) => t.key === 'residential_standard')!;
    expect(template.lines[0]).toEqual({
      description: 'Exterior windows (per pane)',
      quantity: 20,
      unitPriceCents: 450,
    });

    const workflow = applied.workflows.find((w) => w.key === 'lead_followup')!;
    expect(workflow.trigger).toBe('crm.lead.created');
    expect(workflow.enabled).toBe(true);
    expect(workflow.definition.actions[0]!.type).toBe('create_task');
  });

  it('is idempotent — re-applying keeps row ids stable and adds nothing', async () => {
    const { db, tenantA } = await setup();
    const first = await applyIndustry(db, tenantA.id, 'hvac');
    const second = await applyIndustry(db, tenantA.id, 'hvac');

    expect(second.leadStages.map((s) => s.id)).toEqual(first.leadStages.map((s) => s.id));
    expect(second.quoteTemplates.map((t) => t.id)).toEqual(
      first.quoteTemplates.map((t) => t.id),
    );
    expect(second.appointmentTypes).toHaveLength(first.appointmentTypes.length);
    expect(second.dashboardWidgets).toHaveLength(first.dashboardWidgets.length);
    expect(second.workflows).toHaveLength(first.workflows.length);

    const stageRows = await db
      .selectFrom('industries_lead_stages')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .execute();
    expect(stageRows).toHaveLength(getIndustryConfig('hvac')!.leadStages.length);
  });

  it('switching industries replaces stale defaults with the new set', async () => {
    const { db, tenantA } = await setup();
    await applyIndustry(db, tenantA.id, 'window-cleaning');
    const applied = await applyIndustry(db, tenantA.id, 'law-firm');

    const lawFirm = getIndustryConfig('law-firm')!;
    expect(applied.industryKey).toBe('law-firm');
    expect(applied.leadStages.map((s) => s.key)).toEqual(lawFirm.leadStages.map((s) => s.key));
    // window-cleaning-only stages must be gone
    expect(applied.leadStages.map((s) => s.key)).not.toContain('quoted');
    expect(applied.terminology.job).toBe('Matter');

    const templateRows = await db
      .selectFrom('industries_quote_templates')
      .select('key')
      .where('tenant_id', '=', tenantA.id)
      .execute();
    expect(templateRows.map((r) => r.key).sort()).toEqual(
      lawFirm.quoteTemplates.map((t) => t.key).sort(),
    );
  });

  it('throws 404 for an unknown industry key', async () => {
    const { db, tenantA } = await setup();
    await expect(applyIndustry(db, tenantA.id, 'underwater-basket-weaving')).rejects.toThrow(
      ApiError,
    );
    await expect(
      applyIndustry(db, tenantA.id, 'underwater-basket-weaving'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('emits industries.industry.applied after the write', async () => {
    const { db, events, tenantA } = await setup();
    const received: PlatformEvent[] = [];
    events.on('industries.industry.applied', (event) => {
      received.push(event);
    });

    await applyIndustry(db, tenantA.id, 'restaurant', { events });

    expect(received).toHaveLength(1);
    expect(received[0]!.tenantId).toBe(tenantA.id);
    expect(received[0]!.payload).toEqual({ industryKey: 'restaurant' });
  });

  it('writes an audit entry with the acting user', async () => {
    const { db, tenantA } = await setup();
    await applyIndustry(db, tenantA.id, 'construction', { actor: 'user-123' });

    const entries = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .where('action', '=', 'industries.industry.applied')
      .execute();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.actor).toBe('user-123');
    expect(entries[0]!.entity_type).toBe('industries.industry');
    expect(JSON.parse(entries[0]!.diff!)).toEqual({ industryKey: 'construction' });
  });
});

describe('terminology + applied state', () => {
  it('getTerminology returns the applied map', async () => {
    const { db, tenantA } = await setup();
    await applyIndustry(db, tenantA.id, 'medical-dental');
    const terminology = await getTerminology(db, tenantA.id);
    expect(terminology).toBeDefined();
    expect(terminology!.customer).toBe('Patient');
    expect(terminology!.quote).toBe('Treatment Plan');
  });

  it('returns undefined before any industry is applied', async () => {
    const { db, tenantA } = await setup();
    expect(await getTerminology(db, tenantA.id)).toBeUndefined();
    expect(await getAppliedIndustry(db, tenantA.id)).toBeUndefined();
  });
});

describe('tenant isolation', () => {
  it("tenant B sees nothing after tenant A applies an industry", async () => {
    const { db, tenantA, tenantB } = await setup();
    await applyIndustry(db, tenantA.id, 'real-estate');

    expect(await getAppliedIndustry(db, tenantB.id)).toBeUndefined();
    expect(await getTerminology(db, tenantB.id)).toBeUndefined();

    const stageRows = await db
      .selectFrom('industries_lead_stages')
      .selectAll()
      .where('tenant_id', '=', tenantB.id)
      .execute();
    expect(stageRows).toEqual([]);
  });

  it("tenant B applying a different industry leaves tenant A untouched", async () => {
    const { db, tenantA, tenantB } = await setup();
    await applyIndustry(db, tenantA.id, 'music-audio');
    await applyIndustry(db, tenantB.id, 'smart-home-security');

    const appliedA = await getAppliedIndustry(db, tenantA.id);
    const appliedB = await getAppliedIndustry(db, tenantB.id);
    expect(appliedA!.industryKey).toBe('music-audio');
    expect(appliedA!.terminology.customer).toBe('Artist');
    expect(appliedB!.industryKey).toBe('smart-home-security');
    expect(appliedB!.terminology.team_member).toBe('Installer');

    const aStageKeys = appliedA!.leadStages.map((s) => s.key);
    expect(aStageKeys).toContain('demo_review');
    expect(aStageKeys).not.toContain('assessment_scheduled');
  });
});

describe('seedIndustries', () => {
  it('applies the requested industry', async () => {
    const { db, tenantA } = await setup();
    const applied = await seedIndustries(db, tenantA.id, 'spa-wellness');
    expect(applied.industryKey).toBe('spa-wellness');
  });

  it('defaults to the first available industry when none is given', async () => {
    const { db, tenantA } = await setup();
    const applied = await seedIndustries(db, tenantA.id);
    expect(applied.industryKey).toBe('construction'); // alphabetically first
  });
});
