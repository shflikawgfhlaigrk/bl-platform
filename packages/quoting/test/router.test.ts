import { describe, expect, it } from 'vitest';
import type { PlatformEvent } from '@blacklabel/core';
import { json, req, setup } from './helpers';

describe('quoting router', () => {
  it('creates, reads, lists (filtered), updates and deletes quotes over HTTP', async () => {
    const { app, tenantA } = await setup();

    const createRes = await req(app, tenantA.id, 'POST', '/quotes', {
      customerId: 'cust-1',
      title: 'Router quote',
      taxBps: 700,
      lines: [{ description: 'Widget', quantity: 3, unitPriceCents: 250, unitCostCents: 100 }],
    });
    expect(createRes.status).toBe(201);
    const created = (await json(createRes)).data;
    expect(created.quote.status).toBe('draft');
    expect(created.quote.subtotal_cents).toBe(750);
    expect(created.quote.tax_cents).toBe(53); // round(750 * 0.07)
    expect(created.quote.total_cents).toBe(803);
    expect(created.lines).toHaveLength(1);

    const getRes = await req(app, tenantA.id, 'GET', `/quotes/${created.quote.id}`);
    expect(getRes.status).toBe(200);
    expect((await json(getRes)).data.quote.id).toBe(created.quote.id);

    // second quote for another customer, then filter
    await req(app, tenantA.id, 'POST', '/quotes', { customerId: 'cust-2', title: 'Other' });
    const listRes = await req(app, tenantA.id, 'GET', '/quotes?customer_id=cust-1&limit=10');
    const listBody = await json(listRes);
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0].customer_id).toBe('cust-1');
    expect(listBody.limit).toBe(10);

    const patchRes = await req(app, tenantA.id, 'PATCH', `/quotes/${created.quote.id}`, {
      title: 'Renamed',
      discountFixedCents: 50,
    });
    expect(patchRes.status).toBe(200);
    const patched = (await json(patchRes)).data;
    expect(patched.quote.title).toBe('Renamed');
    expect(patched.quote.discount_cents).toBe(50);

    const delRes = await req(app, tenantA.id, 'DELETE', `/quotes/${created.quote.id}`);
    expect(delRes.status).toBe(200);
    expect((await req(app, tenantA.id, 'GET', `/quotes/${created.quote.id}`)).status).toBe(404);
  });

  it('manages line items over HTTP and recomputes totals each time', async () => {
    const { app, tenantA } = await setup();
    const quote = (
      await json(await req(app, tenantA.id, 'POST', '/quotes', { customerId: 'c', title: 'Lines' }))
    ).data.quote;

    const addRes = await req(app, tenantA.id, 'POST', `/quotes/${quote.id}/lines`, {
      description: 'Item',
      quantity: 4,
      unitPriceCents: 500,
    });
    expect(addRes.status).toBe(201);
    const withLine = (await json(addRes)).data;
    expect(withLine.quote.subtotal_cents).toBe(2000);
    const lineId = withLine.lines[0].id;

    const patchRes = await req(app, tenantA.id, 'PATCH', `/quotes/${quote.id}/lines/${lineId}`, {
      quantity: 2,
      discountBps: 5000,
    });
    const patched = (await json(patchRes)).data;
    expect(patched.quote.subtotal_cents).toBe(500); // 1000 - 50%

    const delRes = await req(app, tenantA.id, 'DELETE', `/quotes/${quote.id}/lines/${lineId}`);
    expect((await json(delRes)).data.quote.subtotal_cents).toBe(0);

    expect(
      (await req(app, tenantA.id, 'DELETE', `/quotes/${quote.id}/lines/ghost`)).status,
    ).toBe(404);
  });

  it('rejects invalid bodies with 400 (zod validation)', async () => {
    const { app, tenantA } = await setup();
    // missing title
    expect((await req(app, tenantA.id, 'POST', '/quotes', { customerId: 'c' })).status).toBe(400);
    // negative price
    expect(
      (
        await req(app, tenantA.id, 'POST', '/quotes', {
          customerId: 'c',
          title: 'x',
          lines: [{ description: 'bad', quantity: 1, unitPriceCents: -5 }],
        })
      ).status,
    ).toBe(400);
    // bps out of range
    expect(
      (
        await req(app, tenantA.id, 'POST', '/quotes', { customerId: 'c', title: 'x', discountBps: 10001 })
      ).status,
    ).toBe(400);
    // bad rule: quote scope with a line action type
    expect(
      (
        await req(app, tenantA.id, 'POST', '/pricing-rules', {
          name: 'bad',
          scope: 'quote',
          conditions: [],
          action: { type: 'set_price', amount: 1 },
        })
      ).status,
    ).toBe(400);
  });

  it('does template CRUD, bundle expansion (template of templates) and apply-template', async () => {
    const { app, tenantA } = await setup();

    const child1 = (
      await json(
        await req(app, tenantA.id, 'POST', '/templates', {
          name: 'Base service',
          lineItems: [{ description: 'Base visit', quantity: 1, unitPriceCents: 10000, unitCostCents: 4000 }],
        }),
      )
    ).data;
    const child2 = (
      await json(
        await req(app, tenantA.id, 'POST', '/templates', {
          name: 'Add-on',
          lineItems: [{ description: 'Add-on unit', quantity: 2, unitPriceCents: 1500 }],
        }),
      )
    ).data;
    const bundleRes = await req(app, tenantA.id, 'POST', '/templates', {
      name: 'Bundle',
      lineItems: [{ description: 'Bundle coordination fee', quantity: 1, unitPriceCents: 500 }],
      childTemplateIds: [child1.id, child2.id],
    });
    expect(bundleRes.status).toBe(201);
    const bundle = (await json(bundleRes)).data;

    // creating a bundle referencing a missing child fails
    expect(
      (
        await req(app, tenantA.id, 'POST', '/templates', { name: 'broken', childTemplateIds: ['ghost'] })
      ).status,
    ).toBe(400);

    // list + get
    const list = (await json(await req(app, tenantA.id, 'GET', '/templates'))).data;
    expect(list).toHaveLength(3);
    expect((await req(app, tenantA.id, 'GET', `/templates/${bundle.id}`)).status).toBe(200);

    // quote created straight from the bundle template
    const quoteRes = await req(app, tenantA.id, 'POST', '/quotes', {
      customerId: 'c',
      title: 'From bundle',
      templateId: bundle.id,
    });
    const created = (await json(quoteRes)).data;
    expect(created.lines).toHaveLength(3); // own line + child1 + child2
    expect(created.quote.subtotal_cents).toBe(500 + 10000 + 3000);
    // provenance: each line remembers which template declared it
    expect(created.lines.map((l: any) => l.service_template_id)).toEqual([
      bundle.id,
      child1.id,
      child2.id,
    ]);

    // apply-template onto an existing quote appends lines
    const applied = (
      await json(
        await req(app, tenantA.id, 'POST', `/quotes/${created.quote.id}/apply-template`, {
          templateId: child2.id,
        }),
      )
    ).data;
    expect(applied.lines).toHaveLength(4);
    expect(applied.quote.subtotal_cents).toBe(13500 + 3000);

    // cyclic bundles expand each template at most once (no infinite loop)
    await req(app, tenantA.id, 'PATCH', `/templates/${child1.id}`, {
      childTemplateIds: [bundle.id],
    });
    const cyclic = (
      await json(
        await req(app, tenantA.id, 'POST', '/quotes', {
          customerId: 'c',
          title: 'cyclic',
          templateId: bundle.id,
        }),
      )
    ).data;
    expect(cyclic.lines).toHaveLength(3);

    // delete
    expect((await req(app, tenantA.id, 'DELETE', `/templates/${child2.id}`)).status).toBe(200);
    expect((await req(app, tenantA.id, 'GET', `/templates/${child2.id}`)).status).toBe(404);
  });

  it('manages named discounts and taxes and applies them to quotes as snapshots', async () => {
    const { app, tenantA } = await setup();
    const discount = (
      await json(
        await req(app, tenantA.id, 'POST', '/discounts', { name: 'Loyal 10%', bps: 1000 }),
      )
    ).data;
    const tax = (
      await json(await req(app, tenantA.id, 'POST', '/taxes', { name: 'VAT', rateBps: 2000 }))
    ).data;
    // discount without any amount is rejected
    expect((await req(app, tenantA.id, 'POST', '/discounts', { name: 'empty' })).status).toBe(400);

    const quote = (
      await json(
        await req(app, tenantA.id, 'POST', '/quotes', {
          customerId: 'c',
          title: 'discount+tax',
          lines: [{ description: 'x', quantity: 1, unitPriceCents: 10000 }],
        }),
      )
    ).data.quote;

    const withDiscount = (
      await json(
        await req(app, tenantA.id, 'POST', `/quotes/${quote.id}/apply-discount`, {
          discountId: discount.id,
        }),
      )
    ).data;
    expect(withDiscount.quote.discount_id).toBe(discount.id);
    expect(withDiscount.quote.discount_cents).toBe(1000);

    const withTax = (
      await json(
        await req(app, tenantA.id, 'POST', `/quotes/${quote.id}/apply-tax`, { taxId: tax.id }),
      )
    ).data;
    expect(withTax.quote.tax_id).toBe(tax.id);
    expect(withTax.quote.tax_bps).toBe(2000);
    expect(withTax.quote.tax_cents).toBe(1800); // (10000-1000) * 20%
    expect(withTax.quote.total_cents).toBe(10800);

    const lists = await Promise.all([
      req(app, tenantA.id, 'GET', '/discounts'),
      req(app, tenantA.id, 'GET', '/taxes'),
    ]);
    expect((await json(lists[0]!)).data).toHaveLength(1);
    expect((await json(lists[1]!)).data).toHaveLength(1);
  });

  it('tracks photo/file attachment references by id string', async () => {
    const { app, tenantA } = await setup();
    const quote = (
      await json(await req(app, tenantA.id, 'POST', '/quotes', { customerId: 'c', title: 'photos' }))
    ).data.quote;

    const add1 = await req(app, tenantA.id, 'POST', `/quotes/${quote.id}/attachments`, {
      fileId: 'file-abc',
    });
    expect(add1.status).toBe(201);
    await req(app, tenantA.id, 'POST', `/quotes/${quote.id}/attachments`, { fileId: 'file-def' });
    // duplicates are ignored
    const add3 = await req(app, tenantA.id, 'POST', `/quotes/${quote.id}/attachments`, {
      fileId: 'file-abc',
    });
    expect(JSON.parse((await json(add3)).data.attachments)).toEqual(['file-abc', 'file-def']);

    const removed = await req(
      app,
      tenantA.id,
      'DELETE',
      `/quotes/${quote.id}/attachments/file-abc`,
    );
    expect(JSON.parse((await json(removed)).data.attachments)).toEqual(['file-def']);
  });

  it('renders a print-ready HTML document via the stub PDF provider', async () => {
    const { app, tenantA } = await setup();
    const quote = (
      await json(
        await req(app, tenantA.id, 'POST', '/quotes', {
          customerId: 'cust-9',
          title: 'Document quote',
          taxBps: 800,
          lines: [{ description: 'Deluxe <Service> & more', quantity: 2, unitPriceCents: 12550 }],
        }),
      )
    ).data.quote;

    const res = await req(app, tenantA.id, 'GET', `/quotes/${quote.id}/document`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Tenant A'); // tenant name in header
    expect(html).toContain('Deluxe &lt;Service&gt; &amp; more'); // escaped
    expect(html).toContain('$251.00'); // line total
    expect(html).toContain('$271.08'); // grand total incl. 8% tax
  });

  it('approves over HTTP then converts to a job, emitting quote.converted with the invoice id', async () => {
    const invoiceCalls: any[] = [];
    const { app, tenantA, events } = await setup({
      createInvoice: {
        async createInvoice(input) {
          invoiceCalls.push(input);
          return { id: 'inv-42' };
        },
      },
    });
    const converted: PlatformEvent[] = [];
    events.on('quoting.quote.converted', (e) => {
      converted.push(e);
    });

    const quote = (
      await json(
        await req(app, tenantA.id, 'POST', '/quotes', {
          customerId: 'cust-3',
          title: 'Convert me',
          discountFixedCents: 500,
          taxBps: 1000,
          lines: [{ description: 'Job work', quantity: 2, unitPriceCents: 10000, unitCostCents: 4000 }],
        }),
      )
    ).data.quote;

    // convert before approval is refused
    expect((await req(app, tenantA.id, 'POST', `/quotes/${quote.id}/convert`)).status).toBe(409);

    await req(app, tenantA.id, 'POST', `/quotes/${quote.id}/send`);
    await req(app, tenantA.id, 'POST', `/quotes/${quote.id}/view`, { signerIp: '9.9.9.9' });
    const approveRes = await req(app, tenantA.id, 'POST', `/quotes/${quote.id}/approve`, {
      signerName: 'Cathy Customer',
      signerIp: '9.9.9.9',
    });
    expect(approveRes.status).toBe(200);

    const convertRes = await req(app, tenantA.id, 'POST', `/quotes/${quote.id}/convert`);
    expect(convertRes.status).toBe(200);
    const result = (await json(convertRes)).data;

    // job payload is the API contract for downstream job creation
    expect(result.invoiceId).toBe('inv-42');
    expect(result.job).toMatchObject({
      customerId: 'cust-3',
      title: 'Convert me',
      sourceEntityType: 'quoting.quote',
      sourceEntityId: quote.id,
      discountFixedCents: 500,
      taxBps: 1000,
      subtotalCents: 20000,
      totalCents: 21450, // (20000-500) * 1.10
    });
    expect(result.job.lines).toEqual([
      { description: 'Job work', quantity: 2, unitPriceCents: 10000 },
    ]);

    // billing contract received the same tenant + source linkage
    expect(invoiceCalls).toHaveLength(1);
    expect(invoiceCalls[0]).toMatchObject({
      tenantId: tenantA.id,
      customerId: 'cust-3',
      sourceEntityId: quote.id,
    });

    // event
    expect(converted).toHaveLength(1);
    expect(converted[0]!.payload).toEqual({ quoteId: quote.id, invoiceId: 'inv-42' });

    // quote is marked converted; double conversion is refused
    const after = (await json(await req(app, tenantA.id, 'GET', `/quotes/${quote.id}`))).data.quote;
    expect(after.invoice_id).toBe('inv-42');
    expect(after.converted_at).toBeTruthy();
    expect((await req(app, tenantA.id, 'POST', `/quotes/${quote.id}/convert`)).status).toBe(409);
  });

  it('converts gracefully when the createInvoice contract is absent (invoiceId null)', async () => {
    const { app, tenantA, events } = await setup(); // no contracts wired
    const converted: PlatformEvent[] = [];
    events.on('quoting.quote.converted', (e) => {
      converted.push(e);
    });

    const quote = (
      await json(
        await req(app, tenantA.id, 'POST', '/quotes', {
          customerId: 'c',
          title: 'No billing',
          lines: [{ description: 'x', quantity: 1, unitPriceCents: 100 }],
        }),
      )
    ).data.quote;
    await req(app, tenantA.id, 'POST', `/quotes/${quote.id}/send`);
    await req(app, tenantA.id, 'POST', `/quotes/${quote.id}/approve`, { signerName: 'S' });

    const res = await req(app, tenantA.id, 'POST', `/quotes/${quote.id}/convert`);
    expect(res.status).toBe(200);
    const result = (await json(res)).data;
    expect(result.invoiceId).toBeNull();
    expect(result.job.sourceEntityId).toBe(quote.id);
    expect(converted[0]!.payload).toEqual({ quoteId: quote.id, invoiceId: null });
  });

  it('manages pricing rules over HTTP', async () => {
    const { app, tenantA } = await setup();
    const rule = (
      await json(
        await req(app, tenantA.id, 'POST', '/pricing-rules', {
          name: 'bulk',
          scope: 'line',
          conditions: [{ field: 'quantity', op: 'gte', value: 10 }],
          action: { type: 'percent_adjust', amount: -500 },
          priority: 3,
        }),
      )
    ).data;
    expect(rule.active).toBe(1);

    const list = (await json(await req(app, tenantA.id, 'GET', '/pricing-rules'))).data;
    expect(list).toHaveLength(1);

    const patched = (
      await json(
        await req(app, tenantA.id, 'PATCH', `/pricing-rules/${rule.id}`, { active: false }),
      )
    ).data;
    expect(patched.active).toBe(0);

    // scope/action mismatch on PATCH is rejected
    expect(
      (
        await req(app, tenantA.id, 'PATCH', `/pricing-rules/${rule.id}`, {
          action: { type: 'percent_discount', amount: 100 },
        })
      ).status,
    ).toBe(400);

    expect((await req(app, tenantA.id, 'DELETE', `/pricing-rules/${rule.id}`)).status).toBe(200);
    expect((await req(app, tenantA.id, 'GET', `/pricing-rules/${rule.id}`)).status).toBe(404);
  });

  it('rejects non-object JSON bodies on pricing-rule PATCH with 400, never 500', async () => {
    const { app, tenantA } = await setup();
    const rule = (
      await json(
        await req(app, tenantA.id, 'POST', '/pricing-rules', {
          name: 'r',
          scope: 'line',
          conditions: [],
          action: { type: 'fixed_adjust', amount: -1 },
        }),
      )
    ).data;
    // JSON `null` body used to crash (TypeError on raw.scope) -> 500
    expect((await req(app, tenantA.id, 'PATCH', `/pricing-rules/${rule.id}`, null)).status).toBe(400);
    expect(
      (await req(app, tenantA.id, 'PATCH', `/pricing-rules/${rule.id}`, 'a string')).status,
    ).toBe(400);
    expect((await req(app, tenantA.id, 'PATCH', `/pricing-rules/${rule.id}`, [1, 2])).status).toBe(400);
    // rule untouched
    const after = (await json(await req(app, tenantA.id, 'GET', `/pricing-rules/${rule.id}`))).data;
    expect(after.name).toBe('r');
    expect(after.active).toBe(1);
  });

  it('requires the x-tenant-id header', async () => {
    const { app } = await setup();
    const res = await app.request('/quotes');
    expect(res.status).toBe(400);
  });
});
