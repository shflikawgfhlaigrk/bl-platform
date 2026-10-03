import { describe, expect, it } from 'vitest';
import { coreMigrations, asCoreDb, createTenant, EventBus } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { billingMigrations } from '../src/migrations';
import type { BillingDatabase } from '../src/schema';
import { createInvoice } from '../src/service';

describe('billing migrations', () => {
  it('adds collection receipt tables without changing existing invoices or inventing payment evidence', async () => {
    const db = createTestDb<BillingDatabase>();
    try {
      await runMigrations(db, [...coreMigrations, ...billingMigrations.slice(0, 2)]);
      const tenantId = (await createTenant(asCoreDb(db), { name: 'Existing billing customer' })).id;
      const created = await createInvoice({ db, events: new EventBus() }, tenantId, 'system', { customerId: 'customer', lines: [{ description: 'Original work', quantity: 1, unitPriceCents: 12345 }] });
      const before = await db.selectFrom('billing_invoices').selectAll().where('tenant_id', '=', tenantId).where('id', '=', created.invoice.id).executeTakeFirstOrThrow();
      expect((await runMigrations(db, [...coreMigrations, ...billingMigrations])).applied).toEqual(['billing.0003_collection_receipts']);
      expect(await db.selectFrom('billing_invoices').selectAll().where('tenant_id', '=', tenantId).where('id', '=', created.invoice.id).executeTakeFirstOrThrow()).toEqual(before);
      for (const table of ['billing_source_receipts', 'billing_payment_receipts', 'billing_collection_plans', 'billing_reminder_receipts'] as const) expect(await db.selectFrom(table).selectAll().where('tenant_id', '=', tenantId).execute()).toEqual([]);
    } finally { await db.destroy(); }
  });
  it('apply on a fresh db after coreMigrations', async () => {
    const db = createTestDb<BillingDatabase>();
    const result = await runMigrations(db, [...coreMigrations, ...billingMigrations]);
    expect(result.applied).toContain('billing.0001_billing_tables');
    expect(result.skipped).toEqual([]);

    // Every billing table is queryable and empty.
    expect(await db.selectFrom('billing_accounts').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('billing_invoices').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('billing_invoice_lines').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('billing_payments').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('billing_subscriptions').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('billing_memberships').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('billing_invoice_counters').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('billing_webhook_events').selectAll().execute()).toEqual([]);
  });

  it('are idempotent on re-run', async () => {
    const db = createTestDb<BillingDatabase>();
    await runMigrations(db, [...coreMigrations, ...billingMigrations]);
    const second = await runMigrations(db, [...coreMigrations, ...billingMigrations]);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('billing.0001_billing_tables');
  });
});
