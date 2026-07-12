import type { Hono } from 'hono';
import {
  EventBus,
  asCoreDb,
  coreMigrations,
  createTenant,
  type PlatformEvent,
  type TenantEnv,
  type TenantRow,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { inventoryMigrations } from '../src/migrations';
import { inventoryRouter } from '../src/router';
import type { InventoryDatabase } from '../src/schema';

export async function setup() {
  const db = createTestDb<InventoryDatabase>();
  await runMigrations(db, [...coreMigrations, ...inventoryMigrations]);
  const tenantA = await createTenant(asCoreDb(db), { name: 'Alpha Tack' });
  const tenantB = await createTenant(asCoreDb(db), { name: 'Beta Tack' });
  const events = new EventBus();
  const app = inventoryRouter({ db, events, contracts: {} });
  return { db, tenantA, tenantB, events, app };
}

export function headers(tenant: TenantRow | { id: string }): Record<string, string> {
  return { 'x-tenant-id': tenant.id, 'content-type': 'application/json' };
}

/** Capture every event of a given type (or '*') into an array. */
export function capture(events: EventBus, type = '*'): PlatformEvent[] {
  const seen: PlatformEvent[] = [];
  events.on(type, (e) => {
    seen.push(e);
  });
  return seen;
}

/** Deterministic seeded LCG — NO Math.random (repo determinism rule). */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // Numerical Recipes LCG constants.
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Random integer in [min, max] from a seeded generator. */
export function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export async function createLocation(
  app: Hono<TenantEnv>,
  tenant: { id: string },
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await app.request('/locations', {
    method: 'POST',
    headers: headers(tenant),
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { data: { id: string } };
  return json.data;
}
