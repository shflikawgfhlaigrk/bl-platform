import { describe, expect, it } from 'vitest';
import {
  EventBus,
  asCoreDb,
  coreMigrations,
  createTenant,
  type ModuleDeps,
  type PlatformEvent,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import {
  attachWorkflowEngine,
  workflowsMigrations,
  workflowsRouter,
  type WorkflowsDatabase,
} from '@blacklabel/workflows';

async function setup() {
  const db = createTestDb<WorkflowsDatabase>();
  await runMigrations(db, [...coreMigrations, ...workflowsMigrations]);
  const tenant = await createTenant(asCoreDb(db), { name: 'Router Co' });
  const events = new EventBus();
  const deps: ModuleDeps<WorkflowsDatabase> = { db, events, contracts: {} };
  attachWorkflowEngine(deps); // subscribe the engine like apps/api would
  const app = workflowsRouter(deps);
  const headers = { 'x-tenant-id': tenant.id, 'content-type': 'application/json' };
  return { db, events, tenant, app, headers };
}

const workflowBody = {
  name: 'Lead follow-up',
  triggerEvent: 'crm.lead.created',
  condition: { field: 'source', op: 'eq', value: 'web' },
  actions: [
    { type: 'create_task', config: { title: 'Call {{payload.leadId}}', dueInHours: 4 } },
    { type: 'send_email', config: { to: '{{payload.email}}', subject: 'Hi', body: 'Welcome' } },
  ],
};

describe('workflows router — definitions CRUD', () => {
  it('creates, reads, lists, updates, toggles and deletes a workflow', async () => {
    const { app, headers } = await setup();

    // create
    const createRes = await app.request('/', {
      method: 'POST',
      headers,
      body: JSON.stringify(workflowBody),
    });
    expect(createRes.status).toBe(201);
    const created = ((await createRes.json()) as any).data;
    expect(created.id).toBeTruthy();
    expect(created.enabled).toBe(true);
    expect(created.actions.length).toBe(2);
    expect(created.actions.map((a: any) => a.position)).toEqual([0, 1]);

    // get
    const getRes = await app.request(`/${created.id}`, { headers });
    expect(getRes.status).toBe(200);
    expect(((await getRes.json()) as any).data.name).toBe('Lead follow-up');

    // list
    const listRes = await app.request('/', { headers });
    const listBody = (await listRes.json()) as any;
    expect(listBody.data.length).toBe(1);
    expect(listBody.limit).toBe(50);
    expect(listBody.offset).toBe(0);

    // update (rename + replace actions + clear condition)
    const putRes = await app.request(`/${created.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        name: 'Renamed',
        condition: null,
        actions: [{ type: 'send_sms', config: { to: '1', body: 'yo' } }],
      }),
    });
    expect(putRes.status).toBe(200);
    const updated = ((await putRes.json()) as any).data;
    expect(updated.name).toBe('Renamed');
    expect(updated.condition).toBeNull();
    expect(updated.actions.length).toBe(1);
    expect(updated.actions[0].type).toBe('send_sms');

    // disable / enable
    const disableRes = await app.request(`/${created.id}/disable`, { method: 'POST', headers });
    expect(((await disableRes.json()) as any).data.enabled).toBe(false);
    const enableRes = await app.request(`/${created.id}/enable`, { method: 'POST', headers });
    expect(((await enableRes.json()) as any).data.enabled).toBe(true);

    // delete
    const deleteRes = await app.request(`/${created.id}`, { method: 'DELETE', headers });
    expect(deleteRes.status).toBe(200);
    const getGone = await app.request(`/${created.id}`, { headers });
    expect(getGone.status).toBe(404);
  });

  it('exposes the trigger/action vocabulary at /meta', async () => {
    const { app, headers } = await setup();
    const res = await app.request('/meta', { headers });
    const body = (await res.json()) as any;
    expect(body.data.triggerEvents).toContain('billing.invoice.paid');
    expect(body.data.actionTypes).toContain('webhook');
  });

  it('rejects unknown action types, trigger events and condition ops with 400', async () => {
    const { app, headers } = await setup();

    const badAction = await app.request('/', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...workflowBody,
        actions: [{ type: 'eval_code', config: { code: 'process.exit(1)' } }],
      }),
    });
    expect(badAction.status).toBe(400);
    expect(((await badAction.json()) as any).error.code).toBe('validation_error');

    const badTrigger = await app.request('/', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...workflowBody, triggerEvent: 'not.a.trigger' }),
    });
    expect(badTrigger.status).toBe(400);

    const badOp = await app.request('/', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...workflowBody, condition: { field: 'x', op: 'regex', value: '.*' } }),
    });
    expect(badOp.status).toBe(400);

    const noActions = await app.request('/', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...workflowBody, actions: [] }),
    });
    expect(noActions.status).toBe(400);
  });

  it('requires the tenant header (400) and a real tenant (404)', async () => {
    const { app } = await setup();
    const noHeader = await app.request('/', {});
    expect(noHeader.status).toBe(400);
    const badTenant = await app.request('/', { headers: { 'x-tenant-id': 'ghost' } });
    expect(badTenant.status).toBe(404);
  });
});

describe('workflows router — executions', () => {
  it('lists and details executions produced by the engine', async () => {
    const { app, headers, events, tenant } = await setup();
    const createRes = await app.request('/', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...workflowBody, condition: null }),
    });
    const workflowId = ((await createRes.json()) as any).data.id;

    await events.emit(tenant.id, 'crm.lead.created', { leadId: 'L1', email: 'a@b.c' });

    const listRes = await app.request(`/executions?workflow_id=${workflowId}`, { headers });
    const listBody = (await listRes.json()) as any;
    expect(listBody.data.length).toBe(1);
    expect(listBody.data[0].status).toBe('retrying');

    const detailRes = await app.request(`/executions/${listBody.data[0].id}`, { headers });
    const detail = ((await detailRes.json()) as any).data;
    expect(detail.triggerPayload).toEqual({ leadId: 'L1', email: 'a@b.c' });
    expect(detail.actions.length).toBe(2);
    expect(detail.actions.map((a: any) => a.status)).toEqual(['succeeded', 'failed']);
    expect(detail.actions[1].error).toContain('Email messaging is not connected');
  });
});

describe('workflows router — tasks', () => {
  it('creates, lists and completes tasks; completion emits workflows.task.completed', async () => {
    const { app, headers, events } = await setup();
    const completedEvents: PlatformEvent[] = [];
    events.on('workflows.task.completed', (e) => {
      completedEvents.push(e);
    });

    const createRes = await app.request('/tasks', {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Call customer', dueAt: '2030-01-01T00:00:00.000Z' }),
    });
    expect(createRes.status).toBe(201);
    const task = ((await createRes.json()) as any).data;
    expect(task.status).toBe('open');

    const listRes = await app.request('/tasks?status=open', { headers });
    expect(((await listRes.json()) as any).data.length).toBe(1);

    const completeRes = await app.request(`/tasks/${task.id}/complete`, {
      method: 'POST',
      headers,
    });
    expect(completeRes.status).toBe(200);
    expect(((await completeRes.json()) as any).data.status).toBe('completed');
    expect(completedEvents.length).toBe(1);
    expect(completedEvents[0].payload).toEqual({ taskId: task.id });

    // double-complete conflicts
    const again = await app.request(`/tasks/${task.id}/complete`, { method: 'POST', headers });
    expect(again.status).toBe(409);
  });
});

describe('workflows router — run-pending tick', () => {
  it('marks overdue tasks and reports them (workflows.task.overdue asserted)', async () => {
    const { app, headers, events } = await setup();
    const overdueEvents: PlatformEvent[] = [];
    events.on('workflows.task.overdue', (e) => {
      overdueEvents.push(e);
    });

    const createRes = await app.request('/tasks', {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'ancient todo', dueAt: '2020-01-01T00:00:00.000Z' }),
    });
    const task = ((await createRes.json()) as any).data;

    const tickRes = await app.request('/run-pending', { method: 'POST', headers });
    expect(tickRes.status).toBe(200);
    const tick = ((await tickRes.json()) as any).data;
    expect(tick.overdueTaskIds).toEqual([task.id]);
    expect(overdueEvents.length).toBe(1);
    expect(overdueEvents[0].payload).toMatchObject({ taskId: task.id });

    const overdueList = await app.request('/tasks?status=overdue', { headers });
    expect(((await overdueList.json()) as any).data.map((t: any) => t.id)).toEqual([task.id]);
  });
});

describe('workflows router — notifications and tags', () => {
  it('serves notification rows created by the notify_user action and marks them read', async () => {
    const { app, headers, events, tenant } = await setup();
    await app.request('/', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'notify',
        triggerEvent: 'messaging.message.received',
        actions: [
          { type: 'notify_user', config: { userId: 'U7', title: 'Msg from {{payload.from}}' } },
          { type: 'add_tag', config: { entityType: 'messaging.message', entityId: '{{payload.messageId}}', tag: 'inbound' } },
        ],
      }),
    });
    await events.emit(tenant.id, 'messaging.message.received', {
      messageId: 'M1',
      channel: 'sms',
      from: '+15551234',
    });

    const listRes = await app.request('/notifications?user_id=U7', { headers });
    const notes = ((await listRes.json()) as any).data;
    expect(notes.length).toBe(1);
    expect(notes[0].title).toBe('Msg from +15551234');
    expect(notes[0].read).toBe(false);

    const readRes = await app.request(`/notifications/${notes[0].id}/read`, {
      method: 'POST',
      headers,
    });
    expect(((await readRes.json()) as any).data.read).toBe(true);

    const tagsRes = await app.request('/tags?entity_type=messaging.message&entity_id=M1', {
      headers,
    });
    const tags = ((await tagsRes.json()) as any).data;
    expect(tags).toEqual([
      expect.objectContaining({ entityType: 'messaging.message', entityId: 'M1', tag: 'inbound' }),
    ]);
  });
});
