import { describe, expect, it } from 'vitest';
import { applyDiscount } from '@blacklabel/core';
import { body, create, seedProduct, setup } from './helpers';

const T0 = '2026-07-01T00:00:00.000Z';
const T1 = '2026-07-10T00:00:00.000Z';
const FUTURE = '2026-08-01T00:00:00.000Z';

describe('deterministic price resolution', () => {
  it('falls back to the variation base price when no entry is active', async () => {
    const ctx = await setup();
    const { variation } = await seedProduct(ctx, ctx.A, { priceCents: 4999 });
    const r = await body(await ctx.req(ctx.A, `/variations/${variation.id}/price?at=${T1}`));
    expect(r.data).toMatchObject({ priceCents: 4999, source: 'variation' });
  });

  it('a scheduled future price is NOT active until its effective_from', async () => {
    const ctx = await setup();
    const { variation } = await seedProduct(ctx, ctx.A, { priceCents: 4999 });
    const book = await create(ctx, ctx.A, '/price-books', { name: 'Summer Sale' });
    await create(ctx, ctx.A, '/price-entries', {
      priceBookId: book.id,
      variationId: variation.id,
      priceCents: 3999,
      effectiveFrom: FUTURE,
    });
    // before it starts → base price
    const before = await body(await ctx.req(ctx.A, `/variations/${variation.id}/price?at=${T1}`));
    expect(before.data.priceCents).toBe(4999);
    // at/after it starts → scheduled price
    const after = await body(await ctx.req(ctx.A, `/variations/${variation.id}/price?at=${FUTURE}`));
    expect(after.data).toMatchObject({ priceCents: 3999, source: 'entry' });
  });

  it('most-specific active entry wins; tie → latest effective_from, then id', async () => {
    const ctx = await setup();
    const { variation } = await seedProduct(ctx, ctx.A, { priceCents: 5000 });
    const book = await create(ctx, ctx.A, '/price-books', { name: 'Book' });
    // open-ended entry (least specific)
    await create(ctx, ctx.A, '/price-entries', { priceBookId: book.id, variationId: variation.id, priceCents: 4500 });
    // dated entry starting T0
    await create(ctx, ctx.A, '/price-entries', {
      priceBookId: book.id,
      variationId: variation.id,
      priceCents: 4000,
      effectiveFrom: T0,
    });
    // more recent dated entry starting T1 (should win at T1)
    await create(ctx, ctx.A, '/price-entries', {
      priceBookId: book.id,
      variationId: variation.id,
      priceCents: 3500,
      effectiveFrom: T1,
    });
    const r = await body(await ctx.req(ctx.A, `/variations/${variation.id}/price?at=${T1}`));
    expect(r.data.priceCents).toBe(3500);
  });
});

describe('promotion math (to the cent, via core applyDiscount)', () => {
  it('percent_bps promotion matches applyDiscount exactly', async () => {
    const ctx = await setup();
    const { product, variation } = await seedProduct(ctx, ctx.A, { priceCents: 4999 });
    await create(ctx, ctx.A, '/promotions', {
      name: '15% off tack',
      type: 'percent_bps',
      value: 1500,
      scope: { productIds: [product.id] },
    });
    const r = await body(await ctx.req(ctx.A, `/variations/${variation.id}/promoted-price`));
    expect(r.data.bestCents).toBe(applyDiscount(4999, { bps: 1500 })); // 4249
    expect(r.data.baseCents).toBe(4999);
  });

  it('fixed_cents promotion clamps at 0 and matches core', async () => {
    const ctx = await setup();
    const { variation } = await seedProduct(ctx, ctx.A, { priceCents: 500 });
    await create(ctx, ctx.A, '/promotions', { name: '$10 off', type: 'fixed_cents', value: 1000 });
    const r = await body(await ctx.req(ctx.A, `/variations/${variation.id}/promoted-price`));
    expect(r.data.bestCents).toBe(applyDiscount(500, { fixedCents: 1000 })); // 0
  });

  it('an out-of-scope promotion does not apply', async () => {
    const ctx = await setup();
    const { variation } = await seedProduct(ctx, ctx.A, { priceCents: 4999 });
    await create(ctx, ctx.A, '/promotions', {
      name: 'other dept',
      type: 'percent_bps',
      value: 5000,
      scope: { departmentIds: ['some-other-dept'] },
    });
    const r = await body(await ctx.req(ctx.A, `/variations/${variation.id}/promoted-price`));
    expect(r.data.bestCents).toBe(4999);
    expect(r.data.promotionId).toBeNull();
  });
});
