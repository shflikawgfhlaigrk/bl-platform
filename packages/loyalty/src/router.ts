/**
 * Loyalty REST router. Mounted by apps/api at /api/loyalty.
 * Tenant comes ONLY from core tenant middleware (x-tenant-id header).
 * Optional x-user-id header identifies the acting user for audit ("system").
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  errorHandler,
  tenantMiddleware,
  asCoreDb,
  type ModuleDeps,
  type TenantEnv,
} from '@blacklabel/core';
import type { LoyaltyDatabase } from './schema';
import { PROGRAM_STATUSES, REWARD_KINDS } from './schema';
import type { ProgramRules } from './math';
import * as svc from './service';

const actorOf = (c: Context<TenantEnv>): string => c.req.header('x-user-id') ?? 'system';

const rulesSchema = z.union([
  z.object({ earnPerDollarBps: z.number().int().nonnegative() }).strict(),
  z
    .object({
      punchThresholdCents: z.number().int().nonnegative(),
      punchesForReward: z.number().int().positive(),
    })
    .strict(),
]);

export function loyaltyRouter(deps: ModuleDeps<LoyaltyDatabase>): Hono<TenantEnv> {
  const db = deps.db;
  const events = deps.events;
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(db)));
  const T = (c: Context<TenantEnv>) => c.get('tenantId');

  /* ---------------- programs ---------------- */
  const programCreate = z
    .object({
      name: z.string().min(1),
      rules: rulesSchema,
      reward_kind: z.enum(REWARD_KINDS as [string, ...string[]]),
      reward_value: z.number().int().nonnegative(),
      expiry_months: z.number().int().positive().nullish(),
      daily_earn_cap: z.number().int().positive().nullish(),
      status: z.enum(PROGRAM_STATUSES as [string, ...string[]]).optional(),
    })
    .strict();

  app.post('/programs', async (c) => {
    const b = programCreate.parse(await c.req.json());
    const row = await svc.createProgram(db, T(c), actorOf(c), {
      name: b.name,
      rules: b.rules as ProgramRules,
      rewardKind: b.reward_kind as 'store_credit_cents' | 'percent_off_bps',
      rewardValue: b.reward_value,
      expiryMonths: b.expiry_months ?? null,
      dailyEarnCap: b.daily_earn_cap ?? null,
      status: b.status as 'active' | 'paused' | undefined,
    });
    return c.json({ data: row }, 201);
  });

  app.get('/programs', async (c) => {
    const rows = await svc.listPrograms(db, T(c));
    return c.json({ data: rows });
  });

  app.get('/programs/:id', async (c) => {
    const row = await svc.getProgram(db, T(c), c.req.param('id'));
    return c.json({ data: row });
  });

  app.patch('/programs/:id', async (c) => {
    const b = z
      .object({
        status: z.enum(PROGRAM_STATUSES as [string, ...string[]]).optional(),
        reward_value: z.number().int().nonnegative().optional(),
        daily_earn_cap: z.number().int().positive().nullish(),
        expiry_months: z.number().int().positive().nullish(),
      })
      .strict()
      .parse(await c.req.json());
    const row = await svc.updateProgram(db, T(c), actorOf(c), c.req.param('id'), {
      status: b.status as 'active' | 'paused' | undefined,
      rewardValue: b.reward_value,
      dailyEarnCap: b.daily_earn_cap === undefined ? undefined : b.daily_earn_cap ?? null,
      expiryMonths: b.expiry_months === undefined ? undefined : b.expiry_months ?? null,
    });
    return c.json({ data: row });
  });

  /* ---------------- accounts + ledger ---------------- */
  app.post('/accounts', async (c) => {
    const b = z.object({ program_id: z.string().min(1), profile_id: z.string().min(1) }).strict().parse(await c.req.json());
    const account = await svc.ensureAccount(db, T(c), b.program_id, b.profile_id);
    const balance = await svc.accountBalance(db, T(c), account.id);
    return c.json({ data: { ...account, balance } }, 201);
  });

  app.get('/accounts/:id', async (c) => {
    const account = await svc.getAccount(db, T(c), c.req.param('id'));
    const balance = await svc.accountBalance(db, T(c), account.id);
    return c.json({ data: { ...account, balance } });
  });

  app.get('/accounts/:id/ledger', async (c) => {
    const rows = await svc.listLedger(db, T(c), c.req.param('id'));
    return c.json({ data: rows });
  });

  app.post('/accounts/:id/adjust', async (c) => {
    const b = z.object({ amount: z.number().int(), reason: z.string().min(1) }).strict().parse(await c.req.json());
    const row = await svc.adjustAccount(db, T(c), actorOf(c), c.req.param('id'), b.amount, b.reason);
    return c.json({ data: row }, 201);
  });

  /* ---------------- earn / redeem ---------------- */
  app.post('/earn', async (c) => {
    const b = z
      .object({
        program_id: z.string().min(1),
        profile_id: z.string().min(1),
        order_id: z.string().min(1),
        total_cents: z.number().int().nonnegative(),
        idempotency_key: z.string().min(1),
      })
      .strict()
      .parse(await c.req.json());
    const result = await svc.earnForOrder(db, T(c), actorOf(c), events, {
      programId: b.program_id,
      profileId: b.profile_id,
      orderId: b.order_id,
      totalCents: b.total_cents,
      idempotencyKey: b.idempotency_key,
    });
    return c.json({ data: result }, result.replayed ? 200 : 201);
  });

  app.post('/redeem', async (c) => {
    const b = z
      .object({
        program_id: z.string().min(1),
        profile_id: z.string().min(1),
        amount: z.number().int().positive(),
        order_id: z.string().nullish(),
      })
      .strict()
      .parse(await c.req.json());
    const result = await svc.redeem(db, T(c), actorOf(c), events, {
      programId: b.program_id,
      profileId: b.profile_id,
      amount: b.amount,
      orderId: b.order_id ?? null,
    });
    return c.json({ data: result }, 201);
  });

  app.get('/redemptions/:reference', async (c) => {
    const row = await svc.getRedemptionByReference(db, T(c), c.req.param('reference'));
    if (!row) return c.json({ error: { message: 'redemption not found', code: 'not_found', details: null } }, 404);
    return c.json({ data: row });
  });

  app.post('/redemptions/:reference/consume', async (c) => {
    const b = z.object({ order_id: z.string().min(1) }).strict().parse(await c.req.json());
    const row = await svc.consumeRedemption(db, T(c), actorOf(c), c.req.param('reference'), b.order_id);
    return c.json({ data: row });
  });

  /* ---------------- gift cards ---------------- */
  app.post('/gift-cards', async (c) => {
    const b = z.object({ code: z.string().min(1).optional(), initial_cents: z.number().int().positive() }).strict().parse(await c.req.json());
    const card = await svc.issueGiftCard(db, T(c), actorOf(c), { code: b.code, initialCents: b.initial_cents });
    const balance = await svc.giftCardBalance(db, T(c), card.id);
    return c.json({ data: { ...card, balance } }, 201);
  });

  app.get('/gift-cards', async (c) => {
    const rows = await svc.listGiftCards(db, T(c));
    return c.json({ data: rows });
  });

  app.get('/gift-cards/liability', async (c) => {
    const summary = await svc.giftCardLiability(db, T(c));
    return c.json({ data: summary });
  });

  app.post('/gift-cards/:code/redeem', async (c) => {
    const b = z.object({ cents: z.number().int().positive(), order_id: z.string().nullish() }).strict().parse(await c.req.json());
    const result = await svc.redeemGiftCard(db, T(c), actorOf(c), c.req.param('code'), b.cents, b.order_id ?? null);
    return c.json({ data: result });
  });

  app.post('/gift-cards/:code/void', async (c) => {
    const b = z.object({ reason: z.string().min(1) }).strict().parse(await c.req.json());
    const card = await svc.voidGiftCard(db, T(c), actorOf(c), c.req.param('code'), b.reason);
    return c.json({ data: card });
  });

  /* ---------------- store credit ---------------- */
  app.get('/store-credit/:profileId', async (c) => {
    const balance = await svc.storeCreditBalance(db, T(c), c.req.param('profileId'));
    return c.json({ data: { profileId: c.req.param('profileId'), balance } });
  });

  app.post('/store-credit/:profileId/issue', async (c) => {
    const b = z.object({ cents: z.number().int().positive(), reason: z.string().optional() }).strict().parse(await c.req.json());
    const row = await svc.issueStoreCredit(db, T(c), actorOf(c), c.req.param('profileId'), b.cents, b.reason);
    return c.json({ data: row }, 201);
  });

  app.post('/store-credit/:profileId/redeem', async (c) => {
    const b = z.object({ cents: z.number().int().positive(), order_id: z.string().nullish() }).strict().parse(await c.req.json());
    const result = await svc.redeemStoreCredit(db, T(c), actorOf(c), c.req.param('profileId'), b.cents, b.order_id ?? null);
    return c.json({ data: result });
  });

  app.post('/store-credit/:profileId/adjust', async (c) => {
    const b = z.object({ cents: z.number().int(), reason: z.string().min(1) }).strict().parse(await c.req.json());
    const row = await svc.adjustStoreCredit(db, T(c), actorOf(c), c.req.param('profileId'), b.cents, b.reason);
    return c.json({ data: row }, 201);
  });

  /* ---------------- expiry sweep ---------------- */
  app.post('/expire', async (c) => {
    const b = z.object({ now: z.string().optional() }).strict().parse(await c.req.json().catch(() => ({})));
    const summary = await svc.expireDue(db, T(c), actorOf(c), b.now);
    return c.json({ data: summary });
  });

  return app;
}
