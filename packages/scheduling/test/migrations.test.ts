import { describe, expect, it } from 'vitest';
import { coreMigrations } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { schedulingMigrations } from '@blacklabel/scheduling';
import type { SchedulingDatabase } from '../src/schema';

describe('scheduling migrations', () => {
  it('apply on a fresh db after core migrations', async () => {
    const db = createTestDb<SchedulingDatabase>();
    const result = await runMigrations(db, [...coreMigrations, ...schedulingMigrations]);
    for (const m of schedulingMigrations) {
      expect(result.applied).toContain(m.name);
    }
    expect(result.skipped).toEqual([]);

    // Every scheduling table is queryable.
    await db.selectFrom('scheduling_calendars').selectAll().execute();
    await db.selectFrom('scheduling_locations').selectAll().execute();
    await db.selectFrom('scheduling_staff_members').selectAll().execute();
    await db.selectFrom('scheduling_resources').selectAll().execute();
    await db.selectFrom('scheduling_appointment_types').selectAll().execute();
    await db.selectFrom('scheduling_availability_windows').selectAll().execute();
    await db.selectFrom('scheduling_availability_exceptions').selectAll().execute();
    await db.selectFrom('scheduling_schedule_rules').selectAll().execute();
    await db.selectFrom('scheduling_appointments').selectAll().execute();
    await db.selectFrom('scheduling_appointment_staff').selectAll().execute();
    await db.selectFrom('scheduling_appointment_resources').selectAll().execute();
    await db.selectFrom('scheduling_reminders').selectAll().execute();
  });

  it('are idempotent on re-run', async () => {
    const db = createTestDb<SchedulingDatabase>();
    await runMigrations(db, [...coreMigrations, ...schedulingMigrations]);
    const second = await runMigrations(db, [...coreMigrations, ...schedulingMigrations]);
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBe(coreMigrations.length + schedulingMigrations.length);
  });
});
