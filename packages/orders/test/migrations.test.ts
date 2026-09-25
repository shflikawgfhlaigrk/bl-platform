import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { ordersMigrations } from '../src/migrations';
import type { OrdersDatabase } from '../src/schema';

const TABLES = [
  'orders_orders',
  'orders_lines',
  'orders_tenders',
  'orders_refunds',
  'orders_refund_lines',
  'orders_fulfillments',
  'orders_fulfillment_lines',
  'orders_checkout_sessions',
  'orders_payment_attempts',
  'orders_webhook_events',
];

describe('orders migrations', () => {
  it('apply on a fresh db and create every table', async () => {
    const db = createTestDb<OrdersDatabase>();
    const results = await runMigrations(db, [...coreMigrations, ...ordersMigrations]);
    expect(results.applied).toContain('orders.0001_orders_tables');
    expect(results.applied).toContain('orders.0002_pos_payment_attempts');
    expect(results.applied).toContain('orders.0003_provider_refunds');
    expect(results.applied).toContain('orders.0004_one_active_payment_attempt');
    expect(results.applied).toContain('orders.0005_async_provider_refunds');
    for (const table of TABLES) {
      // A select against each table must succeed (table exists).
      const rows = await db
        .selectFrom(table as 'orders_orders')
        .selectAll()
        .execute();
      expect(rows).toEqual([]);
    }
  });

  it('are idempotent on re-run (no duplicate application)', async () => {
    const db = createTestDb<OrdersDatabase>();
    await runMigrations(db, [...coreMigrations, ...ordersMigrations]);
    // Re-running must not throw and must apply nothing new.
    const second = await runMigrations(db, [...coreMigrations, ...ordersMigrations]);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('orders.0001_orders_tables');
    expect(second.skipped).toContain('orders.0002_pos_payment_attempts');
    expect(second.skipped).toContain('orders.0003_provider_refunds');
    expect(second.skipped).toContain('orders.0004_one_active_payment_attempt');
    expect(second.skipped).toContain('orders.0005_async_provider_refunds');
  });

  it('replays each POS migration safely when DDL committed before bookkeeping', async () => {
    const db = createTestDb<OrdersDatabase>();
    await runMigrations(db, [...coreMigrations, ordersMigrations[0]]);
    for (const migration of ordersMigrations.slice(1)) {
      await migration.up(db as any);
      await expect(migration.up(db as any)).resolves.toBeUndefined();
    }
  });

  it('does not overwrite live POS values when the backfill migration replays', async () => {
    const db = createTestDb<OrdersDatabase>();
    await runMigrations(db, [...coreMigrations, ordersMigrations[0]]);
    const at = '2026-09-03T00:00:00.000Z';
    await db.insertInto('orders_orders').values({
      id: 'replay-order', tenant_id: 'replay-tenant', channel: 'pos', status: 'paid',
      customer_id: null, show_id: null, source: 'mags', source_order_id: 'pos:replay',
      discount_bps: null, discount_fixed_cents: null, tax_bps: 0,
      subtotal_cents: 100, discount_cents: 0, tax_cents: 0, total_cents: 100,
      note: null, sent: 0, sent_at: null, reserved_at: at, paid_at: at,
      fulfilled_at: null, canceled_at: null, created_at: at, updated_at: at,
    } as any).execute();
    await db.insertInto('orders_tenders').values({
      id: 'replay-tender', tenant_id: 'replay-tenant', order_id: 'replay-order',
      kind: 'cash', amount_cents: 100, provider: null, provider_ref: null,
      status: 'partially_refunded', refunded_cents: 25,
      idempotency_key: 'replay-tender-key', created_at: at, updated_at: at,
    } as any).execute();
    await db.insertInto('orders_refunds').values({
      id: 'replay-refund', tenant_id: 'replay-tenant', order_id: 'replay-order',
      tender_id: 'replay-tender', amount_cents: 25, reason: null,
      status: 'completed', created_at: at,
    } as any).execute();

    await ordersMigrations[1].up(db as any);
    await db.updateTable('orders_orders')
      .set({ receipt_number: 'BL-LIVE-RECEIPT' })
      .where('id', '=', 'replay-order').execute();
    await db.updateTable('orders_tenders')
      .set({ cash_received_cents: 150, change_due_cents: 50 })
      .where('id', '=', 'replay-tender').execute();
    await db.updateTable('orders_refunds')
      .set({ idempotency_key: 'live-refund-key' })
      .where('id', '=', 'replay-refund').execute();

    await expect(ordersMigrations[1].up(db as any)).resolves.toBeUndefined();
    await expect(db.selectFrom('orders_orders')
      .select('receipt_number').where('id', '=', 'replay-order').executeTakeFirstOrThrow())
      .resolves.toEqual({ receipt_number: 'BL-LIVE-RECEIPT' });
    await expect(db.selectFrom('orders_tenders')
      .select(['cash_received_cents', 'change_due_cents'])
      .where('id', '=', 'replay-tender').executeTakeFirstOrThrow())
      .resolves.toEqual({ cash_received_cents: 150, change_due_cents: 50 });
    await expect(db.selectFrom('orders_refunds')
      .select('idempotency_key').where('id', '=', 'replay-refund').executeTakeFirstOrThrow())
      .resolves.toEqual({ idempotency_key: 'live-refund-key' });
  });

  it('preserves the externally live payment attempt when deduplicating active attempts', async () => {
    const db = createTestDb<OrdersDatabase>();
    await runMigrations(db, [...coreMigrations, ...ordersMigrations.slice(0, 3)]);
    const oldAt = '2026-09-03T00:00:00.000Z';
    const newAt = '2026-09-03T00:01:00.000Z';

    const attempt = (
      id: string,
      orderId: string,
      status: 'pending' | 'processing',
      createdAt: string,
      providerRef: string | null = null,
    ) => ({
      id,
      tenant_id: 'migration-tenant',
      order_id: orderId,
      checkout_session_id: null,
      provider: 'stripe_terminal',
      provider_ref: providerRef,
      status,
      amount_cents: 100,
      idempotency_key: `idem:${id}`,
      reader_id: 'reader-1',
      provider_data: null,
      failure_code: null,
      failure_message: null,
      created_at: createdAt,
      updated_at: createdAt,
      processing_at: status === 'processing' ? createdAt : null,
      succeeded_at: null,
      failed_at: null,
      canceled_at: null,
    });
    await db.insertInto('orders_payment_attempts').values([
      // The old migration chose this first because it was oldest, even though
      // the other row is already bound to provider-side work.
      attempt('provider-old-local', 'provider-order', 'pending', oldAt),
      attempt('provider-owner', 'provider-order', 'pending', newAt, 'pi_live'),
      // Processing must outrank a newer request that has not reached a reader.
      attempt('processing-owner', 'processing-order', 'processing', oldAt),
      attempt('processing-newer-pending', 'processing-order', 'pending', newAt),
      // Equivalent local rows use the newest timestamps and then id.
      attempt('recency-old', 'recency-order', 'pending', oldAt),
      attempt('recency-new', 'recency-order', 'pending', newAt),
      attempt('tie-a', 'tie-order', 'pending', newAt),
      attempt('tie-z', 'tie-order', 'pending', newAt),
    ] as any).execute();

    await ordersMigrations[3].up(db as any);

    const rows = await db.selectFrom('orders_payment_attempts')
      .select(['id', 'status', 'active_order_key', 'failure_code'])
      .orderBy('id')
      .execute();
    const activeIds = rows.filter((row) => row.active_order_key !== null).map((row) => row.id);
    expect(activeIds).toEqual(['processing-owner', 'provider-owner', 'recency-new', 'tie-z']);
    expect(rows.filter((row) => row.active_order_key === null)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'provider-old-local', status: 'failed', failure_code: 'duplicate_active_attempt',
        }),
        expect.objectContaining({
          id: 'processing-newer-pending', status: 'failed', failure_code: 'duplicate_active_attempt',
        }),
        expect.objectContaining({
          id: 'recency-old', status: 'failed', failure_code: 'duplicate_active_attempt',
        }),
        expect.objectContaining({
          id: 'tie-a', status: 'failed', failure_code: 'duplicate_active_attempt',
        }),
      ]),
    );
    await expect(ordersMigrations[3].up(db as any)).resolves.toBeUndefined();
  });

  it('preserves provider-bound and confirmed refunds when deduplicating pending refunds', async () => {
    const db = createTestDb<OrdersDatabase>();
    await runMigrations(db, [...coreMigrations, ...ordersMigrations.slice(0, 4)]);
    const oldAt = '2026-09-03T00:00:00.000Z';
    const newAt = '2026-09-03T00:01:00.000Z';

    const refund = (
      id: string,
      tenderId: string,
      createdAt: string,
      providerRef: string | null = null,
      providerStatus: 'pending' | 'succeeded' | null = null,
    ) => ({
      id,
      tenant_id: 'migration-tenant',
      order_id: `order:${tenderId}`,
      tender_id: tenderId,
      cash_session_id: null,
      idempotency_key: `idem:${id}`,
      provider: providerRef || providerStatus ? 'stripe_terminal' : null,
      provider_ref: providerRef,
      provider_status: providerStatus,
      amount_cents: 100,
      reason: null,
      status: 'pending',
      created_at: createdAt,
    });
    await db.insertInto('orders_refunds').values([
      // A provider-bound refund must survive an older ref-null placeholder.
      refund('refund-old-local', 'provider-tender', oldAt),
      refund('refund-provider-owner', 'provider-tender', newAt, 're_live', 'pending'),
      // Processor-confirmed success is stronger than a merely bound request.
      refund('refund-confirmed', 'confirmed-tender', oldAt, null, 'succeeded'),
      refund('refund-confirmed-competitor', 'confirmed-tender', newAt, 're_pending', 'pending'),
      // Equivalent local rows use creation time and then id.
      refund('refund-recency-old', 'recency-tender', oldAt),
      refund('refund-recency-new', 'recency-tender', newAt),
      refund('refund-tie-a', 'tie-tender', newAt),
      refund('refund-tie-z', 'tie-tender', newAt),
    ] as any).execute();

    await ordersMigrations[4].up(db as any);

    const rows = await db.selectFrom('orders_refunds')
      .select(['id', 'status', 'provider_status', 'active_tender_key'])
      .orderBy('id')
      .execute();
    const activeIds = rows.filter((row) => row.active_tender_key !== null).map((row) => row.id);
    expect(activeIds).toEqual([
      'refund-confirmed',
      'refund-provider-owner',
      'refund-recency-new',
      'refund-tie-z',
    ]);
    expect(rows.find((row) => row.id === 'refund-confirmed')).toMatchObject({
      status: 'pending', provider_status: 'succeeded',
    });
    expect(rows.filter((row) => row.active_tender_key === null)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'refund-old-local', status: 'failed', provider_status: 'failed',
        }),
        expect.objectContaining({
          id: 'refund-confirmed-competitor', status: 'failed', provider_status: 'failed',
        }),
        expect.objectContaining({
          id: 'refund-recency-old', status: 'failed', provider_status: 'failed',
        }),
        expect.objectContaining({
          id: 'refund-tie-a', status: 'failed', provider_status: 'failed',
        }),
      ]),
    );
    await expect(ordersMigrations[4].up(db as any)).resolves.toBeUndefined();
  });

  it('backfills stable receipt numbers and zero tips for pre-POS orders', async () => {
    const db = createTestDb<OrdersDatabase>();
    await runMigrations(db, [...coreMigrations, ordersMigrations[0]]);
    const at = '2026-09-03T00:00:00.000Z';
    await db
      .insertInto('orders_orders')
      .values({
        id: 'legacy-order',
        tenant_id: 'legacy-tenant',
        channel: 'pos',
        status: 'draft',
        customer_id: null,
        show_id: null,
        source: 'mags',
        source_order_id: null,
        discount_bps: null,
        discount_fixed_cents: null,
        tax_bps: null,
        subtotal_cents: 100,
        discount_cents: 0,
        tax_cents: 0,
        total_cents: 100,
        note: null,
        sent: 0,
        sent_at: null,
        reserved_at: null,
        paid_at: null,
        fulfilled_at: null,
        canceled_at: null,
        created_at: at,
        updated_at: at,
      } as any)
      .execute();
    await db
      .insertInto('orders_tenders')
      .values({
        id: 'legacy-tender',
        tenant_id: 'legacy-tenant',
        order_id: 'legacy-order',
        kind: 'cash',
        amount_cents: 100,
        provider: null,
        provider_ref: null,
        status: 'captured',
        refunded_cents: 0,
        idempotency_key: 'legacy-tender-key',
        created_at: at,
        updated_at: at,
      } as any)
      .execute();
    await db
      .insertInto('orders_refunds')
      .values({
        id: 'legacy-refund',
        tenant_id: 'legacy-tenant',
        order_id: 'legacy-order',
        tender_id: 'legacy-tender',
        amount_cents: 25,
        reason: null,
        status: 'completed',
        created_at: at,
      } as any)
      .execute();

    await runMigrations(db, [...coreMigrations, ...ordersMigrations]);
    const migrated = await db
      .selectFrom('orders_orders')
      .select(['tip_cents', 'receipt_number'])
      .where('tenant_id', '=', 'legacy-tenant')
      .where('id', '=', 'legacy-order')
      .executeTakeFirstOrThrow();
    expect(migrated).toEqual({ tip_cents: 0, receipt_number: 'LEGACY-legacy-order' });
    const tender = await db
      .selectFrom('orders_tenders')
      .select(['cash_received_cents', 'change_due_cents'])
      .where('tenant_id', '=', 'legacy-tenant')
      .where('id', '=', 'legacy-tender')
      .executeTakeFirstOrThrow();
    expect(tender).toEqual({ cash_received_cents: 100, change_due_cents: 0 });
    const refund = await db
      .selectFrom('orders_refunds')
      .select(['idempotency_key', 'cash_session_id'])
      .where('tenant_id', '=', 'legacy-tenant')
      .where('id', '=', 'legacy-refund')
      .executeTakeFirstOrThrow();
    expect(refund).toEqual({ idempotency_key: 'legacy:legacy-refund', cash_session_id: null });
    const providerColumns = await db
      .selectFrom('orders_refunds')
      .select(['provider', 'provider_ref', 'provider_status', 'active_tender_key'])
      .where('tenant_id', '=', 'legacy-tenant')
      .where('id', '=', 'legacy-refund')
      .executeTakeFirstOrThrow();
    expect(providerColumns).toEqual({
      provider: null,
      provider_ref: null,
      provider_status: null,
      active_tender_key: null,
    });
  });
});
