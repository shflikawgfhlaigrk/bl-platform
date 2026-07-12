import { describe, expect, it } from 'vitest';
import { parseCsv } from '@blacklabel/core';
import { body, create, seedProduct, setup } from './helpers';

describe('kits / bundles', () => {
  it('composes a kit from component variations and sums component prices', async () => {
    const ctx = await setup();
    const dept = await create(ctx, ctx.A, '/departments', { name: 'Tack', slug: 'tack' });
    const p = await create(ctx, ctx.A, '/products', { sourceItemId: 'kitItem', name: 'Starter Kit', departmentId: dept.id });
    const c1 = await create(ctx, ctx.A, '/variations', { productId: p.id, sourceVariationId: 'c1', name: 'Pad', priceCents: 3000 });
    const c2 = await create(ctx, ctx.A, '/variations', { productId: p.id, sourceVariationId: 'c2', name: 'Girth', priceCents: 2500 });

    const kit = await create(ctx, ctx.A, '/kits', { productId: p.id, name: 'Starter Kit' });
    await create(ctx, ctx.A, `/kits/${kit.id}/components`, { variationId: c1.id, quantity: 1 });
    await create(ctx, ctx.A, `/kits/${kit.id}/components`, { variationId: c2.id, quantity: 2 });

    const comp = await body(await ctx.req(ctx.A, `/kits/${kit.id}`));
    expect(comp.data.components).toHaveLength(2);
    expect(comp.data.componentPriceCents).toBe(3000 * 1 + 2500 * 2); // 8000
  });
});

describe('label data', () => {
  it('returns sku, name, price and a code128 payload for the printer lane', async () => {
    const ctx = await setup();
    const { variation } = await seedProduct(ctx, ctx.A, { sku: 'LBL-1', priceCents: 1299 });
    await create(ctx, ctx.A, `/variations/${variation.id}/barcodes`, { code: '036000291452', isPrimary: true });
    const res = await ctx.json(ctx.A, 'POST', '/labels', { variationIds: [variation.id] });
    const rows = (await body(res)).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sku: 'LBL-1', priceCents: 1299, code128Payload: '036000291452' });
  });
});

describe('CSV bulk lanes', () => {
  it('round-trips: export -> import produces zero changes', async () => {
    const ctx = await setup();
    await seedProduct(ctx, ctx.A, { sku: 'RT-1', priceCents: 4999 });

    const exportRes = await ctx.req(ctx.A, '/export.csv');
    expect(exportRes.headers.get('content-type')).toContain('text/csv');
    const csv = await exportRes.text();
    const parsed = parseCsv(csv);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sku).toBe('RT-1');
    expect(parsed[0].price_cents).toBe('4999');

    const commit = await body(await ctx.csv(ctx.A, '/import/commit', csv));
    expect(commit.data.failedRows).toBe(0);
    expect(commit.data.updated).toBe(1);

    // re-export identical
    const csv2 = await (await ctx.req(ctx.A, '/export.csv')).text();
    expect(csv2).toBe(csv);
  });

  it('two-phase import rejects bad rows with row-level errors (never partial-silent)', async () => {
    const ctx = await setup();
    const { variation } = await seedProduct(ctx, ctx.A, { sku: 'OLD', priceCents: 1000 });

    const csv = [
      'source_variation_id,source_item_id,name,sku,price_cents',
      `${variation.source_variation_id},x,Renamed,NEW,2000`, // valid update
      ',x,Missing id,Z,999', // invalid: missing source_variation_id
      'unknownVar,x,Ghost,G,not-a-number', // invalid: bad price
    ].join('\n');

    // preview mutates nothing
    const preview = await body(await ctx.csv(ctx.A, '/import/preview', csv));
    expect(preview.data.totalRows).toBe(3);
    expect(preview.data.okRows).toBe(1);
    expect(preview.data.failedRows).toBe(2);
    expect(preview.data.errors.map((e: any) => e.row).sort()).toEqual([3, 4]);
    const stillOld = await body(await ctx.req(ctx.A, `/variations/${variation.id}`));
    expect(stillOld.data.sku).toBe('OLD');

    // commit applies only the valid row
    const commit = await body(await ctx.csv(ctx.A, '/import/commit', csv));
    expect(commit.data.updated).toBe(1);
    expect(commit.data.failedRows).toBe(2);
    const updated = await body(await ctx.req(ctx.A, `/variations/${variation.id}`));
    expect(updated.data.sku).toBe('NEW');
    expect(updated.data.price_cents).toBe(2000);

    const jobs = await body(await ctx.req(ctx.A, '/bulk-jobs'));
    expect(jobs.data[0].rows_failed).toBe(2);
  });
});
