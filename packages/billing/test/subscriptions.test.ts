import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { advanceInterval } from '../src/service';
import { api, json, setupBilling } from './helpers';

async function makeSubscription(
  ctx: Awaited<ReturnType<typeof setupBilling>>,
  tenantId: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await api(ctx.app, tenantId, 'POST', '/subscriptions', {
    customerId: 'sub-cust',
    planName: 'Care Plan',
    amountCents: 7_500,
    interval: 'monthly',
    nextInvoiceAt: DateTime.utc().minus({ minutes: 1 }).toISO()!,
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`subscription create failed: ${await res.text()}`);
  return (await json(res)).data;
}

describe('subscriptions', () => {
  it('creates an active subscription and emits billing.subscription.created', async () => {
    const ctx = await setupBilling();
    const created: any[] = [];
    ctx.events.on('billing.subscription.created', (e) => {
      created.push(e);
    });
    const sub = await makeSubscription(ctx, ctx.tenantA.id, { taxBps: 800 });
    expect(sub.status).toBe('active');
    expect(sub.interval).toBe('monthly');
    expect(created).toHaveLength(1);
    expect(created[0].payload).toEqual({ subscriptionId: sub.id, customerId: 'sub-cust' });

    const fetched = await json(await api(ctx.app, ctx.tenantA.id, 'GET', `/subscriptions/${sub.id}`));
    expect(fetched.data.plan_name).toBe('Care Plan');
  });

  it('generateDueInvoices tick creates one invoice per due subscription and advances the schedule', async () => {
    const ctx = await setupBilling();
    const generatedEvents: any[] = [];
    ctx.events.on('billing.invoice.generated', (e) => {
      generatedEvents.push(e);
    });

    const sub = await makeSubscription(ctx, ctx.tenantA.id, { taxBps: 1000 });
    const before = sub.next_invoice_at as string;

    const tick = await json(await api(ctx.app, ctx.tenantA.id, 'POST', '/subscriptions/tick'));
    expect(tick.data.count).toBe(1);
    const ref = tick.data.generated[0];
    expect(ref.subscriptionId).toBe(sub.id);
    expect(ref.nextInvoiceAt).toBe(advanceInterval(before, 'monthly'));

    // The generated invoice: draft, one plan line, plan amount + tax, provenance.
    const invoice = await json(await api(ctx.app, ctx.tenantA.id, 'GET', `/invoices/${ref.invoiceId}`));
    expect(invoice.data.status).toBe('draft');
    expect(invoice.data.customer_id).toBe('sub-cust');
    expect(invoice.data.source_entity_type).toBe('billing.subscription');
    expect(invoice.data.source_entity_id).toBe(sub.id);
    expect(invoice.data.lines).toHaveLength(1);
    expect(invoice.data.lines[0].description).toBe('Care Plan (monthly)');
    expect(invoice.data.subtotal_cents).toBe(7_500);
    expect(invoice.data.tax_cents).toBe(750);
    expect(invoice.data.total_cents).toBe(8_250);

    expect(generatedEvents).toHaveLength(1);
    expect(generatedEvents[0].payload).toMatchObject({
      invoiceId: ref.invoiceId,
      subscriptionId: sub.id,
      totalCents: 8_250,
    });

    // Schedule advanced -> an immediate second tick generates nothing.
    const updated = await json(await api(ctx.app, ctx.tenantA.id, 'GET', `/subscriptions/${sub.id}`));
    expect(updated.data.next_invoice_at).toBe(ref.nextInvoiceAt);
    const second = await json(await api(ctx.app, ctx.tenantA.id, 'POST', '/subscriptions/tick'));
    expect(second.data.count).toBe(0);
  });

  it('the tick skips paused/canceled and not-yet-due subscriptions', async () => {
    const ctx = await setupBilling();
    const paused = await makeSubscription(ctx, ctx.tenantA.id);
    await api(ctx.app, ctx.tenantA.id, 'PUT', `/subscriptions/${paused.id}`, { status: 'paused' });
    await makeSubscription(ctx, ctx.tenantA.id, {
      nextInvoiceAt: DateTime.utc().plus({ months: 1 }).toISO()!,
    });
    const canceled = await makeSubscription(ctx, ctx.tenantA.id);
    await api(ctx.app, ctx.tenantA.id, 'PUT', `/subscriptions/${canceled.id}`, { status: 'canceled' });

    const tick = await json(await api(ctx.app, ctx.tenantA.id, 'POST', '/subscriptions/tick'));
    expect(tick.data.count).toBe(0);
    const invoices = await json(await api(ctx.app, ctx.tenantA.id, 'GET', '/invoices'));
    expect(invoices.data).toEqual([]);
  });

  it("tenant B cannot see or tick tenant A's subscriptions", async () => {
    const ctx = await setupBilling();
    const sub = await makeSubscription(ctx, ctx.tenantA.id);

    expect((await api(ctx.app, ctx.tenantB.id, 'GET', `/subscriptions/${sub.id}`)).status).toBe(404);
    expect(
      (await api(ctx.app, ctx.tenantB.id, 'PUT', `/subscriptions/${sub.id}`, { status: 'paused' }))
        .status,
    ).toBe(404);
    const bList = await json(await api(ctx.app, ctx.tenantB.id, 'GET', '/subscriptions'));
    expect(bList.data).toEqual([]);

    // B's tick generates nothing and must not touch A's due subscription.
    const bTick = await json(await api(ctx.app, ctx.tenantB.id, 'POST', '/subscriptions/tick'));
    expect(bTick.data.count).toBe(0);
    const bInvoices = await json(await api(ctx.app, ctx.tenantB.id, 'GET', '/invoices'));
    expect(bInvoices.data).toEqual([]);

    const aSub = await json(await api(ctx.app, ctx.tenantA.id, 'GET', `/subscriptions/${sub.id}`));
    expect(aSub.data.status).toBe('active');
    expect(aSub.data.next_invoice_at).toBe(sub.next_invoice_at);
  });
});
