import { createHash, randomUUID } from 'node:crypto';
import {
  hardwareOutcome,
  isAtLeast,
  readCardPaymentsStatus,
  readHardwareOrder,
  readUserRequirements,
  stageRank,
  type MerchantAddress,
  type MerchantRecord,
  type MerchantStage,
  type PreparedMessage,
} from './lifecycle';
import { MerchantConflictError, MerchantExistsError, type MerchantPage, type MerchantStore } from './store';
import { verifyStripeSignature, type SignatureCheck } from './signature';
import { StripeRequestError, type StripeClient } from './stripe-client';

/**
 * Connect settings for a software platform whose merchants sell to their own customers
 * (Stripe "Platform" model): the merchant's account owns payments, readers, refunds and
 * disputes; the merchant pays Stripe's fees; Stripe manages risk and negative balances;
 * merchants get the full Stripe Dashboard. See README.md for the sources.
 */
export const CONNECT_ACCOUNT_SETTINGS = Object.freeze({
  dashboard: 'full',
  feesCollector: 'stripe',
  lossesCollector: 'stripe',
} as const);

/** Smart readers the server-driven POS integration supports (same list as apps/api). */
export const DEFAULT_COMPATIBLE_READERS: readonly string[] = Object.freeze(['bbpos_wisepos_e', 'stripe_s700']);

export class PosServiceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 422) {
    super(message);
    this.name = 'PosServiceError';
    this.code = code;
    this.status = status;
  }
}

/** Told about every stored merchant change, after the write succeeds (audit log, events). */
export interface MerchantObserver {
  /** `before` is null for a new merchant. */
  changed(before: MerchantRecord | null, after: MerchantRecord): Promise<void> | void;
}

export interface PosServiceConfig {
  onboarding: { returnUrl: string; refreshUrl: string };
  /** Our fee on each card payment, collected as a Connect application fee. Default: none. */
  platformFee?: { basisPoints: number; fixedCents: number };
  /** Amount of the go-live test sale, captured and refunded. Default 100 (one dollar). */
  testSaleAmountCents?: number;
  compatibleReaderTypes?: readonly string[];
}

export interface PosServiceOptions extends PosServiceConfig {
  store: MerchantStore;
  stripe: StripeClient;
  observer?: MerchantObserver;
  now?: () => Date;
  newId?: () => string;
}

export interface PurchaseInput {
  purchaseRef: string;
  businessName: string;
  contactEmail: string;
  address: MerchantAddress;
}

type Obj = Record<string, unknown>;
const asObj = (value: unknown): Obj | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : null);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new PosServiceError('invalid_input', `${field} is required (up to ${max} characters).`);
  }
  return value.trim();
}

function httpsUrl(value: unknown, field: string): string {
  const raw = text(value, field, 2000);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PosServiceError('invalid_config', `${field} must be a URL.`);
  }
  if (url.protocol !== 'https:') throw new PosServiceError('invalid_config', `${field} must use https.`);
  return url.toString();
}

function validateAddress(address: MerchantAddress): MerchantAddress {
  if (!address || typeof address !== 'object') throw new PosServiceError('invalid_input', 'A business address is required.');
  if (address.country !== 'US') throw new PosServiceError('invalid_input', 'Only US merchants are supported.');
  const state = text(address.state, 'State', 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) throw new PosServiceError('invalid_input', 'State must be a two-letter code.');
  const postalCode = text(address.postalCode, 'Postal code', 10);
  if (!/^\d{5}(-\d{4})?$/.test(postalCode)) throw new PosServiceError('invalid_input', 'Postal code must be a US ZIP code.');
  return {
    line1: text(address.line1, 'Address line 1', 200),
    ...(address.line2 ? { line2: text(address.line2, 'Address line 2', 200) } : {}),
    city: text(address.city, 'City', 100),
    state,
    postalCode,
    country: 'US',
  };
}

/** Validate service configuration once, so a bad deploy fails at startup instead of mid-onboarding. */
export function resolvePosServiceConfig(options: PosServiceConfig) {
  const returnUrl = httpsUrl(options.onboarding?.returnUrl, 'Onboarding return URL');
  const refreshUrl = httpsUrl(options.onboarding?.refreshUrl, 'Onboarding refresh URL');
  const fee = options.platformFee ?? { basisPoints: 0, fixedCents: 0 };
  if (!Number.isInteger(fee.basisPoints) || fee.basisPoints < 0 || fee.basisPoints > 1000) {
    throw new PosServiceError('invalid_config', 'Platform fee basis points must be a whole number from 0 to 1000.');
  }
  if (!Number.isInteger(fee.fixedCents) || fee.fixedCents < 0 || fee.fixedCents > 500) {
    throw new PosServiceError('invalid_config', 'Platform fixed fee must be a whole number of cents from 0 to 500.');
  }
  const testSaleAmount = options.testSaleAmountCents ?? 100;
  if (!Number.isInteger(testSaleAmount) || testSaleAmount < 50 || testSaleAmount > 1000) {
    throw new PosServiceError('invalid_config', 'The test sale must be between 50 and 1000 cents.');
  }
  const compatibleReaders = new Set(options.compatibleReaderTypes ?? DEFAULT_COMPATIBLE_READERS);
  return { returnUrl, refreshUrl, fee, testSaleAmount, compatibleReaders };
}

export function createPosService(options: PosServiceOptions) {
  const { store, stripe, observer } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => `mer_${randomUUID()}`);
  const { returnUrl, refreshUrl, fee, testSaleAmount, compatibleReaders } = resolvePosServiceConfig(options);
  const iso = () => now().toISOString();

  function applicationFeeFor(amountCents: number): number {
    const amount = Math.round((amountCents * fee.basisPoints) / 10_000) + fee.fixedCents;
    if (amount >= amountCents) throw new PosServiceError('fee_exceeds_amount', 'The platform fee would equal or exceed the payment.');
    return amount;
  }

  function advance(record: MerchantRecord, to: MerchantStage, note: string): void {
    if (stageRank(to) <= stageRank(record.stage)) return;
    record.history.push({ at: iso(), from: record.stage, to, note });
    record.stage = to;
  }

  function block(record: MerchantRecord, code: string, detail: string): void {
    if (record.blocked?.code === code && record.blocked.detail === detail) return;
    record.blocked = { code, detail, at: iso() };
  }

  function unblock(record: MerchantRecord, codes: string[]): void {
    if (record.blocked && codes.includes(record.blocked.code)) record.blocked = null;
  }

  function prepare(record: MerchantRecord, kind: PreparedMessage['kind'], subject: string, body: string): void {
    record.messages.push({ id: `msg_${randomUUID()}`, kind, to: record.contactEmail, subject, body, preparedAt: iso(), sentAt: null });
  }

  function assertMode(record: MerchantRecord): void {
    if (record.livemode !== stripe.livemode) {
      throw new PosServiceError('mode_mismatch', 'This merchant was created in a different Stripe mode than the configured key.', 409);
    }
  }

  async function mutate(id: string, change: (record: MerchantRecord) => Promise<void>): Promise<MerchantRecord> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await store.get(id);
      if (!current) throw new PosServiceError('not_found', 'Merchant not found.', 404);
      const next = structuredClone(current);
      await change(next);
      // Nothing changed (a repeated sync, a duplicate webhook): no write, no version bump, no audit.
      if (JSON.stringify(next) === JSON.stringify(current)) return current;
      next.updatedAt = iso();
      try {
        await store.update(next, current.version);
        const stored = { ...next, version: current.version + 1 };
        await observer?.changed(current, stored);
        return stored;
      } catch (error) {
        // Every Stripe write inside `change` carries an idempotency key, so a retry is safe.
        if (error instanceof MerchantConflictError && attempt < 2) continue;
        throw error;
      }
    }
    throw new PosServiceError('conflict', 'Merchant kept changing; try again.', 409);
  }

  async function ensureLocation(record: MerchantRecord): Promise<void> {
    if (record.locationId || !record.stripeAccountId || !isAtLeast(record.stage, 'verified')) return;
    const location = await stripe.v1<Obj>({
      method: 'POST',
      path: '/v1/terminal/locations',
      account: record.stripeAccountId,
      idempotencyKey: `pos-service:location:${record.id}`,
      params: {
        display_name: record.businessName.slice(0, 1000),
        address: {
          line1: record.address.line1,
          line2: record.address.line2,
          city: record.address.city,
          state: record.address.state,
          postal_code: record.address.postalCode,
          country: 'US',
        },
        metadata: { merchant_id: record.id },
      },
    });
    if (typeof location.id !== 'string' || !location.id.startsWith('tml_')) {
      throw new PosServiceError('invalid_stripe_response', 'Stripe did not return a Terminal location.', 502);
    }
    record.locationId = location.id;
    advance(record, 'location_ready', 'Store location created on the merchant account.');
    applyHardware(record);
  }

  function applyHardware(record: MerchantRecord): void {
    const order = record.hardwareOrder;
    if (!order) return;
    const outcome = hardwareOutcome(order.status as Parameters<typeof hardwareOutcome>[0]);
    if ('blocked' in outcome) {
      block(record, outcome.blocked.code, outcome.blocked.detail);
      return;
    }
    unblock(record, ['hardware_order_canceled', 'hardware_undeliverable']);
    // Hardware can ship before Stripe finishes verifying the merchant; it counts once the location exists.
    if (!isAtLeast(record.stage, 'location_ready')) return;
    const before = record.stage;
    advance(record, outcome.stage, `Card reader order ${order.id} is ${order.status}.`);
    if (before !== record.stage && record.stage === 'reader_shipped') {
      const tracking = order.tracking.map((t) => [t.carrier, t.trackingNumber].filter(Boolean).join(' ')).filter(Boolean);
      prepare(record, 'reader_shipped', 'Your card reader has shipped',
        `Your card reader is on the way.${tracking.length ? ` Tracking: ${tracking.join(', ')}.` : ''}`);
    }
    if (before !== record.stage && record.stage === 'reader_delivered') {
      prepare(record, 'reader_delivered', 'Your card reader arrived: register it',
        'Turn on the reader, open its settings to show the registration code, and enter that code in your POS setup screen.');
    }
  }

  const saleKey = (record: MerchantRecord) => `pos-service:test-sale:${record.id}:${record.testSale.attempt}`;
  const saleStatus = (record: MerchantRecord): MerchantRecord['testSale']['status'] => record.testSale.status;

  function goLive(record: MerchantRecord, note: string): void {
    unblock(record, ['test_sale_refund_incomplete']);
    advance(record, 'live', note);
    prepare(record, 'go_live', 'Your POS is live',
      'Your card reader completed a real test sale, and it has been refunded. You can take payments now.');
  }

  /**
   * Bring the test sale in line with its PaymentIntent. Stripe's server-driven flow: a new intent and
   * a reader waiting for a tap are both `requires_payment_method`; an approved manual-capture payment
   * is `requires_capture`; a decline returns the intent to `requires_payment_method` with
   * `last_payment_error`. A reader-side failure (customer cancel, connection error) arrives as
   * `readerFailure` from terminal.reader.action_failed or an operator cancel.
   */
  async function settleTestSale(record: MerchantRecord, readerFailure?: string): Promise<void> {
    const sale = record.testSale;
    if (!sale.paymentIntentId || sale.status === 'refunded' || !record.stripeAccountId) return;
    const account = record.stripeAccountId;
    const keyBase = saleKey(record);
    let intent = await stripe.v1<Obj>({
      method: 'GET',
      path: `/v1/payment_intents/${sale.paymentIntentId}`,
      account,
      params: { expand: ['latest_charge'] },
    });
    if (intent.status === 'requires_capture') {
      intent = await stripe.v1<Obj>({ method: 'POST', path: `/v1/payment_intents/${sale.paymentIntentId}/capture`, account, idempotencyKey: `${keyBase}:capture` });
    }
    if (intent.status === 'succeeded') {
      if (asObj(intent.latest_charge)?.refunded === true) {
        // Refunded in full, possibly by hand in the Stripe Dashboard after an incomplete refund.
        sale.status = 'refunded';
        sale.failure = null;
        goLive(record, 'Test sale captured and refunded on the real reader.');
        return;
      }
      // Waiting for the refund to be finished in the Stripe Dashboard; never refund twice from here.
      if (sale.failure?.startsWith('refund_')) return;
      sale.status = 'captured';
      sale.failure = null;
      const refund = await stripe.v1<Obj>({
        method: 'POST',
        path: '/v1/refunds',
        account,
        idempotencyKey: `${keyBase}:refund`,
        params: {
          payment_intent: sale.paymentIntentId,
          refund_application_fee: applicationFeeFor(testSaleAmount) > 0 ? true : undefined,
          metadata: { merchant_id: record.id, purpose: 'go_live_test' },
        },
      });
      if (typeof refund.id === 'string' && (refund.status === 'succeeded' || refund.status === 'pending')) {
        sale.status = 'refunded';
        sale.refundId = refund.id;
        goLive(record, 'Test sale captured and refunded on the real reader.');
      } else {
        const status = typeof refund.status === 'string' ? refund.status : 'unknown';
        sale.status = 'failed';
        sale.failure = `refund_${status}`;
        block(record, 'test_sale_refund_incomplete',
          `The test sale was captured but its refund is ${status}. Refund it in the Stripe Dashboard, then check the test sale again.`);
      }
      return;
    }
    if (sale.status === 'failed') return;
    const lastError = asObj(intent.last_payment_error);
    if (intent.status === 'canceled' || (intent.status === 'requires_payment_method' && (lastError || readerFailure))) {
      sale.status = 'failed';
      sale.failure = typeof lastError?.code === 'string' ? lastError.code : readerFailure ?? String(intent.status);
    }
  }

  const api = {
    applicationFeeFor,

    async getMerchant(id: string): Promise<MerchantRecord> {
      const record = await store.get(id);
      if (!record) throw new PosServiceError('not_found', 'Merchant not found.', 404);
      return record;
    },

    async listMerchants(page?: MerchantPage): Promise<MerchantRecord[]> {
      return store.list(page);
    },

    async purchase(input: PurchaseInput): Promise<MerchantRecord> {
      const purchaseRef = text(input.purchaseRef, 'Purchase reference', 200);
      const existing = await store.findByPurchaseRef(purchaseRef);
      if (existing) return existing;
      const contactEmail = text(input.contactEmail, 'Contact email', 254).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) throw new PosServiceError('invalid_input', 'Contact email is not valid.');
      const at = iso();
      const record: MerchantRecord = {
        id: newId(),
        version: 1,
        livemode: stripe.livemode,
        purchaseRef,
        businessName: text(input.businessName, 'Business name', 200),
        contactEmail,
        address: validateAddress(input.address),
        stage: 'purchased',
        blocked: null,
        stripeAccountId: null,
        cardPayments: 'unrequested',
        requirementsDue: [],
        onboardingLink: null,
        locationId: null,
        hardwareOrder: null,
        reader: null,
        testSale: { attempt: 0, paymentIntentId: null, status: 'not_started', refundId: null, failure: null },
        messages: [],
        history: [],
        createdAt: at,
        updatedAt: at,
      };
      try {
        await store.create(record);
      } catch (error) {
        // A concurrent request for the same purchase won; hand back its merchant.
        const winner = error instanceof MerchantExistsError ? await store.findByPurchaseRef(purchaseRef) : null;
        if (winner) return winner;
        throw error;
      }
      await observer?.changed(null, record);
      return record;
    },

    /** Record that a prepared customer message went out. Sending is done by whoever holds the relationship. */
    async markMessageSent(merchantId: string, messageId: string): Promise<MerchantRecord> {
      return mutate(merchantId, async (record) => {
        const message = record.messages.find((m) => m.id === messageId);
        if (!message) throw new PosServiceError('message_not_found', 'Message not found.', 404);
        if (!message.sentAt) message.sentAt = iso();
      });
    },

    /** Create the merchant's Stripe account (once) and a fresh hosted onboarding link. */
    async startOnboarding(id: string): Promise<MerchantRecord> {
      return mutate(id, async (record) => {
        assertMode(record);
        if (isAtLeast(record.stage, 'verified')) return;
        if (!record.stripeAccountId) {
          const account = await stripe.v2<Obj>({
            method: 'POST',
            path: '/v2/core/accounts',
            idempotencyKey: `pos-service:account:${record.id}`,
            body: {
              contact_email: record.contactEmail,
              display_name: record.businessName,
              identity: { country: 'us' },
              configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
              defaults: {
                responsibilities: {
                  fees_collector: CONNECT_ACCOUNT_SETTINGS.feesCollector,
                  losses_collector: CONNECT_ACCOUNT_SETTINGS.lossesCollector,
                },
              },
              dashboard: CONNECT_ACCOUNT_SETTINGS.dashboard,
              include: ['configuration.merchant', 'requirements'],
              metadata: { merchant_id: record.id, purchase_ref: record.purchaseRef },
            },
          });
          if (typeof account.id !== 'string' || !account.id.startsWith('acct_')) {
            throw new PosServiceError('invalid_stripe_response', 'Stripe did not return an account.', 502);
          }
          record.stripeAccountId = account.id;
          record.cardPayments = readCardPaymentsStatus(account);
          advance(record, 'account_created', 'Stripe account created for the merchant.');
        }
        const link = await stripe.v2<Obj>({
          method: 'POST',
          path: '/v2/core/account_links',
          body: {
            account: record.stripeAccountId,
            use_case: {
              type: 'account_onboarding',
              account_onboarding: { configurations: ['merchant'], return_url: returnUrl, refresh_url: refreshUrl },
            },
          },
        });
        if (typeof link.url !== 'string' || !link.url.startsWith('https://')) {
          throw new PosServiceError('invalid_stripe_response', 'Stripe did not return an onboarding link.', 502);
        }
        record.onboardingLink = { url: link.url, expiresAt: typeof link.expires_at === 'string' ? link.expires_at : null };
        advance(record, 'onboarding', 'Hosted onboarding link issued.');
        prepare(record, 'onboarding_link', 'Finish setting up card payments',
          `Verify your business with Stripe to start taking card payments: ${link.url}\nThe link is single-use; ask for a new one if it expires.`);
      });
    },

    /** Re-read the merchant's Stripe account and move the lifecycle to match. */
    async syncAccount(ref: { merchantId: string } | { stripeAccountId: string }): Promise<MerchantRecord> {
      const found = 'merchantId' in ref ? await store.get(ref.merchantId) : await store.findByStripeAccount(ref.stripeAccountId);
      if (!found) throw new PosServiceError('not_found', 'Merchant not found.', 404);
      if (!found.stripeAccountId) throw new PosServiceError('not_onboarding', 'This merchant has no Stripe account yet.', 409);
      const account = await stripe.v2<Obj>({
        method: 'GET',
        path: `/v2/core/accounts/${found.stripeAccountId}`,
        query: { include: ['configuration.merchant', 'requirements'] },
      });
      return mutate(found.id, async (record) => {
        assertMode(record);
        const previousDue = JSON.stringify(record.requirementsDue.map((r) => r.description).sort());
        record.cardPayments = readCardPaymentsStatus(account);
        record.requirementsDue = readUserRequirements(account);
        if (record.cardPayments === 'active') {
          unblock(record, ['requirements_due', 'stripe_review', 'card_payments_unsupported']);
          advance(record, 'verified', 'Stripe activated card payments.');
          await ensureLocation(record);
          return;
        }
        if (record.cardPayments === 'unsupported') {
          block(record, 'card_payments_unsupported', 'Stripe does not support card payments for this business.');
          return;
        }
        if (record.requirementsDue.length) {
          block(record, 'requirements_due', `Stripe needs: ${record.requirementsDue.map((r) => r.description).join(', ')}.`);
          const nowDue = JSON.stringify(record.requirementsDue.map((r) => r.description).sort());
          if (nowDue !== previousDue) {
            prepare(record, 'requirements_due', 'Stripe needs more information',
              'Stripe needs a few more details before card payments can start. Open your POS setup screen for a fresh verification link.');
          }
          return;
        }
        if (record.cardPayments === 'restricted') {
          block(record, 'stripe_review', 'Stripe is reviewing the account; no action is requested yet.');
        }
      });
    },

    async recordHardwareOrder(merchantId: string, order: unknown): Promise<MerchantRecord> {
      const snapshot = readHardwareOrder(order);
      if (!snapshot) throw new PosServiceError('invalid_hardware_order', 'Not a Terminal hardware order.');
      return mutate(merchantId, async (record) => {
        assertMode(record);
        const previous = record.hardwareOrder;
        // A later snapshot of the same order may omit tracking; never lose numbers already known.
        const tracking = snapshot.tracking.length || previous?.id !== snapshot.id ? snapshot.tracking : previous.tracking;
        record.hardwareOrder = { ...snapshot, tracking };
        applyHardware(record);
        if ((snapshot.status === 'undeliverable' || snapshot.status === 'canceled') && (previous?.id !== snapshot.id || previous.status !== snapshot.status)) {
          prepare(record, 'hardware_problem', 'There is a problem with your card reader order', record.blocked?.detail ?? snapshot.status);
        }
      });
    },

    async registerReader(merchantId: string, input: { registrationCode: string; label: string }): Promise<MerchantRecord> {
      const code = text(input.registrationCode, 'Registration code', 64);
      if (!/^[A-Za-z0-9-]+$/.test(code)) throw new PosServiceError('invalid_input', 'Registration code may contain letters, digits and dashes only.');
      const label = text(input.label, 'Reader label', 64);
      return mutate(merchantId, async (record) => {
        assertMode(record);
        if (!record.locationId || !isAtLeast(record.stage, 'location_ready')) {
          throw new PosServiceError('not_ready', 'Stripe has not verified this merchant yet, so there is no store location to register a reader to.', 409);
        }
        if (record.reader) throw new PosServiceError('reader_already_registered', 'A reader is already registered for this merchant.', 409);
        const reader = await stripe.v1<Obj>({
          method: 'POST',
          path: '/v1/terminal/readers',
          account: record.stripeAccountId!,
          idempotencyKey: `pos-service:reader:${record.id}:${sha(code).slice(0, 16)}`,
          params: { registration_code: code, label, location: record.locationId, metadata: { merchant_id: record.id } },
        });
        if (typeof reader.id !== 'string' || !reader.id.startsWith('tmr_')) {
          throw new PosServiceError('invalid_stripe_response', 'Stripe did not return a reader.', 502);
        }
        const deviceType = typeof reader.device_type === 'string' ? reader.device_type : 'unknown';
        if (!compatibleReaders.has(deviceType)) {
          await stripe.v1({ method: 'DELETE', path: `/v1/terminal/readers/${reader.id}`, account: record.stripeAccountId! }).catch(() => undefined);
          block(record, 'incompatible_reader', `A ${deviceType} reader cannot run this POS. Use a Stripe Reader S700 or BBPOS WisePOS E.`);
          return;
        }
        unblock(record, ['incompatible_reader']);
        record.reader = { id: reader.id, deviceType, label };
        advance(record, 'reader_registered', `Reader ${reader.id} (${deviceType}) registered to the store location.`);
      });
    },

    /** Put a small real sale on the reader. The owner taps a card; `advanceTestSale` captures and refunds it. */
    async startTestSale(merchantId: string): Promise<MerchantRecord> {
      return mutate(merchantId, async (record) => {
        assertMode(record);
        if (record.stage === 'live') throw new PosServiceError('already_live', 'This merchant is already live.', 409);
        if (!record.reader || !isAtLeast(record.stage, 'reader_registered')) {
          throw new PosServiceError('not_ready', 'Register a card reader before the test sale.', 409);
        }
        if (record.testSale.status === 'waiting_for_card' || record.testSale.status === 'captured') {
          throw new PosServiceError('test_sale_in_progress', 'A test sale is already in progress.', 409);
        }
        if (record.testSale.failure?.startsWith('refund_')) {
          throw new PosServiceError('test_sale_refund_incomplete',
            'The last test sale was captured but not refunded. Refund it in the Stripe Dashboard, then check the test sale again.', 409);
        }
        if (record.testSale.paymentIntentId) {
          // The card may have gone through after the failure was recorded: finish that sale instead of charging again.
          await settleTestSale(record);
          if (saleStatus(record) !== 'failed') return;
          // Stripe: cancel a failed PaymentIntent before creating a new one, so it can never be charged twice.
          await stripe
            .v1({ method: 'POST', path: `/v1/payment_intents/${record.testSale.paymentIntentId}/cancel`, account: record.stripeAccountId!, idempotencyKey: `${saleKey(record)}:cancel` })
            .catch((error: unknown) => {
              if (!(error instanceof StripeRequestError && error.code === 'payment_intent_unexpected_state')) throw error;
            });
        }
        const attempt = record.testSale.attempt + 1;
        const applicationFee = applicationFeeFor(testSaleAmount);
        const keyBase = `pos-service:test-sale:${record.id}:${attempt}`;
        const intent = await stripe.v1<Obj>({
          method: 'POST',
          path: '/v1/payment_intents',
          account: record.stripeAccountId!,
          idempotencyKey: `${keyBase}:intent`,
          params: {
            amount: testSaleAmount,
            currency: 'usd',
            payment_method_types: ['card_present'],
            capture_method: 'manual',
            ...(applicationFee > 0 ? { application_fee_amount: applicationFee } : {}),
            description: 'Go-live test sale (refunded)',
            metadata: { merchant_id: record.id, purpose: 'go_live_test', attempt: String(attempt) },
          },
        });
        if (typeof intent.id !== 'string' || !intent.id.startsWith('pi_')) {
          throw new PosServiceError('invalid_stripe_response', 'Stripe did not return a payment intent.', 502);
        }
        await stripe.v1({
          method: 'POST',
          path: `/v1/terminal/readers/${record.reader.id}/process_payment_intent`,
          account: record.stripeAccountId!,
          idempotencyKey: `${keyBase}:process`,
          params: { payment_intent: intent.id },
        });
        record.testSale = { attempt, paymentIntentId: intent.id, status: 'waiting_for_card', refundId: null, failure: null };
        advance(record, 'test_sale', 'Go-live test sale sent to the reader.');
      });
    },

    /** Re-check the test sale with Stripe: capture and refund an approved card, or record why it failed. */
    async advanceTestSale(merchantId: string, input: { readerFailure?: string } = {}): Promise<MerchantRecord> {
      return mutate(merchantId, async (record) => {
        assertMode(record);
        await settleTestSale(record, input.readerFailure);
      });
    },

    /**
     * Stop a test sale the reader is still waiting on (Stripe's advice when a reader drops mid-payment).
     * A reader that is already authorizing a card cannot be interrupted, so that payment is left to finish.
     */
    async cancelTestSale(merchantId: string): Promise<MerchantRecord> {
      return mutate(merchantId, async (record) => {
        assertMode(record);
        if (record.testSale.status !== 'waiting_for_card' || !record.reader) {
          throw new PosServiceError('no_test_sale_waiting', 'No test sale is waiting for a card.', 409);
        }
        try {
          await stripe.v1({
            method: 'POST',
            path: `/v1/terminal/readers/${record.reader.id}/cancel_action`,
            account: record.stripeAccountId!,
            idempotencyKey: `${saleKey(record)}:cancel_action`,
          });
        } catch (error) {
          if (error instanceof StripeRequestError && error.code === 'terminal_reader_busy') {
            throw new PosServiceError('reader_busy', 'The reader is authorizing a card right now. Wait a few seconds, then check the test sale.', 409);
          }
          // An offline or unreachable reader has nothing to cancel; the payment's own state decides below.
          if (!(error instanceof StripeRequestError)) throw error;
        }
        await settleTestSale(record, 'canceled_by_operator');
      });
    },

    /**
     * Verify and route a Stripe webhook. Handlers are idempotent, so an event is recorded only
     * after it has been processed; a duplicate delivery of a recorded event is skipped.
     */
    async handleWebhook(input: {
      payload: string;
      signatureHeader: string | null;
      /** One signing secret per Stripe event destination that posts here (thin account events, Connect snapshot events). */
      secret: string | readonly string[] | null;
      nowSeconds?: number;
    }) {
      const secrets = (typeof input.secret === 'string' || input.secret === null ? [input.secret] : [...input.secret]).filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      );
      let check: SignatureCheck = { ok: false, reason: 'missing_secret' };
      for (const secret of secrets) {
        check = verifyStripeSignature({ payload: input.payload, header: input.signatureHeader, secret, nowSeconds: input.nowSeconds });
        if (check.ok) break;
      }
      if (!check.ok) throw new PosServiceError('invalid_signature', `Webhook rejected: ${check.reason}.`, 400);
      let event: Obj;
      try {
        event = JSON.parse(input.payload) as Obj;
      } catch {
        throw new PosServiceError('invalid_payload', 'Webhook body is not JSON.', 400);
      }
      const eventId = typeof event.id === 'string' ? event.id : null;
      const type = typeof event.type === 'string' ? event.type : '';
      if (!eventId || !type) throw new PosServiceError('invalid_payload', 'Webhook event has no id or type.', 400);
      if (await store.hasEvent(eventId)) return { handled: false, action: 'duplicate' as const };

      let result: { handled: boolean; action: string; merchantId?: string } = { handled: false, action: 'ignored' };
      const object = asObj(asObj(event.data)?.object);
      if (type.startsWith('v2.core.account')) {
        const accountId = asObj(event.related_object)?.id;
        if (typeof accountId === 'string' && (await store.findByStripeAccount(accountId))) {
          const record = await api.syncAccount({ stripeAccountId: accountId });
          result = { handled: true, action: 'account_synced', merchantId: record.id };
        }
      } else if (type === 'account.updated' && typeof object?.id === 'string') {
        if (await store.findByStripeAccount(object.id)) {
          const record = await api.syncAccount({ stripeAccountId: object.id });
          result = { handled: true, action: 'account_synced', merchantId: record.id };
        }
      } else if (type.startsWith('terminal.hardware_order.') && object) {
        const merchantId = asObj(object.metadata)?.merchant_id;
        if (typeof merchantId === 'string' && (await store.get(merchantId))) {
          const record = await api.recordHardwareOrder(merchantId, object);
          result = { handled: true, action: 'hardware_order_recorded', merchantId: record.id };
        }
      } else if ((type === 'terminal.reader.action_succeeded' || type === 'terminal.reader.action_failed') && object) {
        const action = asObj(object.action);
        const intentId = asObj(action?.process_payment_intent)?.payment_intent;
        const merchant = typeof event.account === 'string' ? await store.findByStripeAccount(event.account) : null;
        if (merchant && typeof intentId === 'string' && merchant.reader?.id === object.id && merchant.testSale.paymentIntentId === intentId) {
          const failure = type === 'terminal.reader.action_failed' && typeof action?.failure_code === 'string' ? action.failure_code : undefined;
          const record = await api.advanceTestSale(merchant.id, failure ? { readerFailure: failure } : {});
          result = { handled: true, action: 'test_sale_advanced', merchantId: record.id };
        }
      } else if (type.startsWith('payment_intent.') && object) {
        const metadata = asObj(object.metadata);
        const merchantId = metadata?.merchant_id;
        if (metadata?.purpose === 'go_live_test' && typeof merchantId === 'string') {
          const merchant = await store.get(merchantId);
          if (merchant && merchant.stripeAccountId && merchant.stripeAccountId === event.account && merchant.testSale.paymentIntentId === object.id) {
            const record = await api.advanceTestSale(merchantId);
            result = { handled: true, action: 'test_sale_advanced', merchantId: record.id };
          }
        }
      }
      await store.recordEvent(eventId);
      return result;
    },
  };
  return api;
}

export type PosService = ReturnType<typeof createPosService>;
