import { describe, expect, it } from 'vitest';
import { json, req, setup } from './helpers';

/**
 * Tenant-isolation denial tests (CONVENTIONS §5/§10): create data in tenant
 * A, prove tenant B sees nothing and can change nothing, and that A's data
 * survives untouched.
 */
describe('tenant isolation', () => {
  it('quotes (and their lines/approval events) are invisible and immutable cross-tenant', async () => {
    const { app, tenantA, tenantB } = await setup();
    const quote = (
      await json(
        await req(app, tenantA.id, 'POST', '/quotes', {
          customerId: 'c',
          title: 'Private quote',
          lines: [{ description: 'secret work', quantity: 1, unitPriceCents: 12345 }],
        }),
      )
    ).data.quote;

    // read denial
    expect((await req(app, tenantB.id, 'GET', `/quotes/${quote.id}`)).status).toBe(404);
    expect((await json(await req(app, tenantB.id, 'GET', '/quotes'))).data).toEqual([]);
    expect((await req(app, tenantB.id, 'GET', `/quotes/${quote.id}/document`)).status).toBe(404);

    // write denial
    expect((await req(app, tenantB.id, 'PATCH', `/quotes/${quote.id}`, { title: 'hacked' })).status).toBe(404);
    expect((await req(app, tenantB.id, 'DELETE', `/quotes/${quote.id}`)).status).toBe(404);
    expect(
      (
        await req(app, tenantB.id, 'POST', `/quotes/${quote.id}/lines`, {
          description: 'injected',
          quantity: 1,
          unitPriceCents: 1,
        })
      ).status,
    ).toBe(404);
    expect((await req(app, tenantB.id, 'POST', `/quotes/${quote.id}/send`)).status).toBe(404);
    expect(
      (await req(app, tenantB.id, 'POST', `/quotes/${quote.id}/approve`, { signerName: 'Eve' })).status,
    ).toBe(404);
    expect((await req(app, tenantB.id, 'POST', `/quotes/${quote.id}/convert`)).status).toBe(404);
    expect(
      (await req(app, tenantB.id, 'POST', `/quotes/${quote.id}/attachments`, { fileId: 'f' })).status,
    ).toBe(404);

    // A's data untouched
    const after = (await json(await req(app, tenantA.id, 'GET', `/quotes/${quote.id}`))).data;
    expect(after.quote.title).toBe('Private quote');
    expect(after.quote.status).toBe('draft');
    expect(after.lines).toHaveLength(1);
  });

  it('templates, pricing rules, discounts and taxes are tenant-scoped', async () => {
    const { app, tenantA, tenantB } = await setup();

    const template = (
      await json(
        await req(app, tenantA.id, 'POST', '/templates', {
          name: 'A template',
          lineItems: [{ description: 'x', quantity: 1, unitPriceCents: 100 }],
        }),
      )
    ).data;
    const rule = (
      await json(
        await req(app, tenantA.id, 'POST', '/pricing-rules', {
          name: 'A rule',
          scope: 'line',
          conditions: [],
          action: { type: 'fixed_adjust', amount: -1 },
        }),
      )
    ).data;
    const discount = (
      await json(await req(app, tenantA.id, 'POST', '/discounts', { name: 'A disc', bps: 100 }))
    ).data;
    const tax = (
      await json(await req(app, tenantA.id, 'POST', '/taxes', { name: 'A tax', rateBps: 100 }))
    ).data;

    // read denial: lists are empty, gets are 404
    expect((await json(await req(app, tenantB.id, 'GET', '/templates'))).data).toEqual([]);
    expect((await json(await req(app, tenantB.id, 'GET', '/pricing-rules'))).data).toEqual([]);
    expect((await json(await req(app, tenantB.id, 'GET', '/discounts'))).data).toEqual([]);
    expect((await json(await req(app, tenantB.id, 'GET', '/taxes'))).data).toEqual([]);
    expect((await req(app, tenantB.id, 'GET', `/templates/${template.id}`)).status).toBe(404);
    expect((await req(app, tenantB.id, 'GET', `/pricing-rules/${rule.id}`)).status).toBe(404);

    // write denial
    expect(
      (await req(app, tenantB.id, 'PATCH', `/templates/${template.id}`, { name: 'stolen' })).status,
    ).toBe(404);
    expect((await req(app, tenantB.id, 'DELETE', `/templates/${template.id}`)).status).toBe(404);
    expect((await req(app, tenantB.id, 'DELETE', `/pricing-rules/${rule.id}`)).status).toBe(404);
    expect((await req(app, tenantB.id, 'DELETE', `/discounts/${discount.id}`)).status).toBe(404);
    expect((await req(app, tenantB.id, 'DELETE', `/taxes/${tax.id}`)).status).toBe(404);

    // B cannot bundle A's template, apply A's discount/tax/template to B quotes
    expect(
      (
        await req(app, tenantB.id, 'POST', '/templates', {
          name: 'thief bundle',
          childTemplateIds: [template.id],
        })
      ).status,
    ).toBe(400);
    const bQuote = (
      await json(await req(app, tenantB.id, 'POST', '/quotes', { customerId: 'c', title: 'B quote' }))
    ).data.quote;
    expect(
      (
        await req(app, tenantB.id, 'POST', `/quotes/${bQuote.id}/apply-template`, {
          templateId: template.id,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await req(app, tenantB.id, 'POST', `/quotes/${bQuote.id}/apply-discount`, {
          discountId: discount.id,
        })
      ).status,
    ).toBe(404);
    expect(
      (await req(app, tenantB.id, 'POST', `/quotes/${bQuote.id}/apply-tax`, { taxId: tax.id })).status,
    ).toBe(404);

    // A untouched
    expect((await json(await req(app, tenantA.id, 'GET', '/templates'))).data).toHaveLength(1);
    expect((await json(await req(app, tenantA.id, 'GET', `/templates/${template.id}`))).data.name).toBe(
      'A template',
    );
  });

  it("tenant B's pricing rules never affect tenant A's quotes", async () => {
    const { app, tenantA, tenantB } = await setup();
    // B sets an aggressive global rule (empty conditions = matches everything)
    await req(app, tenantB.id, 'POST', '/pricing-rules', {
      name: 'B rule: everything free',
      scope: 'line',
      conditions: [],
      action: { type: 'set_price', amount: 0 },
    });

    const aQuote = (
      await json(
        await req(app, tenantA.id, 'POST', '/quotes', {
          customerId: 'c',
          title: 'A quote',
          lines: [{ description: 'x', quantity: 1, unitPriceCents: 7777 }],
        }),
      )
    ).data;
    expect(aQuote.quote.subtotal_cents).toBe(7777);
    expect(aQuote.lines[0].effective_unit_price_cents).toBe(7777);

    // while B's own quotes ARE affected
    const bQuote = (
      await json(
        await req(app, tenantB.id, 'POST', '/quotes', {
          customerId: 'c',
          title: 'B quote',
          lines: [{ description: 'x', quantity: 1, unitPriceCents: 7777 }],
        }),
      )
    ).data;
    expect(bQuote.quote.subtotal_cents).toBe(0);
  });

  it('client-supplied tenant ids in the body are ignored (header is the only source)', async () => {
    const { app, db, tenantA, tenantB } = await setup();
    const res = await req(app, tenantA.id, 'POST', '/quotes', {
      customerId: 'c',
      title: 'sneaky',
      tenant_id: tenantB.id,
      tenantId: tenantB.id,
    });
    expect(res.status).toBe(201);
    const created = (await json(res)).data.quote;
    const row = await db
      .selectFrom('quoting_quotes')
      .select(['tenant_id'])
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(row.tenant_id).toBe(tenantA.id);
  });
});
