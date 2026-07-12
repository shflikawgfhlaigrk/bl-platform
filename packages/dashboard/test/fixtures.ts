import type { Kysely } from 'kysely';
import {
  EventBus,
  asCoreDb,
  computeTotals,
  coreMigrations,
  createTenant,
  type TenantRow,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { dashboardMigrations } from '../src/migrations';
import { dashboardRouter } from '../src/router';
import type { DashboardDatabase } from '../src/schema';

/**
 * Test fixtures. The dashboard only reads other modules' tables, so tests
 * create MINIMAL fixture versions of those tables matching the documented
 * read contracts in src/schema.ts (plus a few extra columns to prove the
 * dashboard tolerates the owning modules having wider rows).
 */

export async function setup() {
  const db = createTestDb<DashboardDatabase>();
  await runMigrations(db, [...coreMigrations, ...dashboardMigrations]);
  const tenantA = await createTenant(asCoreDb(db), { name: 'Alpha Services' });
  const tenantB = await createTenant(asCoreDb(db), { name: 'Beta Services' });
  const events = new EventBus();
  const app = dashboardRouter({ db, events, contracts: {} });
  return { db, tenantA, tenantB, events, app };
}

export function headers(tenant: TenantRow | { id: string }): Record<string, string> {
  return { 'x-tenant-id': tenant.id, 'content-type': 'application/json' };
}

export async function createSourceTables(db: Kysely<DashboardDatabase>): Promise<void> {
  await db.schema
    .createTable('billing_invoices')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('customer_id', 'text') // extra column beyond the read contract
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('total_cents', 'integer', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('crm_leads')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('name', 'text') // extra
    .addColumn('source', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('scheduling_appointments')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('quoting_quotes')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('workflows_tasks')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();

  // Mirrors portal-employee's real table: employee_id + clock_in_at/clock_out_at.
  await db.schema
    .createTable('portal_employee_time_entries')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('employee_id', 'text', (c) => c.notNull())
    .addColumn('shift_id', 'text') // extra column beyond the read contract
    .addColumn('clock_in_at', 'text', (c) => c.notNull())
    .addColumn('clock_out_at', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();

  // Real table name is portal_employee_work_logs (NOT *_worklogs).
  await db.schema
    .createTable('portal_employee_work_logs')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('assignment_id', 'text') // extra
    .addColumn('employee_id', 'text', (c) => c.notNull())
    .addColumn('kind', 'text') // extra
    .addColumn('body', 'text') // extra
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();

  // Reviews ratings live on reviews_responses (there is no reviews_reviews).
  await db.schema
    .createTable('reviews_responses')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('tenant_id', 'text', (c) => c.notNull())
    .addColumn('request_id', 'text') // extra
    .addColumn('customer_id', 'text') // extra
    .addColumn('rating', 'integer', (c) => c.notNull())
    .addColumn('comment', 'text') // extra
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
}

export interface SeedExpectations {
  /** computeTotals-derived totals of the two paid invoices, to the cent. */
  inv1TotalCents: number;
  inv2TotalCents: number;
  paidCents: number;
}

/**
 * Deterministic dataset for one tenant, spread across Jan/Feb/Mar 2026 so
 * date-range filters have known answers. All-time expectations:
 *   revenue: paid 2 invoices (computeTotals-derived), 6 invoices total
 *   leads: 6 (referral 3, web 2, unknown 1)
 *   appointments: 6 (scheduled 2, completed 3, canceled 1)
 *   quotes: 6 (draft 1, sent 2, approved 1, declined 1, converted 1)
 *           → sent-set 5, approved-set 2, conversion 4000 bps
 *   tasks: 6 (open 2, in_progress 1, completed 2, cancelled 1) → open 3
 *   time entries: 4 (60m + 90m + 30m completed = 180m, 1 open)
 *   worklogs: 3 (u-emp1 ×2, u-emp2 ×1)
 *   reviews: 4 (5,4,4,2) → avg 3.75
 *
 * February-only (2026-02-01 → 2026-02-28) expectations:
 *   revenue: paid = inv2 only; leads 2; appointments 3 (all completed);
 *   quotes sent-set 3 / approved 1 → 3333 bps; open tasks 2;
 *   minutes 120; worklogs 2; reviews 2 (4,4) → avg 4.
 */
export async function seedSources(
  db: Kysely<DashboardDatabase>,
  tenantId: string,
  prefix: string,
): Promise<SeedExpectations> {
  const inv1 = computeTotals(
    [
      { quantity: 2, unitPriceCents: 10000 },
      { quantity: 1.5, unitPriceCents: 8000, discount: { bps: 1000 } },
    ],
    { discount: { fixedCents: 500 }, taxBps: 825 },
  );
  const inv2 = computeTotals([{ quantity: 1, unitPriceCents: 4599 }], { taxBps: 825 });

  await db
    .insertInto('billing_invoices')
    .values([
      { id: `${prefix}-i1`, tenant_id: tenantId, status: 'paid', total_cents: inv1.totalCents, created_at: '2026-01-15T10:00:00.000Z' },
      { id: `${prefix}-i2`, tenant_id: tenantId, status: 'paid', total_cents: inv2.totalCents, created_at: '2026-02-10T10:00:00.000Z' },
      { id: `${prefix}-i3`, tenant_id: tenantId, status: 'sent', total_cents: 50000, created_at: '2026-02-20T10:00:00.000Z' },
      { id: `${prefix}-i4`, tenant_id: tenantId, status: 'void', total_cents: 10000, created_at: '2026-03-05T10:00:00.000Z' },
      { id: `${prefix}-i5`, tenant_id: tenantId, status: 'draft', total_cents: 12345, created_at: '2026-03-06T10:00:00.000Z' },
      { id: `${prefix}-i6`, tenant_id: tenantId, status: 'overdue', total_cents: 22200, created_at: '2026-03-07T10:00:00.000Z' },
    ])
    .execute();

  await db
    .insertInto('crm_leads')
    .values([
      { id: `${prefix}-l1`, tenant_id: tenantId, source: 'referral', created_at: '2026-01-05T10:00:00.000Z' },
      { id: `${prefix}-l2`, tenant_id: tenantId, source: 'referral', created_at: '2026-01-06T10:00:00.000Z' },
      { id: `${prefix}-l3`, tenant_id: tenantId, source: 'referral', created_at: '2026-01-07T10:00:00.000Z' },
      { id: `${prefix}-l4`, tenant_id: tenantId, source: 'web', created_at: '2026-02-02T10:00:00.000Z' },
      { id: `${prefix}-l5`, tenant_id: tenantId, source: 'web', created_at: '2026-02-03T10:00:00.000Z' },
      { id: `${prefix}-l6`, tenant_id: tenantId, source: null, created_at: '2026-03-01T10:00:00.000Z' },
    ])
    .execute();

  await db
    .insertInto('scheduling_appointments')
    .values([
      { id: `${prefix}-a1`, tenant_id: tenantId, status: 'scheduled', created_at: '2026-01-10T10:00:00.000Z' },
      { id: `${prefix}-a2`, tenant_id: tenantId, status: 'scheduled', created_at: '2026-01-11T10:00:00.000Z' },
      { id: `${prefix}-a3`, tenant_id: tenantId, status: 'completed', created_at: '2026-02-05T10:00:00.000Z' },
      { id: `${prefix}-a4`, tenant_id: tenantId, status: 'completed', created_at: '2026-02-06T10:00:00.000Z' },
      { id: `${prefix}-a5`, tenant_id: tenantId, status: 'completed', created_at: '2026-02-07T10:00:00.000Z' },
      { id: `${prefix}-a6`, tenant_id: tenantId, status: 'canceled', created_at: '2026-03-02T10:00:00.000Z' },
    ])
    .execute();

  await db
    .insertInto('quoting_quotes')
    .values([
      { id: `${prefix}-q1`, tenant_id: tenantId, status: 'draft', created_at: '2026-01-03T10:00:00.000Z' },
      { id: `${prefix}-q2`, tenant_id: tenantId, status: 'sent', created_at: '2026-01-20T10:00:00.000Z' },
      { id: `${prefix}-q3`, tenant_id: tenantId, status: 'sent', created_at: '2026-02-14T10:00:00.000Z' },
      { id: `${prefix}-q4`, tenant_id: tenantId, status: 'approved', created_at: '2026-02-15T10:00:00.000Z' },
      { id: `${prefix}-q5`, tenant_id: tenantId, status: 'declined', created_at: '2026-02-16T10:00:00.000Z' },
      { id: `${prefix}-q6`, tenant_id: tenantId, status: 'converted', created_at: '2026-03-03T10:00:00.000Z' },
    ])
    .execute();

  await db
    .insertInto('workflows_tasks')
    .values([
      { id: `${prefix}-t1`, tenant_id: tenantId, status: 'open', created_at: '2026-01-04T10:00:00.000Z' },
      { id: `${prefix}-t2`, tenant_id: tenantId, status: 'open', created_at: '2026-02-04T10:00:00.000Z' },
      { id: `${prefix}-t3`, tenant_id: tenantId, status: 'in_progress', created_at: '2026-02-09T10:00:00.000Z' },
      { id: `${prefix}-t4`, tenant_id: tenantId, status: 'completed', created_at: '2026-01-30T10:00:00.000Z' },
      { id: `${prefix}-t5`, tenant_id: tenantId, status: 'completed', created_at: '2026-02-28T10:00:00.000Z' },
      { id: `${prefix}-t6`, tenant_id: tenantId, status: 'cancelled', created_at: '2026-03-04T10:00:00.000Z' },
    ])
    .execute();

  await db
    .insertInto('portal_employee_time_entries')
    .values([
      { id: `${prefix}-e1`, tenant_id: tenantId, employee_id: 'u-emp1', clock_in_at: '2026-01-12T09:00:00.000Z', clock_out_at: '2026-01-12T10:00:00.000Z', created_at: '2026-01-12T09:00:00.000Z' },
      { id: `${prefix}-e2`, tenant_id: tenantId, employee_id: 'u-emp1', clock_in_at: '2026-02-11T09:00:00.000Z', clock_out_at: '2026-02-11T10:30:00.000Z', created_at: '2026-02-11T09:00:00.000Z' },
      { id: `${prefix}-e3`, tenant_id: tenantId, employee_id: 'u-emp2', clock_in_at: '2026-02-12T14:00:00.000Z', clock_out_at: '2026-02-12T14:30:00.000Z', created_at: '2026-02-12T14:00:00.000Z' },
      { id: `${prefix}-e4`, tenant_id: tenantId, employee_id: 'u-emp1', clock_in_at: '2026-03-08T09:00:00.000Z', clock_out_at: null, created_at: '2026-03-08T09:00:00.000Z' },
    ])
    .execute();

  await db
    .insertInto('portal_employee_work_logs')
    .values([
      { id: `${prefix}-w1`, tenant_id: tenantId, employee_id: 'u-emp1', created_at: '2026-01-13T10:00:00.000Z' },
      { id: `${prefix}-w2`, tenant_id: tenantId, employee_id: 'u-emp1', created_at: '2026-02-13T10:00:00.000Z' },
      { id: `${prefix}-w3`, tenant_id: tenantId, employee_id: 'u-emp2', created_at: '2026-02-14T10:00:00.000Z' },
    ])
    .execute();

  await db
    .insertInto('reviews_responses')
    .values([
      { id: `${prefix}-r1`, tenant_id: tenantId, rating: 5, created_at: '2026-01-25T10:00:00.000Z' },
      { id: `${prefix}-r2`, tenant_id: tenantId, rating: 4, created_at: '2026-02-21T10:00:00.000Z' },
      { id: `${prefix}-r3`, tenant_id: tenantId, rating: 4, created_at: '2026-02-22T10:00:00.000Z' },
      { id: `${prefix}-r4`, tenant_id: tenantId, rating: 2, created_at: '2026-03-09T10:00:00.000Z' },
    ])
    .execute();

  return {
    inv1TotalCents: inv1.totalCents,
    inv2TotalCents: inv2.totalCents,
    paidCents: inv1.totalCents + inv2.totalCents,
  };
}

/** Minimal contrasting dataset for the isolation tenant. */
export async function seedTenantB(db: Kysely<DashboardDatabase>, tenantId: string): Promise<void> {
  await db
    .insertInto('billing_invoices')
    .values([{ id: 'b-i1', tenant_id: tenantId, status: 'paid', total_cents: 999, created_at: '2026-02-01T10:00:00.000Z' }])
    .execute();
  await db
    .insertInto('crm_leads')
    .values([{ id: 'b-l1', tenant_id: tenantId, source: 'web', created_at: '2026-02-01T10:00:00.000Z' }])
    .execute();
}

export const FEB = { from: '2026-02-01', to: '2026-02-28' };
