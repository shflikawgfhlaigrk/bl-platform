/**
 * Adversarial regression tests added during verification:
 * - CSV import must not bypass service-level validation (status, value_cents)
 * - /custom-fields DELETE is scoped to crm.* definitions and to the tenant
 * - q search is case-insensitive
 * - sort works (and is whitelisted) on notes/attachments/tags lists
 * - generic /timeline and /taggings never leak across tenants
 */
import { describe, expect, it } from 'vitest';
import { asCoreDb, defineCustomField, listCustomFields } from '@blacklabel/core';
import { body, create, setup } from './helpers';

describe('CSV import cannot bypass validation', () => {
  it('rejects an invalid customer status row and imports the rest', async () => {
    const ctx = await setup();
    const csv = [
      'name,status',
      'Good Customer,active',
      'Bad Status Customer,bogus_status',
    ].join('\n');
    const res = await ctx.req(ctx.A, '/customers/import.csv', {
      method: 'POST',
      headers: { 'content-type': 'text/csv' },
      body: csv,
    });
    expect(res.status).toBe(200);
    const result = (await body(res)).data;
    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].row).toBe(3);
    expect(result.errors[0].message).toContain('status');

    const rows = await ctx.db
      .selectFrom('crm_customers')
      .selectAll()
      .where('tenant_id', '=', ctx.A)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
  });

  it('rejects a negative value_cents lead row', async () => {
    const ctx = await setup();
    const csv = ['name,value_cents', 'Good Lead,5000', 'Negative Lead,-100'].join('\n');
    const res = await ctx.req(ctx.A, '/leads/import.csv', {
      method: 'POST',
      headers: { 'content-type': 'text/csv' },
      body: csv,
    });
    const result = (await body(res)).data;
    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].row).toBe(3);

    const leads = (await body(await ctx.req(ctx.A, '/leads'))).data;
    expect(leads).toHaveLength(1);
    expect(leads[0].value_cents).toBe(5000);
  });
});

describe('custom-field definition scope', () => {
  it("DELETE /custom-fields/:id cannot delete another module's definition", async () => {
    const ctx = await setup();
    // Another module's definition lives in the same core table.
    const foreign = await defineCustomField(asCoreDb(ctx.db), ctx.A, {
      entityType: 'billing.invoice',
      key: 'po_number',
      label: 'PO number',
      kind: 'text',
    });
    const res = await ctx.req(ctx.A, `/custom-fields/${foreign.id}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    const still = await listCustomFields(asCoreDb(ctx.db), ctx.A, 'billing.invoice');
    expect(still.map((d) => d.id)).toContain(foreign.id);
  });

  it("tenant B cannot delete tenant A's crm definition", async () => {
    const ctx = await setup();
    const defRes = await ctx.json(ctx.A, 'POST', '/custom-fields', {
      entity_type: 'crm.customer',
      key: 'referral_code',
      label: 'Referral code',
      kind: 'text',
    });
    expect(defRes.status).toBe(201);
    const def = (await body(defRes)).data;

    expect((await ctx.req(ctx.B, `/custom-fields/${def.id}`, { method: 'DELETE' })).status).toBe(404);
    const still = await listCustomFields(asCoreDb(ctx.db), ctx.A, 'crm.customer');
    expect(still.map((d) => d.id)).toContain(def.id);

    // A can delete its own.
    expect((await ctx.req(ctx.A, `/custom-fields/${def.id}`, { method: 'DELETE' })).status).toBe(200);
  });
});

describe('search & sort hardening', () => {
  it('q search is case-insensitive', async () => {
    const ctx = await setup();
    await create(ctx, ctx.A, '/customers', { name: 'Alpha Services' });
    await create(ctx, ctx.A, '/customers', { name: 'Beta Group' });
    const lower = (await body(await ctx.req(ctx.A, '/customers?q=alpha'))).data;
    expect(lower.map((r: any) => r.name)).toEqual(['Alpha Services']);
    const upper = (await body(await ctx.req(ctx.A, '/customers?q=ALPHA'))).data;
    expect(upper.map((r: any) => r.name)).toEqual(['Alpha Services']);

    await create(ctx, ctx.A, '/tags', { name: 'VIP' });
    const tags = (await body(await ctx.req(ctx.A, '/tags?q=vip'))).data;
    expect(tags.map((r: any) => r.name)).toEqual(['VIP']);
  });

  it('notes/attachments/tags lists support whitelisted sort and reject others', async () => {
    const ctx = await setup();
    const customer = await create(ctx, ctx.A, '/customers', { name: 'Sort Customer' });
    await create(ctx, ctx.A, '/notes', {
      entity_type: 'crm.customer',
      entity_id: customer.id,
      body: 'first note',
    });
    await create(ctx, ctx.A, '/notes', {
      entity_type: 'crm.customer',
      entity_id: customer.id,
      body: 'second note',
    });
    const asc = (await body(await ctx.req(ctx.A, '/notes?sort=created_at'))).data;
    const desc = (await body(await ctx.req(ctx.A, '/notes?sort=-created_at'))).data;
    expect(asc).toHaveLength(2);
    expect(desc).toHaveLength(2);
    for (let i = 1; i < asc.length; i += 1) expect(asc[i - 1].created_at <= asc[i].created_at).toBe(true);
    for (let i = 1; i < desc.length; i += 1) expect(desc[i - 1].created_at >= desc[i].created_at).toBe(true);
    expect((await ctx.req(ctx.A, '/notes?sort=body')).status).toBe(400);

    await create(ctx, ctx.A, '/attachments', {
      entity_type: 'crm.customer',
      entity_id: customer.id,
      file_id: 'f1',
      filename: 'b.pdf',
    });
    await create(ctx, ctx.A, '/attachments', {
      entity_type: 'crm.customer',
      entity_id: customer.id,
      file_id: 'f2',
      filename: 'a.pdf',
    });
    const byName = (await body(await ctx.req(ctx.A, '/attachments?sort=filename'))).data;
    expect(byName.map((a: any) => a.filename)).toEqual(['a.pdf', 'b.pdf']);
    expect((await ctx.req(ctx.A, '/attachments?sort=file_id')).status).toBe(400);

    await create(ctx, ctx.A, '/tags', { name: 'zeta' });
    await create(ctx, ctx.A, '/tags', { name: 'alpha' });
    const tagsDesc = (await body(await ctx.req(ctx.A, '/tags?sort=-name'))).data;
    expect(tagsDesc.map((t: any) => t.name)).toEqual(['zeta', 'alpha']);
    expect((await ctx.req(ctx.A, '/tags?sort=color')).status).toBe(400);
  });
});

describe('tenant isolation — timeline and taggings', () => {
  it("generic /timeline never returns another tenant's events", async () => {
    const ctx = await setup();
    const deal = await create(ctx, ctx.A, '/deals', { title: 'A-only deal' });
    const mine = (await body(
      await ctx.req(ctx.A, `/timeline?entity_type=crm.deal&entity_id=${deal.id}`),
    )).data;
    expect(mine.length).toBeGreaterThan(0);
    const theirs = (await body(
      await ctx.req(ctx.B, `/timeline?entity_type=crm.deal&entity_id=${deal.id}`),
    )).data;
    expect(theirs).toEqual([]);
  });

  it("/taggings never returns another tenant's tags", async () => {
    const ctx = await setup();
    const customer = await create(ctx, ctx.A, '/customers', { name: 'Tagged A' });
    const tag = await create(ctx, ctx.A, '/tags', { name: 'iso' });
    await ctx.json(ctx.A, 'POST', `/tags/${tag.id}/attach`, {
      entity_type: 'crm.customer',
      entity_id: customer.id,
    });
    const mine = (await body(
      await ctx.req(ctx.A, `/taggings?entity_type=crm.customer&entity_id=${customer.id}`),
    )).data;
    expect(mine).toHaveLength(1);
    const theirs = (await body(
      await ctx.req(ctx.B, `/taggings?entity_type=crm.customer&entity_id=${customer.id}`),
    )).data;
    expect(theirs).toEqual([]);
    // B also cannot attach its tags to A's entity (entity lookup is tenant-scoped).
    const bTag = await create(ctx, ctx.B, '/tags', { name: 'b-tag' });
    const attach = await ctx.json(ctx.B, 'POST', `/tags/${bTag.id}/attach`, {
      entity_type: 'crm.customer',
      entity_id: customer.id,
    });
    expect(attach.status).toBe(404);
  });
});
