import { describe, expect, it } from 'vitest';
import {
  EventBus,
  asCoreDb,
  coreMigrations,
  createTenant,
  type PlatformEvent,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import {
  workflowsCreateTaskContract,
  workflowsMigrations,
  type WorkflowsDatabase,
} from '@blacklabel/workflows';

describe('workflowsCreateTaskContract (core CreateTaskContract implementation)', () => {
  it('creates a tenant-scoped task row and emits workflows.task.created', async () => {
    const db = createTestDb<WorkflowsDatabase>();
    await runMigrations(db, [...coreMigrations, ...workflowsMigrations]);
    const tenantA = await createTenant(asCoreDb(db), { name: 'A' });
    const tenantB = await createTenant(asCoreDb(db), { name: 'B' });
    const events = new EventBus();
    const seen: PlatformEvent[] = [];
    events.on('workflows.task.created', (e) => {
      seen.push(e);
    });

    const contract = workflowsCreateTaskContract(db, events);
    const result = await contract.createTask({
      tenantId: tenantA.id,
      title: 'Send quote follow-up',
      description: 'from another module via contract',
      dueAt: '2030-01-01T00:00:00.000Z',
      relatedEntityType: 'quoting.quote',
      relatedEntityId: 'Q-77',
    });
    expect(result.id).toBeTruthy();

    const row = await db
      .selectFrom('workflows_tasks')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .where('id', '=', result.id)
      .executeTakeFirst();
    expect(row?.title).toBe('Send quote follow-up');
    expect(row?.related_entity_id).toBe('Q-77');
    expect(row?.status).toBe('open');

    // Event emitted with the right tenant.
    expect(seen.length).toBe(1);
    expect(seen[0].tenantId).toBe(tenantA.id);
    expect(seen[0].payload).toEqual({ taskId: result.id });

    // Invisible from the other tenant.
    const fromB = await db
      .selectFrom('workflows_tasks')
      .selectAll()
      .where('tenant_id', '=', tenantB.id)
      .execute();
    expect(fromB).toEqual([]);
  });

  it('rejects blank titles', async () => {
    const db = createTestDb<WorkflowsDatabase>();
    await runMigrations(db, [...coreMigrations, ...workflowsMigrations]);
    const tenant = await createTenant(asCoreDb(db), { name: 'A' });
    const contract = workflowsCreateTaskContract(db, new EventBus());
    await expect(contract.createTask({ tenantId: tenant.id, title: '  ' })).rejects.toMatchObject({
      status: 400,
    });
  });
});
