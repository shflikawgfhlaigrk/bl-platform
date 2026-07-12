import { describe, expect, it } from 'vitest';
import { body, create, setup } from './helpers';

describe('customers CRUD via router', () => {
  it('creates, reads, updates, deletes a customer (with audit entries)', async () => {
    const ctx = await setup();
    const created = await create(ctx, ctx.A, '/customers', {
      name: 'Avery Collins',
      email: 'avery@example.com',
      phone: '+1-555-0100',
    });
    expect(created.id).toBeTruthy();
    expect(created.name).toBe('Avery Collins');
    expect(created.status).toBe('active');
    expect(created.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const got = await body(await ctx.req(ctx.A, `/customers/${created.id}`));
    expect(got.data.email).toBe('avery@example.com');

    const updatedRes = await ctx.json(ctx.A, 'PATCH', `/customers/${created.id}`, {
      phone: '+1-555-9999',
      status: 'inactive',
    });
    expect(updatedRes.status).toBe(200);
    const updated = (await body(updatedRes)).data;
    expect(updated.phone).toBe('+1-555-9999');
    expect(updated.status).toBe('inactive');
    expect(updated.updated_at >= created.updated_at).toBe(true);

    const delRes = await ctx.req(ctx.A, `/customers/${created.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    const goneRes = await ctx.req(ctx.A, `/customers/${created.id}`);
    expect(goneRes.status).toBe(404);

    // Audit log recorded create + update + delete.
    const audits = await ctx.db
      .selectFrom('audit_log')
      .selectAll()
      .where('tenant_id', '=', ctx.A)
      .where('entity_type', '=', 'crm.customer')
      .where('entity_id', '=', created.id)
      .execute();
    const actions = audits.map((a) => a.action).sort();
    expect(actions).toEqual(['crm.customer.created', 'crm.customer.deleted', 'crm.customer.updated']);
  });

  it('emits crm.customer.created after the write', async () => {
    const ctx = await setup();
    const seen: any[] = [];
    ctx.events.on('crm.customer.created', (e) => {
      seen.push(e);
    });
    const created = await create(ctx, ctx.A, '/customers', { name: 'Jordan Blake' });
    expect(seen).toHaveLength(1);
    expect(seen[0].tenantId).toBe(ctx.A);
    expect(seen[0].payload).toEqual({ customerId: created.id });
  });

  it('validates payloads (unknown keys and missing name are 400)', async () => {
    const ctx = await setup();
    const missing = await ctx.json(ctx.A, 'POST', '/customers', { email: 'x@y.z' });
    expect(missing.status).toBe(400);
    const unknownKey = await ctx.json(ctx.A, 'POST', '/customers', {
      name: 'ok',
      tenant_id: 'evil-tenant',
    });
    expect(unknownKey.status).toBe(400);
  });

  it('rejects a client-supplied tenant_id and never leaks across tenants', async () => {
    const ctx = await setup();
    const a = await create(ctx, ctx.A, '/customers', { name: 'Tenant A Customer' });

    // Tenant B cannot read, update, or delete A's customer.
    expect((await ctx.req(ctx.B, `/customers/${a.id}`)).status).toBe(404);
    expect((await ctx.json(ctx.B, 'PATCH', `/customers/${a.id}`, { name: 'stolen' })).status).toBe(404);
    expect((await ctx.req(ctx.B, `/customers/${a.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await ctx.req(ctx.B, `/customers/${a.id}/timeline`)).status).toBe(404);

    // B's list is empty; A's data is untouched.
    const bList = (await body(await ctx.req(ctx.B, '/customers'))).data;
    expect(bList).toEqual([]);
    const aRow = (await body(await ctx.req(ctx.A, `/customers/${a.id}`))).data;
    expect(aRow.name).toBe('Tenant A Customer');
  });

  it('search, filter, sort, and pagination work on the list endpoint', async () => {
    const ctx = await setup();
    await create(ctx, ctx.A, '/customers', { name: 'Alpha Services', email: 'alpha@example.com' });
    await create(ctx, ctx.A, '/customers', { name: 'Beta Group', email: 'beta@example.com' });
    await create(ctx, ctx.A, '/customers', {
      name: 'Gamma Alpha Holdings',
      status: 'archived',
    });

    // q substring search
    const q = (await body(await ctx.req(ctx.A, '/customers?q=Alpha'))).data;
    expect(q.map((r: any) => r.name).sort()).toEqual(['Alpha Services', 'Gamma Alpha Holdings']);

    // equality filter
    const archived = (await body(await ctx.req(ctx.A, '/customers?status=archived'))).data;
    expect(archived).toHaveLength(1);
    expect(archived[0].name).toBe('Gamma Alpha Holdings');

    // sort whitelist: allowed
    const sorted = (await body(await ctx.req(ctx.A, '/customers?sort=name'))).data;
    expect(sorted.map((r: any) => r.name)).toEqual([
      'Alpha Services',
      'Beta Group',
      'Gamma Alpha Holdings',
    ]);

    // sort whitelist: rejected column
    expect((await ctx.req(ctx.A, '/customers?sort=tenant_id')).status).toBe(400);

    // pagination
    const page = await body(await ctx.req(ctx.A, '/customers?sort=name&limit=2&offset=1'));
    expect(page.limit).toBe(2);
    expect(page.offset).toBe(1);
    expect(page.data.map((r: any) => r.name)).toEqual(['Beta Group', 'Gamma Alpha Holdings']);
  });

  it('appends timeline events on create/update and serves the timeline endpoint', async () => {
    const ctx = await setup();
    const customer = await create(ctx, ctx.A, '/customers', { name: 'Timeline Customer' });
    await ctx.json(ctx.A, 'PATCH', `/customers/${customer.id}`, { phone: '+1-555-1234' });

    const res = await ctx.req(ctx.A, `/customers/${customer.id}/timeline`);
    expect(res.status).toBe(200);
    const timeline = (await body(res)).data;
    const types = timeline.map((t: any) => t.event_type);
    expect(types).toContain('created');
    expect(types).toContain('updated');
    // newest first (non-increasing created_at)
    const stamps = timeline.map((t: any) => t.created_at);
    for (let i = 1; i < stamps.length; i += 1) {
      expect(stamps[i - 1] >= stamps[i]).toBe(true);
    }
  });

  it('supports custom fields: define via endpoint, set value, reject unknown key', async () => {
    const ctx = await setup();
    const defRes = await ctx.json(ctx.A, 'POST', '/custom-fields', {
      entity_type: 'crm.customer',
      key: 'referral_code',
      label: 'Referral code',
      kind: 'text',
    });
    expect(defRes.status).toBe(201);

    const customer = await create(ctx, ctx.A, '/customers', {
      name: 'Custom Fields Customer',
      custom_fields: { referral_code: 'FRIEND-22' },
    });
    expect(customer.custom_fields).toEqual({ referral_code: 'FRIEND-22' });

    const fetched = (await body(await ctx.req(ctx.A, `/customers/${customer.id}`))).data;
    expect(fetched.custom_fields).toEqual({ referral_code: 'FRIEND-22' });

    const bad = await ctx.json(ctx.A, 'POST', '/customers', {
      name: 'Bad Custom',
      custom_fields: { not_defined: 1 },
    });
    expect(bad.status).toBe(400);

    // Definitions are tenant-scoped: tenant B has no referral_code field.
    const badB = await ctx.json(ctx.B, 'POST', '/customers', {
      name: 'B Customer',
      custom_fields: { referral_code: 'X' },
    });
    expect(badB.status).toBe(400);

    const list = (await body(await ctx.req(ctx.A, '/custom-fields?entity_type=crm.customer'))).data;
    expect(list).toHaveLength(1);
    expect(list[0].key).toBe('referral_code');
  });

  it('requires the x-tenant-id header (400) and a real tenant (404)', async () => {
    const ctx = await setup();
    const noHeader = await ctx.app.request('/customers');
    expect(noHeader.status).toBe(400);
    const badTenant = await ctx.app.request('/customers', {
      headers: { 'x-tenant-id': 'not-a-tenant' },
    });
    expect(badTenant.status).toBe(404);
  });
});
