import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
// @ts-expect-error authored browser JS is exercised against the actual billing API below
import { billingView, paymentSubmission, paymentReceiptMessage } from '../public/billing.js';
import { api as billingApi, json, makeSentInvoice, setupBilling } from '../../../packages/billing/test/helpers';

afterEach(() => vi.unstubAllGlobals());

describe('billing customer UI', () => {
  it('retains one operation key after a lost response and records the next identical cash installment', async () => {
    vi.stubGlobal('crypto', { randomUUID });
    const ctx = await setupBilling();
    try {
      const invoice = await makeSentInvoice(ctx, ctx.tenantA.id);
      let loseResponse = true;
      const request = vi.fn(async (route: string, method: string, body: unknown) => {
        const response = await billingApi(ctx.app, ctx.tenantA.id, method, route.replace(/^billing/, ''), body);
        const result = await json(response);
        expect(response.status, JSON.stringify(result)).toBe(201);
        if (loseResponse) { loseResponse = false; throw new Error('Synthetic response loss after commit'); }
        return result.data;
      });
      const firstForm = paymentSubmission(request, invoice.id);
      const installment = { amountCents: 5000, method: 'manual', externalRef: 'cash' };
      await expect(firstForm(installment)).rejects.toThrow('response loss');
      const retry = await firstForm(installment);
      expect(retry.replayed).toBe(true);
      expect(paymentReceiptMessage(retry)).toContain('already recorded');
      const secondForm = paymentSubmission(request, invoice.id);
      const second = await secondForm(installment);
      expect(second.replayed).toBe(false);
      expect(second.invoice).toMatchObject({ status: 'paid', paid_cents: 10000 });
      expect(paymentReceiptMessage(second)).toBe('Payment recorded.');
      const keys = request.mock.calls.map(([, , body]) => (body as {receiptRef: string}).receiptRef);
      expect(keys[0]).toBe(keys[1]); expect(keys[2]).not.toBe(keys[1]);
      const payments = (await json(await billingApi(ctx.app, ctx.tenantA.id, 'GET', `/invoices/${invoice.id}/payments`))).data;
      expect(payments).toHaveLength(2); expect(payments.every((row: any) => row.external_ref === 'cash')).toBe(true);
    } finally { await ctx.db.destroy(); }
  });

  it('renders 200 invoices repeatedly with four requests per render and reports subscription failures', async () => {
    const invoices = Array.from({ length: 200 }, (_, i) => ({ id: `invoice-${i}`, number: `INV-${i}`,
      collection: { invoiceId: `invoice-${i}`, stage: 'balance', depositRemainingCents: 0, balanceCents: 10000, reminderStopReason: 'disabled' } }));
    const api = vi.fn(async (route: string) => {
      if (route === 'billing/invoices?limit=200') return invoices;
      if (route === 'billing/subscriptions/tick') return { count: 1, failureCount: 1 };
      if (['billing/subscriptions?limit=200', 'billing/memberships?limit=200', 'crm/customers?limit=200'].includes(route)) return [];
      throw new Error(`Unexpected request: ${route}`);
    });
    let html = '';
    const content = { querySelectorAll: () => [], insertAdjacentHTML: (_where: string, value: string) => { html += value; } };
    const tick: {onclick?: () => Promise<void>} = {};
    vi.stubGlobal('document', { querySelector: () => tick });
    const base = async () => {
      html = '';
      const [rows, customers] = await Promise.all([api('billing/invoices?limit=200'), api('crm/customers?limit=200')]);
      return { invoices: rows, customers };
    };
    const say = vi.fn();
    const table = (rows: any[], columns: any[]) => rows.map(row => columns.map(([, value]) => typeof value === 'function' ? value(row) : row[value]).join(' ')).join('\n');
    let render: () => Promise<void>;
    render = billingView(base, { api, content, table, say, render: () => render(), esc: String, when: String, money: String,
      panel: (title: string, body: string) => title + body, form: (_id: string, title: string, body: string) => title + body,
      select: () => '', field: () => '', bindForm: () => {}, cents: Number, customerOptions: () => '' });
    await render(); await render();
    expect(api).toHaveBeenCalledTimes(8); expect(html).toContain('INV-199');
    expect(api.mock.calls.some(([route]) => route.includes('/collection-plan'))).toBe(false);
    await tick.onclick!();
    expect(say).toHaveBeenLastCalledWith('1 due invoices generated. 1 subscriptions need review in the activity log.', true);
  });
});
