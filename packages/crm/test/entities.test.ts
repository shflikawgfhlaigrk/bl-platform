import { describe, expect, it } from 'vitest';
import { body, create, setup, type TestContext } from './helpers';

describe('companies, contacts, deals, jobs', () => {
  it('company CRUD works', async () => {
    const ctx = await setup();
    const company = await create(ctx, ctx.A, '/companies', {
      name: 'Northside Property Group',
      domain: 'northside.example',
    });
    const updated = (
      await body(await ctx.json(ctx.A, 'PATCH', `/companies/${company.id}`, { phone: '+1-555-1' }))
    ).data;
    expect(updated.phone).toBe('+1-555-1');
    const list = (await body(await ctx.req(ctx.A, '/companies?q=Northside'))).data;
    expect(list).toHaveLength(1);
    expect((await ctx.req(ctx.A, `/companies/${company.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await ctx.req(ctx.A, `/companies/${company.id}`)).status).toBe(404);
  });

  it('contact CRUD works and mirrors onto the linked customer timeline', async () => {
    const ctx = await setup();
    const customer = await create(ctx, ctx.A, '/customers', { name: 'Contact Holder' });
    const contact = await create(ctx, ctx.A, '/contacts', {
      first_name: 'Sam',
      last_name: 'Reyes',
      customer_id: customer.id,
    });
    expect(contact.first_name).toBe('Sam');
    const timeline = (await body(await ctx.req(ctx.A, `/customers/${customer.id}/timeline`))).data;
    expect(timeline.map((t: any) => t.event_type)).toContain('contact.created');
  });

  it('deal create/status change emits crm.deal.created and crm.deal.stage_changed', async () => {
    const ctx = await setup();
    const createdEvents: any[] = [];
    const stageEvents: any[] = [];
    ctx.events.on('crm.deal.created', (e) => {
      createdEvents.push(e);
    });
    ctx.events.on('crm.deal.stage_changed', (e) => {
      stageEvents.push(e);
    });

    const deal = await create(ctx, ctx.A, '/deals', {
      title: 'Annual contract',
      value_cents: 480000,
    });
    expect(deal.status).toBe('open');
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0].payload).toEqual({ dealId: deal.id });

    const won = (await body(await ctx.json(ctx.A, 'PATCH', `/deals/${deal.id}`, { status: 'won' }))).data;
    expect(won.status).toBe('won');
    expect(stageEvents).toHaveLength(1);
    expect(stageEvents[0].payload).toEqual({
      dealId: deal.id,
      from: 'open',
      to: 'won',
      valueCents: 480000,
    });

    // No event when status does not change.
    await ctx.json(ctx.A, 'PATCH', `/deals/${deal.id}`, { value_cents: 500000 });
    expect(stageEvents).toHaveLength(1);
  });

  it('job create emits crm.job.created and job CRUD works', async () => {
    const ctx = await setup();
    const seen: any[] = [];
    ctx.events.on('crm.job.created', (e) => {
      seen.push(e);
    });
    const job = await create(ctx, ctx.A, '/jobs', { title: 'Initial site visit' });
    expect(job.status).toBe('planned');
    expect(seen[0].payload).toEqual({ jobId: job.id });
    const done = (
      await body(await ctx.json(ctx.A, 'PATCH', `/jobs/${job.id}`, { status: 'completed' }))
    ).data;
    expect(done.status).toBe('completed');
  });
});

describe('notes, tasks, tags, attachments, source attributions', () => {
  it('notes attach to an entity, appear in its timeline, and are validated', async () => {
    const ctx = await setup();
    const customer = await create(ctx, ctx.A, '/customers', { name: 'Note Customer' });
    const note = await create(ctx, ctx.A, '/notes', {
      entity_type: 'crm.customer',
      entity_id: customer.id,
      body: 'Prefers morning appointments.',
    });
    expect(note.body).toBe('Prefers morning appointments.');

    // note on a missing entity -> 404
    const missing = await ctx.json(ctx.A, 'POST', '/notes', {
      entity_type: 'crm.customer',
      entity_id: 'nope',
      body: 'x',
    });
    expect(missing.status).toBe(404);

    const listed = (await body(
      await ctx.req(ctx.A, `/notes?entity_type=crm.customer&entity_id=${customer.id}`),
    )).data;
    expect(listed).toHaveLength(1);

    const patched = (
      await body(await ctx.json(ctx.A, 'PATCH', `/notes/${note.id}`, { body: 'Updated note.' }))
    ).data;
    expect(patched.body).toBe('Updated note.');

    const timeline = (await body(await ctx.req(ctx.A, `/customers/${customer.id}/timeline`))).data;
    expect(timeline.map((t: any) => t.event_type)).toContain('note_added');

    expect((await ctx.req(ctx.A, `/notes/${note.id}`, { method: 'DELETE' })).status).toBe(200);
  });

  it('tasks complete idempotently and emit crm.task.completed once', async () => {
    const ctx = await setup();
    const seen: any[] = [];
    ctx.events.on('crm.task.completed', (e) => {
      seen.push(e);
    });
    const lead = await create(ctx, ctx.A, '/leads', { name: 'Task Lead' });
    const task = await create(ctx, ctx.A, '/tasks', {
      title: 'Call the lead back',
      entity_type: 'crm.lead',
      entity_id: lead.id,
    });
    expect(task.status).toBe('open');

    const done = (await body(await ctx.json(ctx.A, 'POST', `/tasks/${task.id}/complete`))).data;
    expect(done.status).toBe('completed');
    expect(done.completed_at).toBeTruthy();
    // idempotent second complete
    const again = (await body(await ctx.json(ctx.A, 'POST', `/tasks/${task.id}/complete`))).data;
    expect(again.completed_at).toBe(done.completed_at);
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toEqual({ taskId: task.id });

    const timeline = (await body(await ctx.req(ctx.A, `/leads/${lead.id}/timeline`))).data;
    expect(timeline.map((t: any) => t.event_type)).toContain('task_completed');

    // filter by status
    const open = (await body(await ctx.req(ctx.A, '/tasks?status=open'))).data;
    expect(open).toEqual([]);
  });

  it('tags attach/detach with idempotent attach and duplicate-name conflict', async () => {
    const ctx = await setup();
    const customer = await create(ctx, ctx.A, '/customers', { name: 'Tagged Customer' });
    const tag = await create(ctx, ctx.A, '/tags', { name: 'vip', color: '#d4af37' });

    expect((await ctx.json(ctx.A, 'POST', '/tags', { name: 'vip' })).status).toBe(409);

    const attach = await ctx.json(ctx.A, 'POST', `/tags/${tag.id}/attach`, {
      entity_type: 'crm.customer',
      entity_id: customer.id,
    });
    expect(attach.status).toBe(201);
    // idempotent
    const attach2 = await ctx.json(ctx.A, 'POST', `/tags/${tag.id}/attach`, {
      entity_type: 'crm.customer',
      entity_id: customer.id,
    });
    expect(attach2.status).toBe(201);

    const taggings = (await body(
      await ctx.req(ctx.A, `/taggings?entity_type=crm.customer&entity_id=${customer.id}`),
    )).data;
    expect(taggings).toHaveLength(1);
    expect(taggings[0].name).toBe('vip');

    const detach = await ctx.json(ctx.A, 'POST', `/tags/${tag.id}/detach`, {
      entity_type: 'crm.customer',
      entity_id: customer.id,
    });
    expect(detach.status).toBe(200);
    const after = (await body(
      await ctx.req(ctx.A, `/taggings?entity_type=crm.customer&entity_id=${customer.id}`),
    )).data;
    expect(after).toEqual([]);

    // deleting a tag removes its taggings
    await ctx.json(ctx.A, 'POST', `/tags/${tag.id}/attach`, {
      entity_type: 'crm.customer',
      entity_id: customer.id,
    });
    await ctx.req(ctx.A, `/tags/${tag.id}`, { method: 'DELETE' });
    const rows = await ctx.db
      .selectFrom('crm_taggables')
      .selectAll()
      .where('tenant_id', '=', ctx.A)
      .execute();
    expect(rows).toEqual([]);
  });

  it('attachment references and source attributions CRUD', async () => {
    const ctx = await setup();
    const deal = await create(ctx, ctx.A, '/deals', { title: 'Attachment Deal' });
    const att = await create(ctx, ctx.A, '/attachments', {
      entity_type: 'crm.deal',
      entity_id: deal.id,
      file_id: 'file_123',
      filename: 'estimate.pdf',
      mime_type: 'application/pdf',
      size_bytes: 1024,
    });
    const renamed = (
      await body(
        await ctx.json(ctx.A, 'PATCH', `/attachments/${att.id}`, { filename: 'estimate-v2.pdf' }),
      )
    ).data;
    expect(renamed.filename).toBe('estimate-v2.pdf');
    const listed = (await body(
      await ctx.req(ctx.A, `/attachments?entity_type=crm.deal&entity_id=${deal.id}`),
    )).data;
    expect(listed).toHaveLength(1);
    expect((await ctx.req(ctx.A, `/attachments/${att.id}`, { method: 'DELETE' })).status).toBe(200);

    const lead = await create(ctx, ctx.A, '/leads', { name: 'Attributed Lead' });
    const attr = await create(ctx, ctx.A, '/source-attributions', {
      entity_type: 'crm.lead',
      entity_id: lead.id,
      source: 'website',
      medium: 'organic',
    });
    const updatedAttr = (
      await body(
        await ctx.json(ctx.A, 'PATCH', `/source-attributions/${attr.id}`, { campaign: 'spring' }),
      )
    ).data;
    expect(updatedAttr.campaign).toBe('spring');
    const bySource = (await body(await ctx.req(ctx.A, '/source-attributions?source=website'))).data;
    expect(bySource).toHaveLength(1);
    expect(
      (await ctx.req(ctx.A, `/source-attributions/${attr.id}`, { method: 'DELETE' })).status,
    ).toBe(200);
  });

  it('generic /timeline endpoint requires valid entity params', async () => {
    const ctx = await setup();
    const deal = await create(ctx, ctx.A, '/deals', { title: 'Timeline Deal' });
    const ok = await ctx.req(ctx.A, `/timeline?entity_type=crm.deal&entity_id=${deal.id}`);
    expect(ok.status).toBe(200);
    expect((await body(ok)).data.map((t: any) => t.event_type)).toContain('created');
    expect((await ctx.req(ctx.A, '/timeline?entity_type=crm.deal')).status).toBe(400);
    expect((await ctx.req(ctx.A, '/timeline?entity_type=bogus&entity_id=x')).status).toBe(400);
  });
});

describe('tenant isolation — every entity denies cross-tenant access', () => {
  interface Denial {
    name: string;
    createPath: string;
    makeBody: (ctx: TestContext, customerId: string) => Record<string, unknown>;
    patchBody: Record<string, unknown>;
  }

  const cases: Denial[] = [
    {
      name: 'companies',
      createPath: '/companies',
      makeBody: () => ({ name: 'Iso Co' }),
      patchBody: { name: 'stolen' },
    },
    {
      name: 'customers',
      createPath: '/customers',
      makeBody: () => ({ name: 'Iso Customer' }),
      patchBody: { name: 'stolen' },
    },
    {
      name: 'contacts',
      createPath: '/contacts',
      makeBody: () => ({ first_name: 'Iso' }),
      patchBody: { first_name: 'stolen' },
    },
    {
      name: 'leads',
      createPath: '/leads',
      makeBody: () => ({ name: 'Iso Lead' }),
      patchBody: { name: 'stolen' },
    },
    {
      name: 'deals',
      createPath: '/deals',
      makeBody: () => ({ title: 'Iso Deal' }),
      patchBody: { title: 'stolen' },
    },
    {
      name: 'jobs',
      createPath: '/jobs',
      makeBody: () => ({ title: 'Iso Job' }),
      patchBody: { title: 'stolen' },
    },
    {
      name: 'notes',
      createPath: '/notes',
      makeBody: (_ctx, customerId) => ({
        entity_type: 'crm.customer',
        entity_id: customerId,
        body: 'Iso note',
      }),
      patchBody: { body: 'stolen' },
    },
    {
      name: 'tasks',
      createPath: '/tasks',
      makeBody: () => ({ title: 'Iso Task' }),
      patchBody: { title: 'stolen' },
    },
    {
      name: 'tags',
      createPath: '/tags',
      makeBody: () => ({ name: 'iso-tag' }),
      patchBody: { name: 'stolen' },
    },
    {
      name: 'attachments',
      createPath: '/attachments',
      makeBody: (_ctx, customerId) => ({
        entity_type: 'crm.customer',
        entity_id: customerId,
        file_id: 'file_iso',
        filename: 'iso.pdf',
      }),
      patchBody: { filename: 'stolen.pdf' },
    },
    {
      name: 'source-attributions',
      createPath: '/source-attributions',
      makeBody: (_ctx, customerId) => ({
        entity_type: 'crm.customer',
        entity_id: customerId,
        source: 'iso',
      }),
      patchBody: { source: 'stolen' },
    },
  ];

  it.each(cases)('$name: tenant B gets 404/empty and A data is untouched', async (tc) => {
    const ctx = await setup();
    const customer = await create(ctx, ctx.A, '/customers', { name: 'Iso Parent Customer' });
    const created = await create(ctx, ctx.A, tc.createPath, tc.makeBody(ctx, customer.id));

    // B: read denied
    expect((await ctx.req(ctx.B, `${tc.createPath}/${created.id}`)).status).toBe(404);
    // B: update denied
    expect((await ctx.json(ctx.B, 'PATCH', `${tc.createPath}/${created.id}`, tc.patchBody)).status).toBe(404);
    // B: delete denied
    expect((await ctx.req(ctx.B, `${tc.createPath}/${created.id}`, { method: 'DELETE' })).status).toBe(404);
    // B: list does not include A's row
    const bList = (await body(await ctx.req(ctx.B, tc.createPath))).data;
    expect(bList.map((r: any) => r.id)).not.toContain(created.id);
    // A: row is untouched and readable
    const aRes = await ctx.req(ctx.A, `${tc.createPath}/${created.id}`);
    expect(aRes.status).toBe(200);
    const aRow = (await body(aRes)).data;
    for (const [k, v] of Object.entries(tc.makeBody(ctx, customer.id))) {
      expect(aRow[k]).toBe(v);
    }
  });
});
