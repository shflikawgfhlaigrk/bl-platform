import { describe, expect, it } from 'vitest';
import type { PlatformEvent } from '@blacklabel/core';
import { body, create, seedProduct, setup } from './helpers';

describe('publication transitions + events', () => {
  it('publishes an eligible product and emits catalog.publication.changed', async () => {
    const ctx = await setup();
    const pubEvents: PlatformEvent[] = [];
    ctx.events.on('catalog.publication.changed', (e) => {
      pubEvents.push(e);
    });
    const { product } = await seedProduct(ctx, ctx.A, { priceCents: 4999 });

    const res = await ctx.json(ctx.A, 'POST', `/products/${product.id}/publication`, { state: 'published' });
    expect(res.status).toBe(200);
    expect((await body(res)).data.publication_state).toBe('published');

    expect(pubEvents).toHaveLength(1);
    expect(pubEvents[0].payload).toEqual({ v: 1, itemIds: [product.id] });
  });

  it('refuses to publish without a department or price', async () => {
    const ctx = await setup();
    // product with a department but NO priced variation
    const dept = await create(ctx, ctx.A, '/departments', { name: 'Tack', slug: 'tack' });
    const product = await create(ctx, ctx.A, '/products', {
      sourceItemId: 'noPrice',
      name: 'Unpriced Thing',
      departmentId: dept.id,
    });
    await create(ctx, ctx.A, '/variations', {
      productId: product.id,
      sourceVariationId: 'vNoPrice',
      name: 'Regular',
      priceCents: null,
    });
    const res = await ctx.json(ctx.A, 'POST', `/products/${product.id}/publication`, { state: 'published' });
    expect(res.status).toBe(400);
    expect((await body(res)).error.details.reasons).toContain('no_price');

    // allowUnpriced overrides the price requirement
    const ok = await ctx.json(ctx.A, 'POST', `/products/${product.id}/publication`, {
      state: 'published',
      allowUnpriced: true,
    });
    expect(ok.status).toBe(200);
  });

  it('auto-excludes a DNU product on create and refuses to publish it', async () => {
    const ctx = await setup();
    const dept = await create(ctx, ctx.A, '/departments', { name: 'Tack', slug: 'tack' });
    const product = await create(ctx, ctx.A, '/products', {
      sourceItemId: 'dnu1',
      name: 'DNU old strap',
      departmentId: dept.id,
      sourceCategoryName: 'Belts',
    });
    expect(product.publication_state).toBe('excluded');
    expect(product.exclusion_reason).toBe('dnu');

    await create(ctx, ctx.A, '/variations', {
      productId: product.id,
      sourceVariationId: 'vdnu',
      name: 'Regular',
      priceCents: 500,
    });
    const res = await ctx.json(ctx.A, 'POST', `/products/${product.id}/publication`, { state: 'published' });
    expect(res.status).toBe(400);
    expect((await body(res)).error.details.reasons).toContain('excluded:dnu');
  });

  it('createVariation emits catalog.variation.changed with v:1', async () => {
    const ctx = await setup();
    const changed: PlatformEvent[] = [];
    ctx.events.on('catalog.variation.changed', (e) => {
      changed.push(e);
    });
    const { variation } = await seedProduct(ctx, ctx.A);
    expect(changed.some((e) => (e.payload as any).variationId === variation.id && (e.payload as any).v === 1)).toBe(
      true,
    );
  });
});
