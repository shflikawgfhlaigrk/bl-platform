import {
  EventBus,
  asCoreDb,
  coreMigrations,
  createTenant,
  type TenantRow,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { automationMigrations } from '../src/migrations';
import { automationRouter } from '../src/router';
import { DispatcherRegistry } from '../src/dispatcher';
import type { CreateRuleInput } from '../src/rules';
import type { AutomationDatabase } from '../src/schema';

export async function setup() {
  const db = createTestDb<AutomationDatabase>();
  await runMigrations(db, [...coreMigrations, ...automationMigrations]);
  const tenantA = await createTenant(asCoreDb(db), { name: 'Alpha Tack' });
  const tenantB = await createTenant(asCoreDb(db), { name: 'Beta Tack' });
  const events = new EventBus();
  const registry = new DispatcherRegistry();
  const app = automationRouter({ db, events, contracts: {} }, registry);
  return { db, tenantA, tenantB, events, registry, app };
}

export function headers(tenant: TenantRow | { id: string }): Record<string, string> {
  return { 'x-tenant-id': tenant.id, 'content-type': 'application/json' };
}

/** A minimal automatic rule that fires on inventory.stock.below_reorder_point. */
export function reorderRule(): CreateRuleInput {
  return {
    name: 'Auto-reorder below point',
    triggerEvent: 'inventory.stock.below_reorder_point',
    conditions: [{ path: 'onHand', op: 'lte', value: 5 }],
    actionKind: 'purchasing.reorder',
    actionTemplate: { variationId: '{{variationId}}', locationId: '{{locationId}}', at: 'now' },
    policy: 'automatic',
    idempotencyWindowSeconds: 3600,
  };
}

/** A valid payload for inventory.stock.below_reorder_point. */
export function reorderEvent(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    variationId: 'var_1',
    locationId: 'loc_1',
    onHand: 2,
    reorderPoint: 10,
    ...overrides,
  };
}
