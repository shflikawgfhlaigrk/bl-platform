import { describe, expect, it } from 'vitest';
import { body, create, seedProduct, setup } from './helpers';

describe('barcode lookup precedence + conflicts', () => {
  it('resolves normalized barcode > sku > name substring', async () => {
    const ctx = await setup();
    const { product, variation } = await seedProduct(ctx, ctx.A, { sku: 'SKU-XYZ', priceCents: 1000 });

    // add a valid UPC-A barcode
    await create(ctx, ctx.A, `/variations/${variation.id}/barcodes`, { code: '0 36000 29145 2', isPrimary: true });

    // 1) normalized barcode wins
    const byBarcode = await body(await ctx.req(ctx.A, '/lookup?code=036000291452'));
    expect(byBarcode.data.matchType).toBe('barcode');
    expect(byBarcode.data.matches[0].variation.id).toBe(variation.id);

    // barcode lookup tolerates the spaced form too (normalization)
    const spaced = await body(await ctx.req(ctx.A, `/lookup?code=${encodeURIComponent('0 36000 29145 2')}`));
    expect(spaced.data.matchType).toBe('barcode');

    // 2) sku exact (a code that is not a barcode)
    const bySku = await body(await ctx.req(ctx.A, '/lookup?code=SKU-XYZ'));
    expect(bySku.data.matchType).toBe('sku');
    expect(bySku.data.matches[0].variation.id).toBe(variation.id);

    // 3) name substring fallback
    const byName = await body(await ctx.req(ctx.A, '/lookup?code=LeMieux'));
    expect(byName.data.matchType).toBe('name');
    expect(byName.data.matches.some((m: any) => m.product.id === product.id)).toBe(true);

    // miss
    const miss = await body(await ctx.req(ctx.A, '/lookup?code=zzzznope'));
    expect(miss.data.matchType).toBe('none');
    expect(miss.data.matches).toEqual([]);
  });

  it('is merge-tolerant: a duplicated normalized code returns ALL matches and is queryable as a conflict', async () => {
    const ctx = await setup();
    const dept = await create(ctx, ctx.A, '/departments', { name: 'Tack', slug: 'tack' });
    const product = await create(ctx, ctx.A, '/products', {
      sourceItemId: 'itemDup',
      name: 'Dup Product',
      departmentId: dept.id,
    });
    const v1 = await create(ctx, ctx.A, '/variations', {
      productId: product.id,
      sourceVariationId: 'v1',
      name: 'A',
      priceCents: 100,
    });
    const v2 = await create(ctx, ctx.A, '/variations', {
      productId: product.id,
      sourceVariationId: 'v2',
      name: 'B',
      priceCents: 200,
    });
    // same UPC on two variations (real-world duplicate)
    await create(ctx, ctx.A, `/variations/${v1.id}/barcodes`, { code: '036000291452' });
    await create(ctx, ctx.A, `/variations/${v2.id}/barcodes`, { code: '036000291452' });

    const lookup = await body(await ctx.req(ctx.A, '/lookup?code=036000291452'));
    expect(lookup.data.matchType).toBe('barcode');
    const ids = lookup.data.matches.map((m: any) => m.variation.id).sort();
    expect(ids).toEqual([v1.id, v2.id].sort());

    const conflicts = await body(await ctx.req(ctx.A, '/conflicts'));
    expect(conflicts.data).toHaveLength(1);
    expect(conflicts.data[0].codeNormalized).toBe('036000291452');
    expect(conflicts.data[0].variationIds.sort()).toEqual([v1.id, v2.id].sort());
  });

  it('stores an invalid hand-typed code and still finds it', async () => {
    const ctx = await setup();
    const { variation } = await seedProduct(ctx, ctx.A);
    const bc = await create(ctx, ctx.A, `/variations/${variation.id}/barcodes`, { code: '036000291451' });
    expect(bc.checksum_valid).toBe(0);
    const found = await body(await ctx.req(ctx.A, '/lookup?code=036000291451'));
    expect(found.data.matchType).toBe('barcode');
  });
});
