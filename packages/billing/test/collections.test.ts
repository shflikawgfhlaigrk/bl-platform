import { afterEach, describe, expect, it } from 'vitest';
import { parseCsv } from '@blacklabel/core';
import { billingCreateInvoiceContract, createInvoice, listInvoices } from '../src/service';
import { api, json, makeSentInvoice, setupBilling, type TestContext } from './helpers';

const fixtures: TestContext[] = [];
async function fixture() { const ctx = await setupBilling(); fixtures.push(ctx); return ctx; }
afterEach(async () => { for (const ctx of fixtures.splice(0)) await ctx.db.destroy(); });
async function data(ctx: TestContext, path: string, method = 'GET', body?: unknown) {
  const response = await api(ctx.app, ctx.tenantA.id, method, path, body); const result = await json(response);
  expect(response.status, JSON.stringify(result)).toBeLessThan(300); return result.data;
}
const due = '2020-01-01T00:00:00.000Z';

describe('deposit, balance, receipts and stopped reminder drafts', () => {
  it('collects an exact manual deposit then balance, exposes true instructions and stops all drafts when settled', async () => {
    const ctx = await fixture(); const invoice = await makeSentInvoice(ctx, ctx.tenantA.id, { lines: [{ description: 'Agreed work', quantity: 2.5, unitPriceCents: 3333 }], taxBps: 825 });
    expect(invoice.total_cents).toBe(9020);
    await data(ctx, `/invoices/${invoice.id}/collection-plan`, 'PUT', { depositCents: 2706, depositDueAt: due, balanceDueAt: due, remindersEnabled: true });
    const plan = await data(ctx, `/invoices/${invoice.id}/collection-plan`); expect(plan).toMatchObject({ stage: 'deposit', depositRemainingCents: 2706, balanceCents: 9020, reminderStopReason: null });
    const intent = await data(ctx, `/invoices/${invoice.id}/payment-intents`, 'POST', { purpose: 'deposit' });
    expect(intent).toMatchObject({ provider: 'manual', amountCents: 2706, status: 'requires_action' }); expect(intent.clientSecret).toBeUndefined();
    const reminder = await data(ctx, `/invoices/${invoice.id}/reminders`, 'POST', { operationKey: 'first-deposit-draft' }); expect(reminder.status).toBe('prepared'); expect(reminder.message).toContain('$27.06'); expect(reminder.delivery_reference).toBeNull();
    await data(ctx, `/invoices/${invoice.id}/payments`, 'POST', { amountCents: 2706, method: 'transfer', receiptRef: 'bank-fixture-1' });
    expect((await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${invoice.id}/void`)).status).toBe(409);
    const after = await data(ctx, `/invoices/${invoice.id}/collection-plan`); expect(after).toMatchObject({ stage: 'balance', depositRemainingCents: 0, balanceCents: 6314 });
    expect((await data(ctx, `/invoices/${invoice.id}/reminders`))[0]).toMatchObject({ status: 'suppressed', reason: 'balance_changed' });
    expect((await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${invoice.id}/payment-intents`, { purpose: 'deposit' })).status).toBe(409);
    expect(await data(ctx, `/invoices/${invoice.id}/payment-intents`, 'POST', { purpose: 'balance' })).toMatchObject({ amountCents: 6314 });
    const balanceDraft = await data(ctx, `/invoices/${invoice.id}/reminders`, 'POST', { operationKey: 'remaining-balance-draft' }); expect(balanceDraft).toMatchObject({ stage: 'balance', amount_cents: 6314, status: 'prepared' });
    await data(ctx, `/invoices/${invoice.id}/payments`, 'POST', { amountCents: 6314, receiptRef: 'bank-fixture-2' });
    expect(await data(ctx, `/invoices/${invoice.id}/collection-plan`)).toMatchObject({ stage: 'settled', balanceCents: 0, reminderStopReason: 'paid' });
    expect(await data(ctx, `/invoices/${invoice.id}/reminders`, 'POST', { operationKey: 'after-paid' })).toMatchObject({ status: 'suppressed', reason: 'paid', message: null });
    expect((await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${invoice.id}/reminders/${balanceDraft.id}/receipt`, { deliveryReference: 'late-delivery' })).status).toBe(409);
  });

  it('deduplicates one payment submission while allowing repeated cash references and rejecting changed retry payloads', async () => {
    const ctx = await fixture(); const invoice = await makeSentInvoice(ctx, ctx.tenantA.id);
    let paid = 0; ctx.events.on('billing.invoice.paid', () => { paid += 1; });
    const input = { amountCents: 5000, externalRef: 'cash', receiptRef: 'payment-operation-1' };
    const [a, b] = await Promise.all([data(ctx, `/invoices/${invoice.id}/payments`, 'POST', input), data(ctx, `/invoices/${invoice.id}/payments`, 'POST', input)]);
    expect(a.payment.id).toBe(b.payment.id); expect(a.replayed).not.toBe(b.replayed);
    expect(a.payment.external_ref).toBe('cash'); expect(paid).toBe(0);
    expect(await data(ctx, `/invoices/${invoice.id}/payments`)).toHaveLength(1);
    for (const changed of [{ amountCents: 4999 }, { externalRef: 'check' }, { providerRef: 'other-provider-reference' }]) {
      expect((await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${invoice.id}/payments`, { ...input, ...changed })).status).toBe(409);
    }
    const second = await data(ctx, `/invoices/${invoice.id}/payments`, 'POST', { ...input, receiptRef: 'payment-operation-2' });
    expect(second.replayed).toBe(false); expect(second.payment.id).not.toBe(a.payment.id);
    expect(second.invoice).toMatchObject({ paid_cents: 10000, status: 'paid' }); expect(paid).toBe(1);
    const other = await makeSentInvoice(ctx, ctx.tenantA.id);
    expect((await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${other.id}/payments`, input)).status).toBe(409);
    expect(await data(ctx, `/invoices/${other.id}/payments`, 'POST', { ...input, receiptRef: 'payment-operation-3' })).toMatchObject({ replayed: false, payment: { external_ref: 'cash' } });
    expect((await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${other.id}/payments`, { amountCents: 1, receiptRef: 'blank-reference', externalRef: '  ' })).status).toBe(400);
  });

  it('returns all 200 collection summaries in two database reads without leaking another company', async () => {
    const ctx = await fixture(); const first = await makeSentInvoice(ctx, ctx.tenantA.id);
    await data(ctx, `/invoices/${first.id}/collection-plan`, 'PUT', { depositCents: 2000, depositDueAt: due, remindersEnabled: true });
    const seed = await ctx.db.selectFrom('billing_invoices').selectAll().where('id', '=', first.id).executeTakeFirstOrThrow();
    await ctx.db.insertInto('billing_invoices').values(Array.from({ length: 199 }, (_, i) => ({ ...seed, id: `collection-fixture-${i}`, number: `COL-${i}` }))).execute();
    await makeSentInvoice(ctx, ctx.tenantB.id);
    let queries = 0;
    const observed = ctx.db.withPlugin({ transformQuery(args) { queries += 1; return args.node; }, async transformResult(args) { return args.result; } });
    const rows = await listInvoices(observed, ctx.tenantA.id, { limit: 200, offset: 0 });
    expect(queries).toBe(2); expect(rows).toHaveLength(200);
    expect(rows.every(row => row.tenant_id === ctx.tenantA.id)).toBe(true);
    expect(rows.find(row => row.id === first.id)!.collection).toEqual(await data(ctx, `/invoices/${first.id}/collection-plan`));
    expect(rows.find(row => row.id === 'collection-fixture-0')!.collection).toMatchObject({ balanceCents: 10000, stage: 'balance', reminderStopReason: 'disabled' });
  });

  it('deduplicates stable invoice contract sources and rejects changed scope without consuming invoice numbers', async () => {
    const ctx = await fixture(); const contract = billingCreateInvoiceContract(ctx.db, ctx.events);
    const input = { tenantId: ctx.tenantA.id, customerId: 'customer', sourceEntityType: 'workflows.action', sourceEntityId: 'workflow:execution:action', lines: [{ description: 'Approved service', quantity: 1, unitPriceCents: 10000 }] };
    const [a, b] = await Promise.all([contract.createInvoice(input), contract.createInvoice(input)]); expect(a.id).toBe(b.id);
    await expect(contract.createInvoice({ ...input, lines: [{ description: 'Different scope', quantity: 1, unitPriceCents: 10000 }] })).rejects.toMatchObject({ status: 409 });
    const next = await contract.createInvoice({ ...input, sourceEntityId: 'workflow:execution:action-two' });
    const invoices = await data(ctx, '/invoices'); expect(invoices).toHaveLength(2); expect(invoices.map((row: any) => row.number).sort()).toEqual(['INV-1', 'INV-2']); expect(next.id).not.toBe(a.id);
    const tenantB = await contract.createInvoice({ ...input, tenantId: ctx.tenantB.id }); expect(tenantB.id).not.toBe(a.id);
  });

  it('adopts one preexisting matching source invoice and refuses ambiguous legacy duplicates', async () => {
    const ctx = await fixture(); const contract = billingCreateInvoiceContract(ctx.db, ctx.events);
    const source = { customerId: 'legacy-customer', sourceEntityType: 'workflows.action', sourceEntityId: 'legacy-action', lines: [{ description: 'Existing work', quantity: 1, unitPriceCents: 1000 }] };
    const existing = await createInvoice({ db: ctx.db, events: ctx.events }, ctx.tenantA.id, 'system', source);
    expect(await contract.createInvoice({ ...source, tenantId: ctx.tenantA.id })).toEqual({ id: existing.invoice.id }); expect(await data(ctx, '/invoices')).toHaveLength(1);
    const ambiguous = { ...source, sourceEntityId: 'ambiguous-action' };
    await createInvoice({ db: ctx.db, events: ctx.events }, ctx.tenantA.id, 'system', ambiguous); await createInvoice({ db: ctx.db, events: ctx.events }, ctx.tenantA.id, 'system', ambiguous);
    await expect(contract.createInvoice({ ...ambiguous, tenantId: ctx.tenantA.id })).rejects.toMatchObject({ status: 409 }); expect(await data(ctx, '/invoices')).toHaveLength(3);
  });

  it('suppresses reminders for optout, void, future due dates and disabled plans while keeping recorded manual delivery evidence', async () => {
    const ctx = await fixture(); const invoice = await makeSentInvoice(ctx, ctx.tenantA.id);
    await data(ctx, `/invoices/${invoice.id}/collection-plan`, 'PUT', { depositCents: 2000, depositDueAt: due, balanceDueAt: due, remindersEnabled: true });
    const draft = await data(ctx, `/invoices/${invoice.id}/reminders`, 'POST', { operationKey: 'draft-one' });
    const recorded = await data(ctx, `/invoices/${invoice.id}/reminders/${draft.id}/receipt`, 'POST', { deliveryReference: 'synthetic-manual-message-1' }); expect(recorded.status).toBe('recorded');
    expect(await data(ctx, `/invoices/${invoice.id}/reminders/${draft.id}/receipt`, 'POST', { deliveryReference: 'synthetic-manual-message-1' })).toMatchObject({ id: draft.id, status: 'recorded' });
    expect((await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${invoice.id}/reminders/${draft.id}/receipt`, { deliveryReference: 'different-receipt' })).status).toBe(409);
    await data(ctx, `/invoices/${invoice.id}/collection-plan`, 'PUT', { depositCents: 2000, depositDueAt: due, balanceDueAt: due, optedOut: true });
    expect(await data(ctx, `/invoices/${invoice.id}/reminders`, 'POST', { operationKey: 'opted-out' })).toMatchObject({ status: 'suppressed', reason: 'opted_out', message: null });
    await data(ctx, `/invoices/${invoice.id}/void`, 'POST');
    expect(await data(ctx, `/invoices/${invoice.id}/reminders`, 'POST', { operationKey: 'void' })).toMatchObject({ status: 'suppressed', reason: 'void' });
    expect((await data(ctx, `/invoices/${invoice.id}/reminders`)).find((row: any) => row.id === draft.id).delivery_reference).toBe('synthetic-manual-message-1');
    const future = await makeSentInvoice(ctx, ctx.tenantA.id); await data(ctx, `/invoices/${future.id}/collection-plan`, 'PUT', { depositCents: 0, balanceDueAt: '2100-01-01T00:00:00.000Z', remindersEnabled: true });
    expect(await data(ctx, `/invoices/${future.id}/reminders`, 'POST', { operationKey: 'future' })).toMatchObject({ status: 'suppressed', reason: 'not_due' });
    const disabled = await makeSentInvoice(ctx, ctx.tenantA.id);
    expect(await data(ctx, `/invoices/${disabled.id}/reminders`, 'POST', { operationKey: 'disabled' })).toMatchObject({ status: 'suppressed', reason: 'disabled' });
  });

  it('enforces collection, reminder, payment and receipt tenant boundaries and validates unsafe inputs', async () => {
    const ctx = await fixture(); const invoice = await makeSentInvoice(ctx, ctx.tenantA.id);
    for (const [path, method, body] of [[`/invoices/${invoice.id}/collection-plan`, 'GET', undefined], [`/invoices/${invoice.id}/collection-plan`, 'PUT', { depositCents: 1 }], [`/invoices/${invoice.id}/reminders`, 'POST', { operationKey: 'foreign' }], [`/invoices/${invoice.id}/reminders`, 'GET', undefined]] as const) expect((await api(ctx.app, ctx.tenantB.id, method, path, body)).status).toBe(404);
    expect((await api(ctx.app, ctx.tenantA.id, 'PUT', `/invoices/${invoice.id}/collection-plan`, { depositCents: 10001 })).status).toBe(400);
    expect((await api(ctx.app, ctx.tenantA.id, 'PUT', `/invoices/${invoice.id}/collection-plan`, { depositCents: 1.5 })).status).toBe(400);
    expect((await api(ctx.app, ctx.tenantA.id, 'POST', `/invoices/${invoice.id}/payments`, { amountCents: Number.MAX_SAFE_INTEGER })).status).toBe(400);
    expect((await api(ctx.app, ctx.tenantA.id, 'PUT', `/invoices/${invoice.id}/collection-plan`, { depositCents: 1, depositDueAt: '2030-01-02T00:00:00.000Z', balanceDueAt: '2030-01-01T00:00:00.000Z' })).status).toBe(400);
    expect((await api(ctx.app, ctx.tenantA.id, 'GET', `/invoices/${invoice.id}/payments`)).status).toBe(200);
  });

  it('exports exact cents, source and manual receipt references while isolating other-company ledgers', async () => {
    const ctx = await fixture(); const invoice = await makeSentInvoice(ctx, ctx.tenantA.id); await data(ctx, `/invoices/${invoice.id}/payments`, 'POST', { amountCents: 2500, receiptRef: 'receipt-export-1', externalRef: 'Cash ledger 42' });
    const invoices = parseCsv(await (await api(ctx.app, ctx.tenantA.id, 'GET', '/invoices/export.csv')).text());
    expect(invoices).toMatchObject([{ total_cents: '10000', paid_cents: '2500', balance_cents: '7500' }]);
    const payments = parseCsv(await (await api(ctx.app, ctx.tenantA.id, 'GET', '/payments/export.csv')).text()); expect(payments).toMatchObject([{ amount_cents: '2500', receipt_ref: 'receipt-export-1', external_ref: 'Cash ledger 42', invoice_id: invoice.id }]);
    expect(parseCsv(await (await api(ctx.app, ctx.tenantB.id, 'GET', '/payments/export.csv')).text())).toEqual([]);
  });
});
