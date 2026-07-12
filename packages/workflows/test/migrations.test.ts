import { describe, expect, it } from 'vitest';
import { EventBus, asCoreDb, coreMigrations, createTenant } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import {
  seedWorkflows,
  workflowsMigrations,
  type WorkflowsDatabase,
} from '@blacklabel/workflows';

describe('workflows migrations', () => {
  it('apply on a fresh db (after core) and create the module tables', async () => {
    const db = createTestDb<WorkflowsDatabase>();
    const result = await runMigrations(db, [...coreMigrations, ...workflowsMigrations]);
    expect(result.applied).toEqual(
      expect.arrayContaining([
        'workflows.0001_workflows_and_actions',
        'workflows.0002_executions',
        'workflows.0003_tasks_notifications_tags',
      ]),
    );

    // Prove each table exists and accepts a row shaped by our schema types.
    await db
      .insertInto('workflows_workflows')
      .values({
        id: 'w1',
        tenant_id: 't1',
        name: 'demo',
        trigger_event: 'crm.lead.created',
        condition_json: null,
        enabled: 1,
        max_attempts: 3,
        created_at: '2026-07-10T00:00:00.000Z',
        updated_at: '2026-07-10T00:00:00.000Z',
      })
      .execute();
    const row = await db
      .selectFrom('workflows_workflows')
      .selectAll()
      .where('tenant_id', '=', 't1')
      .executeTakeFirst();
    expect(row?.name).toBe('demo');
  });

  it('are idempotent on re-run', async () => {
    const db = createTestDb<WorkflowsDatabase>();
    await runMigrations(db, [...coreMigrations, ...workflowsMigrations]);
    const second = await runMigrations(db, [...coreMigrations, ...workflowsMigrations]);
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBe(coreMigrations.length + workflowsMigrations.length);
  });
});

describe('seedWorkflows', () => {
  it('creates demo workflows for the tenant', async () => {
    const db = createTestDb<WorkflowsDatabase>();
    await runMigrations(db, [...coreMigrations, ...workflowsMigrations]);
    const tenant = await createTenant(asCoreDb(db), { name: 'Seed Co' });
    const created = await seedWorkflows(db, tenant.id, new EventBus());
    expect(created.length).toBe(3);
    const rows = await db
      .selectFrom('workflows_workflows')
      .selectAll()
      .where('tenant_id', '=', tenant.id)
      .execute();
    expect(rows.length).toBe(3);
    expect(created[2].condition).toEqual({ field: 'totalCents', op: 'gte', value: 50_000 });
  });
});
