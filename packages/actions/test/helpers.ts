import {
  EventBus,
  asCoreDb,
  coreMigrations,
  createTenant,
  type PlatformEvent,
  type TenantRow,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { actionsMigrations } from '../src/migrations';
import { actionsRouter } from '../src/router';
import type { ActionsDatabase } from '../src/schema';

export async function setup() {
  const db = createTestDb<ActionsDatabase>();
  await runMigrations(db, [...coreMigrations, ...actionsMigrations]);
  const tenantA = await createTenant(asCoreDb(db), { name: 'Alpha Tack' });
  const tenantB = await createTenant(asCoreDb(db), { name: 'Beta Tack' });
  const events = new EventBus();
  const app = actionsRouter({ db, events, contracts: {} });
  return { db, tenantA, tenantB, events, app };
}

export function headers(tenant: TenantRow | { id: string }): Record<string, string> {
  return { 'x-tenant-id': tenant.id, 'content-type': 'application/json' };
}

/** Collect events of a given type into an array for assertions. */
export function collect(events: EventBus, type: string): PlatformEvent[] {
  const seen: PlatformEvent[] = [];
  events.on(type, (e) => {
    seen.push(e);
  });
  return seen;
}

/** A minimal valid open() body. */
export function openBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'stock_below_reorder_point',
    title: 'Stock below reorder point',
    priority: 'p2',
    dedupeKey: 'sbrp:var_1:loc_1',
    evidence: { onHand: 1, reorderPoint: 5 },
    deepLink: '/inventory/variations/var_1',
    ...overrides,
  };
}
