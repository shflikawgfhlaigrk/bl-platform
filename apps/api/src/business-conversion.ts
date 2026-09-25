import type { Kysely } from 'kysely';
import { ApiError, EventBus, type PlatformEvent } from '@blacklabel/core';
import { createJob, getEntity, ENTITY_DEFS, type CrmDatabase } from '@blacklabel/crm';
import { billingCreateInvoiceContract, getInvoice, type BillingDatabase } from '@blacklabel/billing';
import { convertQuote, getQuote, getQuoteConversion, recordQuoteConversion, type QuotingDatabase } from '@blacklabel/quoting';

/** All three modules share one transaction; workflow subscribers run after commit. */
export function businessQuoteConversion(db: Kysely<any>, events: EventBus) {
  return async (tenantId: string, actor: string, quoteId: string) => {
    const emitted: PlatformEvent[] = [];
    const result = await db.transaction().execute(async tx => {
      const deferred = new EventBus(); deferred.on('*', event => { emitted.push(event); });
      const ctx = { db: tx as unknown as Kysely<QuotingDatabase>, events: deferred,
        contracts: { createInvoice: billingCreateInvoiceContract(tx as unknown as Kysely<BillingDatabase>, deferred) }, tenantId, actor };
      const { quote } = await getQuote(ctx, quoteId);
      const crm = tx as unknown as Kysely<CrmDatabase>, billing = tx as unknown as Kysely<BillingDatabase>;
      if (!await getEntity(crm, tenantId, ENTITY_DEFS.customer, quote.customer_id)) throw ApiError.notFound('Quote customer not found.');
      const saved = await getQuoteConversion(ctx, quoteId);
      if (saved) {
        const job = await getEntity(crm, tenantId, ENTITY_DEFS.job, saved.job_id), invoice = await getInvoice(billing, tenantId, saved.invoice_id);
        if (!job || !invoice || job.customer_id !== quote.customer_id || invoice.invoice.customer_id !== quote.customer_id || invoice.invoice.total_cents !== quote.total_cents) throw ApiError.conflict('Converted job or invoice needs review.');
        return { quoteId, job, jobId: saved.job_id, invoiceId: saved.invoice_id, totalCents: quote.total_cents, replayed: true };
      }
      // Adopt an earlier invoice-only conversion without issuing another invoice.
      const invoiceId = quote.converted_at && quote.invoice_id ? quote.invoice_id : (await convertQuote(ctx, quoteId)).invoiceId;
      if (!invoiceId) throw ApiError.conflict('Invoice creation did not complete.');
      const invoice = await getInvoice(billing, tenantId, invoiceId);
      if (!invoice || invoice.invoice.customer_id !== quote.customer_id || invoice.invoice.total_cents !== quote.total_cents) throw ApiError.conflict('Invoice readback differs from the approved quote.');
      const created = await createJob(crm, deferred, tenantId, actor, { customer_id: quote.customer_id, title: quote.title, description: quote.notes, status: 'planned' });
      const job = await getEntity(crm, tenantId, ENTITY_DEFS.job, created.id);
      if (!job || job.customer_id !== quote.customer_id || job.title !== quote.title) throw ApiError.conflict('CRM job readback differs from the approved work.');
      await recordQuoteConversion(ctx, quoteId, created.id, invoiceId);
      return { quoteId, job, jobId: created.id, invoiceId, totalCents: quote.total_cents, replayed: false };
    });
    const eventProblems: string[] = [];
    for (const event of emitted) {
      const delivered = await events.emit(event.tenantId, event.type, event.payload);
      if (delivered.errors.length) eventProblems.push(event.type);
    }
    return { ...result, ...(eventProblems.length ? { eventDeliveryNeedsReview: eventProblems } : {}) };
  };
}
