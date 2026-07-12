import { describe, expect, it } from 'vitest';
import { seedQuoting } from '@blacklabel/quoting';
import { json, req, setup } from './helpers';

describe('seedQuoting (window cleaning + spa example data)', () => {
  it('seeds templates, bundles, pricing rules, a discount and a tax for one tenant only', async () => {
    const { app, db, events, tenantA, tenantB } = await setup();
    const seeded = await seedQuoting(db, tenantA.id, { events });

    const templates = (await json(await req(app, tenantA.id, 'GET', '/templates'))).data;
    expect(templates.map((t: any) => t.name).sort()).toEqual([
      'Classic Facial Treatment',
      'Deluxe Spa Day Package',
      'Full-Service Window Package',
      'Interior Window Add-On',
      'Signature Massage Session',
      'Standard Exterior Window Cleaning',
    ]);
    expect((await json(await req(app, tenantA.id, 'GET', '/pricing-rules'))).data).toHaveLength(2);
    expect((await json(await req(app, tenantA.id, 'GET', '/discounts'))).data).toHaveLength(1);
    expect((await json(await req(app, tenantA.id, 'GET', '/taxes'))).data).toHaveLength(1);

    // strictly tenant-scoped: tenant B sees none of it
    expect((await json(await req(app, tenantB.id, 'GET', '/templates'))).data).toEqual([]);
    expect((await json(await req(app, tenantB.id, 'GET', '/pricing-rules'))).data).toEqual([]);
    expect(seeded.templates.windowFullPackage).toBeTruthy();
  });

  it('quoting from the window-cleaning bundle expands both child templates and prices correctly', async () => {
    const { app, db, events, tenantA } = await setup();
    const seeded = await seedQuoting(db, tenantA.id, { events });

    const created = (
      await json(
        await req(app, tenantA.id, 'POST', '/quotes', {
          customerId: 'cust-wc',
          title: 'Whole-house window cleaning',
          templateId: seeded.templates.windowFullPackage,
        }),
      )
    ).data;

    // bundle = exterior (3 lines) + interior (2 lines)
    expect(created.lines).toHaveLength(5);
    // 20*650 + 20*200 + 4500 + 20*450 + 20*100 = 32500
    expect(created.quote.subtotal_cents).toBe(32500);
    // below the $500 volume-rule threshold, no quantity >= 40 -> no rule discounts
    expect(created.quote.discount_cents).toBe(0);
    expect(created.quote.total_cents).toBe(32500);
    // margin: cost = 20*200+20*50+1500+20*150+20*25 = 10000
    expect(created.quote.total_cost_cents).toBe(10000);
    expect(created.quote.margin_cents).toBe(22500);
    expect(created.quote.margin_bps).toBe(Math.round((22500 * 10000) / 32500));
  });

  it('seeded pricing rules fire on qualifying quotes (spa day for a large group)', async () => {
    const { app, db, events, tenantA } = await setup();
    const seeded = await seedQuoting(db, tenantA.id, { events });

    // spa day package (own line + massage + facial), plus a high-quantity line
    const created = (
      await json(
        await req(app, tenantA.id, 'POST', '/quotes', {
          customerId: 'cust-spa',
          title: 'Corporate spa day',
          templateId: seeded.templates.spaDayPackage,
          lines: [{ description: 'Robe rental', quantity: 40, unitPriceCents: 500, unitCostCents: 100 }],
        }),
      )
    ).data;

    // robe line: 40 units triggers the 10%-off line rule -> 500 -> 450
    const robe = created.lines.find((l: any) => l.description === 'Robe rental');
    expect(robe.effective_unit_price_cents).toBe(450);
    expect(robe.total_cents).toBe(18000);

    // subtotal: 18000 (robes) + 2500 (lounge) + 9500 + 1500 (massage) + 8000 (facial) = 39500
    expect(created.quote.subtotal_cents).toBe(39500);
    // under $500 -> volume rule does not fire
    expect(created.quote.discount_cents).toBe(0);

    // add more robes to cross the $500 quote-rule threshold
    const bigger = (
      await json(
        await req(app, tenantA.id, 'POST', `/quotes/${created.quote.id}/lines`, {
          description: 'Premium suite upgrade',
          quantity: 1,
          unitPriceCents: 15000,
        }),
      )
    ).data;
    // subtotal 54500 >= 50000 -> 5% volume discount = 2725
    expect(bigger.quote.subtotal_cents).toBe(54500);
    expect(bigger.quote.discount_cents).toBe(2725);
    expect(bigger.quote.total_cents).toBe(51775);
  });
});
