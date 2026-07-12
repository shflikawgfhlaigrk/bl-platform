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
  createWorkflow,
  evaluateCondition,
  getExecution,
  listExecutions,
  renderTemplate,
  workflowsMigrations,
  type FetchLike,
  type WorkflowEngineOptions,
  type WorkflowsDatabase,
} from '@blacklabel/workflows';

async function setup(contracts: Contracts = {}, engineOptions: WorkflowEngineOptions = {}) {
  const db = createTestDb<WorkflowsDatabase>();
  await runMigrations(db, [...coreMigrations, ...workflowsMigrations]);
  const tenant = await createTenant(asCoreDb(db), { name: 'Engine Co' });
  const events = new EventBus();
  const deps: ModuleDeps<WorkflowsDatabase> = { db, events, contracts };
  const { engine } = attachWorkflowEngine(deps, engineOptions);
  return { db, events, tenant, deps, engine };
}

const okFetch: FetchLike = async () => ({ status: 200, ok: true, text: async () => 'ok' });

describe('template + condition helpers', () => {
  it('renderTemplate resolves dot paths and blanks missing values', () => {
    const out = renderTemplate('lead {{payload.lead.id}} via {{payload.source}}{{payload.nope}}', {
      payload: { lead: { id: 'L1' }, source: 'web' },
    });
    expect(out).toBe('lead L1 via web');
  });

  it('evaluateCondition handles eq/gt/contains/exists/not_exists', () => {
    const payload = { totalCents: 5000, tags: ['vip'], name: 'Northwind' };
    expect(evaluateCondition({ field: 'totalCents', op: 'eq', value: 5000 }, payload)).toBe(true);
    expect(evaluateCondition({ field: 'totalCents', op: 'gt', value: 4999 }, payload)).toBe(true);
    expect(evaluateCondition({ field: 'totalCents', op: 'gt', value: 5000 }, payload)).toBe(false);
    expect(evaluateCondition({ field: 'name', op: 'contains', value: 'wind' }, payload)).toBe(true);
    expect(evaluateCondition({ field: 'tags', op: 'contains', value: 'vip' }, payload)).toBe(true);
    expect(evaluateCondition({ field: 'missing', op: 'exists' }, payload)).toBe(false);
    expect(evaluateCondition({ field: 'missing', op: 'not_exists' }, payload)).toBe(true);
    // Non-comparable types never match ordered operators.
    expect(evaluateCondition({ field: 'name', op: 'gt', value: 3 }, payload)).toBe(false);
  });
});

describe('trigger matching', () => {
  it('runs a matching enabled workflow and logs the execution', async () => {
    const { db, events, tenant } = await setup();
    await createWorkflow(db, events, tenant.id, {
      name: 'greet lead',
      triggerEvent: 'crm.lead.created',
      actions: [
        {
          type: 'send_email',
          config: {
            to: '{{payload.email}}',
            subject: 'Welcome {{payload.leadId}}',
            body: 'Thanks for reaching out.',
          },
        },
      ],
    });

    await events.emit(tenant.id, 'crm.lead.created', { leadId: 'L1', email: 'x@y.z' });

    const executions = await listExecutions(db, tenant.id);
    expect(executions.length).toBe(1);
    expect(executions[0].status).toBe('succeeded');
    expect(executions[0].triggerEvent).toBe('crm.lead.created');
    expect(executions[0].triggerPayload).toEqual({ leadId: 'L1', email: 'x@y.z' });

    const detail = await getExecution(db, tenant.id, executions[0].id);
    expect(detail.actions?.length).toBe(1);
    expect(detail.actions?.[0].status).toBe('succeeded');
    // Provider stub captured the rendered (templated) email.
    expect(detail.actions?.[0].output).toEqual({
      stub: true,
      channel: 'email',
      to: 'x@y.z',
      subject: 'Welcome L1',
      body: 'Thanks for reaching out.',
    });
  });

  it('does not run for other event types', async () => {
    const { db, events, tenant } = await setup();
    await createWorkflow(db, events, tenant.id, {
      name: 'lead only',
      triggerEvent: 'crm.lead.created',
      actions: [{ type: 'send_sms', config: { to: '1', body: 'hi' } }],
    });
    await events.emit(tenant.id, 'quoting.quote.approved', { quoteId: 'Q1' });
    expect(await listExecutions(db, tenant.id)).toEqual([]);
  });

  it('does not run a disabled workflow', async () => {
    const { db, events, tenant } = await setup();
    await createWorkflow(db, events, tenant.id, {
      name: 'off',
      triggerEvent: 'crm.lead.created',
      enabled: false,
      actions: [{ type: 'send_sms', config: { to: '1', body: 'hi' } }],
    });
    await events.emit(tenant.id, 'crm.lead.created', { leadId: 'L1' });
    expect(await listExecutions(db, tenant.id)).toEqual([]);
  });
});

describe('condition filter', () => {
  it('runs only when the payload condition matches', async () => {
    const { db, events, tenant } = await setup();
    await createWorkflow(db, events, tenant.id, {
      name: 'big invoices only',
      triggerEvent: 'billing.invoice.paid',
      condition: { field: 'totalCents', op: 'gte', value: 10_000 },
      actions: [{ type: 'send_sms', config: { to: '{{payload.customerId}}', body: 'thanks!' } }],
    });

    await events.emit(tenant.id, 'billing.invoice.paid', {
      invoiceId: 'I1',
      customerId: 'C1',
      totalCents: 500,
    });
    expect(await listExecutions(db, tenant.id)).toEqual([]);

    await events.emit(tenant.id, 'billing.invoice.paid', {
      invoiceId: 'I2',
      customerId: 'C1',
      totalCents: 25_000,
    });
    const executions = await listExecutions(db, tenant.id);
    expect(executions.length).toBe(1);
    expect(executions[0].status).toBe('succeeded');
  });
});

describe('actions', () => {
  it('create_task writes a task row and emits workflows.task.created', async () => {
    const { db, events, tenant } = await setup();
    const seen: PlatformEvent[] = [];
    events.on('workflows.task.created', (e) => {
      seen.push(e);
    });
    await createWorkflow(db, events, tenant.id, {
      name: 'follow up',
      triggerEvent: 'crm.lead.created',
      actions: [
        {
          type: 'create_task',
          config: {
            title: 'Call lead {{payload.leadId}}',
            dueInHours: 2,
            relatedEntityType: 'crm.lead',
            relatedEntityId: '{{payload.leadId}}',
          },
        },
      ],
    });

    await events.emit(tenant.id, 'crm.lead.created', { leadId: 'L9' });

    const task = await db
      .selectFrom('workflows_tasks')
      .selectAll()
      .where('tenant_id', '=', tenant.id)
      .executeTakeFirst();
    expect(task?.title).toBe('Call lead L9');
    expect(task?.related_entity_id).toBe('L9');
    expect(task?.due_at).toBeTruthy();
    expect(seen.length).toBe(1);
    expect(seen[0].payload).toEqual({ taskId: task!.id });
  });

  it('notify_user writes a notification row', async () => {
    const { db, events, tenant } = await setup();
    await createWorkflow(db, events, tenant.id, {
      name: 'ping owner',
      triggerEvent: 'crm.lead.created',
      actions: [
        { type: 'notify_user', config: { userId: 'U1', title: 'New lead {{payload.leadId}}' } },
      ],
    });
    await events.emit(tenant.id, 'crm.lead.created', { leadId: 'L2' });
    const note = await db
      .selectFrom('workflows_notifications')
      .selectAll()
      .where('tenant_id', '=', tenant.id)
      .executeTakeFirst();
    expect(note?.user_id).toBe('U1');
    expect(note?.title).toBe('New lead L2');
    expect(note?.read).toBe(0);
  });

  it('add_tag writes a tag row and is idempotent across runs', async () => {
    const { db, events, tenant } = await setup();
    await createWorkflow(db, events, tenant.id, {
      name: 'tag lead',
      triggerEvent: 'crm.lead.created',
      actions: [
        { type: 'add_tag', config: { entityType: 'crm.lead', entityId: '{{payload.leadId}}', tag: 'hot' } },
      ],
    });
    await events.emit(tenant.id, 'crm.lead.created', { leadId: 'L3' });
    await events.emit(tenant.id, 'crm.lead.created', { leadId: 'L3' });

    const tags = await db
      .selectFrom('workflows_tags')
      .selectAll()
      .where('tenant_id', '=', tenant.id)
      .execute();
    expect(tags.length).toBe(1);
    expect(tags[0].tag).toBe('hot');

    const executions = await listExecutions(db, tenant.id);
    expect(executions.length).toBe(2);
    const outputs = await Promise.all(
      executions.map(async (e) => (await getExecution(db, tenant.id, e.id)).actions?.[0].output),
    );
    expect(outputs).toEqual(
      expect.arrayContaining([expect.objectContaining({ created: true }), expect.objectContaining({ created: false })]),
    );
  });

  it('update_lead_stage records intent (stub per spec — no core contract yet)', async () => {
    const { db, events, tenant } = await setup();
    await createWorkflow(db, events, tenant.id, {
      name: 'advance stage',
      triggerEvent: 'quoting.quote.approved',
      actions: [
        { type: 'update_lead_stage', config: { leadId: '{{payload.customerId}}', stage: 'won' } },
      ],
    });
    await events.emit(tenant.id, 'quoting.quote.approved', {
      quoteId: 'Q1',
      customerId: 'C7',
      totalCents: 100,
    });
    const [execution] = await listExecutions(db, tenant.id);
    const detail = await getExecution(db, tenant.id, execution.id);
    expect(detail.actions?.[0].status).toBe('succeeded');
    expect(detail.actions?.[0].output).toEqual({ stub: true, leadId: 'C7', stage: 'won' });
  });

  it('create_appointment goes through the injected scheduling contract', async () => {
    const calls: unknown[] = [];
    const contracts: Contracts = {
      createAppointment: {
        createAppointment: async (input) => {
          calls.push(input);
          return { id: 'APPT-1' };
        },
      },
    };
    const { db, events, tenant } = await setup(contracts);
    await createWorkflow(db, events, tenant.id, {
      name: 'book follow-up visit',
      triggerEvent: 'quoting.quote.approved',
      actions: [
        {
          type: 'create_appointment',
          config: { customerId: '{{payload.customerId}}', startsInHours: 48, durationMinutes: 30 },
        },
      ],
    });
    await events.emit(tenant.id, 'quoting.quote.approved', {
      quoteId: 'Q2',
      customerId: 'C42',
      totalCents: 9900,
    });
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ tenantId: tenant.id, customerId: 'C42' });
    const [execution] = await listExecutions(db, tenant.id);
    const detail = await getExecution(db, tenant.id, execution.id);
    expect(detail.actions?.[0].output).toEqual({ appointmentId: 'APPT-1' });
  });

  it('create_appointment is skipped gracefully when the contract is absent', async () => {
    const { db, events, tenant } = await setup({});
    await createWorkflow(db, events, tenant.id, {
      name: 'book without contract',
      triggerEvent: 'quoting.quote.approved',
      actions: [{ type: 'create_appointment', config: { customerId: 'C1' } }],
    });
    await events.emit(tenant.id, 'quoting.quote.approved', {
      quoteId: 'Q3',
      customerId: 'C1',
      totalCents: 100,
    });
    const [execution] = await listExecutions(db, tenant.id);
    expect(execution.status).toBe('succeeded'); // skipped != failed: no retry churn
    const detail = await getExecution(db, tenant.id, execution.id);
    expect(detail.actions?.[0].status).toBe('skipped');
  });

  it('create_invoice goes through the injected billing contract', async () => {
    const calls: unknown[] = [];
    const contracts: Contracts = {
      createInvoice: {
        createInvoice: async (input) => {
          calls.push(input);
          return { id: 'INV-1' };
        },
      },
    };
    const { db, events, tenant } = await setup(contracts);
    await createWorkflow(db, events, tenant.id, {
      name: 'invoice completed appointment',
      triggerEvent: 'scheduling.appointment.completed',
      actions: [
        {
          type: 'create_invoice',
          config: {
            customerId: '{{payload.customerId}}',
            lines: [{ description: 'Service visit', quantity: 1, unitPriceCents: 12_500 }],
            taxBps: 800,
          },
        },
      ],
    });
    await events.emit(tenant.id, 'scheduling.appointment.completed', {
      appointmentId: 'A1',
      customerId: 'C9',
    });
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({
      tenantId: tenant.id,
      customerId: 'C9',
      lines: [{ description: 'Service visit', quantity: 1, unitPriceCents: 12_500 }],
      taxBps: 800,
    });
  });

  it('send_email routes through the messaging contract when wired', async () => {
    const calls: unknown[] = [];
    const contracts: Contracts = {
      sendMessage: {
        sendMessage: async (input) => {
          calls.push(input);
          return { id: 'MSG-1' };
        },
      },
    };
    const { db, events, tenant } = await setup(contracts);
    await createWorkflow(db, events, tenant.id, {
      name: 'contract email',
      triggerEvent: 'crm.lead.created',
      actions: [{ type: 'send_email', config: { to: 'a@b.c', subject: 's', body: 'b' } }],
    });
    await events.emit(tenant.id, 'crm.lead.created', { leadId: 'L1' });
    expect(calls[0]).toMatchObject({ tenantId: tenant.id, channel: 'email', to: 'a@b.c' });
    const [execution] = await listExecutions(db, tenant.id);
    const detail = await getExecution(db, tenant.id, execution.id);
    expect(detail.actions?.[0].output).toEqual({ messageId: 'MSG-1', via: 'contract' });
  });
});

describe('webhook action', () => {
  it('POSTs JSON with the trigger payload and captures the response', async () => {
    const requests: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({ url, init });
      return { status: 200, ok: true, text: async () => '{"received":true}' };
    };
    const { db, events, tenant } = await setup({}, { fetchImpl });
    await createWorkflow(db, events, tenant.id, {
      name: 'notify external system',
      triggerEvent: 'reviews.review.submitted',
      actions: [
        {
          type: 'webhook',
          config: { url: 'https://example.test/hooks/reviews', headers: { 'x-secret': 'shh' } },
        },
      ],
    });
    await events.emit(tenant.id, 'reviews.review.submitted', { reviewId: 'R1', rating: 5 });

    expect(requests.length).toBe(1);
    expect(requests[0].url).toBe('https://example.test/hooks/reviews');
    expect(requests[0].init.method).toBe('POST');
    expect(requests[0].init.headers['content-type']).toBe('application/json');
    expect(requests[0].init.headers['x-secret']).toBe('shh');
    const body = JSON.parse(requests[0].init.body);
    expect(body.payload).toEqual({ reviewId: 'R1', rating: 5 });
    expect(body.event.type).toBe('reviews.review.submitted');

    const [execution] = await listExecutions(db, tenant.id);
    const detail = await getExecution(db, tenant.id, execution.id);
    expect(detail.actions?.[0].output).toEqual({
      status: 200,
      responseBody: '{"received":true}',
    });
  });

  it('treats non-2xx responses as failures (retryable) and captures the status', async () => {
    const fetchImpl: FetchLike = async () => ({ status: 500, ok: false, text: async () => 'boom' });
    const { db, events, tenant } = await setup({}, { fetchImpl });
    await createWorkflow(db, events, tenant.id, {
      name: 'failing hook',
      triggerEvent: 'crm.lead.created',
      actions: [{ type: 'webhook', config: { url: 'https://example.test/hook' } }],
    });
    await events.emit(tenant.id, 'crm.lead.created', { leadId: 'L1' });
    const [execution] = await listExecutions(db, tenant.id);
    expect(execution.status).toBe('retrying');
    const detail = await getExecution(db, tenant.id, execution.id);
    expect(detail.actions?.[0].status).toBe('failed');
    expect(detail.actions?.[0].error).toContain('500');
    expect(detail.actions?.[0].error).toContain('boom');
  });

  it('times out and records the timeout error', async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const { db, events, tenant } = await setup({}, { fetchImpl });
    await createWorkflow(db, events, tenant.id, {
      name: 'slow hook',
      triggerEvent: 'crm.lead.created',
      actions: [{ type: 'webhook', config: { url: 'https://example.test/slow', timeoutMs: 10 } }],
    });
    await events.emit(tenant.id, 'crm.lead.created', { leadId: 'L1' });
    const [execution] = await listExecutions(db, tenant.id);
    const detail = await getExecution(db, tenant.id, execution.id);
    expect(detail.actions?.[0].status).toBe('failed');
    expect(detail.actions?.[0].error).toContain('timed out after 10ms');
  });
});

describe('failure isolation', () => {
  it('a failing action does not stop later actions in the same workflow', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('network down');
    };
    const { db, events, tenant } = await setup({}, { fetchImpl });
    await createWorkflow(db, events, tenant.id, {
      name: 'hook then notify',
      triggerEvent: 'crm.lead.created',
      actions: [
        { type: 'webhook', config: { url: 'https://example.test/hook' } },
        { type: 'notify_user', config: { userId: 'U1', title: 'still notified' } },
      ],
    });
    await events.emit(tenant.id, 'crm.lead.created', { leadId: 'L1' });

    const [execution] = await listExecutions(db, tenant.id);
    const detail = await getExecution(db, tenant.id, execution.id);
    expect(detail.actions?.map((a) => a.status)).toEqual(['failed', 'succeeded']);
    // Only the failed action is queued for retry.
    expect(execution.failedActionIds.length).toBe(1);
    const note = await db
      .selectFrom('workflows_notifications')
      .selectAll()
      .where('tenant_id', '=', tenant.id)
      .executeTakeFirst();
    expect(note?.title).toBe('still notified');
  });

  it('one broken workflow does not stop another workflow on the same trigger', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('always broken');
    };
    const { db, events, tenant } = await setup({}, { fetchImpl });
    await createWorkflow(db, events, tenant.id, {
      name: 'a-broken',
      triggerEvent: 'crm.lead.created',
      actions: [{ type: 'webhook', config: { url: 'https://example.test/broken' } }],
    });
    await createWorkflow(db, events, tenant.id, {
      name: 'b-healthy',
      triggerEvent: 'crm.lead.created',
      actions: [{ type: 'notify_user', config: { userId: 'U2', title: 'B ran' } }],
    });

    const emitResult = await events.emit(tenant.id, 'crm.lead.created', { leadId: 'L1' });
    expect(emitResult.errors).toEqual([]); // the engine never throws into the bus

    const executions = await listExecutions(db, tenant.id);
    expect(executions.length).toBe(2);
    const note = await db
      .selectFrom('workflows_notifications')
      .selectAll()
      .where('tenant_id', '=', tenant.id)
      .executeTakeFirst();
    expect(note?.title).toBe('B ran');
  });
});
