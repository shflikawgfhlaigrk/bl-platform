import {
  EventBus,
  asCoreDb,
  coreMigrations,
  createTenant,
  type PlatformEvent,
  type TenantRow,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { showsMigrations } from '../src/migrations';
import { showsRouter } from '../src/router';
import type { ShowsDatabase } from '../src/schema';

export async function setup() {
  const db = createTestDb<ShowsDatabase>();
  await runMigrations(db, [...coreMigrations, ...showsMigrations]);
  const tenantA = await createTenant(asCoreDb(db), { name: 'Alpha Tack' });
  const tenantB = await createTenant(asCoreDb(db), { name: 'Beta Tack' });
  const events = new EventBus();
  const app = showsRouter({ db, events, contracts: {} });
  return { db, tenantA, tenantB, events, app };
}

export function headers(tenant: TenantRow | { id: string }): Record<string, string> {
  return { 'x-tenant-id': tenant.id, 'content-type': 'application/json' };
}

/** Minimal shape of the Hono app used by these helpers. */
export type TestApp = { request: (url: string, init?: RequestInit) => Response | Promise<Response> };

/** Collect every event of `type` emitted during the test. */
export function collect(events: EventBus, type: string): Array<PlatformEvent> {
  const seen: Array<PlatformEvent> = [];
  events.on(type, (e) => {
    seen.push(e);
  });
  return seen;
}

/** POST/PATCH JSON helper against the router. */
export async function req(
  app: TestApp,
  method: string,
  url: string,
  tenant: { id: string },
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const init: RequestInit = { method, headers: headers(tenant) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await app.request(url, init);
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** Create a venue + planned show, returning both ids. */
export async function makeShow(
  app: TestApp,
  tenant: { id: string },
  overrides: Record<string, unknown> = {},
): Promise<{ venueId: string; showId: string }> {
  const venue = await req(app, 'POST', '/venues', tenant, {
    name: 'World Equestrian Center',
    state: 'FL',
    address: { street: '1 Equestrian Way', city: 'Ocala', state: 'FL', zip: '34482' },
  });
  const venueId = venue.json.data.id;
  const show = await req(app, 'POST', '/shows', tenant, {
    venueId,
    name: 'WEC Winter Spectacular',
    startsOn: '2026-01-15',
    endsOn: '2026-01-20',
    boothFeeCents: 50000,
    travelCostCents: 30000,
    staffing: [{ name: 'Mags' }],
    ...overrides,
  });
  return { venueId, showId: show.json.data.id };
}

/** Drive a show all the way to `closing` so a closeout can be completed/closed. */
export async function driveToClosing(
  app: TestApp,
  tenant: { id: string },
  showId: string,
): Promise<void> {
  for (const to of ['packing', 'active', 'returned', 'closing']) {
    const r = await req(app, 'POST', `/shows/${showId}/transition`, tenant, { to });
    if (r.status !== 200) throw new Error(`transition to ${to} failed: ${JSON.stringify(r.json)}`);
  }
}
