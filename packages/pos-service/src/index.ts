/**
 * @blacklabel/pos-service — done-for-you point of sale on Stripe Connect.
 *
 * Black Label is the Connect platform. Each merchant gets its own Stripe account (full Dashboard,
 * Stripe collects fees from the merchant and carries negative-balance losses), a Terminal
 * location, a card reader, and a refunded go-live test sale. Lifecycle, sources, and the
 * founder-gated steps: README.md.
 *
 * Internal events emitted (module.entity.verb; ids, stages and codes only, NO PII):
 *   pos_service.merchant.created        { v:1, merchantId, livemode }
 *   pos_service.merchant.stage_changed  { v:1, merchantId, from, to }
 *   pos_service.merchant.blocked        { v:1, merchantId, code }
 *   pos_service.message.prepared        { v:1, merchantId, messageId, kind }
 *
 * Integrator wiring (apps/api): mount `posServiceRouter` at /api/pos-service with a Stripe client
 * built from the platform secret key, the Connect webhook signing secret, and https onboarding
 * return/refresh URLs. The webhook route authenticates by Stripe signature, so it must bypass
 * the browser, CSRF, and RBAC guards the same way the orders payment webhooks do.
 */
export const MODULE_KEY = 'pos-service' as const;

// Migrations
export { posServiceMigrations } from './migrations';

// Router factory
export { posServiceRouter } from './router';
export type { PosServiceRouterOptions } from './router';

// Public types
export type { PosServiceDatabase, PosServiceMerchantRow, PosServiceWebhookEventRow } from './schema';

// Engine: lifecycle, persistence, Stripe transport, signatures, audit/events observer
export * from './lifecycle';
export * from './store';
export { createDbMerchantStore } from './db-store';
export { POS_SERVICE_EVENTS, posServiceObserver } from './observer';
export * from './signature';
export * from './stripe-client';
export * from './service';
export * from './checklist';
