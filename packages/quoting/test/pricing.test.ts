import { describe, expect, it } from 'vitest';
import { computeTotals } from '@blacklabel/core';
import {
  addQuoteLine,
  createPricingRule,
  createQuote,
  updateQuote,
} from '../src/service';
import { ctxFor, setup } from './helpers';

describe('quote pricing math (delegates to core computeTotals)', () => {
  it('applies line discounts -> quote discount -> tax, to the cent', async () => {
    const world = await setup();
    const ctx = ctxFor(world, world.tenantA.id);
    const { quote } = await createQuote(ctx, {
      customerId: 'cust-1',
      title: 'Test quote',
      discountBps: 500,
      discountFixedCents: 100,
      taxBps: 800,
      lines: [
        { description: 'A', quantity: 2, unitPriceCents: 1000, unitCostCents: 300, discountBps: 1000 },
        { description: 'B', quantity: 3, unitPriceCents: 333, unitCostCents: 100 },
      ],
    });

    // cross-check against core's canonical math
    const expected = computeTotals(
      [
        { quantity: 2, unitPriceCents: 1000, discount: { bps: 1000 } },
        { quantity: 3, unitPriceCents: 333 },
      ],
      { discount: { bps: 500, fixedCents: 100 }, taxBps: 800 },
    );

    expect(quote.subtotal_cents).toBe(2799); // (2000-200) + 999
    expect(quote.discount_cents).toBe(240); // 140 (5%) + 100 fixed
    expect(quote.tax_cents).toBe(205); // round(2559 * 0.08)
    expect(quote.total_cents).toBe(2764);
    expect(quote.subtotal_cents).toBe(expected.subtotalCents);
    expect(quote.discount_cents).toBe(expected.discountCents);
    expect(quote.tax_cents).toBe(expected.taxCents);
    expect(quote.total_cents).toBe(expected.totalCents);
  });

  it('handles edge cases: fractional quantities, 100% discount, over-discount clamps to 0, zero quantity', async () => {
    const world = await setup();
    const ctx = ctxFor(world, world.tenantA.id);

    // fractional quantity rounds at the line
    const fractional = await createQuote(ctx, {
      customerId: 'c',
      title: 'fractional',
      lines: [{ description: 'hours', quantity: 2.5, unitPriceCents: 999 }],
    });
    expect(fractional.quote.subtotal_cents).toBe(2498); // round(2497.5)

    // 100% line discount
    const free = await createQuote(ctx, {
      customerId: 'c',
      title: 'free',
      lines: [{ description: 'freebie', quantity: 1, unitPriceCents: 5000, discountBps: 10000 }],
    });
    expect(free.quote.subtotal_cents).toBe(0);
    expect(free.quote.total_cents).toBe(0);

    // fixed discount bigger than subtotal clamps at 0 (never negative)
    const clamped = await createQuote(ctx, {
      customerId: 'c',
      title: 'clamped',
      discountFixedCents: 99999,
      taxBps: 1000,
      lines: [{ description: 'small', quantity: 1, unitPriceCents: 500 }],
    });
    expect(clamped.quote.discount_cents).toBe(500);
    expect(clamped.quote.tax_cents).toBe(0);
    expect(clamped.quote.total_cents).toBe(0);

    // zero-quantity line contributes nothing
    const zero = await createQuote(ctx, {
      customerId: 'c',
      title: 'zero',
      lines: [{ description: 'none', quantity: 0, unitPriceCents: 12345 }],
    });
    expect(zero.quote.subtotal_cents).toBe(0);
  });

  it('computes internal cost, profit margin cents and margin bps (incl. negative margin)', async () => {
    const world = await setup();
    const ctx = ctxFor(world, world.tenantA.id);
    const { quote } = await createQuote(ctx, {
      customerId: 'c',
      title: 'margin',
      discountBps: 500,
      discountFixedCents: 100,
      taxBps: 800,
      lines: [
        { description: 'A', quantity: 2, unitPriceCents: 1000, unitCostCents: 300, discountBps: 1000 },
        { description: 'B', quantity: 3, unitPriceCents: 333, unitCostCents: 100 },
      ],
    });
    // cost: 2*300 + 3*100 = 900; revenue (pre-tax): 2799 - 240 = 2559
    expect(quote.total_cost_cents).toBe(900);
    expect(quote.margin_cents).toBe(1659);
    expect(quote.margin_bps).toBe(Math.round((1659 * 10000) / 2559)); // 6483

    // negative margin: cost above price
    const losing = await createQuote(ctx, {
      customerId: 'c',
      title: 'loss leader',
      lines: [{ description: 'below cost', quantity: 1, unitPriceCents: 100, unitCostCents: 200 }],
    });
    expect(losing.quote.margin_cents).toBe(-100);
    expect(losing.quote.margin_bps).toBe(-10000);

    // zero revenue -> margin_bps 0 (no division blowup)
    const empty = await createQuote(ctx, { customerId: 'c', title: 'empty' });
    expect(empty.quote.margin_bps).toBe(0);
  });

  it('line-scope pricing rules adjust the effective unit price in priority order', async () => {
    const world = await setup();
    const ctx = ctxFor(world, world.tenantA.id);
    await createPricingRule(ctx, {
      name: '10% off bulk',
      scope: 'line',
      conditions: [{ field: 'quantity', op: 'gte', value: 10 }],
      action: { type: 'percent_adjust', amount: -1000 },
      priority: 1,
    });
    await createPricingRule(ctx, {
      name: 'then 50c off',
      scope: 'line',
      conditions: [{ field: 'quantity', op: 'gte', value: 10 }],
      action: { type: 'fixed_adjust', amount: -50 },
      priority: 2,
    });

    const { quote, lines } = await createQuote(ctx, {
      customerId: 'c',
      title: 'ruled',
      lines: [
        { description: 'bulk item', quantity: 10, unitPriceCents: 1000 },
        { description: 'single item', quantity: 1, unitPriceCents: 1000 },
      ],
    });
    // bulk: 1000 -> 900 (priority 1) -> 850 (priority 2); single untouched
    expect(lines[0]!.effective_unit_price_cents).toBe(850);
    expect(lines[0]!.total_cents).toBe(8500);
    expect(lines[1]!.effective_unit_price_cents).toBe(1000);
    expect(quote.subtotal_cents).toBe(9500);
  });

  it('quote-scope rules grant conditional discounts only when the condition holds', async () => {
    const world = await setup();
    const ctx = ctxFor(world, world.tenantA.id);
    await createPricingRule(ctx, {
      name: '5% over $500',
      scope: 'quote',
      conditions: [{ field: 'subtotal_cents', op: 'gte', value: 50000 }],
      action: { type: 'percent_discount', amount: 500 },
    });

    const below = await createQuote(ctx, {
      customerId: 'c',
      title: 'below threshold',
      lines: [{ description: 'x', quantity: 1, unitPriceCents: 49999 }],
    });
    expect(below.quote.discount_cents).toBe(0);
    expect(below.quote.total_cents).toBe(49999);

    const above = await addQuoteLine(ctx, below.quote.id, {
      description: 'y',
      quantity: 1,
      unitPriceCents: 10001,
    });
    // subtotal 60000 -> 5% rule discount = 3000
    expect(above.quote.subtotal_cents).toBe(60000);
    expect(above.quote.discount_cents).toBe(3000);
    expect(above.quote.total_cents).toBe(57000);
  });

  it('quote-scope rule discounts stack with the quote-level discount (percent first, then fixed)', async () => {
    const world = await setup();
    const ctx = ctxFor(world, world.tenantA.id);
    await createPricingRule(ctx, {
      name: 'flat $10 off big quotes',
      scope: 'quote',
      conditions: [{ field: 'subtotal_cents', op: 'gte', value: 10000 }],
      action: { type: 'fixed_discount', amount: 1000 },
    });
    const created = await createQuote(ctx, {
      customerId: 'c',
      title: 'stacked',
      lines: [{ description: 'x', quantity: 1, unitPriceCents: 20000 }],
    });
    const { quote } = await updateQuote(ctx, created.quote.id, { discountBps: 1000 });
    // 20000 - 2000 (10%) - 1000 (rule) = 17000
    expect(quote.discount_cents).toBe(3000);
    expect(quote.total_cents).toBe(17000);
  });
});
