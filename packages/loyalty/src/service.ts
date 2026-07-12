/**
 * Tenant-scoped loyalty business logic. Deterministic math (see math.ts),
 * append-only ledgers, exact liability, and fraud controls. Every mutation is
 * tenant-scoped and audited. Customer profiles are referenced by id string.
 */
import { randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import type { Kysely } from 'kysely';
import { ApiError, asCoreDb, audit, id, nowIso, type EventBus } from '@blacklabel/core';
import type {
  GiftCardStatus,
  LoyaltyAccountRow,
  LoyaltyDatabase,
  LoyaltyGiftCardLedgerRow,
  LoyaltyGiftCardRow,
  LoyaltyLedgerRow,
  LoyaltyProgramRow,
  LoyaltyRedemptionRow,
  LoyaltyStoreCreditLedgerRow,
  ProgramStatus,
  RewardKind,
} from './schema';
import { applyDailyCap, computeEarn, type ProgramRules } from './math';

type Db = Kysely<LoyaltyDatabase>;

/** Business day grouping is America/New_York per platform convention. */
const BUSINESS_ZONE = 'America/New_York';

/** Crockford-ish alphabet: no ambiguous I, L, O, U. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function generateCode(length = 12): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return out;
}

/* ------------------------------------------------------------------ *
 * Programs
 * ------------------------------------------------------------------ */

export interface ProgramInput {
  name: string;
  rules: ProgramRules;
  rewardKind: RewardKind;
  rewardValue: number;
  expiryMonths?: number | null;
  dailyEarnCap?: number | null;
  status?: ProgramStatus;
}

export async function createProgram(
  db: Db,
  tenantId: string,
  actor: string,
  input: ProgramInput,
): Promise<LoyaltyProgramRow> {
  // Validate rules shape early (throws on malformed).
  computeEarn(input.rules, 0);
  if (!Number.isInteger(input.rewardValue) || input.rewardValue < 0) {
    throw ApiError.badRequest('rewardValue must be a non-negative integer');
  }
  const now = nowIso();
  const row: LoyaltyProgramRow = {
    id: id(),
    tenant_id: tenantId,
    name: input.name,
    rules: JSON.stringify(input.rules),
    reward_kind: input.rewardKind,
    reward_value: input.rewardValue,
    expiry_months: input.expiryMonths ?? null,
    daily_earn_cap: input.dailyEarnCap ?? null,
    status: input.status ?? 'active',
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('loyalty_programs').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'loyalty.program.created', 'loyalty.program', row.id);
  return row;
}

export async function getProgram(db: Db, tenantId: string, programId: string): Promise<LoyaltyProgramRow> {
  const row = await db
    .selectFrom('loyalty_programs')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', programId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`program not found: ${programId}`);
  return row;
}

export async function listPrograms(db: Db, tenantId: string): Promise<LoyaltyProgramRow[]> {
  return db
    .selectFrom('loyalty_programs')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

export async function updateProgram(
  db: Db,
  tenantId: string,
  actor: string,
  programId: string,
  patch: { status?: ProgramStatus; rewardValue?: number; dailyEarnCap?: number | null; expiryMonths?: number | null },
): Promise<LoyaltyProgramRow> {
  await getProgram(db, tenantId, programId);
  const set: Record<string, string | number | null> = { updated_at: nowIso() };
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.rewardValue !== undefined) set.reward_value = patch.rewardValue;
  if (patch.dailyEarnCap !== undefined) set.daily_earn_cap = patch.dailyEarnCap;
  if (patch.expiryMonths !== undefined) set.expiry_months = patch.expiryMonths;
  await db
    .updateTable('loyalty_programs')
    .set(set)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', programId)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'loyalty.program.updated', 'loyalty.program', programId, patch);
  return getProgram(db, tenantId, programId);
}

/* ------------------------------------------------------------------ *
 * Accounts + balance
 * ------------------------------------------------------------------ */

async function getOrCreateAccount(
  db: Db,
  tenantId: string,
  programId: string,
  profileId: string,
): Promise<LoyaltyAccountRow> {
  const existing = await db
    .selectFrom('loyalty_accounts')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('program_id', '=', programId)
    .where('profile_id', '=', profileId)
    .executeTakeFirst();
  if (existing) return existing;
  const now = nowIso();
  const row: LoyaltyAccountRow = {
    id: id(),
    tenant_id: tenantId,
    program_id: programId,
    profile_id: profileId,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('loyalty_accounts').values(row).execute();
  return row;
}

export async function ensureAccount(
  db: Db,
  tenantId: string,
  programId: string,
  profileId: string,
): Promise<LoyaltyAccountRow> {
  await getProgram(db, tenantId, programId);
  return getOrCreateAccount(db, tenantId, programId, profileId);
}

export async function getAccount(db: Db, tenantId: string, accountId: string): Promise<LoyaltyAccountRow> {
  const row = await db
    .selectFrom('loyalty_accounts')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', accountId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`account not found: ${accountId}`);
  return row;
}

/** Balance = SUM(signed ledger amounts). Exact integer math. */
export async function accountBalance(db: Db, tenantId: string, accountId: string): Promise<number> {
  const rows = await db
    .selectFrom('loyalty_ledger')
    .select('amount')
    .where('tenant_id', '=', tenantId)
    .where('account_id', '=', accountId)
    .execute();
  return rows.reduce((sum, r) => sum + r.amount, 0);
}

export async function listLedger(db: Db, tenantId: string, accountId: string): Promise<LoyaltyLedgerRow[]> {
  return db
    .selectFrom('loyalty_ledger')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('account_id', '=', accountId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

/* ------------------------------------------------------------------ *
 * Earn (replay-safe) + daily cap fraud control
 * ------------------------------------------------------------------ */

export interface EarnInput {
  programId: string;
  profileId: string;
  orderId: string;
  totalCents: number;
  idempotencyKey: string;
}

/**
 * Earn for an order. Replay-safe: the same idempotency_key earns exactly ONCE
 * (unique per tenant). Enforces the per-account daily earn cap.
 */
export async function earnForOrder(
  db: Db,
  tenantId: string,
  actor: string,
  events: EventBus | undefined,
  input: EarnInput,
): Promise<{ ledger: LoyaltyLedgerRow; replayed: boolean }> {
  const program = await getProgram(db, tenantId, input.programId);
  const result = await db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('loyalty_ledger')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirst();
    if (existing) return { ledger: existing, replayed: true };

    const account = await getOrCreateAccount(trx as Db, tenantId, input.programId, input.profileId);
    const rules = JSON.parse(program.rules) as ProgramRules;
    const earnTrace = computeEarn(rules, input.totalCents);

    // Daily cap = earn booked in the America/New_York calendar day of `now`.
    const now = nowIso();
    const dayStartUtc = DateTime.fromISO(now, { zone: 'utc' })
      .setZone(BUSINESS_ZONE)
      .startOf('day')
      .toUTC()
      .toISO()!;
    const todaysEarnRows = await trx
      .selectFrom('loyalty_ledger')
      .select('amount')
      .where('tenant_id', '=', tenantId)
      .where('account_id', '=', account.id)
      .where('kind', '=', 'earn')
      .where('created_at', '>=', dayStartUtc)
      .execute();
    const alreadyToday = todaysEarnRows.reduce((s, r) => s + r.amount, 0);
    const cap = applyDailyCap(earnTrace.earned, alreadyToday, program.daily_earn_cap);

    const ledger: LoyaltyLedgerRow = {
      id: id(),
      tenant_id: tenantId,
      account_id: account.id,
      kind: 'earn',
      amount: cap.granted,
      order_id: input.orderId,
      idempotency_key: input.idempotencyKey,
      trace: JSON.stringify({ ...earnTrace, cap }),
      reason: null,
      created_at: now,
    };
    await trx.insertInto('loyalty_ledger').values(ledger).execute();
    return { ledger, replayed: false };
  });

  if (!result.replayed) {
    await audit(asCoreDb(db), tenantId, actor, 'loyalty.points.earned', 'loyalty.account', result.ledger.account_id, {
      amount: result.ledger.amount,
      orderId: input.orderId,
    });
    if (events) {
      await events.emit(tenantId, 'loyalty.points.earned', {
        v: 1,
        accountId: result.ledger.account_id,
        amount: result.ledger.amount,
      });
    }
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Redeem -> redemption record (consumable by orders as a tender ref)
 * ------------------------------------------------------------------ */

export interface RedeemInput {
  programId: string;
  profileId: string;
  amount: number;
  orderId?: string | null;
}

export async function redeem(
  db: Db,
  tenantId: string,
  actor: string,
  events: EventBus | undefined,
  input: RedeemInput,
): Promise<{ redemption: LoyaltyRedemptionRow; ledger: LoyaltyLedgerRow }> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw ApiError.badRequest('redeem amount must be a positive integer');
  }
  const program = await getProgram(db, tenantId, input.programId);
  const out = await db.transaction().execute(async (trx) => {
    const account = await getOrCreateAccount(trx as Db, tenantId, input.programId, input.profileId);
    const balRows = await trx
      .selectFrom('loyalty_ledger')
      .select('amount')
      .where('tenant_id', '=', tenantId)
      .where('account_id', '=', account.id)
      .execute();
    const balance = balRows.reduce((s, r) => s + r.amount, 0);
    if (input.amount > balance) {
      throw ApiError.conflict(`insufficient balance: have ${balance}, need ${input.amount}`);
    }
    const now = nowIso();
    const ledger: LoyaltyLedgerRow = {
      id: id(),
      tenant_id: tenantId,
      account_id: account.id,
      kind: 'redeem',
      amount: -input.amount,
      order_id: input.orderId ?? null,
      idempotency_key: null,
      trace: JSON.stringify({ model: 'redeem', requested: input.amount, balanceBefore: balance }),
      reason: null,
      created_at: now,
    };
    await trx.insertInto('loyalty_ledger').values(ledger).execute();
    const redemption: LoyaltyRedemptionRow = {
      id: id(),
      tenant_id: tenantId,
      account_id: account.id,
      program_id: input.programId,
      ledger_id: ledger.id,
      reference: generateCode(),
      reward_kind: program.reward_kind,
      reward_value: program.reward_value,
      amount: input.amount,
      status: 'issued',
      order_id: input.orderId ?? null,
      created_at: now,
      updated_at: now,
    };
    await trx.insertInto('loyalty_redemptions').values(redemption).execute();
    return { redemption, ledger };
  });
  await audit(asCoreDb(db), tenantId, actor, 'loyalty.reward.redeemed', 'loyalty.redemption', out.redemption.id, {
    amount: input.amount,
  });
  if (events) {
    await events.emit(tenantId, 'loyalty.reward.redeemed', {
      v: 1,
      accountId: out.redemption.account_id,
      redemptionId: out.redemption.id,
      amount: input.amount,
    });
  }
  return out;
}

export async function getRedemptionByReference(
  db: Db,
  tenantId: string,
  reference: string,
): Promise<LoyaltyRedemptionRow | undefined> {
  return db
    .selectFrom('loyalty_redemptions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('reference', '=', reference)
    .executeTakeFirst();
}

/** Mark a redemption consumed by an order (tender linkage). */
export async function consumeRedemption(
  db: Db,
  tenantId: string,
  actor: string,
  reference: string,
  orderId: string,
): Promise<LoyaltyRedemptionRow> {
  const red = await getRedemptionByReference(db, tenantId, reference);
  if (!red) throw ApiError.notFound(`redemption not found: ${reference}`);
  if (red.status !== 'issued') throw ApiError.conflict(`redemption ${reference} is ${red.status}`);
  await db
    .updateTable('loyalty_redemptions')
    .set({ status: 'consumed', order_id: orderId, updated_at: nowIso() })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', red.id)
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'loyalty.redemption.consumed', 'loyalty.redemption', red.id, { orderId });
  return { ...red, status: 'consumed', order_id: orderId };
}

/* ------------------------------------------------------------------ *
 * Adjust / revoke (audited, reason required)
 * ------------------------------------------------------------------ */

export async function adjustAccount(
  db: Db,
  tenantId: string,
  actor: string,
  accountId: string,
  amount: number,
  reason: string,
): Promise<LoyaltyLedgerRow> {
  if (!reason || reason.trim() === '') throw ApiError.badRequest('adjust requires a reason');
  if (!Number.isInteger(amount) || amount === 0) throw ApiError.badRequest('adjust amount must be a non-zero integer');
  await getAccount(db, tenantId, accountId);
  const row: LoyaltyLedgerRow = {
    id: id(),
    tenant_id: tenantId,
    account_id: accountId,
    kind: amount < 0 ? 'revoke' : 'adjust',
    amount,
    order_id: null,
    idempotency_key: null,
    trace: JSON.stringify({ model: 'adjust', amount, reason }),
    reason,
    created_at: nowIso(),
  };
  await db.insertInto('loyalty_ledger').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'loyalty.account.adjusted', 'loyalty.account', accountId, { amount, reason });
  return row;
}

/* ------------------------------------------------------------------ *
 * Gift cards + liability
 * ------------------------------------------------------------------ */

export async function issueGiftCard(
  db: Db,
  tenantId: string,
  actor: string,
  input: { code?: string; initialCents: number },
): Promise<LoyaltyGiftCardRow> {
  if (!Number.isInteger(input.initialCents) || input.initialCents <= 0) {
    throw ApiError.badRequest('initialCents must be a positive integer');
  }
  const now = nowIso();
  let code = input.code ?? generateCode();
  if (input.code) {
    const clash = await db
      .selectFrom('loyalty_gift_cards')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('code', '=', input.code)
      .executeTakeFirst();
    if (clash) throw ApiError.conflict(`gift card code already exists: ${input.code}`);
  } else {
    // Regenerate on the rare collision.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const clash = await db
        .selectFrom('loyalty_gift_cards')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('code', '=', code)
        .executeTakeFirst();
      if (!clash) break;
      code = generateCode();
    }
  }
  const card: LoyaltyGiftCardRow = {
    id: id(),
    tenant_id: tenantId,
    code,
    status: 'active',
    initial_cents: input.initialCents,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('loyalty_gift_cards').values(card).execute();
  await db
    .insertInto('loyalty_gift_card_ledger')
    .values({
      id: id(),
      tenant_id: tenantId,
      gift_card_id: card.id,
      kind: 'issue',
      amount_cents: input.initialCents,
      order_id: null,
      reason: null,
      created_at: now,
    })
    .execute();
  await audit(asCoreDb(db), tenantId, actor, 'loyalty.gift_card.issued', 'loyalty.gift_card', card.id, {
    initialCents: input.initialCents,
  });
  return card;
}

async function getGiftCard(db: Db, tenantId: string, code: string): Promise<LoyaltyGiftCardRow> {
  const row = await db
    .selectFrom('loyalty_gift_cards')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('code', '=', code)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`gift card not found: ${code}`);
  return row;
}

export async function giftCardBalance(db: Db, tenantId: string, giftCardId: string): Promise<number> {
  const rows = await db
    .selectFrom('loyalty_gift_card_ledger')
    .select('amount_cents')
    .where('tenant_id', '=', tenantId)
    .where('gift_card_id', '=', giftCardId)
    .execute();
  return rows.reduce((s, r) => s + r.amount_cents, 0);
}

export async function redeemGiftCard(
  db: Db,
  tenantId: string,
  actor: string,
  code: string,
  cents: number,
  orderId?: string | null,
): Promise<{ card: LoyaltyGiftCardRow; balance: number }> {
  if (!Number.isInteger(cents) || cents <= 0) throw ApiError.badRequest('redeem cents must be a positive integer');
  return db.transaction().execute(async (trx) => {
    const card = await (async () => {
      const row = await trx
        .selectFrom('loyalty_gift_cards')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('code', '=', code)
        .executeTakeFirst();
      if (!row) throw ApiError.notFound(`gift card not found: ${code}`);
      return row;
    })();
    if (card.status === 'void') throw ApiError.conflict('gift card is void');
    const balRows = await trx
      .selectFrom('loyalty_gift_card_ledger')
      .select('amount_cents')
      .where('tenant_id', '=', tenantId)
      .where('gift_card_id', '=', card.id)
      .execute();
    const balance = balRows.reduce((s, r) => s + r.amount_cents, 0);
    if (cents > balance) throw ApiError.conflict(`insufficient gift card balance: have ${balance}, need ${cents}`);
    const now = nowIso();
    await trx
      .insertInto('loyalty_gift_card_ledger')
      .values({
        id: id(),
        tenant_id: tenantId,
        gift_card_id: card.id,
        kind: 'redeem',
        amount_cents: -cents,
        order_id: orderId ?? null,
        reason: null,
        created_at: now,
      })
      .execute();
    const newBalance = balance - cents;
    const status: GiftCardStatus = newBalance === 0 ? 'redeemed' : card.status;
    await trx
      .updateTable('loyalty_gift_cards')
      .set({ status, updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', card.id)
      .execute();
    await audit(asCoreDb(trx as Db), tenantId, actor, 'loyalty.gift_card.redeemed', 'loyalty.gift_card', card.id, { cents });
    return { card: { ...card, status, updated_at: now }, balance: newBalance };
  });
}

export async function voidGiftCard(
  db: Db,
  tenantId: string,
  actor: string,
  code: string,
  reason: string,
): Promise<LoyaltyGiftCardRow> {
  if (!reason || reason.trim() === '') throw ApiError.badRequest('void requires a reason');
  return db.transaction().execute(async (trx) => {
    const card = await trx
      .selectFrom('loyalty_gift_cards')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('code', '=', code)
      .executeTakeFirst();
    if (!card) throw ApiError.notFound(`gift card not found: ${code}`);
    if (card.status === 'void') throw ApiError.conflict('gift card already void');
    const balRows = await trx
      .selectFrom('loyalty_gift_card_ledger')
      .select('amount_cents')
      .where('tenant_id', '=', tenantId)
      .where('gift_card_id', '=', card.id)
      .execute();
    const balance = balRows.reduce((s, r) => s + r.amount_cents, 0);
    const now = nowIso();
    if (balance !== 0) {
      await trx
        .insertInto('loyalty_gift_card_ledger')
        .values({
          id: id(),
          tenant_id: tenantId,
          gift_card_id: card.id,
          kind: 'void',
          amount_cents: -balance,
          order_id: null,
          reason,
          created_at: now,
        })
        .execute();
    }
    await trx
      .updateTable('loyalty_gift_cards')
      .set({ status: 'void', updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', card.id)
      .execute();
    await audit(asCoreDb(trx as Db), tenantId, actor, 'loyalty.gift_card.voided', 'loyalty.gift_card', card.id, { reason });
    return { ...card, status: 'void', updated_at: now };
  });
}

export interface LiabilitySummary {
  activeCount: number;
  outstandingCents: number;
}

/** Exact outstanding gift-card liability = SUM(balance) over ACTIVE cards. */
export async function giftCardLiability(db: Db, tenantId: string): Promise<LiabilitySummary> {
  const active = await db
    .selectFrom('loyalty_gift_cards')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'active')
    .execute();
  let outstandingCents = 0;
  for (const c of active) outstandingCents += await giftCardBalance(db, tenantId, c.id);
  return { activeCount: active.length, outstandingCents };
}

export async function listGiftCards(db: Db, tenantId: string): Promise<LoyaltyGiftCardRow[]> {
  return db
    .selectFrom('loyalty_gift_cards')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

/* ------------------------------------------------------------------ *
 * Store credit (same append-only ledger pattern, per profile)
 * ------------------------------------------------------------------ */

export async function storeCreditBalance(db: Db, tenantId: string, profileId: string): Promise<number> {
  const rows = await db
    .selectFrom('loyalty_store_credit_ledger')
    .select('amount_cents')
    .where('tenant_id', '=', tenantId)
    .where('profile_id', '=', profileId)
    .execute();
  return rows.reduce((s, r) => s + r.amount_cents, 0);
}

export async function issueStoreCredit(
  db: Db,
  tenantId: string,
  actor: string,
  profileId: string,
  cents: number,
  reason?: string,
): Promise<LoyaltyStoreCreditLedgerRow> {
  if (!Number.isInteger(cents) || cents <= 0) throw ApiError.badRequest('cents must be a positive integer');
  const row: LoyaltyStoreCreditLedgerRow = {
    id: id(),
    tenant_id: tenantId,
    profile_id: profileId,
    kind: 'issue',
    amount_cents: cents,
    order_id: null,
    reason: reason ?? null,
    created_at: nowIso(),
  };
  await db.insertInto('loyalty_store_credit_ledger').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'loyalty.store_credit.issued', 'loyalty.store_credit', profileId, { cents });
  return row;
}

export async function redeemStoreCredit(
  db: Db,
  tenantId: string,
  actor: string,
  profileId: string,
  cents: number,
  orderId?: string | null,
): Promise<{ ledger: LoyaltyStoreCreditLedgerRow; balance: number }> {
  if (!Number.isInteger(cents) || cents <= 0) throw ApiError.badRequest('cents must be a positive integer');
  return db.transaction().execute(async (trx) => {
    const balRows = await trx
      .selectFrom('loyalty_store_credit_ledger')
      .select('amount_cents')
      .where('tenant_id', '=', tenantId)
      .where('profile_id', '=', profileId)
      .execute();
    const balance = balRows.reduce((s, r) => s + r.amount_cents, 0);
    if (cents > balance) throw ApiError.conflict(`insufficient store credit: have ${balance}, need ${cents}`);
    const row: LoyaltyStoreCreditLedgerRow = {
      id: id(),
      tenant_id: tenantId,
      profile_id: profileId,
      kind: 'redeem',
      amount_cents: -cents,
      order_id: orderId ?? null,
      reason: null,
      created_at: nowIso(),
    };
    await trx.insertInto('loyalty_store_credit_ledger').values(row).execute();
    await audit(asCoreDb(trx as Db), tenantId, actor, 'loyalty.store_credit.redeemed', 'loyalty.store_credit', profileId, { cents });
    return { ledger: row, balance: balance - cents };
  });
}

export async function adjustStoreCredit(
  db: Db,
  tenantId: string,
  actor: string,
  profileId: string,
  cents: number,
  reason: string,
): Promise<LoyaltyStoreCreditLedgerRow> {
  if (!reason || reason.trim() === '') throw ApiError.badRequest('adjust requires a reason');
  if (!Number.isInteger(cents) || cents === 0) throw ApiError.badRequest('adjust cents must be a non-zero integer');
  const row: LoyaltyStoreCreditLedgerRow = {
    id: id(),
    tenant_id: tenantId,
    profile_id: profileId,
    kind: 'adjust',
    amount_cents: cents,
    order_id: null,
    reason,
    created_at: nowIso(),
  };
  await db.insertInto('loyalty_store_credit_ledger').values(row).execute();
  await audit(asCoreDb(db), tenantId, actor, 'loyalty.store_credit.adjusted', 'loyalty.store_credit', profileId, { cents, reason });
  return row;
}

/* ------------------------------------------------------------------ *
 * Expiry sweep
 * ------------------------------------------------------------------ */

export interface ExpireSummary {
  expiredAccounts: number;
  totalExpired: number;
}

/**
 * Expire points earned before each active program's expiry window. Deterministic
 * and safe to re-run: for each account it expires only the still-unexpired
 * portion of earn older than the cutoff, capped at the current balance.
 */
export async function expireDue(
  db: Db,
  tenantId: string,
  actor: string,
  now: string = nowIso(),
): Promise<ExpireSummary> {
  const programs = await db
    .selectFrom('loyalty_programs')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'active')
    .execute();
  let expiredAccounts = 0;
  let totalExpired = 0;
  for (const program of programs) {
    if (program.expiry_months == null) continue;
    const cutoff = DateTime.fromISO(now, { zone: 'utc' }).minus({ months: program.expiry_months }).toISO()!;
    const accounts = await db
      .selectFrom('loyalty_accounts')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('program_id', '=', program.id)
      .execute();
    for (const account of accounts) {
      await db.transaction().execute(async (trx) => {
        const all = await trx
          .selectFrom('loyalty_ledger')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('account_id', '=', account.id)
          .execute();
        const balance = all.reduce((s, r) => s + r.amount, 0);
        const expiredEarn = all
          .filter((r) => r.kind === 'earn' && r.created_at < cutoff)
          .reduce((s, r) => s + r.amount, 0);
        const alreadyExpired = all.filter((r) => r.kind === 'expire').reduce((s, r) => s - r.amount, 0);
        const toExpire = Math.min(balance, expiredEarn - alreadyExpired);
        if (toExpire <= 0) return;
        await trx
          .insertInto('loyalty_ledger')
          .values({
            id: id(),
            tenant_id: tenantId,
            account_id: account.id,
            kind: 'expire',
            amount: -toExpire,
            order_id: null,
            idempotency_key: null,
            trace: JSON.stringify({ model: 'expire', cutoff, expiredEarn, alreadyExpired, balance, toExpire }),
            reason: null,
            created_at: now,
          })
          .execute();
        expiredAccounts += 1;
        totalExpired += toExpire;
      });
    }
  }
  if (totalExpired > 0) {
    await audit(asCoreDb(db), tenantId, actor, 'loyalty.expiry.swept', 'loyalty.program', 'sweep', {
      expiredAccounts,
      totalExpired,
    });
  }
  return { expiredAccounts, totalExpired };
}
