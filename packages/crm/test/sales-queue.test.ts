import { describe, expect, it } from 'vitest';
import { asCoreDb, coreMigrations, createTenant, createUser } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import { crmMigrations, type CrmDatabase } from '@blacklabel/crm';
import { body, create, setup } from './helpers';

const PAST = '2025-01-02T09:00:00.000Z';
const FUTURE = '2099-01-02T09:00:00.000Z';
const owner = (ctx: Awaited<ReturnType<typeof setup>>, tenantId = ctx.A) =>
  createUser(asCoreDb(ctx.db), tenantId, { name: 'Synthetic owner', email: 'owner@example.test', role: 'owner' });

describe('owned next-action sales queue', () => {
  it('upgrades existing leads/stages without deleting records and reruns safely', async () => {
    const db = createTestDb<CrmDatabase>();
    await runMigrations(db, [...coreMigrations, ...crmMigrations.slice(0, 3)]);
    const tenant = await createTenant(asCoreDb(db), { name: 'Existing company' });
    const at = '2026-01-01T00:00:00.000Z';
    await db.insertInto('crm_leads').values({ id: 'old-lead', tenant_id: tenant.id, name: 'Existing lead', stage: 'won', created_at: at, updated_at: at } as never).execute();
    await db.insertInto('crm_lead_stages').values({ id: 'old-stage', tenant_id: tenant.id, key: 'won', label: 'Won', sort_order: 0, created_at: at } as never).execute();
    const result = await runMigrations(db, [...coreMigrations, ...crmMigrations]);
    expect(result.applied).toEqual(['crm.0004_owned_next_action_queue']);
    const lead = await db.selectFrom('crm_leads').selectAll().where('tenant_id', '=', tenant.id).where('id', '=', 'old-lead').executeTakeFirstOrThrow();
    expect(lead).toMatchObject({ name: 'Existing lead', stage: 'won', next_action: null, next_action_due_at: null, next_action_revision: 0 });
    const stage = await db.selectFrom('crm_lead_stages').selectAll().where('tenant_id', '=', tenant.id).executeTakeFirstOrThrow();
    expect(stage.is_closed).toBe(1);
    expect((await runMigrations(db, [...coreMigrations, ...crmMigrations])).applied).toEqual([]);
    await db.destroy();
  });

  it('persists ownership/action/date, normalizes timezone, exposes source drillthrough and exports them', async () => {
    const ctx = await setup(), user = await owner(ctx);
    const lead = await create(ctx, ctx.A, '/leads', {
      name: 'Service inquiry', source: 'referral', owner_user_id: user.id,
      next_action: ' Confirm scope ', next_action_due_at: '2099-01-02T11:00:00+02:00', value_cents: 82000,
    });
    expect(lead).toMatchObject({ next_action: 'Confirm scope', next_action_due_at: FUTURE, next_action_revision: 1 });
    const queue = (await body(await ctx.req(ctx.A, '/sales-queue'))).data;
    expect(queue.items[0]).toMatchObject({ id: lead.id, owner_name: user.name, exceptions: [], source_record: { entity_type: 'crm.lead', entity_id: lead.id, api_path: `/api/crm/leads/${lead.id}` } });
    expect(queue.summary).toEqual({ active: 1, overdue: 0, unowned: 0, no_next_action: 0, no_due_date: 0, pipeline_value_cents: 82000 });
    expect((await body(await ctx.req(ctx.A, `/leads/${lead.id}`))).data.next_action).toBe('Confirm scope');
    const csv = await (await ctx.req(ctx.A, '/leads/export.csv')).text();
    expect(csv).toContain('next_action,next_action_due_at');
    expect(csv).toContain('Confirm scope');
    expect((await body(await ctx.req(ctx.A, '/owners'))).data.map((row: any) => row.id)).toEqual([user.id]);
  });

  it('filters exception buckets with a stable priority and a full matching pipeline report', async () => {
    const ctx = await setup(), user = await owner(ctx);
    const due = await create(ctx, ctx.A, '/leads', { name: 'Overdue', owner_user_id: user.id, next_action: 'Call', next_action_due_at: PAST, value_cents: 100 });
    const unowned = await create(ctx, ctx.A, '/leads', { name: 'Unowned', next_action: 'Visit', next_action_due_at: FUTURE, value_cents: 200 });
    const missing = await create(ctx, ctx.A, '/leads', { name: 'No action', owner_user_id: user.id, value_cents: 300 });
    const undated = await create(ctx, ctx.A, '/leads', { name: 'No due date', owner_user_id: user.id, next_action: 'Review', value_cents: 400 });
    await create(ctx, ctx.A, '/leads', { name: 'Closed won', stage: 'won', value_cents: 90000 });
    await create(ctx, ctx.A, '/leads', { name: 'Closed lost', stage: 'lost' });
    const queue = (await body(await ctx.req(ctx.A, '/sales-queue?limit=2'))).data;
    expect(queue.items.map((row: any) => row.id)).toEqual([due.id, unowned.id]);
    expect(queue.summary).toEqual({ active: 4, overdue: 1, unowned: 1, no_next_action: 1, no_due_date: 1, pipeline_value_cents: 1000 });
    for (const [bucket, expected] of [['overdue', due.id], ['unowned', unowned.id], ['no_next_action', missing.id], ['no_due_date', undated.id]]) {
      const filtered = (await body(await ctx.req(ctx.A, `/sales-queue?bucket=${bucket}`))).data;
      expect(filtered.items.map((row: any) => row.id)).toEqual([expected]);
      expect(filtered.summary.active).toBe(4);
    }
    const mine = (await body(await ctx.req(ctx.A, `/sales-queue?owner_user_id=${user.id}`))).data;
    expect(mine.summary.active).toBe(3);
    const search = (await body(await ctx.req(ctx.A, '/sales-queue?q=REVIEW'))).data;
    expect(search.items.map((row: any) => row.id)).toEqual([undated.id]);
    expect(search.summary.active).toBe(1);
    expect((await ctx.req(ctx.A, '/sales-queue?bucket=imaginary')).status).toBe(400);
  });

  it('has no 200-row report cutoff and returns an empty report accurately', async () => {
    const ctx = await setup();
    const at = '2026-01-01T00:00:00.000Z';
    for (let n = 0; n < 205; n++) await ctx.db.insertInto('crm_leads').values({
      id: `synthetic-${String(n).padStart(3, '0')}`, tenant_id: ctx.A, name: `Lead ${n}`, stage: 'new',
      next_action: null, next_action_due_at: null, next_action_revision: 0, value_cents: 10, created_at: at, updated_at: at,
    } as never).execute();
    const queue = (await body(await ctx.req(ctx.A, '/sales-queue?limit=10&offset=200'))).data;
    expect(queue.items).toHaveLength(5);
    expect(queue.summary).toMatchObject({ active: 205, unowned: 205, no_next_action: 205, pipeline_value_cents: 2050 });
    const empty = (await body(await ctx.req(ctx.B, '/sales-queue'))).data;
    expect(empty.items).toEqual([]);
    expect(empty.summary).toEqual({ active: 0, overdue: 0, unowned: 0, no_next_action: 0, no_due_date: 0, pipeline_value_cents: 0 });
  });

  it('denies foreign owners, queue data, source updates and completion without touching tenant A', async () => {
    const ctx = await setup(), aUser = await owner(ctx), bUser = await owner(ctx, ctx.B);
    const lead = await create(ctx, ctx.A, '/leads', { name: 'Private lead', owner_user_id: aUser.id, next_action: 'Call', next_action_due_at: PAST });
    expect((await ctx.json(ctx.A, 'POST', '/leads', { name: 'Invalid owner', owner_user_id: bUser.id })).status).toBe(404);
    expect((await ctx.json(ctx.A, 'PATCH', `/leads/${lead.id}`, { owner_user_id: bUser.id })).status).toBe(404);
    const foreignCustomer = await create(ctx, ctx.B, '/customers', { name: 'Foreign customer' });
    expect((await ctx.json(ctx.A, 'PATCH', `/leads/${lead.id}`, { customer_id: foreignCustomer.id })).status).toBe(404);
    expect((await ctx.json(ctx.B, 'PATCH', `/leads/${lead.id}`, { next_action: 'Steal action' })).status).toBe(404);
    expect((await ctx.json(ctx.B, 'POST', `/leads/${lead.id}/next-action/complete`, { idempotency_key: 'foreign-completion', revision: lead.next_action_revision })).status).toBe(404);
    expect((await body(await ctx.req(ctx.B, '/sales-queue'))).data.items).toEqual([]);
    expect((await body(await ctx.req(ctx.B, '/owners'))).data.map((row: any) => row.id)).toEqual([bUser.id]);
    expect((await body(await ctx.req(ctx.A, `/leads/${lead.id}`))).data).toMatchObject({ owner_user_id: aUser.id, next_action: 'Call', next_action_revision: 1 });
  });

  it('rejects invalid action/dates and invalid stage atomically before any field mutation', async () => {
    const ctx = await setup();
    for (const invalid of [
      { next_action: ' ' }, { next_action: 'Call', next_action_due_at: 'tomorrow' },
      { next_action: 'Call', next_action_due_at: '2026-01-01T09:00:00' },
      { next_action_due_at: FUTURE },
    ]) expect((await ctx.json(ctx.A, 'POST', '/leads', { name: 'Invalid', ...invalid })).status).toBe(400);
    const lead = await create(ctx, ctx.A, '/leads', { name: 'Original', next_action: 'Call', next_action_due_at: FUTURE });
    expect((await ctx.json(ctx.A, 'PATCH', `/leads/${lead.id}`, { name: 'Changed', stage: 'invalid', next_action: 'Different' })).status).toBe(400);
    expect((await body(await ctx.req(ctx.A, `/leads/${lead.id}`))).data).toMatchObject({ name: 'Original', next_action: 'Call', next_action_revision: 1 });
    const cleared = await body(await ctx.json(ctx.A, 'PATCH', `/leads/${lead.id}`, { next_action: null }));
    expect(cleared.data).toMatchObject({ next_action: null, next_action_due_at: null, next_action_revision: 2 });
    const imported = await body(await ctx.req(ctx.A, '/leads/import.csv', { method: 'POST', headers: { 'content-type': 'text/csv' }, body: 'name,next_action,next_action_due_at\nBad CSV,Call,tomorrow\nGood CSV,Follow up,2099-01-02T09:00:00.000Z' }));
    expect(imported.data.imported).toBe(1);
    expect(imported.data.errors).toHaveLength(1);
  });

  it('completes exactly once, records outcome, mirrors customer activity and preserves a replacement on replay', async () => {
    const ctx = await setup(), user = await owner(ctx);
    const customer = await create(ctx, ctx.A, '/customers', { name: 'Synthetic customer' });
    const lead = await create(ctx, ctx.A, '/leads', { name: 'Repeat service', customer_id: customer.id, owner_user_id: user.id, next_action: 'Confirm availability', next_action_due_at: FUTURE });
    const seen: any[] = [];
    ctx.events.on('crm.lead.next_action_completed', (event) => { seen.push(event); });
    const payload = { idempotency_key: 'complete-action-001', revision: 1, note: 'Customer requested a quote' };
    const first = (await body(await ctx.json(ctx.A, 'POST', `/leads/${lead.id}/next-action/complete`, payload))).data;
    expect(first.replayed).toBe(false);
    expect(first.receipt).toMatchObject({ lead_id: lead.id, action: 'Confirm availability', owner_user_id: user.id, note: payload.note });
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toEqual({ leadId: lead.id, receiptId: first.receipt.id });
    expect((await body(await ctx.req(ctx.A, `/leads/${lead.id}`))).data).toMatchObject({ next_action: null, next_action_due_at: null, next_action_revision: 2 });
    await ctx.json(ctx.A, 'PATCH', `/leads/${lead.id}`, { next_action: 'Prepare quote', next_action_due_at: FUTURE });
    const replay = (await body(await ctx.json(ctx.A, 'POST', `/leads/${lead.id}/next-action/complete`, payload))).data;
    expect(replay).toMatchObject({ replayed: true, receipt: { id: first.receipt.id } });
    expect(seen).toHaveLength(1);
    expect((await body(await ctx.req(ctx.A, `/leads/${lead.id}`))).data).toMatchObject({ next_action: 'Prepare quote', next_action_revision: 3 });
    const history = (await body(await ctx.req(ctx.A, `/customers/${customer.id}/timeline`))).data;
    const completed = history.filter((row: any) => row.event_type === 'lead.next_action_completed');
    expect(completed).toHaveLength(1);
    expect(JSON.parse(completed[0].data)).toMatchObject({ action: 'Confirm availability', note: payload.note });
    const receipts = await ctx.db.selectFrom('crm_next_action_completions').selectAll().where('tenant_id', '=', ctx.A).execute();
    const audits = await ctx.db.selectFrom('audit_log').selectAll().where('tenant_id', '=', ctx.A).where('action', '=', 'crm.lead.next_action_completed').execute();
    expect(receipts).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect((await ctx.json(ctx.A, 'POST', `/leads/${lead.id}/next-action/complete`, { ...payload, note: 'Different outcome' })).status).toBe(409);
    expect((await ctx.json(ctx.A, 'POST', `/leads/${lead.id}/next-action/complete`, { ...payload, idempotency_key: 'stale-completion-key' })).status).toBe(409);
    expect((await ctx.json(ctx.A, 'PATCH', `/leads/${lead.id}`, { next_action: 'Stale replacement', expected_next_action_revision: 1 })).status).toBe(409);
    expect((await body(await ctx.req(ctx.A, `/leads/${lead.id}`))).data.next_action).toBe('Prepare quote');
  });

  it('uses explicit configurable closed-stage semantics and refuses removal of a stage still in use', async () => {
    const ctx = await setup();
    expect((await ctx.json(ctx.A, 'PUT', '/lead-stages', { stages: [{ key: 'inquiry' }, { key: 'complete', label: 'Complete', is_closed: true }] })).status).toBe(200);
    await create(ctx, ctx.A, '/leads', { name: 'Completed inquiry', stage: 'complete', value_cents: 500 });
    const queue = (await body(await ctx.req(ctx.A, '/sales-queue'))).data;
    expect(queue.summary.active).toBe(0);
    const preserved = await ctx.json(ctx.A, 'PUT', '/lead-stages', { stages: [{ key: 'inquiry' }, { key: 'complete', label: 'Complete renamed' }] });
    expect((await body(preserved)).data.find((row: any) => row.key === 'complete').is_closed).toBe(true);
    expect((await ctx.json(ctx.A, 'PUT', '/lead-stages', { stages: [{ key: 'inquiry' }] })).status).toBe(409);
    expect((await body(await ctx.req(ctx.A, '/lead-stages'))).data.map((row: any) => row.key)).toEqual(['inquiry', 'complete']);
  });
});
