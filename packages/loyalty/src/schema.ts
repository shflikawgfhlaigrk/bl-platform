/**
 * @blacklabel/loyalty — row types. Extends CoreDatabase per /CONVENTIONS.md.
 *
 * Deterministic earn/redeem, rewards, gift-card + store-credit liability
 * ledgers, expiry, and fraud controls. References customer profiles by
 * `profile_id` STRING only (no import/join into customers/crm).
 *
 * Conventions:
 * - ids: TEXT nanoid via id()
 * - timestamps: TEXT ISO-8601 UTC via nowIso()
 * - money: INTEGER cents (*_cents). Program-native ledger `amount` is a signed
 *   integer whose unit (punches or cents) is defined by the program.
 * - JSON (rules, trace): TEXT, serialized in code.
 */
import type { CoreDatabase } from '@blacklabel/core';

export type ProgramStatus = 'active' | 'paused';
export const PROGRAM_STATUSES: readonly ProgramStatus[] = ['active', 'paused'];

export type RewardKind = 'store_credit_cents' | 'percent_off_bps';
export const REWARD_KINDS: readonly RewardKind[] = ['store_credit_cents', 'percent_off_bps'];

export type LedgerKind = 'earn' | 'redeem' | 'expire' | 'adjust' | 'revoke';
export const LEDGER_KINDS: readonly LedgerKind[] = ['earn', 'redeem', 'expire', 'adjust', 'revoke'];

export type GiftCardStatus = 'active' | 'redeemed' | 'void';
export type GiftCardLedgerKind = 'issue' | 'redeem' | 'adjust' | 'void';
export const GIFT_CARD_LEDGER_KINDS: readonly GiftCardLedgerKind[] = [
  'issue',
  'redeem',
  'adjust',
  'void',
];

export type StoreCreditLedgerKind = 'issue' | 'redeem' | 'adjust' | 'void' | 'expire';
export const STORE_CREDIT_LEDGER_KINDS: readonly StoreCreditLedgerKind[] = [
  'issue',
  'redeem',
  'adjust',
  'void',
  'expire',
];

export type RedemptionStatus = 'issued' | 'consumed' | 'void';

export interface LoyaltyProgramRow {
  id: string;
  tenant_id: string;
  name: string;
  /** JSON: { earnPerDollarBps } OR { punchThresholdCents, punchesForReward }. */
  rules: string;
  reward_kind: RewardKind;
  /** cents (store_credit_cents) or bps (percent_off_bps). */
  reward_value: number;
  expiry_months: number | null;
  /** Per-account daily earn cap in program-native units; null = no cap. */
  daily_earn_cap: number | null;
  status: ProgramStatus;
  created_at: string;
  updated_at: string;
}

export interface LoyaltyAccountRow {
  id: string;
  tenant_id: string;
  program_id: string;
  /** customers profile id (string ref only). */
  profile_id: string;
  created_at: string;
  updated_at: string;
}

/** APPEND-ONLY. Balance = SUM(amount). idempotency_key UNIQUE per tenant. */
export interface LoyaltyLedgerRow {
  id: string;
  tenant_id: string;
  account_id: string;
  kind: LedgerKind;
  /** Signed program-native units (earn +, redeem/expire/revoke -, adjust ±). */
  amount: number;
  order_id: string | null;
  idempotency_key: string | null;
  /** JSON deterministic computation trace. */
  trace: string;
  reason: string | null;
  created_at: string;
}

export interface LoyaltyGiftCardRow {
  id: string;
  tenant_id: string;
  code: string;
  status: GiftCardStatus;
  initial_cents: number;
  created_at: string;
  updated_at: string;
}

/** APPEND-ONLY. Balance = SUM(amount_cents). */
export interface LoyaltyGiftCardLedgerRow {
  id: string;
  tenant_id: string;
  gift_card_id: string;
  kind: GiftCardLedgerKind;
  /** Signed cents (issue +, redeem/void -, adjust ±). */
  amount_cents: number;
  order_id: string | null;
  reason: string | null;
  created_at: string;
}

/** APPEND-ONLY per profile. Balance = SUM(amount_cents). */
export interface LoyaltyStoreCreditLedgerRow {
  id: string;
  tenant_id: string;
  profile_id: string;
  kind: StoreCreditLedgerKind;
  amount_cents: number;
  order_id: string | null;
  reason: string | null;
  created_at: string;
}

/** A redemption record consumable by orders as a tender reference. */
export interface LoyaltyRedemptionRow {
  id: string;
  tenant_id: string;
  account_id: string;
  program_id: string;
  ledger_id: string;
  /** Human-usable tender reference code. */
  reference: string;
  reward_kind: RewardKind;
  reward_value: number;
  /** Program-native units consumed by this redemption. */
  amount: number;
  status: RedemptionStatus;
  order_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface LoyaltyDatabase extends CoreDatabase {
  loyalty_programs: LoyaltyProgramRow;
  loyalty_accounts: LoyaltyAccountRow;
  loyalty_ledger: LoyaltyLedgerRow;
  loyalty_gift_cards: LoyaltyGiftCardRow;
  loyalty_gift_card_ledger: LoyaltyGiftCardLedgerRow;
  loyalty_store_credit_ledger: LoyaltyStoreCreditLedgerRow;
  loyalty_redemptions: LoyaltyRedemptionRow;
}
