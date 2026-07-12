/**
 * @blacklabel/portal-customer — customer-facing portal: magic-token login,
 * self-service views over the customer's own appointments/quotes/invoices/
 * jobs/review-requests (via injected providers), quote approve/decline,
 * pay placeholder, uploads, messages, and contact self-management.
 * Strictly tenant + customer scoped.
 *
 * Events emitted (module-internal, `portal_customer.entity.verb`):
 * - portal_customer.account.created        { accountId, customerId, email }
 * - portal_customer.login_link.requested   { accountId, tokenId, expiresAt }
 * - portal_customer.session.created        { accountId, sessionId, expiresAt }
 * - portal_customer.contact.updated        { accountId, customerId, fields }
 * - portal_customer.quote.approved         { quoteId, customerId, accountId, approvalEventId, totalCents }
 * - portal_customer.quote.declined         { quoteId, customerId, accountId, approvalEventId, totalCents }
 * - portal_customer.payment_intent.created { invoiceId, customerId, accountId, paymentIntentId, amountCents }
 * - portal_customer.message.sent           { messageId, accountId, customerId, relayedMessageId }
 * - portal_customer.upload.created         { uploadId, accountId, customerId, fileId, fileName }
 */
export const MODULE_KEY = 'portal-customer' as const;

// Migrations
export { portalCustomerMigrations } from './migrations';

// Router factory
export { portalCustomerRouter } from './router';
export type { PortalCustomerDeps } from './router';

// Row types + database map
export type {
  PortalCustomerAccountRow,
  PortalCustomerLoginTokenRow,
  PortalCustomerSessionRow,
  PortalCustomerMessageRow,
  PortalCustomerUploadRow,
  PortalCustomerDatabase,
  PortalUploadKind,
} from './schema';

// Cross-module provider interfaces (wired by apps/api) + payment stub
export { stubPaymentProvider, LOGIN_TOKEN_TTL_MINUTES, SESSION_TTL_DAYS } from './service';
export type {
  PortalCustomerProviders,
  PortalAppointment,
  PortalAppointmentsProvider,
  PortalQuote,
  PortalQuoteLine,
  PortalQuotesProvider,
  QuoteApprovalEventInput,
  QuoteDecision,
  PortalInvoice,
  PortalInvoicesProvider,
  PaymentIntentStub,
  PortalPaymentProvider,
  PortalFileRegistration,
  PortalFilesProvider,
  PortalJobStatus,
  PortalJobsProvider,
  PortalReviewRequest,
  PortalReviewsProvider,
} from './service';

// Seed
export { seedPortalCustomer } from './seed';
export type { PortalCustomerSeedResult } from './seed';
