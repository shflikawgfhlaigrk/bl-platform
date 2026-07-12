import {
  EventBus,
  asCoreDb,
  coreMigrations,
  createTenant,
  type TenantRow,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { randomBytes } from 'node:crypto';
import { adminMigrations } from '../src/migrations';
import { adminRouter, type AdminRouterDeps } from '../src/router';
import type { AdminDatabase } from '../src/schema';
import { HealthService } from '../src/health';
import type { BackupProvider, CredentialTester } from '../src/index';

/** Deterministic 32-byte test key (base64). */
export const TEST_KEY = randomBytes(32);

export async function setup(
  extra:
    | Partial<AdminRouterDeps>
    | ((ctx: { db: ReturnType<typeof createTestDb<AdminDatabase>>; events: EventBus }) => Partial<AdminRouterDeps>) = {},
) {
  const db = createTestDb<AdminDatabase>();
  await runMigrations(db, [...coreMigrations, ...adminMigrations]);
  const tenantA = await createTenant(asCoreDb(db), { name: 'Alpha Tack' });
  const tenantB = await createTenant(asCoreDb(db), { name: 'Beta Tack' });
  const events = new EventBus();
  const overrides = typeof extra === 'function' ? extra({ db, events }) : extra;
  const app = adminRouter({
    db,
    events,
    contracts: {},
    masterKey: TEST_KEY,
    ...overrides,
  });
  return { db, tenantA, tenantB, events, app };
}

export function headers(
  tenant: TenantRow | { id: string },
  userId?: string,
): Record<string, string> {
  const h: Record<string, string> = {
    'x-tenant-id': tenant.id,
    'content-type': 'application/json',
  };
  if (userId) h['x-user-id'] = userId;
  return h;
}

/** A tester that always succeeds. */
export const okTester: CredentialTester = async () => ({ ok: true, detail: 'noop ok' });
/** A tester that always fails. */
export const failTester: CredentialTester = async () => ({ ok: false, detail: 'auth rejected' });

export { HealthService };
export type { BackupProvider };
