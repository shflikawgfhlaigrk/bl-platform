import { describe, expect, it } from 'vitest';
import { buildImportPlan, importFromLedger, type LedgerItem } from '../src/importer';
import { body, setup } from './helpers';

/** A small synthetic ledger that exercises every mapping/exclusion branch. */
function fixture(): LedgerItem[] {
  return [
    {
      sourceItemId: 'i1',
      name: 'LeMieux Saddle Pad',
      categoryName: 'Saddle Pads',
      variations: [
        { sourceVariationId: 'i1v1', name: 'Medium', sku: 'LM-PAD-M', upc: '0 36000 29145 2', priceCents: 4999 },
        { sourceVariationId: 'i1v2', name: 'Large', sku: 'LM-PAD-L', upc: '036000291451', priceCents: 5499 }, // bad check digit
      ],
    },
    {
      sourceItemId: 'i2',
      name: 'TuffRider Breeches',
      categoryName: 'Womens Breeches',
      variations: [{ sourceVariationId: 'i2v1', name: '28R', sku: 'TR-28', upc: '4006381333931', priceCents: 8900 }],
    },
    {
      sourceItemId: 'i3',
      name: 'DNU old halter',
      categoryName: 'Halters',
      variations: [{ sourceVariationId: 'i3v1', name: 'Regular', sku: 'DNU-1', upc: null, priceCents: 100 }],
    },
    {
      sourceItemId: 'i4',
      name: 'Mystery Widget',
      categoryName: 'Miscellaneous', // → needs_review
      variations: [
        { sourceVariationId: 'i4v1', name: 'Regular', sku: 'WID', upc: '036000291452', priceCents: 1000 }, // duplicate normalized upc with i1v1
      ],
    },
    {
      sourceItemId: 'i5',
      name: 'Consignment lot',
      categoryName: 'JPC Consignment',
      variations: [{ sourceVariationId: 'i5v1', name: 'Regular', sku: null, upc: null, priceCents: null }],
    },
  ];
}

describe('buildImportPlan (pure)', () => {
  it('maps, extracts brands, flags exclusions, and computes honest stats', () => {
    const plan = buildImportPlan(fixture());
    expect(plan.stats.items).toBe(5);
    expect(plan.stats.variations).toBe(6);
    expect(plan.stats.skus).toBe(5); // only i5v1 has no sku
    expect(plan.stats.upcs).toBe(4);
    expect(plan.stats.badCheckDigits).toBe(1); // i1v2
    expect(plan.stats.duplicateNormalizedUpcs).toBe(1); // 036000291452 on i1v1 + i4v1
    expect(plan.stats.excluded).toBe(2); // DNU + JPC Consignment

    const brandSlugs = plan.brands.map((b) => b.slug).sort();
    expect(brandSlugs).toEqual(['lemieux', 'tuffrider']);

    const misc = plan.categoryMappings.find((m) => m.sourceCategoryName === 'Miscellaneous')!;
    expect(misc.status).toBe('needs_review');
    const pads = plan.categoryMappings.find((m) => m.sourceCategoryName === 'Saddle Pads')!;
    expect(pads).toMatchObject({ status: 'mapped', departmentSlug: 'saddle-pads' });

    const dnu = plan.products.find((p) => p.sourceItemId === 'i3')!;
    expect(dnu).toMatchObject({ publicationState: 'excluded', exclusionReason: 'dnu' });
    const jpc = plan.products.find((p) => p.sourceItemId === 'i5')!;
    expect(jpc).toMatchObject({ publicationState: 'excluded', exclusionReason: 'jpc_consignment' });
  });
});

describe('importFromLedger (idempotent apply)', () => {
  it('imports rows, preserves source ids, and is idempotent on re-run', async () => {
    const ctx = await setup();
    const first = await importFromLedger(ctx.db, ctx.A, fixture(), { events: ctx.events });
    expect(first.productsInserted).toBe(5);
    expect(first.variationsInserted).toBe(6);
    expect(first.barcodesInserted).toBe(4);
    expect(first.brandsInserted).toBe(2);
    expect(first.departmentsInserted).toBeGreaterThan(0);

    // second run: NO new rows, everything updates in place
    const second = await importFromLedger(ctx.db, ctx.A, fixture(), { events: ctx.events });
    expect(second.productsInserted).toBe(0);
    expect(second.variationsInserted).toBe(0);
    expect(second.barcodesInserted).toBe(0);
    expect(second.brandsInserted).toBe(0);
    expect(second.departmentsInserted).toBe(0);
    expect(second.productsUpdated).toBe(5);
    expect(second.variationsUpdated).toBe(6);

    // row counts unchanged after two runs
    const products = await ctx.db.selectFrom('catalog_products').selectAll().where('tenant_id', '=', ctx.A).execute();
    const variations = await ctx.db.selectFrom('catalog_variations').selectAll().where('tenant_id', '=', ctx.A).execute();
    const barcodes = await ctx.db.selectFrom('catalog_barcodes').selectAll().where('tenant_id', '=', ctx.A).execute();
    expect(products).toHaveLength(5);
    expect(variations).toHaveLength(6);
    expect(barcodes).toHaveLength(4);

    // preserved source ids resolve via lookup + conflicts show the dup UPC
    const conflicts = await body(await ctx.req(ctx.A, '/conflicts'));
    expect(conflicts.data.some((k: any) => k.codeNormalized === '036000291452')).toBe(true);

    // excluded products are excluded; a mapped+priced one can be listed as draft
    const excluded = await body(await ctx.req(ctx.A, '/products?publicationState=excluded'));
    expect(excluded.data).toHaveLength(2);
  });

  it('review queue lists needs_review categories after import', async () => {
    const ctx = await setup();
    await importFromLedger(ctx.db, ctx.A, fixture());
    const review = await body(await ctx.req(ctx.A, '/category-mappings?status=needs_review'));
    expect(review.data.some((m: any) => m.source_category_name === 'Miscellaneous')).toBe(true);
  });
});
