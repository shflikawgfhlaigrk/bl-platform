import { describe, expect, it } from 'vitest';
import { normalizeEmail, normalizePhone } from '@blacklabel/customers';
import { body, create, setup } from './helpers';

describe('profiles: CRUD, normalization, import idempotency, tenant denial', () => {
  it('normalizes email (case/space) and phone (E.164-ish digits) on create', async () => {
    const ctx = await setup();
    const p = await create(ctx, ctx.A, '/profiles', {
      email: '  Jane.Doe@Example.COM ',
      phone: '(404) 555-1212',
      first_name: 'Jane',
      source: 'storefront',
    });
    expect(p.email_normalized).toBe('jane.doe@example.com');
    expect(p.phone_normalized).toBe('14045551212');
    expect(p.merged_into).toBeNull();
  });

  it('pure normalizers document the rules', () => {
    expect(normalizeEmail('  A@B.com ')).toBe('a@b.com');
    expect(normalizeEmail('')).toBeNull();
    expect(normalizePhone('404-555-1212')).toBe('14045551212'); // 10 digits -> prepend 1
    expect(normalizePhone('+1 404 555 1212')).toBe('14045551212');
    expect(normalizePhone('0044 20 7946 0958')).toBe('442079460958'); // 00 stripped, kept as-is
    expect(normalizePhone('')).toBeNull();
  });

  it('searches by normalized email/phone and by name', async () => {
    const ctx = await setup();
    await create(ctx, ctx.A, '/profiles', { email: 'match@x.com', first_name: 'Aaron' });
    await create(ctx, ctx.A, '/profiles', { phone: '4045550000', last_name: 'Zephyr' });

    const byEmail = (await body(await ctx.req(ctx.A, '/profiles?email=MATCH@X.com'))).data;
    expect(byEmail).toHaveLength(1);
    const byPhone = (await body(await ctx.req(ctx.A, '/profiles?phone=(404)%20555-0000'))).data;
    expect(byPhone).toHaveLength(1);
    const byName = (await body(await ctx.req(ctx.A, '/profiles?name=zeph'))).data;
    expect(byName).toHaveLength(1);
  });

  it('rejects a duplicate crm_customer_id per tenant with 409', async () => {
    const ctx = await setup();
    await create(ctx, ctx.A, '/profiles', { crm_customer_id: 'crm-1', email: 'a@a.com' });
    const dup = await ctx.json(ctx.A, 'POST', '/profiles', { crm_customer_id: 'crm-1', email: 'b@b.com' });
    expect(dup.status).toBe(409);
  });

  it('importProfiles is idempotent keyed on crm_customer_id (re-run updates, never duplicates)', async () => {
    const ctx = await setup();
    const rows = [
      { crm_customer_id: 'sq-1', email: 'One@x.com', first_name: 'One' },
      { crm_customer_id: 'sq-2', phone: '4045551111', first_name: 'Two' },
    ];
    const first = (await body(await ctx.json(ctx.A, 'POST', '/profiles/import', { rows }))).data;
    expect(first.imported).toBe(2);
    expect(first.updated).toBe(0);

    const second = (
      await body(
        await ctx.json(ctx.A, 'POST', '/profiles/import', {
          rows: [{ crm_customer_id: 'sq-1', email: 'one-new@x.com', first_name: 'One!' }],
        }),
      )
    ).data;
    expect(second.imported).toBe(0);
    expect(second.updated).toBe(1);

    const all = (await body(await ctx.req(ctx.A, '/profiles?limit=100'))).data;
    expect(all).toHaveLength(2);
    const one = all.find((p: any) => p.crm_customer_id === 'sq-1');
    expect(one.email_normalized).toBe('one-new@x.com');
  });

  it('denies cross-tenant reads/updates (tenant B cannot see or patch A)', async () => {
    const ctx = await setup();
    const p = await create(ctx, ctx.A, '/profiles', { email: 'secret@a.com' });

    expect((await ctx.req(ctx.B, `/profiles/${p.id}`)).status).toBe(404);
    expect((await ctx.json(ctx.B, 'PATCH', `/profiles/${p.id}`, { first_name: 'X' })).status).toBe(404);
    // A untouched
    const still = (await body(await ctx.req(ctx.A, `/profiles/${p.id}`))).data;
    expect(still.email_normalized).toBe('secret@a.com');
    // B list empty
    expect((await body(await ctx.req(ctx.B, '/profiles'))).data).toEqual([]);
  });
});
