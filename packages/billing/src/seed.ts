import type { Kysely } from 'kysely';
import { EventBus, id, nowIso } from '@blacklabel/core';
import { DateTime } from 'luxon';
import type { BillingDatabase } from './schema';
import {
  createBillingAccount,
  createInvoice,
  createMembership,
  createSubscription,
  recordPayment,
  sendInvoice,
  type BillingCtx,
} from './service';

export interface BillingSeedResult {
  billingAccountId: string;
  customerId: string;
  draftInvoiceId: string;
  partialInvoiceId: string;
  paidInvoiceId: string;
  subscriptionId: string;
  membershipId: string;
}

/**
 * Demo data: one billing account, a draft / partially-paid / paid invoice,
 * an active monthly subscription due now, and an active membership.
 *
 * Pass the platform EventBus to fan events out to listeners; when omitted a
 * throwaway bus is used (seed events are then dropped — fine for demos).
 */
export async function seedBilling(
  db: Kysely<BillingDatabase>,
  tenantId: string,
  events: EventBus = new EventBus(),
): Promise<BillingSeedResult> {
  const ctx: BillingCtx = { db, events };
  const actor = 'system';
  const customerId = `demo-customer-${id()}`;

  const account = await createBillingAccount(ctx, tenantId, actor, {
    customerId,
    name: 'Demo Billing Account',
    email: 'billing@example.test',
  });

  const draft = await createInvoice(ctx, tenantId, actor, {
    customerId,
    billingAccountId: account.id,
    lines: [
      { description: 'Service visit', quantity: 2, unitPriceCents: 12_500 },
      { description: 'Materials', quantity: 1, unitPriceCents: 4_800 },
    ],
    taxBps: 800,
    memo: 'Draft demo invoice',
  });

  const partial = await createInvoice(ctx, tenantId, actor, {
    customerId,
    billingAccountId: account.id,
    lines: [{ description: 'Project deposit', quantity: 1, unitPriceCents: 50_000 }],
    dueAt: DateTime.utc().plus({ days: 14 }).toISO()!,
    portalVisible: true,
  });
  await sendInvoice(ctx, tenantId, actor, partial.invoice.id);
  await recordPayment(ctx, tenantId, actor, partial.invoice.id, {
    amountCents: 20_000,
    method: 'check',
    note: 'First installment',
  });

  const paid = await createInvoice(ctx, tenantId, actor, {
    customerId,
    billingAccountId: account.id,
    lines: [{ description: 'Consultation', quantity: 1, unitPriceCents: 9_900 }],
    portalVisible: true,
  });
  await sendInvoice(ctx, tenantId, actor, paid.invoice.id);
  await recordPayment(ctx, tenantId, actor, paid.invoice.id, {
    amountCents: paid.invoice.total_cents,
    method: 'card',
  });

  const subscription = await createSubscription(ctx, tenantId, actor, {
    customerId,
    planName: 'Standard maintenance plan',
    amountCents: 7_500,
    interval: 'monthly',
    nextInvoiceAt: nowIso(),
    billingAccountId: account.id,
  });

  const membership = await createMembership(ctx, tenantId, actor, {
    customerId,
    planKey: 'standard',
    subscriptionId: subscription.id,
  });

  return {
    billingAccountId: account.id,
    customerId,
    draftInvoiceId: draft.invoice.id,
    partialInvoiceId: partial.invoice.id,
    paidInvoiceId: paid.invoice.id,
    subscriptionId: subscription.id,
    membershipId: membership.id,
  };
}
