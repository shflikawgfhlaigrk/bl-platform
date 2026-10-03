import { describe, expect, it } from 'vitest';
import { EventBus, asCoreDb, coreMigrations, createTenant, createUser, type PlatformEvent } from '@blacklabel/core';
import { createTestDb, runMigrations, type Kysely } from '@blacklabel/db';
import type { KyselyPlugin } from 'kysely';
import { billingCreateInvoiceContract, billingMigrations, type BillingDatabase } from '@blacklabel/billing';
import { createSchedulingContract, schedulingMigrations, type SchedulingDatabase } from '@blacklabel/scheduling';
import { createWorkflow, createWorkflowEngine, getExecution, listExecutions, updateWorkflow, setWorkflowEnabled,
  installWorkflowRecipe, listWorkflowRecipes, workflowsRouter, workflowsMigrations, type WorkflowsDatabase } from '@blacklabel/workflows';

const T0 = '2026-10-03T12:00:00.000Z';
async function setup() {
  const db = createTestDb<WorkflowsDatabase>();
  await runMigrations(db, [...coreMigrations, ...workflowsMigrations]);
  const tenant = await createTenant(asCoreDb(db), { name: 'Recovery fixture' });
  const owner = await createUser(asCoreDb(db), tenant.id, { name: 'Fixture owner', email: 'owner@example.test', role: 'owner' });
  const events = new EventBus(), clock = { now: T0 };
  const deps = { db, events, contracts: {} };
  const engine = createWorkflowEngine(deps, { clock: () => clock.now, baseBackoffMs: 1000 });
  const workflow = await createWorkflow(db, events, tenant.id, { name: 'Lead first touch', triggerEvent: 'crm.lead.created', actions: [
    { type: 'create_task', config: { title: 'Call {{payload.leadId}}', dueInHours: 24 } },
    { type: 'notify_user', config: { userId: 'owner-fixture', title: 'Lead {{payload.leadId}} needs a response' } },
    { type: 'add_tag', config: { entityType: 'crm.lead', entityId: '{{payload.leadId}}', tag: 'needs-first-touch' } },
  ] });
  const event: PlatformEvent = { id: 'stable-event-fixture', tenantId: tenant.id, type: 'crm.lead.created', payload: { leadId: 'L1' }, occurredAt: T0 };
  return { db, tenant, owner, events, clock, deps, engine, workflow, event };
}

async function interrupted(f: Awaited<ReturnType<typeof setup>>) {
  const [execution] = await listExecutions(f.db, f.tenant.id);
  // Persisted crash boundary: effects/atomic receipts survived, while attempt
  // logging/header finalization did not. No production data is touched.
  await f.db.deleteFrom('workflows_execution_actions').where('tenant_id', '=', f.tenant.id).where('execution_id', '=', execution.id).execute();
  await f.db.updateTable('workflows_executions').set({ status: 'retrying', attempts: 0, finished_at: null, next_retry_at: T0,
    failed_action_ids_json: null, claim_token: 'dead-process-fixture', claim_expires_at: T0 })
    .where('tenant_id', '=', f.tenant.id).where('id', '=', execution.id).execute();
  return execution;
}

function blockedAttemptLogs() {
  const state = { blocked: true };
  const plugin: KyselyPlugin = {
    transformQuery(args) {
      if (state.blocked && args.node.kind === 'InsertQueryNode' && JSON.stringify(args.node.into).includes('workflows_execution_actions')) {
        throw new Error('Injected process-loss boundary before attempt log');
      }
      return args.node;
    },
    async transformResult(args) { return args.result; },
  };
  return { state, plugin };
}

describe('workflow trigger and local-action recovery receipts', () => {
  it('adds recovery columns without changing a pre-existing workflow or task and re-runs safely', async () => {
    const db = createTestDb<WorkflowsDatabase>();
    try {
      await runMigrations(db, [...coreMigrations, ...workflowsMigrations.slice(0, 3)]);
      await db.insertInto('workflows_workflows').values({ id: 'existing-workflow', tenant_id: 'existing-company', name: 'Owner process',
        trigger_event: 'crm.lead.created', condition_json: null, enabled: 0, max_attempts: 2, created_at: T0, updated_at: T0 }).execute();
      await db.insertInto('workflows_tasks').values({ id: 'existing-task', tenant_id: 'existing-company', title: 'Existing customer work',
        description: 'Preserve this note', assignee_user_id: null, due_at: T0, status: 'completed', related_entity_type: 'crm.job',
        related_entity_id: 'existing-job', completed_at: T0, created_at: T0, updated_at: T0 }).execute();
      const original = await db.selectFrom('workflows_tasks').selectAll().where('tenant_id', '=', 'existing-company').execute();
      const first = await runMigrations(db, [...coreMigrations, ...workflowsMigrations]);
      expect(first.applied).toEqual(['workflows.0004_recovery_receipts']);
      expect(await db.selectFrom('workflows_tasks').selectAll().where('tenant_id', '=', 'existing-company').execute()).toEqual(original);
      expect(await db.selectFrom('workflows_workflows').selectAll().where('tenant_id', '=', 'existing-company').executeTakeFirst())
        .toMatchObject({ id: 'existing-workflow', name: 'Owner process', enabled: 0, max_attempts: 2, recipe_key: null });
      expect((await runMigrations(db, [...coreMigrations, ...workflowsMigrations])).applied).toEqual([]);
    } finally { await db.destroy(); }
  });

  it('runs one business task for concurrent replay of the same platform event', async () => {
    const f = await setup();
    try {
      await Promise.all([f.engine.handleEvent(f.event), f.engine.handleEvent(f.event)]);
      expect(await listExecutions(f.db, f.tenant.id)).toHaveLength(1);
      expect(await f.db.selectFrom('workflows_tasks').selectAll().where('tenant_id', '=', f.tenant.id).execute()).toHaveLength(1);
      expect(await f.db.selectFrom('workflows_notifications').selectAll().where('tenant_id', '=', f.tenant.id).execute()).toHaveLength(1);
      expect(await f.db.selectFrom('workflows_tags').selectAll().where('tenant_id', '=', f.tenant.id).execute()).toHaveLength(1);
    } finally { await f.db.destroy(); }
  });

  it('replays a retained event after engine recreation without repeating local work', async () => {
    const f = await setup();
    try {
      await f.engine.handleEvent(f.event);
      const replacement = createWorkflowEngine(f.deps, { clock: () => f.clock.now });
      await replacement.handleEvent(f.event);
      const [execution] = await listExecutions(f.db, f.tenant.id);
      expect((await getExecution(f.db, f.tenant.id, execution.id)).receipts).toHaveLength(3);
      expect(await listExecutions(f.db, f.tenant.id)).toHaveLength(1);
    } finally { await f.db.destroy(); }
  });

  it('recovers task, notification and tag from their atomic receipts when attempt logs are absent', async () => {
    const f = await setup();
    try {
      await f.engine.handleEvent(f.event); const previous = await interrupted(f);
      f.clock.now = '2026-10-03T12:02:00.000Z';
      const replacement = createWorkflowEngine(f.deps, { clock: () => f.clock.now });
      expect((await replacement.runPending({ tenantId: f.tenant.id })).retried).toEqual([previous.id]);
      for (const table of ['workflows_tasks','workflows_notifications','workflows_tags'] as const) {
        expect(await f.db.selectFrom(table).selectAll().where('tenant_id', '=', f.tenant.id).execute()).toHaveLength(1);
      }
      const result = await getExecution(f.db, f.tenant.id, previous.id);
      expect(result.status).toBe('succeeded'); expect(result.receipts).toHaveLength(3);
      expect(result.actions).toHaveLength(3);
    } finally { await f.db.destroy(); }
  });

  it('recovers an actual interrupted write path and counts the lost attempt before any effect', async () => {
    const f = await setup();
    try {
      const { state, plugin } = blockedAttemptLogs(), injectedDb = f.db.withPlugin(plugin);
      const stopped = createWorkflowEngine({ ...f.deps, db: injectedDb }, { clock: () => f.clock.now });
      await stopped.handleEvent(f.event);
      let [execution] = await listExecutions(f.db, f.tenant.id);
      expect(execution.attempts).toBe(1); expect(execution.status).toBe('retrying');
      expect((await getExecution(f.db, f.tenant.id, execution.id)).actions).toEqual([]);
      expect(await f.db.selectFrom('workflows_tasks').selectAll().where('tenant_id', '=', f.tenant.id).execute()).toHaveLength(1);
      state.blocked = false; f.clock.now = '2026-10-03T12:02:00.000Z';
      await createWorkflowEngine(f.deps, { clock: () => f.clock.now }).runPending({ tenantId: f.tenant.id });
      [execution] = await listExecutions(f.db, f.tenant.id);
      expect(execution.status).toBe('succeeded'); expect(execution.attempts).toBe(2);
      expect(await f.db.selectFrom('workflows_tasks').selectAll().where('tenant_id', '=', f.tenant.id).execute()).toHaveLength(1);
      expect((await getExecution(f.db, f.tenant.id, execution.id)).receipts).toHaveLength(3);
    } finally { await f.db.destroy(); }
  });

  it('rolls back the local business record when its atomic receipt cannot commit', async () => {
    const f = await setup();
    try {
      let blocked = true;
      const plugin: KyselyPlugin = {
        transformQuery(args) {
          if (blocked && args.node.kind === 'InsertQueryNode' && JSON.stringify(args.node.into).includes('workflows_action_receipts')) throw new Error('Receipt storage unavailable fixture');
          return args.node;
        }, async transformResult(args) { return args.result; },
      };
      const engine = createWorkflowEngine({ ...f.deps, db: f.db.withPlugin(plugin) }, { clock: () => f.clock.now, baseBackoffMs: 1000 });
      await engine.handleEvent(f.event);
      for (const table of ['workflows_tasks','workflows_notifications','workflows_tags','workflows_action_receipts'] as const) {
        expect(await f.db.selectFrom(table).selectAll().where('tenant_id', '=', f.tenant.id).execute()).toEqual([]);
      }
      blocked = false; f.clock.now = '2026-10-03T12:00:01.000Z';
      await engine.runPending({ tenantId: f.tenant.id });
      expect((await listExecutions(f.db, f.tenant.id))[0].status).toBe('succeeded');
      expect(await f.db.selectFrom('workflows_tasks').selectAll().where('tenant_id', '=', f.tenant.id).execute()).toHaveLength(1);
    } finally { await f.db.destroy(); }
  });

  it('does not emit a completed claim after ownership changes during an external action', async () => {
    const f = await setup();
    try {
      let calls = 0, success = 0;
      f.events.on('workflows.execution.succeeded', () => { success++; });
      await createWorkflow(f.db, f.events, f.tenant.id, { name: 'Claim fixture', triggerEvent: 'billing.invoice.paid',
        actions: [{ type: 'create_appointment', config: { customerId: 'fixture-customer' } }] });
      const contracts = { createAppointment: { createAppointment: async () => {
        calls++;
        const [execution] = await listExecutions(f.db, f.tenant.id);
        await f.db.updateTable('workflows_executions').set({ claim_token: 'replacement-claim-fixture', claim_expires_at: T0 })
          .where('tenant_id', '=', f.tenant.id).where('id', '=', execution.id).execute();
        return { id: 'appointment-fixture' };
      } } };
      const engine = createWorkflowEngine({ ...f.deps, contracts }, { clock: () => f.clock.now });
      await engine.handleEvent({ ...f.event, type: 'billing.invoice.paid' });
      expect(success).toBe(0); expect(calls).toBe(1);
      await engine.runPending({ tenantId: f.tenant.id });
      expect(calls).toBe(1); expect(success).toBe(1);
    } finally { await f.db.destroy(); }
  });

  it('uses the real Billing source receipt when invoice creation succeeds before its attempt log', async () => {
    const f = await setup();
    try {
      await runMigrations(f.db, billingMigrations);
      await createWorkflow(f.db, f.events, f.tenant.id, { name: 'Invoice fixture', triggerEvent: 'billing.invoice.paid',
        actions: [{ type: 'create_invoice', config: { customerId: 'fixture-customer', lines: [{ description: 'Fixture work', quantity: 1, unitPriceCents: 12550 }] } }] });
      const contract = billingCreateInvoiceContract(f.db as unknown as Kysely<BillingDatabase>, f.events);
      const { state, plugin } = blockedAttemptLogs();
      const deps = { ...f.deps, db: f.db.withPlugin(plugin), contracts: { createInvoice: contract } };
      await createWorkflowEngine(deps, { clock: () => f.clock.now }).handleEvent({ ...f.event, type: 'billing.invoice.paid' });
      let invoices = await (f.db as unknown as Kysely<BillingDatabase>).selectFrom('billing_invoices').selectAll()
        .where('tenant_id', '=', f.tenant.id).execute();
      expect(invoices).toHaveLength(1); expect(invoices[0].total_cents).toBe(12550);
      expect(invoices[0].source_entity_type).toBe('workflows.action');
      const originalId = invoices[0].id;
      state.blocked = false; f.clock.now = '2026-10-03T12:02:00.000Z';
      await createWorkflowEngine(deps, { clock: () => f.clock.now }).runPending({ tenantId: f.tenant.id });
      invoices = await (f.db as unknown as Kysely<BillingDatabase>).selectFrom('billing_invoices').selectAll()
        .where('tenant_id', '=', f.tenant.id).execute();
      expect(invoices.map(invoice => invoice.id)).toEqual([originalId]);
      expect((await listExecutions(f.db, f.tenant.id))[0].status).toBe('succeeded');
    } finally { await f.db.destroy(); }
  });

  it('uses the real Scheduling receipt when booking commits before its attempt log', async () => {
    const f = await setup();
    try {
      await runMigrations(f.db, schedulingMigrations);
      const workflow = await createWorkflow(f.db, f.events, f.tenant.id, { name: 'Booking fixture', triggerEvent: 'billing.invoice.paid',
        actions: [{ type: 'create_appointment', config: { customerId: 'fixture-customer', startsInHours: 24,
          durationMinutes: 90, serviceKey: 'Fixture service', notes: 'Original booking instructions' } }] });
      const bookingDb = f.db as unknown as Kysely<SchedulingDatabase>;
      const contract = createSchedulingContract({ db: bookingDb, events: f.events });
      const { state, plugin } = blockedAttemptLogs();
      const deps = { ...f.deps, db: f.db.withPlugin(plugin), contracts: { createAppointment: contract } };
      await createWorkflowEngine(deps, { clock: () => f.clock.now }).handleEvent({ ...f.event, type: 'billing.invoice.paid' });
      let bookings = await bookingDb.selectFrom('scheduling_appointments').selectAll()
        .where('tenant_id', '=', f.tenant.id).execute();
      expect(bookings).toHaveLength(1);
      expect(bookings[0]).toMatchObject({ starts_at: '2026-10-04T12:00:00.000Z', ends_at: '2026-10-04T13:30:00.000Z',
        title: 'Fixture service', notes: 'Original booking instructions' });
      const originalId = bookings[0].id;
      const [execution] = await listExecutions(f.db, f.tenant.id);
      expect(execution.status).toBe('retrying'); expect(execution.attempts).toBe(1);
      const snapshot = JSON.parse((await f.db.selectFrom('workflows_executions').select('actions_snapshot_json')
        .where('tenant_id', '=', f.tenant.id).where('id', '=', execution.id).executeTakeFirstOrThrow()).actions_snapshot_json!);
      const actionKey = `workflow:${execution.id}:${snapshot.actions[0].id}`;
      await expect(contract.createAppointment({ tenantId: f.tenant.id, idempotencyKey: actionKey, customerId: 'fixture-customer',
        startsAt: '2026-10-04T12:00:00.000Z', endsAt: '2026-10-04T13:30:00.000Z', serviceKey: 'Conflicting instructions',
        notes: 'Original booking instructions' })).rejects.toMatchObject({ status: 409 });
      await updateWorkflow(f.db, f.events, f.tenant.id, workflow.id, { actions: [{ type: 'create_appointment', config: {
        customerId: 'fixture-customer', startsInHours: 48, durationMinutes: 60, serviceKey: 'Owner edits for future bookings',
        notes: 'Changed instructions for future bookings' } }] });
      state.blocked = false; f.clock.now = '2026-10-03T12:02:00.000Z';
      await createWorkflowEngine(deps, { clock: () => f.clock.now }).runPending({ tenantId: f.tenant.id });
      bookings = await bookingDb.selectFrom('scheduling_appointments').selectAll().where('tenant_id', '=', f.tenant.id).execute();
      expect(bookings.map(booking => booking.id)).toEqual([originalId]);
      const recovered = await getExecution(f.db, f.tenant.id, execution.id);
      expect(recovered.status).toBe('succeeded'); expect(recovered.attempts).toBe(2);
      expect(recovered.actions![0].output).toEqual({ appointmentId: originalId });
    } finally { await f.db.destroy(); }
  });

  it('freezes action inputs and due windows across later workflow edits and recovery', async () => {
    const f = await setup();
    try {
      await f.engine.handleEvent(f.event); const previous = await interrupted(f);
      await updateWorkflow(f.db, f.events, f.tenant.id, f.workflow.id, { maxAttempts: 10,
        actions: [{ type: 'create_task', config: { title: 'Edited later', dueInHours: 72 } }] });
      f.clock.now = '2026-10-03T12:02:00.000Z'; await f.engine.runPending({ tenantId: f.tenant.id });
      const tasks = await f.db.selectFrom('workflows_tasks').selectAll().where('tenant_id', '=', f.tenant.id).execute();
      expect(tasks).toHaveLength(1); expect(tasks[0]).toMatchObject({ title: 'Call L1', due_at: '2026-10-04T12:00:00.000Z' });
      expect((await getExecution(f.db, f.tenant.id, previous.id)).actions).toHaveLength(3);
    } finally { await f.db.destroy(); }
  });

  it('lets only one of two engines claim an interrupted execution', async () => {
    const f = await setup();
    try {
      await f.engine.handleEvent(f.event); const previous = await interrupted(f);
      const second = createWorkflowEngine(f.deps, { clock: () => f.clock.now });
      const results = await Promise.all([f.engine.runPending({ tenantId: f.tenant.id }), second.runPending({ tenantId: f.tenant.id })]);
      expect(results.flatMap(result => result.retried)).toEqual([previous.id]);
      expect((await getExecution(f.db, f.tenant.id, previous.id)).actions).toHaveLength(3);
    } finally { await f.db.destroy(); }
  });

  it('waits for a live claim to expire and respects a paused workflow', async () => {
    const f = await setup();
    try {
      await f.engine.handleEvent(f.event); const previous = await interrupted(f);
      await f.db.updateTable('workflows_executions').set({ claim_expires_at: '2026-10-03T12:01:00.000Z' })
        .where('tenant_id', '=', f.tenant.id).where('id', '=', previous.id).execute();
      expect((await f.engine.runPending({ tenantId: f.tenant.id })).retried).toEqual([]);
      await setWorkflowEnabled(f.db, f.events, f.tenant.id, f.workflow.id, false);
      f.clock.now = '2026-10-03T12:02:00.000Z';
      expect((await f.engine.runPending({ tenantId: f.tenant.id })).retried).toEqual([]);
      await setWorkflowEnabled(f.db, f.events, f.tenant.id, f.workflow.id, true);
      expect((await f.engine.runPending({ tenantId: f.tenant.id })).retried).toEqual([previous.id]);
    } finally { await f.db.destroy(); }
  });

  it('stops recovery at the saved attempt bound despite a later increased workflow limit', async () => {
    const f = await setup();
    try {
      await f.engine.handleEvent(f.event); const previous = await interrupted(f);
      await f.db.updateTable('workflows_executions').set({ attempts: 3 }).where('tenant_id', '=', f.tenant.id).where('id', '=', previous.id).execute();
      await updateWorkflow(f.db, f.events, f.tenant.id, f.workflow.id, { maxAttempts: 10 });
      await f.engine.runPending({ tenantId: f.tenant.id });
      const result = await getExecution(f.db, f.tenant.id, previous.id);
      expect(result.status).toBe('failed'); expect(result.actions).toEqual([]);
      expect((await f.engine.runPending({ tenantId: f.tenant.id })).retried).toEqual([]);
    } finally { await f.db.destroy(); }
  });

  it('isolates the same originating event ID and receipts between two companies', async () => {
    const f = await setup();
    try {
      const b = await createTenant(asCoreDb(f.db), { name: 'Other fixture company' });
      await createWorkflow(f.db, f.events, b.id, { name: 'Other company', triggerEvent: 'crm.lead.created',
        actions: [{ type: 'create_task', config: { title: 'Other company task' } }] });
      await Promise.all([f.engine.handleEvent(f.event), f.engine.handleEvent({ ...f.event, tenantId: b.id })]);
      const [aExecution] = await listExecutions(f.db, f.tenant.id);
      expect(await listExecutions(f.db, b.id)).toHaveLength(1);
      await expect(getExecution(f.db, b.id, aExecution.id)).rejects.toMatchObject({ status: 404 });
      expect(await f.db.selectFrom('workflows_action_receipts').selectAll().where('tenant_id', '=', b.id).execute()).toHaveLength(1);
    } finally { await f.db.destroy(); }
  });

  it('preserves the prior event payload on ID reuse and treats a fresh event ID as a distinct occurrence', async () => {
    const f = await setup();
    try {
      await f.engine.handleEvent(f.event);
      await f.engine.handleEvent({ ...f.event, payload: { leadId: 'WRONG' } });
      expect((await listExecutions(f.db, f.tenant.id))[0].triggerPayload).toEqual({ leadId: 'L1' });
      await f.engine.handleEvent({ ...f.event, id: 'another-occurrence-fixture' });
      expect(await listExecutions(f.db, f.tenant.id)).toHaveLength(2);
      expect(await f.db.selectFrom('workflows_tasks').selectAll().where('tenant_id', '=', f.tenant.id).execute()).toHaveLength(2);
    } finally { await f.db.destroy(); }
  });
});

describe('bounded built-in workflow recipes', () => {
  it('installs each useful local recipe and runs its matching business job with receipts', async () => {
    const f = await setup();
    try {
      const presets = listWorkflowRecipes(); expect(presets).toHaveLength(3);
      for (const preset of presets) {
        expect(preset.externalEffects).toBe(false);
        const installed = await installWorkflowRecipe(f.db, f.events, f.tenant.id, preset.key, { assigneeUserId: f.owner.id });
        const event = { id: `preset:${preset.key}`, tenantId: f.tenant.id, type: installed.triggerEvent,
          occurredAt: T0, payload: { leadId: 'L2', quoteId: 'Q1', jobId: 'J1' } };
        await f.engine.handleEvent(event);
        const execution = (await listExecutions(f.db, f.tenant.id)).find(item => item.workflowId === installed.id)!;
        const detail = await getExecution(f.db, f.tenant.id, execution.id);
        expect(detail.status).toBe('succeeded'); expect(detail.receipts).toHaveLength(3);
      }
    } finally { await f.db.destroy(); }
  });

  it('repeated and concurrent recipe installation preserves the owner-edited workflow', async () => {
    const f = await setup();
    try {
      const [first, second] = await Promise.all([installWorkflowRecipe(f.db, f.events, f.tenant.id, 'lead-first-touch', { assigneeUserId: f.owner.id }),
        installWorkflowRecipe(f.db, f.events, f.tenant.id, 'lead-first-touch', { assigneeUserId: f.owner.id })]);
      expect(first.id).toBe(second.id);
      await updateWorkflow(f.db, f.events, f.tenant.id, first.id, { name: 'My response process', enabled: false });
      const repeat = await installWorkflowRecipe(f.db, f.events, f.tenant.id, 'lead-first-touch', { assigneeUserId: f.owner.id, dueInHours: 1 });
      expect(repeat.name).toBe('My response process'); expect(repeat.enabled).toBe(false);
      expect(repeat.actions[0].config.dueInHours).toBe(24);
    } finally { await f.db.destroy(); }
  });

  it('rejects a foreign assignee, unknown recipe and invalid due windows through real routes', async () => {
    const f = await setup();
    try {
      const b = await createTenant(asCoreDb(f.db), { name: 'Other recipe fixture' });
      const other = await createUser(asCoreDb(f.db), b.id, { name: 'Other owner', email: 'other@example.test', role: 'owner' });
      const app = workflowsRouter(f.deps), headers = { 'x-tenant-id': f.tenant.id, 'content-type': 'application/json' };
      const install = (key: string, body: unknown) => app.request(`/recipes/${key}/install`, { method: 'POST', headers, body: JSON.stringify(body) });
      expect((await app.request('/recipes', { headers })).status).toBe(200);
      expect((await install('lead-first-touch', { assigneeUserId: other.id })).status).toBe(400);
      expect((await install('missing', { assigneeUserId: f.owner.id })).status).toBe(404);
      for (const dueInHours of [0, 169, 1.5, true, '24']) expect((await install('lead-first-touch', { assigneeUserId: f.owner.id, dueInHours })).status).toBe(400);
      expect((await install('lead-first-touch', { assigneeUserId: f.owner.id, dueInHours: 4 })).status).toBe(201);
    } finally { await f.db.destroy(); }
  });
});
