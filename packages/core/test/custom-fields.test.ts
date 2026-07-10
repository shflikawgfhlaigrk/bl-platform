import { describe, expect, it } from 'vitest';
import {
  coreMigrations,
  createTenant,
  defineCustomField,
  deleteCustomField,
  listCustomFields,
  type CoreDatabase,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';

async function setup() {
  const db = createTestDb<CoreDatabase>();
  await runMigrations(db, coreMigrations);
  const tenant = await createTenant(db, { name: 'Acme' });
  return { db, tenant };
}

describe('custom field definitions', () => {
  it('defines and lists fields scoped to tenant and entity type', async () => {
    const { db, tenant } = await setup();
    await defineCustomField(db, tenant.id, {
      entityType: 'crm.lead',
      key: 'referral_source',
      label: 'Referral source',
      kind: 'select',
    });
    await defineCustomField(db, tenant.id, {
      entityType: 'billing.invoice',
      key: 'po_number',
      label: 'PO number',
      kind: 'text',
    });

    const leadFields = await listCustomFields(db, tenant.id, 'crm.lead');
    expect(leadFields.map((f) => f.key)).toEqual(['referral_source']);

    const all = await listCustomFields(db, tenant.id);
    expect(all).toHaveLength(2);
  });

  it('rejects duplicate keys per (tenant, entity_type) with 409', async () => {
    const { db, tenant } = await setup();
    const input = {
      entityType: 'crm.lead',
      key: 'referral_source',
      label: 'Referral source',
      kind: 'text' as const,
    };
    await defineCustomField(db, tenant.id, input);
    await expect(defineCustomField(db, tenant.id, input)).rejects.toMatchObject({ status: 409 });
  });

  it('allows the same key for a different tenant (tenant isolation)', async () => {
    const { db, tenant } = await setup();
    const other = await createTenant(db, { name: 'Other Co' });
    const input = {
      entityType: 'crm.lead',
      key: 'referral_source',
      label: 'Referral source',
      kind: 'text' as const,
    };
    await defineCustomField(db, tenant.id, input);
    await expect(defineCustomField(db, other.id, input)).resolves.toBeTruthy();
    expect(await listCustomFields(db, other.id)).toHaveLength(1);
  });

  it('rejects bad keys and kinds with 400', async () => {
    const { db, tenant } = await setup();
    await expect(
      defineCustomField(db, tenant.id, {
        entityType: 'crm.lead',
        key: 'Bad Key',
        label: 'x',
        kind: 'text',
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      defineCustomField(db, tenant.id, {
        entityType: 'crm.lead',
        key: 'ok_key',
        label: 'x',
        kind: 'nope' as never,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('deletes fields tenant-scoped', async () => {
    const { db, tenant } = await setup();
    const other = await createTenant(db, { name: 'Other Co' });
    const field = await defineCustomField(db, tenant.id, {
      entityType: 'crm.lead',
      key: 'k1',
      label: 'K1',
      kind: 'text',
    });
    // denial from another tenant
    await expect(deleteCustomField(db, other.id, field.id)).rejects.toMatchObject({ status: 404 });
    await deleteCustomField(db, tenant.id, field.id);
    expect(await listCustomFields(db, tenant.id)).toEqual([]);
  });
});
