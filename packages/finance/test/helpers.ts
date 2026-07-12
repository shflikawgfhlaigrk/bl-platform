import {
  EventBus,
  asCoreDb,
  coreMigrations,
  createTenant,
  type TenantRow,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { financeMigrations } from '../src/migrations';
import { financeRouter } from '../src/router';
import type { FinanceDatabase } from '../src/schema';

export async function setup() {
  const db = createTestDb<FinanceDatabase>();
  await runMigrations(db, [...coreMigrations, ...financeMigrations]);
  const tenantA = await createTenant(asCoreDb(db), { name: 'Alpha Tack' });
  const tenantB = await createTenant(asCoreDb(db), { name: 'Beta Tack' });
  const events = new EventBus();
  const app = financeRouter({ db, events, contracts: {} });
  return { db, tenantA, tenantB, events, app };
}

export function headers(tenant: TenantRow | { id: string }): Record<string, string> {
  return { 'x-tenant-id': tenant.id, 'content-type': 'application/json' };
}

export async function api(
  app: Awaited<ReturnType<typeof setup>>['app'],
  tenant: { id: string } | string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const tenantId = typeof tenant === 'string' ? tenant : tenant.id;
  return app.request(path, {
    method,
    headers: { 'x-tenant-id': tenantId, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function json(res: Response): Promise<any> {
  return res.json();
}

/** Two completed card payments whose net sums to a known payout amount. */
export function paymentRows(): import('../src/service').ImportPaymentInput[] {
  return [
    {
      sourcePaymentId: 'pay_1',
      orderRef: 'ord_1',
      amountCents: 10000,
      feeCents: 290,
      netCents: 9710,
      sourceKind: 'card' as const,
      cardBrand: 'VISA',
      status: 'COMPLETED',
      occurredAt: '2026-03-07T15:00:00.000Z',
    },
    {
      sourcePaymentId: 'pay_2',
      orderRef: 'ord_2',
      amountCents: 5000,
      feeCents: 175,
      netCents: 4825,
      sourceKind: 'card' as const,
      cardBrand: 'MASTERCARD',
      status: 'COMPLETED',
      occurredAt: '2026-03-08T16:30:00.000Z',
    },
    {
      sourcePaymentId: 'pay_3',
      orderRef: null,
      amountCents: 2000,
      feeCents: 0,
      netCents: 2000,
      sourceKind: 'cash' as const,
      cardBrand: null,
      status: 'COMPLETED',
      occurredAt: '2026-03-09T12:00:00.000Z',
    },
  ];
}
