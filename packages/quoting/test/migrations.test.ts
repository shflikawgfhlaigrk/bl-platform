import { describe, expect, it } from 'vitest';
import { coreMigrations, createTenant, asCoreDb } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { quotingMigrations, type QuotingDatabase } from '@blacklabel/quoting';

describe('quoting migrations', () => {
  it('upgrades existing quote evidence without rewriting legacy hashes or inventing snapshots', async () => {
    const db = createTestDb<QuotingDatabase>();
    try {
      await runMigrations(db, [...coreMigrations, ...quotingMigrations.slice(0, 2)]);
      const tenantId = (await createTenant(asCoreDb(db), { name: 'Legacy evidence' })).id;
      const legacyHash = 'a'.repeat(64);
      await db.insertInto('quoting_approval_events').values({ id: 'legacy-event', tenant_id: tenantId, quote_id: 'legacy-quote', seq: 0,
        event_type: 'approved', signer_name: 'Original signer', signer_ip: null, payload_hash: legacyHash, note: null, created_at: '2026-01-01T00:00:00.000Z' } as any).execute();
      const applied = await runMigrations(db, [...coreMigrations, ...quotingMigrations]); expect(applied.applied).toEqual(['quoting.0003_immutable_scope_revisions']);
      const event = await db.selectFrom('quoting_approval_events').selectAll().where('tenant_id', '=', tenantId).where('id', '=', 'legacy-event').executeTakeFirstOrThrow();
      expect(event.payload_hash).toBe(legacyHash); expect(event.payload_schema_version).toBe(1); expect(event.payload_json).toBeNull(); expect(event.signer_name).toBe('Original signer');
      expect((await runMigrations(db, [...coreMigrations, ...quotingMigrations])).applied).toEqual([]);
    } finally { await db.destroy(); }
  });
  it('apply cleanly on a fresh db after core, and are idempotent', async () => {
    const db = createTestDb<QuotingDatabase>();
    const first = await runMigrations(db, [...coreMigrations, ...quotingMigrations]);
    expect(first.applied).toContain('quoting.0001_quoting_tables');
    expect(first.skipped).toEqual([]);

    const second = await runMigrations(db, [...coreMigrations, ...quotingMigrations]);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('quoting.0001_quoting_tables');
  });

  it('create all quoting tables (queryable and tenant-filterable)', async () => {
    const db = createTestDb<QuotingDatabase>();
    await runMigrations(db, [...coreMigrations, ...quotingMigrations]);
    // Every table must exist and accept a tenant_id-filtered select.
    const tables = [
      'quoting_quotes',
      'quoting_quote_lines',
      'quoting_pricing_rules',
      'quoting_service_templates',
      'quoting_discounts',
      'quoting_taxes',
      'quoting_approval_events',
    ] as const;
    for (const table of tables) {
      const rows = await db
        .selectFrom(table)
        .selectAll()
        .where('tenant_id', '=', 'none')
        .execute();
      expect(rows).toEqual([]);
    }
  });
});
