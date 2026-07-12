/**
 * @blacklabel/loyalty — deterministic loyalty/rewards, gift-card + store-credit
 * liability ledgers, expiry, and fraud controls.
 *
 * References customer profiles by `profile_id` STRING only — never imports
 * customers or crm. Every computation is dad-explainable and carries a trace.
 *
 * Internal events emitted (module.entity.verb; ids + integer amounts only,
 * NO PII):
 *   loyalty.points.earned    { v:1, accountId, amount }
 *   loyalty.reward.redeemed  { v:1, accountId, redemptionId, amount }
 *
 * Integrator wiring:
 *   - earnForOrder({programId, profileId, orderId, totalCents, idempotencyKey})
 *     is called by the orders module on order.paid; replay-safe (unique
 *     idempotency_key per tenant -> an order earns ONCE).
 *   - redeem(...) returns a redemption whose `reference` is a tender code;
 *     orders consumes it via consumeRedemption(reference, orderId).
 *   - gift-card liability is exposed at GET /gift-cards/liability.
 */
export const MODULE_KEY = 'loyalty' as const;

// Migrations
export { loyaltyMigrations } from './migrations';

// Router factory
export { loyaltyRouter } from './router';

// Public types
export type {
  LoyaltyDatabase,
  LoyaltyProgramRow,
  LoyaltyAccountRow,
  LoyaltyLedgerRow,
  LoyaltyGiftCardRow,
  LoyaltyGiftCardLedgerRow,
  LoyaltyStoreCreditLedgerRow,
  LoyaltyRedemptionRow,
  ProgramStatus,
  RewardKind,
  LedgerKind,
  GiftCardStatus,
  RedemptionStatus,
} from './schema';
export {
  PROGRAM_STATUSES,
  REWARD_KINDS,
  LEDGER_KINDS,
  GIFT_CARD_LEDGER_KINDS,
  STORE_CREDIT_LEDGER_KINDS,
} from './schema';

// Pure math (deterministic, dad-explainable)
export { computeEarn, applyDailyCap, isPointsRules, isPunchRules } from './math';
export type { ProgramRules, PointsRules, PunchRules, EarnTrace } from './math';

// Service functions (integrator programmatic use)
export {
  createProgram,
  ensureAccount,
  accountBalance,
  earnForOrder,
  redeem,
  getRedemptionByReference,
  consumeRedemption,
  giftCardLiability,
  giftCardBalance,
  issueGiftCard,
  redeemGiftCard,
  voidGiftCard,
  storeCreditBalance,
  issueStoreCredit,
  redeemStoreCredit,
  expireDue,
} from './service';
export type { ProgramInput, EarnInput, RedeemInput, LiabilitySummary, ExpireSummary } from './service';
