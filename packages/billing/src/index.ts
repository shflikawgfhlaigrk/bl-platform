/**
 * @blacklabel/billing — invoices, payments, subscriptions, memberships.
 *
 * Events emitted (module.entity.verb):
 *   billing.invoice.paid        (catalog) { invoiceId, customerId, totalCents }
 *   billing.invoice.created     { invoiceId, customerId, totalCents }
 *   billing.invoice.sent        { invoiceId, customerId, totalCents }
 *   billing.invoice.voided      { invoiceId, customerId }
 *   billing.invoice.generated   { invoiceId, subscriptionId, customerId, totalCents }
 *   billing.invoice.converted   { invoiceId, quoteId }
 *   billing.payment.recorded    { paymentId, invoiceId, amountCents }
 *   billing.subscription.created{ subscriptionId, customerId }
 *   billing.membership.created  { membershipId, customerId, planKey }
 *
 * Contract implementation: billingCreateInvoiceContract (CreateInvoiceContract)
 * — apps/api wires it into other modules' deps.contracts.createInvoice.
 */

export const MODULE_KEY = 'billing' as const;
export { getInvoice, listInvoices, createPaymentIntent, getCollectionPlan, setCollectionPlan, prepareCollectionReminder, recordCollectionReminder, listCollectionReminders, exportPaymentsCsv } from './service';

// Migrations
export { billingMigrations } from './migrations';

// Router factory
export { billingRouter } from './router';
export type { BillingRouterOptions } from './router';

// Schema / row types
export type {
  BillingDatabase,
  BillingAccountRow,
  BillingInvoiceRow,
  BillingInvoiceLineRow,
  BillingPaymentRow,
  BillingSubscriptionRow,
  BillingMembershipRow,
  BillingInvoiceCounterRow,
  BillingWebhookEventRow,
  InvoiceStatus,
  SubscriptionStatus,
  SubscriptionInterval,
  MembershipStatus,
} from './schema';

// Payment provider interface + adapters (Stripe-shaped, not Stripe-hardcoded)
export {
  manualPaymentProvider,
  stubPaymentProvider,
  defaultPaymentProviders,
} from './providers';
export type {
  PaymentProvider,
  PaymentIntent,
  PaymentIntentStatus,
  CreatePaymentIntentInput,
  ProviderWebhookEvent,
  WebhookOutcome,
} from './providers';

// Status math + contract implementation + tick (public API surface)
export {
  computeInvoiceStatus,
  advanceInterval,
  generateDueInvoices,
  billingCreateInvoiceContract,
} from './service';
export type {
  BillingCtx,
  CollectionPlanInput,
  CollectionPlanDetails,
  InvoiceDto,
  InvoiceWithLines,
  InvoiceLineInputSvc,
  CreateInvoiceInputSvc,
  QuoteToInvoiceInput,
  GeneratedInvoiceRef,
} from './service';

// Seed helper
export { seedBilling } from './seed';
export type { BillingSeedResult } from './seed';
