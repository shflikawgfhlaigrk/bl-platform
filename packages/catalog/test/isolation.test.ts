import { describe, expect, it } from 'vitest';
import { body, create, seedProduct, setup } from './helpers';

describe('tenant isolation (denial everywhere)', () => {
  it('missing tenant header is rejected', async () => {
    const ctx = await setup();
    const res = await ctx.app.request('/departments');
    expect(res.status).toBe(400);
  });

  it('tenant B cannot read, update, or reach tenant A entities', async () => {
    const ctx = await setup();
    const { dept, product, variation } = await seedProduct(ctx, ctx.A, { priceCents: 1000 });

    // reads scoped
    expect((await body(await ctx.req(ctx.B, '/departments'))).data).toEqual([]);
    expect((await body(await ctx.req(ctx.B, '/products'))).data).toEqual([]);
    expect((await body(await ctx.req(ctx.B, '/variations'))).data).toEqual([]);

    // direct gets 404 across tenants
    expect((await ctx.req(ctx.B, `/products/${product.id}`)).status).toBe(404);
    expect((await ctx.req(ctx.B, `/variations/${variation.id}`)).status).toBe(404);

    // updates across tenants 404
    expect((await ctx.json(ctx.B, 'PATCH', `/products/${product.id}`, { name: 'HACK' })).status).toBe(404);
    expect((await ctx.json(ctx.B, 'PATCH', `/variations/${variation.id}`, { sku: 'HACK' })).status).toBe(404);
    expect((await ctx.json(ctx.B, 'PATCH', `/departments/${dept.id}`, { name: 'HACK' })).status).toBe(404);
    expect(
      (await ctx.json(ctx.B, 'POST', `/products/${product.id}/publication`, { state: 'published' })).status,
    ).toBe(404);

    // A's data untouched
    const still = await body(await ctx.req(ctx.A, `/products/${product.id}`));
    expect(still.data.name).toBe('LeMieux Saddle Pad');
  });

  it('barcode lookup and conflicts are tenant-scoped', async () => {
    const ctx = await setup();
    const { variation } = await seedProduct(ctx, ctx.A);
    await create(ctx, ctx.A, `/variations/${variation.id}/barcodes`, { code: '036000291452' });
    const miss = await body(await ctx.req(ctx.B, '/lookup?code=036000291452'));
    expect(miss.data.matchType).toBe('none');
    expect((await body(await ctx.req(ctx.B, '/conflicts'))).data).toEqual([]);
  });

  it('price entries / promotions / kits are tenant-scoped', async () => {
    const ctx = await setup();
    const { variation } = await seedProduct(ctx, ctx.A, { priceCents: 5000 });
    const book = await create(ctx, ctx.A, '/price-books', { name: 'B' });
    await create(ctx, ctx.A, '/price-entries', { priceBookId: book.id, variationId: variation.id, priceCents: 4000 });
    expect((await body(await ctx.req(ctx.B, '/price-books'))).data).toEqual([]);
    expect((await body(await ctx.req(ctx.B, '/promotions'))).data).toEqual([]);
    expect((await body(await ctx.req(ctx.B, '/kits'))).data).toEqual([]);
    // B resolving A's variation id → 404
    expect((await ctx.req(ctx.B, `/variations/${variation.id}/price`)).status).toBe(404);
  });
});

describe('audit on mutations', () => {
  it('writes namespaced audit rows for product + variation + publication', async () => {
    const ctx = await setup();
    const { product, variation } = await seedProduct(ctx, ctx.A, { priceCents: 1000 });
    await ctx.json(ctx.A, 'POST', `/products/${product.id}/publication`, { state: 'published' });

    const rows = await ctx.db
      .selectFrom('audit_log')
      .selectAll()
      .where('tenant_id', '=', ctx.A)
      .execute();
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('catalog.product.created');
    expect(actions).toContain('catalog.variation.created');
    expect(actions).toContain('catalog.publication.changed');
    // audit is tenant-scoped
    const bRows = await ctx.db.selectFrom('audit_log').selectAll().where('tenant_id', '=', ctx.B).execute();
    expect(bRows).toEqual([]);
    // entity ids reference the real rows
    const prodAudit = rows.find((r) => r.action === 'catalog.product.created')!;
    expect(prodAudit.entity_type).toBe('catalog.product');
    expect(prodAudit.entity_id).toBe(product.id);
    expect(variation.id).toBeTruthy();
  });
});
