import { describe, expect, it } from 'vitest';
import {
  EventBus,
  asCoreDb,
  coreMigrations,
  createTenant,
  type Contracts,
  type ModuleDeps,
  type PlatformEvent,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import {
  attachWorkflowEngine,
  createTask,
  createWorkflow,
  getExecution,
  listExecutions,
  setWorkflowEnabled,
  workflowsMigrations,
  type WorkflowsDatabase,
} from '@blacklabel/workflows';

const T0 = '2026-07-10T00:00:00.000Z';

/** Deterministic setup: fixed controllable clock + 1s base backoff. */
async function setup(contracts: Contracts = {}) {
  const db = createTestDb<WorkflowsDatabase>();
  await runMigrations(db, [...coreMigrations, ...workflowsMigrations]);
  const tenant = await createTenant(asCoreDb(db), { name: 'Retry Co' });
  const events = new EventBus();
  const deps: ModuleDeps<WorkflowsDatabase> = { db, events, contracts };
  const clockBox = { now: T0 };
  const { engine } = attachWorkflowEngine(deps, {
    baseBackoffMs: 1000,
    clock: () => clockBox.now,
  });
  return { db, events, tenant, engine, clockBox };
}

describe('retry with exponential backoff', () => {
  it('persists attempts + next_retry_at, doubles the delay, then fails permanently', async () => {
    let failuresLeft = 99; // never recovers
    const contracts: Contracts = {
      createAppointment: {
        createAppointment: async () => {
          if (failuresLeft-- > 0) throw new Error('scheduler offline');
          return { id: 'A1' };
        },
      },
    };
    const { db, events, tenant, engine, clockBox } = await setup(contracts);
    const failedEvents: PlatformEvent[] = [];
    events.on('workflows.execution.failed', (e) => {
      failedEvents.push(e);
    });

    const workflow = await createWorkflow(db, events, tenant.id, {
      name: 'book it',
      triggerEvent: 'crm.lead.created',
      maxAttempts: 3,
      actions: [{ type: 'create_appointment', config: { customerId: 'C1' } }],
    });

    await events.emit(tenant.id, 'crm.lead.created', { leadId: 'L1' });

    // Attempt 1 failed -> retrying, backoff = 1000ms * 2^0
    let [execution] = await listExecutions(db, tenant.id);
    expect(execution.status).toBe('retrying');
    expect(execution.attempts).toBe(1);
    expect(execution.nextRetryAt).toBe('2026-07-10T00:00:01.000Z');

    // Not due yet: nothing processed.
    clockBox.now = '2026-07-10T00:00:00.500Z';
    let tick = await engine.runPending({ tenantId: tenant.id });
    expect(tick.retried).toEqual([]);

    // Due: attempt 2 fails -> backoff doubles to 2000ms.
    clockBox.now = '2026-07-10T00:00:01.000Z';
    tick = await engine.runPending({ tenantId: tenant.id });
    expect(tick.retried).toEqual([execution.id]);
    [execution] = await listExecutions(db, tenant.id);
    expect(execution.attempts).toBe(2);
    expect(execution.status).toBe('retrying');
    expect(execution.nextRetryAt).toBe('2026-07-10T00:00:03.000Z');

    // Attempt 3 = maxAttempts -> permanent failure, emits workflows.execution.failed.
    clockBox.now = '2026-07-10T00:00:03.000Z';
    await engine.runPending({ tenantId: tenant.id });
    [execution] = await listExecutions(db, tenant.id);
    expect(execution.status).toBe('failed');
    expect(execution.attempts).toBe(3);
    expect(execution.nextRetryAt).toBeNull();
    expect(execution.finishedAt).toBe('2026-07-10T00:00:03.000Z');
    expect(failedEvents.length).toBe(1);
    expect(failedEvents[0].payload).toMatchObject({
      executionId: execution.id,
      workflowId: workflow.id,
      attempts: 3,
    });

    // Per-attempt action log rows: one failed row per attempt.
    const detail = await getExecution(db, tenant.id, execution.id);
    expect(detail.actions?.map((a) => [a.attempt, a.status])).toEqual([
      [1, 'failed'],
      [2, 'failed'],
      [3, 'failed'],
    ]);
    expect(detail.actions?.every((a) => a.error === 'scheduler offline')).toBe(true);
  });

  it('re-runs ONLY the failed actions on retry and succeeds once they recover', async () => {
    let appointmentCalls = 0;
    let invoiceCalls = 0;
    let invoiceShouldFail = true;
    const contracts: Contracts = {
      createAppointment: {
        createAppointment: async () => {
          appointmentCalls += 1;
          return { id: 'A1' };
        },
      },
      createInvoice: {
        createInvoice: async () => {
          invoiceCalls += 1;
          if (invoiceShouldFail) throw new Error('billing offline');
          return { id: 'I1' };
        },
      },
    };
    const { db, events, tenant, engine, clockBox } = await setup(contracts);
    const succeededEvents: PlatformEvent[] = [];
    events.on('workflows.execution.succeeded', (e) => {
      succeededEvents.push(e);
    });

    await createWorkflow(db, events, tenant.id, {
      name: 'book then bill',
      triggerEvent: 'scheduling.appointment.completed',
      actions: [
        { type: 'create_appointment', config: { customerId: 'C1' } },
        {
          type: 'create_invoice',
          config: {
            customerId: 'C1',
            lines: [{ description: 'visit', quantity: 1, unitPriceCents: 100 }],
          },
        },
      ],
    });

    await events.emit(tenant.id, 'scheduling.appointment.completed', { appointmentId: 'A0' });
    expect(appointmentCalls).toBe(1);
    expect(invoiceCalls).toBe(1);
    let [execution] = await listExecutions(db, tenant.id);
    expect(execution.status).toBe('retrying');
    expect(execution.failedActionIds.length).toBe(1);

    invoiceShouldFail = false;
    clockBox.now = '2026-07-10T00:00:01.000Z';
    await engine.runPending({ tenantId: tenant.id });

    [execution] = await listExecutions(db, tenant.id);
    expect(execution.status).toBe('succeeded');
    expect(execution.failedActionIds).toEqual([]);
    // The already-succeeded appointment action was NOT re-run.
    expect(appointmentCalls).toBe(1);
    expect(invoiceCalls).toBe(2);
    expect(succeededEvents.length).toBe(1);
  });

  it('pauses due retries while the workflow is disabled and resumes on re-enable', async () => {
    let shouldFail = true;
    let calls = 0;
    const contracts: Contracts = {
      createAppointment: {
        createAppointment: async () => {
          calls += 1;
          if (shouldFail) throw new Error('offline');
          return { id: 'A1' };
        },
      },
    };
    const { db, events, tenant, engine, clockBox } = await setup(contracts);
    const workflow = await createWorkflow(db, events, tenant.id, {
      name: 'pausable',
      triggerEvent: 'crm.lead.created',
      maxAttempts: 5,
      actions: [{ type: 'create_appointment', config: { customerId: 'C1' } }],
    });

    await events.emit(tenant.id, 'crm.lead.created', { leadId: 'L1' });
    expect(calls).toBe(1);
    let [execution] = await listExecutions(db, tenant.id);
    expect(execution.status).toBe('retrying');

    // Disable the workflow: the due retry must NOT run its actions.
    await setWorkflowEnabled(db, events, tenant.id, workflow.id, false);
    shouldFail = false; // would succeed if (wrongly) run
    clockBox.now = '2026-07-10T00:00:01.000Z';
    let tick = await engine.runPending({ tenantId: tenant.id });
    expect(tick.retried).toEqual([]);
    expect(calls).toBe(1);
    [execution] = await listExecutions(db, tenant.id);
    expect(execution.status).toBe('retrying'); // paused, not lost
    expect(execution.attempts).toBe(1);

    // Re-enable: the next tick picks the execution back up and it succeeds.
    await setWorkflowEnabled(db, events, tenant.id, workflow.id, true);
    tick = await engine.runPending({ tenantId: tenant.id });
    expect(tick.retried).toEqual([execution.id]);
    expect(calls).toBe(2);
    [execution] = await listExecutions(db, tenant.id);
    expect(execution.status).toBe('succeeded');
    expect(execution.attempts).toBe(2);
  });
});

describe('runPending tick — overdue tasks', () => {
  it('marks due tasks overdue, emits workflows.task.overdue, and triggers workflows off it', async () => {
    const { db, events, tenant, engine, clockBox } = await setup();
    const overdueEvents: PlatformEvent[] = [];
    events.on('workflows.task.overdue', (e) => {
      overdueEvents.push(e);
    });

    // A workflow that reacts to overdue tasks by notifying a user.
    await createWorkflow(db, events, tenant.id, {
      name: 'escalate overdue work',
      triggerEvent: 'workflows.task.overdue',
      actions: [
        { type: 'notify_user', config: { userId: 'MGR', title: 'Task {{payload.taskId}} is overdue' } },
      ],
    });

    const task = await createTask(db, events, tenant.id, {
      title: 'call back',
      dueAt: '2026-07-09T23:00:00.000Z', // before T0
    });
    const notDue = await createTask(db, events, tenant.id, {
      title: 'later',
      dueAt: '2026-07-11T00:00:00.000Z',
    });

    clockBox.now = T0;
    const tick = await engine.runPending({ tenantId: tenant.id });
    expect(tick.overdueTasks).toEqual([task.id]);
    expect(overdueEvents.length).toBe(1);
    expect(overdueEvents[0].payload).toEqual({ taskId: task.id, dueAt: '2026-07-09T23:00:00.000Z' });

    const rows = await db
      .selectFrom('workflows_tasks')
      .selectAll()
      .where('tenant_id', '=', tenant.id)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    expect(rows.find((r) => r.id === task.id)?.status).toBe('overdue');
    expect(rows.find((r) => r.id === notDue.id)?.status).toBe('open');

    // The overdue event triggered the escalation workflow.
    const note = await db
      .selectFrom('workflows_notifications')
      .selectAll()
      .where('tenant_id', '=', tenant.id)
      .executeTakeFirst();
    expect(note?.user_id).toBe('MGR');
    expect(note?.title).toBe(`Task ${task.id} is overdue`);

    // Second tick: nothing new (no re-marking, no duplicate events).
    const tick2 = await engine.runPending({ tenantId: tenant.id });
    expect(tick2.overdueTasks).toEqual([]);
    expect(overdueEvents.length).toBe(1);
  });
});
