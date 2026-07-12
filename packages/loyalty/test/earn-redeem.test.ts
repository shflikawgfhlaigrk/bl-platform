import { describe, expect, it } from 'vitest';
import { body, create, setup } from './helpers';

async function pointsProgram(ctx: any, tenant: string, extra: Record<string, unknown> = {}) {
  return create(ctx, tenant, '/programs', {
    name: 'Points',
    rules: { earnPerDollarBps: 10000 }, // 1 pt / $1
    reward_kind: 'store_credit_cents',
    reward_value: 1000,
    ...extra,
  });
}

describe('loyalty earn: replay-safe idempotency + daily cap', () => {
  it('the same order (idempotency key) earns exactly once', async () => {
    const ctx = await setup();
    const prog = await pointsProgram(ctx, ctx.A);
    const payload = {
      program_id: prog.id,
      profile_id: 'cust-1',
      order_id: 'ord-1',
      total_cents: 5000,
      idempotency_key: 'ord-1',
    };
    const first = await ctx.json(ctx.A, 'POST', '/earn', payload);
    expect(first.status).toBe(201);
    const firstData = (await body(first)).data;
    expect(firstData.replayed).toBe(false);
    expect(firstData.ledger.amount).toBe(50);

    // Replay: same key -> 200, replayed, NO second earn.
    const second = await ctx.json(ctx.A, 'POST', '/earn', payload);
    expect(second.status).toBe(200);
    expect((await body(second)).data.replayed).toBe(true);

    const account = firstData.ledger.account_id;
    const ledger = (await body(await ctx.req(ctx.A, `/accounts/${account}/ledger`))).data;
    expect(ledger.filter((r: any) => r.kind === 'earn')).toHaveLength(1);
    const acct = (await body(await ctx.req(ctx.A, `/accounts/${account}`))).data;
    expect(acct.balance).toBe(50);
  });

  it('enforces per-account daily earn cap (fraud control)', async () => {
    const ctx = await setup();
    const prog = await pointsProgram(ctx, ctx.A, { daily_earn_cap: 60 });
    const earn = (order: string, cents: number) =>
      ctx.json(ctx.A, 'POST', '/earn', {
        program_id: prog.id,
        profile_id: 'cust-cap',
        order_id: order,
        total_cents: cents,
        idempotency_key: order,
      });
    const a = (await body(await earn('o1', 5000))).data; // 50 pts
    expect(a.ledger.amount).toBe(50);
    const b = (await body(await earn('o2', 5000))).data; // would be 50, capped to 10
    expect(b.ledger.amount).toBe(10);
    const cc = (await body(await earn('o3', 5000))).data; // capped to 0
    expect(cc.ledger.amount).toBe(0);
    expect(JSON.parse(cc.ledger.trace).cap.capApplied).toBe(true);
  });
});

describe('loyalty redeem: balance-checked, produces a tender reference', () => {
  it('rejects insufficient balance with 409 and consumes a redemption for an order', async () => {
    const ctx = await setup();
    const prog = await pointsProgram(ctx, ctx.A);
    await ctx.json(ctx.A, 'POST', '/earn', {
      program_id: prog.id,
      profile_id: 'cust-r',
      order_id: 'o1',
      total_cents: 3000, // 30 pts
      idempotency_key: 'o1',
    });

    // Over-redeem -> 409.
    const over = await ctx.json(ctx.A, 'POST', '/redeem', { program_id: prog.id, profile_id: 'cust-r', amount: 100 });
    expect(over.status).toBe(409);

    // Valid redeem -> issued redemption with a reference; balance drops.
    const red = (await body(await ctx.json(ctx.A, 'POST', '/redeem', { program_id: prog.id, profile_id: 'cust-r', amount: 20 }))).data;
    expect(red.redemption.status).toBe('issued');
    expect(typeof red.redemption.reference).toBe('string');
    expect(red.redemption.reward_kind).toBe('store_credit_cents');

    // Orders consumes the redemption tender.
    const consumed = (
      await body(await ctx.json(ctx.A, 'POST', `/redemptions/${red.redemption.reference}/consume`, { order_id: 'ord-x' }))
    ).data;
    expect(consumed.status).toBe('consumed');
    expect(consumed.order_id).toBe('ord-x');
    // Double-consume -> 409.
    expect((await ctx.json(ctx.A, 'POST', `/redemptions/${red.redemption.reference}/consume`, { order_id: 'ord-y' })).status).toBe(409);
  });

  it('adjust requires a reason and moves balance', async () => {
    const ctx = await setup();
    const prog = await pointsProgram(ctx, ctx.A);
    const acct = (await body(await ctx.json(ctx.A, 'POST', '/accounts', { program_id: prog.id, profile_id: 'cust-a' }))).data;
    // No reason -> 400.
    expect((await ctx.json(ctx.A, 'POST', `/accounts/${acct.id}/adjust`, { amount: 25 })).status).toBe(400);
    await ctx.json(ctx.A, 'POST', `/accounts/${acct.id}/adjust`, { amount: 25, reason: 'goodwill' });
    const after = (await body(await ctx.req(ctx.A, `/accounts/${acct.id}`))).data;
    expect(after.balance).toBe(25);
  });
});

describe('loyalty punch card', () => {
  it('accrues one punch per qualifying order and exposes the trace', async () => {
    const ctx = await setup();
    const prog = await create(ctx, ctx.A, '/programs', {
      name: 'Punch',
      rules: { punchThresholdCents: 2000, punchesForReward: 3 },
      reward_kind: 'percent_off_bps',
      reward_value: 1000,
    });
    const earn = (o: string, cents: number) =>
      ctx.json(ctx.A, 'POST', '/earn', { program_id: prog.id, profile_id: 'p', order_id: o, total_cents: cents, idempotency_key: o });
    const e1 = (await body(await earn('o1', 2500))).data;
    expect(e1.ledger.amount).toBe(1);
    expect(JSON.parse(e1.ledger.trace).model).toBe('punch');
    await earn('o2', 1000); // below threshold -> 0
    await earn('o3', 5000); // 1
    const acct = (await body(await ctx.req(ctx.A, `/accounts/${e1.ledger.account_id}`))).data;
    expect(acct.balance).toBe(2);
  });
});

describe('tenant isolation', () => {
  it('denies cross-tenant program/account access', async () => {
    const ctx = await setup();
    const prog = await pointsProgram(ctx, ctx.A);
    expect((await ctx.req(ctx.B, `/programs/${prog.id}`)).status).toBe(404);
    expect((await body(await ctx.req(ctx.B, '/programs'))).data).toEqual([]);
  });
});
