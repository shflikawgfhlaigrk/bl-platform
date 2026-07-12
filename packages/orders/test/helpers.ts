import {
  EventBus,
  asCoreDb,
  coreMigrations,
  createTenant,
  type PlatformEvent,
  type TenantRow,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { ordersMigrations } from '../src/migrations';
import { ordersRouter } from '../src/router';
import { simulatorCheckoutProvider } from '../src/providers';
import type { OrdersDatabase } from '../src/schema';

export const SIM_SECRET = 'sim-webhook-secret-1234567890';

export async function setup() {
  const db = createTestDb<OrdersDatabase>();
  await runMigrations(db, [...coreMigrations, ...ordersMigrations]);
  const tenantA = await createTenant(asCoreDb(db), { name: 'Alpha Tack' });
  const tenantB = await createTenant(asCoreDb(db), { name: 'Beta Tack' });
  const events = new EventBus();
  const simulator = simulatorCheckoutProvider({ secret: SIM_SECRET });
  const app = ordersRouter({ db, events, contracts: {} }, { providers: [simulator] });
  return { db, tenantA, tenantB, events, app, simulator };
}

export function headers(tenant: TenantRow | { id: string }): Record<string, string> {
  return { 'x-tenant-id': tenant.id, 'content-type': 'application/json' };
}

/** Collect every emitted event of a type for assertions. */
export function collect(events: EventBus, type: string): PlatformEvent[] {
  const seen: PlatformEvent[] = [];
  events.on(type, (e) => {
    seen.push(e);
  });
  return seen;
}

/** A two-line order fixture: one variation-backed line + one custom line. */
export function fixtureOrderBody() {
  return {
    channel: 'pos' as const,
    customerId: 'crm_cust_1',
    lines: [
      {
        variationId: 'var_belt',
        locationId: 'loc_warehouse',
        description: 'Ellany Elastic Belt',
        qty: 3,
        unitPriceCents: 4000,
      },
      {
        description: 'Custom engraving',
        qty: 1,
        unitPriceCents: 1000,
      },
    ],
  };
}
