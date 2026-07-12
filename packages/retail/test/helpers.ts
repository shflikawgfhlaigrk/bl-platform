import {
  EventBus,
  asCoreDb,
  coreMigrations,
  createTenant,
  type TenantRow,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { retailMigrations } from '../src/migrations';
import { retailRouter, type RetailImportWiring } from '../src/router';
import type { RetailDatabase } from '../src/schema';
import type { ImportSalesInput } from '../src/service';

export async function setup(wiring: RetailImportWiring = {}) {
  const db = createTestDb<RetailDatabase>();
  await runMigrations(db, [...coreMigrations, ...retailMigrations]);
  const tenantA = await createTenant(asCoreDb(db), { name: 'Alpha Tack' });
  const tenantB = await createTenant(asCoreDb(db), { name: 'Beta Tack' });
  const events = new EventBus();
  const app = retailRouter({ db, events, contracts: {} }, wiring);
  return { db, tenantA, tenantB, events, app };
}

/* ------------------------------------------------------------------ *
 * Real-Square-shaped fixtures for the incremental import pipeline.
 * ------------------------------------------------------------------ */

export function squarePayment(id: string, amount: number, status = 'COMPLETED') {
  return {
    id,
    created_at: '2026-03-07T15:00:00.000Z',
    status,
    amount_money: { amount, currency: 'USD' },
    processing_fee: [{ amount_money: { amount: Math.round(amount * 0.029) + 30, currency: 'USD' } }],
    customer_id: 'CUST1',
    order_id: `ORD_${id}`,
  };
}

export function squareOrder(id: string, total: number, state = 'COMPLETED') {
  return {
    id,
    location_id: 'LCP2395Z8RW11',
    state,
    created_at: '2026-03-07T15:00:00.000Z',
    total_money: { amount: total, currency: 'USD' },
    line_items: [
      {
        uid: 'u1',
        name: 'AZ Gelante Stretch Belt',
        quantity: '1',
        catalog_object_id: 'VAR1',
        total_money: { amount: total, currency: 'USD' },
      },
    ],
  };
}

export function headers(tenant: TenantRow | { id: string }): Record<string, string> {
  return { 'x-tenant-id': tenant.id, 'content-type': 'application/json' };
}

/** A small, exact fixture: 3 completed payments + 1 failed, 4 lines, 1 refund. */
export function fixtureImport(): ImportSalesInput {
  return {
    source: 'square-ledger',
    payments: [
      {
        sourceId: 'pay_1',
        paidAt: '2026-03-07T15:00:00.000Z',
        status: 'COMPLETED',
        amountCents: 12550,
        feeCents: 261,
        customerSourceId: 'cust_1',
        orderSourceId: 'ord_1',
      },
      {
        sourceId: 'pay_2',
        paidAt: '2026-03-08T16:30:00.000Z',
        status: 'COMPLETED',
        amountCents: 4999,
        feeCents: 104,
        customerSourceId: 'cust_1',
        orderSourceId: 'ord_2',
      },
      {
        sourceId: 'pay_3',
        paidAt: '2026-03-14T17:45:00.000Z',
        status: 'COMPLETED',
        amountCents: 20000,
        feeCents: null,
        customerSourceId: null,
        orderSourceId: 'ord_3',
      },
      {
        sourceId: 'pay_4',
        paidAt: '2026-03-14T18:00:00.000Z',
        status: 'FAILED',
        amountCents: 999,
        feeCents: null,
        customerSourceId: null,
        orderSourceId: null,
      },
    ],
    orderLines: [
      {
        sourceOrderId: 'ord_1',
        name: 'Ellany Elastic Belt',
        quantity: 1,
        totalCents: 12550,
        catalogSourceId: 'var_1',
        categoryName: 'Belts',
      },
      {
        sourceOrderId: 'ord_2',
        name: 'LeMieux Saddle Pad',
        quantity: 1,
        totalCents: 4999,
        catalogSourceId: 'var_2',
        categoryName: 'Saddle Pads',
      },
      {
        sourceOrderId: 'ord_3',
        name: 'TuffRider Breeches',
        quantity: 2,
        totalCents: 20000,
        catalogSourceId: 'var_3',
        categoryName: 'Apparel',
      },
      {
        sourceOrderId: 'ord_3',
        name: 'Hoof Pick',
        quantity: 1,
        totalCents: 0,
        catalogSourceId: null,
        categoryName: null,
      },
    ],
    refunds: [
      {
        sourceId: 'ref_1',
        refundedAt: '2026-03-15T12:00:00.000Z',
        status: 'COMPLETED',
        amountCents: 4999,
      },
    ],
  };
}
