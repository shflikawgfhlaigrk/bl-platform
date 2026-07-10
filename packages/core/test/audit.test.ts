import { describe, expect, it } from 'vitest';
import {
  audit,
  coreMigrations,
  createTenant,
  listAuditEntries,
  type CoreDatabase,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';

describe('audit', () => {
  it('writes entries with a JSON diff and reads them back per entity', async () => {
    const db = createTestDb<CoreDatabase>();
    await runMigrations(db, coreMigrations);
    const t = await createTenant(db, { name: 'Acme' });

    const entry = await audit(db, t.id, 'user-1', 'crm.lead.updated', 'crm.lead', 'lead-9', {
      before: { status: 'new' },
      after: { status: 'contacted' },
    });
    expect(entry.diff).toBeTypeOf('string');
    expect(JSON.parse(entry.diff as string)).toEqual({
      before: { status: 'new' },
      after: { status: 'contacted' },
    });

    await audit(db, t.id, 'system', 'crm.lead.deleted', 'crm.lead', 'lead-9');

    const entries = await listAuditEntries(db, t.id, 'crm.lead', 'lead-9');
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.tenant_id === t.id)).toBe(true);
    // no-diff entry stores null
    expect(entries.find((e) => e.actor === 'system')?.diff).toBeNull();
  });

  it('is tenant-scoped on read', async () => {
    const db = createTestDb<CoreDatabase>();
    await runMigrations(db, coreMigrations);
    const a = await createTenant(db, { name: 'A' });
    const b = await createTenant(db, { name: 'B' });
    await audit(db, a.id, 'u', 'x.y.z', 'x.thing', 'e1', { k: 1 });
    expect(await listAuditEntries(db, b.id, 'x.thing', 'e1')).toEqual([]);
  });
});
