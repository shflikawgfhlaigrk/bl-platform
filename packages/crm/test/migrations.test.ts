import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { crmMigrations, type CrmDatabase } from '@blacklabel/crm';

describe('crm migrations', () => {
  it('apply cleanly on a fresh db after core migrations', async () => {
    const db = createTestDb<CrmDatabase>();
    const result = await runMigrations(db, [...coreMigrations, ...crmMigrations]);
    expect(result.applied).toEqual(
      expect.arrayContaining([
        'crm.0001_companies_customers_contacts',
        'crm.0002_leads_stages_deals_jobs',
        'crm.0003_notes_tasks_tags_timeline_attachments_attribution',
      ]),
    );
    // All crm tables exist and are queryable.
    for (const table of [
      'crm_companies',
      'crm_customers',
      'crm_contacts',
      'crm_leads',
      'crm_lead_stages',
      'crm_deals',
      'crm_jobs',
      'crm_notes',
      'crm_tasks',
      'crm_tags',
      'crm_taggables',
      'crm_timeline_events',
      'crm_attachments',
      'crm_source_attributions',
    ] as const) {
      const rows = await db.selectFrom(table).selectAll().execute();
      expect(rows).toEqual([]);
    }
  });

  it('are idempotent on re-run', async () => {
    const db = createTestDb<CrmDatabase>();
    const all = [...coreMigrations, ...crmMigrations];
    const first = await runMigrations(db, all);
    expect(first.skipped).toEqual([]);
    const second = await runMigrations(db, all);
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBe(all.length);
  });
});
