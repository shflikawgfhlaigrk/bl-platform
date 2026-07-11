/**
 * Front Desk V4 — industries → scheduling bridge.
 * Applying an industry provisions REAL bookable scheduling_appointment_types
 * (not just the industries_appointment_types read-model), idempotently, and
 * those types book via the scheduling API (201). Neutral example: spa-wellness.
 */
import { describe, it, expect } from 'vitest';
import { asCoreDb, coreMigrations, createTenant, EventBus } from '@blacklabel/core';
import { createTestDb, runMigrations, type Kysely } from '@blacklabel/db';
import {
  schedulingMigrations,
  schedulingRouter,
  createSchedulingAppointmentTypeContract,
  type SchedulingDatabase,
} from '@blacklabel/scheduling';
import { applyIndustry } from '../src/service';
import { industriesMigrations } from '../src/migrations';
import type { IndustriesDatabase } from '../src/schema';

type DB = IndustriesDatabase & SchedulingDatabase;

// Kysely's Transaction<DB> is invariant, so the shared intersection db is
// narrowed to each module's view at the boundary — the same `dbFor` pattern
// apps/api uses in the real composition root.
async function setup() {
  const db = createTestDb<DB>();
  await runMigrations(db, [...coreMigrations, ...industriesMigrations, ...schedulingMigrations]);
  const tenant = await createTenant(asCoreDb(db), { name: 'Spa Co' });
  const events = new EventBus();
  const indDb = db as unknown as Kysely<IndustriesDatabase>;
  const schedDb = db as unknown as Kysely<SchedulingDatabase>;
  const contracts = {
    createAppointmentType: createSchedulingAppointmentTypeContract({ db: schedDb, events }),
  };
  return { db, indDb, schedDb, events, contracts, tenantId: tenant.id };
}

function schedTypes(db: Kysely<SchedulingDatabase>, tenantId: string) {
  return db
    .selectFrom('scheduling_appointment_types')
    .select(['id', 'name', 'duration_minutes'])
    .where('tenant_id', '=', tenantId)
    .orderBy('name')
    .execute();
}

describe('industries → scheduling bridge', () => {
  it('provisions bookable scheduling appointment types from the industry', async () => {
    const { indDb, schedDb, contracts, tenantId } = await setup();
    await applyIndustry(indDb, tenantId, 'spa-wellness', { contracts });
    const types = await schedTypes(schedDb, tenantId);
    const byName = Object.fromEntries(types.map((t) => [t.name, t.duration_minutes]));
    expect(types).toHaveLength(3);
    expect(byName['Wellness Consultation']).toBe(30);
    expect(byName['60-Minute Massage']).toBe(60);
    expect(byName['Facial Treatment']).toBe(75);
  });

  it('books a bridged type via the scheduling API (201)', async () => {
    const { indDb, schedDb, events, contracts, tenantId } = await setup();
    await applyIndustry(indDb, tenantId, 'spa-wellness', { contracts });
    const [type] = await schedTypes(schedDb, tenantId);
    const app = schedulingRouter({ db: schedDb, events, contracts: {} });
    const headers = { 'x-tenant-id': tenantId, 'content-type': 'application/json' };
    const cal = await app.request('/calendars', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Main', timezone: 'UTC' }),
    });
    const calId = ((await cal.json()) as any).data.id;
    const res = await app.request('/appointments', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        calendarId: calId,
        title: 'Booked via bridge',
        appointmentTypeId: type.id,
        startsAt: '2026-07-13T10:00:00Z',
        timezone: 'UTC',
      }),
    });
    expect(res.status).toBe(201);
    const created = ((await res.json()) as any).data.appointments[0];
    expect(created.appointment_type_id).toBe(type.id);
  });

  it('is idempotent — re-applying does not duplicate scheduling types', async () => {
    const { indDb, schedDb, contracts, tenantId } = await setup();
    await applyIndustry(indDb, tenantId, 'spa-wellness', { contracts });
    await applyIndustry(indDb, tenantId, 'spa-wellness', { contracts });
    expect(await schedTypes(schedDb, tenantId)).toHaveLength(3);
  });

  it('without the contract, only the read-model is written (back-compat)', async () => {
    const { indDb, schedDb, tenantId } = await setup();
    await applyIndustry(indDb, tenantId, 'spa-wellness', {});
    expect(await schedTypes(schedDb, tenantId)).toHaveLength(0);
    const readModel = await indDb
      .selectFrom('industries_appointment_types')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .execute();
    expect(readModel).toHaveLength(3);
  });
});
