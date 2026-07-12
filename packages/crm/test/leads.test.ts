import { describe, expect, it } from 'vitest';
import { body, create, setup } from './helpers';

describe('leads + configurable stages', () => {
  it('creates a lead in the default first stage and emits crm.lead.created', async () => {
    const ctx = await setup();
    const seen: any[] = [];
    ctx.events.on('crm.lead.created', (e) => {
      seen.push(e);
    });
    const lead = await create(ctx, ctx.A, '/leads', {
      name: 'Morgan Ellis',
      source: 'website',
      value_cents: 45000,
    });
    expect(lead.stage).toBe('new');
    expect(lead.value_cents).toBe(45000);
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toEqual({ leadId: lead.id });
    expect(seen[0].tenantId).toBe(ctx.A);
  });

  it('serves the default stage list when none is configured', async () => {
    const ctx = await setup();
    const stages = (await body(await ctx.req(ctx.A, '/lead-stages'))).data;
    expect(stages.map((s: any) => s.key)).toEqual([
      'new',
      'contacted',
      'qualified',
      'quoted',
      'won',
      'lost',
    ]);
  });

  it('changes stage via POST /leads/:id/stage, emits event, audits, and timelines', async () => {
    const ctx = await setup();
    const events: any[] = [];
    ctx.events.on('crm.lead.stage_changed', (e) => {
      events.push(e);
    });
    const lead = await create(ctx, ctx.A, '/leads', { name: 'Priya Nair' });

    const res = await ctx.json(ctx.A, 'POST', `/leads/${lead.id}/stage`, { stage: 'contacted' });
    expect(res.status).toBe(200);
    expect((await body(res)).data.stage).toBe('contacted');

    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ leadId: lead.id, from: 'new', to: 'contacted' });

    const timeline = (await body(await ctx.req(ctx.A, `/leads/${lead.id}/timeline`))).data;
    const stageEvents = timeline.filter((t: any) => t.event_type === 'stage_changed');
    expect(stageEvents).toHaveLength(1);
    expect(JSON.parse(stageEvents[0].data)).toEqual({ from: 'new', to: 'contacted' });

    const audits = await ctx.db
      .selectFrom('audit_log')
      .selectAll()
      .where('tenant_id', '=', ctx.A)
      .where('action', '=', 'crm.lead.stage_changed')
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0].entity_id).toBe(lead.id);
  });

  it('rejects an invalid stage with 400 and the allowed list', async () => {
    const ctx = await setup();
    const lead = await create(ctx, ctx.A, '/leads', { name: 'Casey Donovan' });
    const res = await ctx.json(ctx.A, 'POST', `/leads/${lead.id}/stage`, { stage: 'imaginary' });
    expect(res.status).toBe(400);
    const err = (await body(res)).error;
    expect(err.details.allowed).toContain('new');

    const createBad = await ctx.json(ctx.A, 'POST', '/leads', { name: 'X', stage: 'nope' });
    expect(createBad.status).toBe(400);
  });

  it('supports per-tenant configurable stages without affecting other tenants', async () => {
    const ctx = await setup();
    const put = await ctx.json(ctx.A, 'PUT', '/lead-stages', {
      stages: [
        { key: 'inquiry', label: 'Inquiry' },
        { key: 'estimate', label: 'Estimate sent' },
        { key: 'closed', label: 'Closed' },
      ],
    });
    expect(put.status).toBe(200);

    // Tenant A: new custom pipeline.
    const aStages = (await body(await ctx.req(ctx.A, '/lead-stages'))).data;
    expect(aStages.map((s: any) => s.key)).toEqual(['inquiry', 'estimate', 'closed']);

    const lead = await create(ctx, ctx.A, '/leads', { name: 'Custom Pipeline Lead' });
    expect(lead.stage).toBe('inquiry');
    const moved = await ctx.json(ctx.A, 'POST', `/leads/${lead.id}/stage`, { stage: 'estimate' });
    expect((await body(moved)).data.stage).toBe('estimate');
    // Old default stage no longer valid for tenant A.
    const bad = await ctx.json(ctx.A, 'POST', `/leads/${lead.id}/stage`, { stage: 'contacted' });
    expect(bad.status).toBe(400);

    // Tenant B still has the defaults.
    const bStages = (await body(await ctx.req(ctx.B, '/lead-stages'))).data;
    expect(bStages.map((s: any) => s.key)).toEqual([
      'new',
      'contacted',
      'qualified',
      'quoted',
      'won',
      'lost',
    ]);
    const bLead = await create(ctx, ctx.B, '/leads', { name: 'B lead' });
    expect(bLead.stage).toBe('new');
  });

  it('PATCH with a stage change routes through stage-transition logic', async () => {
    const ctx = await setup();
    const events: any[] = [];
    ctx.events.on('crm.lead.stage_changed', (e) => {
      events.push(e);
    });
    const lead = await create(ctx, ctx.A, '/leads', { name: 'Patch Stager' });
    const res = await ctx.json(ctx.A, 'PATCH', `/leads/${lead.id}`, {
      stage: 'qualified',
      value_cents: 99000,
    });
    expect(res.status).toBe(200);
    const updated = (await body(res)).data;
    expect(updated.stage).toBe('qualified');
    expect(updated.value_cents).toBe(99000);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ leadId: lead.id, from: 'new', to: 'qualified' });
  });

  it('mirrors lead activity onto the linked customer timeline', async () => {
    const ctx = await setup();
    const customer = await create(ctx, ctx.A, '/customers', { name: 'Linked Customer' });
    const lead = await create(ctx, ctx.A, '/leads', {
      name: 'Linked Lead',
      customer_id: customer.id,
    });
    await ctx.json(ctx.A, 'POST', `/leads/${lead.id}/stage`, { stage: 'won' });

    const timeline = (await body(await ctx.req(ctx.A, `/customers/${customer.id}/timeline`))).data;
    const types = timeline.map((t: any) => t.event_type);
    expect(types).toContain('lead.created');
    expect(types).toContain('lead.stage_changed');
    const mirrored = timeline.find((t: any) => t.event_type === 'lead.stage_changed');
    expect(JSON.parse(mirrored.data)).toEqual({ from: 'new', to: 'won', leadId: lead.id });
  });

  it('enforces tenant isolation on leads and stage transitions', async () => {
    const ctx = await setup();
    const lead = await create(ctx, ctx.A, '/leads', { name: 'A-only lead' });
    expect((await ctx.req(ctx.B, `/leads/${lead.id}`)).status).toBe(404);
    expect(
      (await ctx.json(ctx.B, 'POST', `/leads/${lead.id}/stage`, { stage: 'contacted' })).status,
    ).toBe(404);
    expect((await ctx.req(ctx.B, `/leads/${lead.id}`, { method: 'DELETE' })).status).toBe(404);
    // untouched
    const still = (await body(await ctx.req(ctx.A, `/leads/${lead.id}`))).data;
    expect(still.stage).toBe('new');
  });

  it('filters leads by stage and searches by name', async () => {
    const ctx = await setup();
    const l1 = await create(ctx, ctx.A, '/leads', { name: 'Filter Alpha' });
    await create(ctx, ctx.A, '/leads', { name: 'Filter Beta' });
    await ctx.json(ctx.A, 'POST', `/leads/${l1.id}/stage`, { stage: 'qualified' });

    const qualified = (await body(await ctx.req(ctx.A, '/leads?stage=qualified'))).data;
    expect(qualified).toHaveLength(1);
    expect(qualified[0].name).toBe('Filter Alpha');

    const search = (await body(await ctx.req(ctx.A, '/leads?q=Beta'))).data;
    expect(search).toHaveLength(1);
    expect(search[0].name).toBe('Filter Beta');
  });
});
