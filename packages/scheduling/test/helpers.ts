import {
  asCoreDb,
  coreMigrations,
  createTenant,
  EventBus,
  type TenantRow,
} from '@blacklabel/core';
import { createTestDb, runMigrations, type Kysely } from '@blacklabel/db';
import { schedulingMigrations, schedulingRouter } from '@blacklabel/scheduling';
import type { Hono } from 'hono';
import type { TenantEnv } from '@blacklabel/core';
import type { SchedulingDatabase } from '../src/schema';
import {
  createSchedulingContext,
  NoopExternalCalendarProvider,
  type ReminderDeliveryInput,
  type ReminderDeliveryProvider,
  type SchedulingCtx,
} from '../src/service';

class TestReminderProvider implements ReminderDeliveryProvider {
  readonly name = 'test';
  readonly deliveries: ReminderDeliveryInput[] = [];

  async deliver(input: ReminderDeliveryInput): Promise<{ delivered: boolean }> {
    this.deliveries.push(input);
    return { delivered: true };
  }
}

export interface TestWorld {
  db: Kysely<SchedulingDatabase>;
  events: EventBus;
  ctx: SchedulingCtx;
  app: Hono<TenantEnv>;
  tenantA: TenantRow;
  tenantB: TenantRow;
  reminderDelivery: TestReminderProvider;
  calendarSync: NoopExternalCalendarProvider;
}

export async function setup(): Promise<TestWorld> {
  const db = createTestDb<SchedulingDatabase>();
  await runMigrations(db, [...coreMigrations, ...schedulingMigrations]);
  const tenantA = await createTenant(asCoreDb(db), { name: 'Tenant A' });
  const tenantB = await createTenant(asCoreDb(db), { name: 'Tenant B' });
  const events = new EventBus();
  const reminderDelivery = new TestReminderProvider();
  const calendarSync = new NoopExternalCalendarProvider();
  const ctx = createSchedulingContext({ db, events, reminderDelivery, calendarSync });
  const app = schedulingRouter({ db, events, contracts: {} }, { reminderDelivery, calendarSync });
  return { db, events, ctx, app, tenantA, tenantB, reminderDelivery, calendarSync };
}

/** JSON request against the router with the tenant header set. */
export async function api(
  app: Hono<TenantEnv>,
  tenantId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await app.request(path, {
    method,
    headers: {
      'x-tenant-id': tenantId,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}
