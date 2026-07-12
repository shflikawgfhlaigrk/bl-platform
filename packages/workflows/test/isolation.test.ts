import { describe, expect, it } from 'vitest';
import {
  EventBus,
  asCoreDb,
  coreMigrations,
  createTenant,
  type ModuleDeps,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import {
  attachWorkflowEngine,
  workflowsMigrations,
  workflowsRouter,
  type WorkflowEngineOptions,
  type WorkflowsDatabase,
} from '@blacklabel/workflows';

async function setup(engineOptions: WorkflowEngineOptions = {}) {
  const db = createTestDb<WorkflowsDatabase>();
  await runMigrations(db, [...coreMigrations, ...workflowsMigrations]);
  const tenantA = await createTenant(asCoreDb(db), { name: 'Tenant A' });
  const tenantB = await createTenant(asCoreDb(db), { name: 'Tenant B' });
  const events = new EventBus();
  const deps: ModuleDeps<WorkflowsDatabase> = { db, events, contracts: {} };
  attachWorkflowEngine(deps, engineOptions);
  const app = workflowsRouter(deps, engineOptions);
  const headersA = { 'x-tenant-id': tenantA.id, 'content-type': 'application/json' };
  const headersB = { 'x-tenant-id': tenantB.id, 'content-type': 'application/json' };
  return { db, events, tenantA, tenantB, app, headersA, headersB };
}

const simpleWorkflow = {
  name: 'A-only workflow',
  triggerEvent: 'crm.lead.created',
  actions: [{ type: 'notify_user', config: { userId: 'U-A', title: 'lead in' } }],
};

describe('tenant isolation — workflows', () => {
  it('tenant B cannot read, update or delete tenant A workflows; A stays intact', async () => {
    const { app, headersA, headersB } = await setup();
    const createRes = await app.request('/', {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify(simpleWorkflow),
    });
    const workflow = ((await createRes.json()) as any).data;

    // read
    expect((((await (await app.request('/', { headers: headersB })).json()) as any).data)).toEqual([]);
    expect((await app.request(`/${workflow.id}`, { headers: headersB })).status).toBe(404);

    // update
    const putRes = await app.request(`/${workflow.id}`, {
      method: 'PUT',
      headers: headersB,
      body: JSON.stringify({ name: 'hijacked' }),
    });
    expect(putRes.status).toBe(404);

    // toggle + delete
    expect((await app.request(`/${workflow.id}/disable`, { method: 'POST', headers: headersB })).status).toBe(404);
    expect((await app.request(`/${workflow.id}`, { method: 'DELETE', headers: headersB })).status).toBe(404);

    // A's workflow untouched
    const getA = await app.request(`/${workflow.id}`, { headers: headersA });
    expect(getA.status).toBe(200);
    const body = ((await getA.json()) as any).data;
    expect(body.name).toBe('A-only workflow');
    expect(body.enabled).toBe(true);
  });

  it("an event for tenant A never runs tenant B's workflows (and vice versa)", async () => {
    const { app, events, tenantA, tenantB, headersA, headersB } = await setup();
    await app.request('/', {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify(simpleWorkflow),
    });
    await app.request('/', {
      method: 'POST',
      headers: headersB,
      body: JSON.stringify({ ...simpleWorkflow, name: 'B workflow' }),
    });

    await events.emit(tenantA.id, 'crm.lead.created', { leadId: 'L-A' });

    const execA = ((await (await app.request('/executions', { headers: headersA })).json()) as any).data;
    const execB = ((await (await app.request('/executions', { headers: headersB })).json()) as any).data;
    expect(execA.length).toBe(1);
    expect(execB.length).toBe(0);

    // Notifications (side effects) also landed only in tenant A.
    const notesA = ((await (await app.request('/notifications', { headers: headersA })).json()) as any).data;
    const notesB = ((await (await app.request('/notifications', { headers: headersB })).json()) as any).data;
    expect(notesA.length).toBe(1);
    expect(notesB.length).toBe(0);

    // B cannot read A's execution detail by id.
    const detailRes = await app.request(`/executions/${execA[0].id}`, { headers: headersB });
    expect(detailRes.status).toBe(404);
  });
});

describe('tenant isolation — tasks, notifications, tags', () => {
  it('tasks are invisible and immutable across tenants', async () => {
    const { app, headersA, headersB } = await setup();
    const createRes = await app.request('/tasks', {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify({ title: 'A task' }),
    });
    const task = ((await createRes.json()) as any).data;

    expect((((await (await app.request('/tasks', { headers: headersB })).json()) as any).data)).toEqual([]);
    expect((await app.request(`/tasks/${task.id}`, { headers: headersB })).status).toBe(404);
    expect(
      (await app.request(`/tasks/${task.id}/complete`, { method: 'POST', headers: headersB })).status,
    ).toBe(404);

    // still open for A
    const getA = await app.request(`/tasks/${task.id}`, { headers: headersA });
    expect(((await getA.json()) as any).data.status).toBe('open');
  });

  it("run-pending for tenant B does not touch tenant A's overdue tasks or retries", async () => {
    const { app, headersA, headersB } = await setup();
    await app.request('/tasks', {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify({ title: 'A overdue', dueAt: '2020-01-01T00:00:00.000Z' }),
    });

    const tickB = ((await (await app.request('/run-pending', { method: 'POST', headers: headersB })).json()) as any).data;
    expect(tickB.overdueTaskIds).toEqual([]);

    // A's task is still open until A (or the system sweep) ticks.
    const tasksA = ((await (await app.request('/tasks?status=open', { headers: headersA })).json()) as any).data;
    expect(tasksA.length).toBe(1);

    const tickA = ((await (await app.request('/run-pending', { method: 'POST', headers: headersA })).json()) as any).data;
    expect(tickA.overdueTaskIds.length).toBe(1);
  });

  it("run-pending for tenant B does not process tenant A's due execution retries", async () => {
    // Every webhook call fails instantly -> executions land in 'retrying'.
    const { app, events, tenantA, headersA, headersB } = await setup({
      fetchImpl: async () => {
        throw new Error('down');
      },
      baseBackoffMs: 1, // due almost immediately
    });
    await app.request('/', {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify({
        name: 'A hook',
        triggerEvent: 'crm.lead.created',
        actions: [{ type: 'webhook', config: { url: 'https://example.test/a' } }],
      }),
    });
    await events.emit(tenantA.id, 'crm.lead.created', { leadId: 'L-A' });
    await new Promise((r) => setTimeout(r, 5)); // pass the 1ms backoff

    const tickB = ((await (await app.request('/run-pending', { method: 'POST', headers: headersB })).json()) as any).data;
    expect(tickB.retriedExecutionIds).toEqual([]);

    // A's execution is untouched (still attempt 1) until A ticks.
    let execA = ((await (await app.request('/executions', { headers: headersA })).json()) as any).data;
    expect(execA[0].status).toBe('retrying');
    expect(execA[0].attempts).toBe(1);

    const tickA = ((await (await app.request('/run-pending', { method: 'POST', headers: headersA })).json()) as any).data;
    expect(tickA.retriedExecutionIds).toEqual([execA[0].id]);
    execA = ((await (await app.request('/executions', { headers: headersA })).json()) as any).data;
    expect(execA[0].attempts).toBe(2);
  });

  it('notifications and tags are tenant-scoped', async () => {
    const { db, app, events, tenantA, headersA, headersB } = await setup();
    await app.request('/', {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify({
        name: 'notify+tag',
        triggerEvent: 'reviews.review.submitted',
        actions: [
          { type: 'notify_user', config: { userId: 'U1', title: 'review!' } },
          { type: 'add_tag', config: { entityType: 'reviews.review', entityId: '{{payload.reviewId}}', tag: 'five-star' } },
        ],
      }),
    });
    await events.emit(tenantA.id, 'reviews.review.submitted', { reviewId: 'R1', rating: 5 });

    const notesB = ((await (await app.request('/notifications', { headers: headersB })).json()) as any).data;
    expect(notesB).toEqual([]);
    const tagsB = ((await (await app.request('/tags', { headers: headersB })).json()) as any).data;
    expect(tagsB).toEqual([]);

    const notesA = ((await (await app.request('/notifications', { headers: headersA })).json()) as any).data;
    expect(notesA.length).toBe(1);

    // B cannot mark A's notification read — and it stays unread for A.
    const noteId = notesA[0].id;
    expect(
      (await app.request(`/notifications/${noteId}/read`, { method: 'POST', headers: headersB })).status,
    ).toBe(404);
    const rowA = await db
      .selectFrom('workflows_notifications')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .where('id', '=', noteId)
      .executeTakeFirst();
    expect(rowA?.read).toBe(0);
  });
});
