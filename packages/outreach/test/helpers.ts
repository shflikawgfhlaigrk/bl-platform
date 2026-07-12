import { EventBus, asCoreDb, coreMigrations, createTenant, type PlatformEvent, type TenantRow } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { outreachMigrations } from '../src/migrations';
import { outreachRouter } from '../src/router';
import type { OutreachDatabase } from '../src/schema';
import type { OutreachAdapters, IsSuppressedFn, SuppressFn } from '../src/adapters';

export async function setup(adapters: OutreachAdapters = {}) {
  const db = createTestDb<OutreachDatabase>();
  await runMigrations(db, [...coreMigrations, ...outreachMigrations]);
  const tenantA = await createTenant(asCoreDb(db), { name: 'Mags Tack' });
  const tenantB = await createTenant(asCoreDb(db), { name: 'Other Barn' });
  const events = new EventBus();
  const app = outreachRouter({ db, events, contracts: {} }, adapters);
  return { db, tenantA, tenantB, events, app };
}

export function headers(tenant: TenantRow | { id: string }): Record<string, string> {
  return { 'x-tenant-id': tenant.id, 'content-type': 'application/json' };
}

/** Collect events of a given type (or '*') into an array for assertions. */
export function collect(events: EventBus, type = '*'): PlatformEvent[] {
  const captured: PlatformEvent[] = [];
  events.on(type, (e) => {
    captured.push(e);
  });
  return captured;
}

/** A trivial in-memory suppression store implementing the injected callbacks. */
export function makeSuppressions() {
  const set = new Set<string>();
  const suppress: SuppressFn = (tenantId, email) => {
    set.add(`${tenantId}:${email.toLowerCase()}`);
  };
  const isSuppressed: IsSuppressedFn = (tenantId, email) => set.has(`${tenantId}:${email.toLowerCase()}`);
  return { set, suppress, isSuppressed };
}

/** Fully open all send gates for a tenant (armed + postal + provider + from). */
export async function armTenant(app: import('hono').Hono<any>, tenant: { id: string }) {
  const res = await app.request('/settings', {
    method: 'PUT',
    headers: headers(tenant),
    body: JSON.stringify({
      armed: true,
      postalAddress: '123 Barn Rd, Newnan GA 30263',
      fromEmail: 'shop@magstack.test',
      fromName: 'Mags Tack',
      providerCredentialRef: 'cred_smtp_1',
    }),
  });
  if (res.status !== 200) throw new Error(`armTenant failed: ${res.status} ${await res.text()}`);
  return res;
}
