import { describe, expect, it } from 'vitest';
import { body, create, setup } from './helpers';

describe('gift cards: lifecycle + liability to the cent', () => {
  it('issues, redeems, voids, and sums outstanding liability exactly', async () => {
    const ctx = await setup();
    // Seed the real-truth shape: a handful of cards.
    const c1 = await create(ctx, ctx.A, '/gift-cards', { initial_cents: 5000 });
    const c2 = await create(ctx, ctx.A, '/gift-cards', { initial_cents: 2500 });
    const c3 = await create(ctx, ctx.A, '/gift-cards', { code: 'GIFT-ABC', initial_cents: 10000 });
    expect(c1.balance).toBe(5000);

    // Redeem part of c1.
    const r = (await body(await ctx.json(ctx.A, 'POST', `/gift-cards/${c1.code}/redeem`, { cents: 2000 }))).data;
    expect(r.balance).toBe(3000);
    // Over-redeem c2 -> 409.
    expect((await ctx.json(ctx.A, 'POST', `/gift-cards/${c2.code}/redeem`, { cents: 9999 })).status).toBe(409);
    // Fully redeem c2 -> status redeemed, drops out of liability.
    const r2 = (await body(await ctx.json(ctx.A, 'POST', `/gift-cards/${c2.code}/redeem`, { cents: 2500 }))).data;
    expect(r2.card.status).toBe('redeemed');
    expect(r2.balance).toBe(0);

    // Void c3 (requires reason) -> drops out of liability.
    expect((await ctx.json(ctx.A, 'POST', `/gift-cards/${c3.code}/void`, {})).status).toBe(400);
    const voided = (await body(await ctx.json(ctx.A, 'POST', `/gift-cards/${c3.code}/void`, { reason: 'lost' }))).data;
    expect(voided.status).toBe('void');

    // Liability = only c1's remaining $30.00.
    const liab = (await body(await ctx.req(ctx.A, '/gift-cards/liability'))).data;
    expect(liab.activeCount).toBe(1);
    expect(liab.outstandingCents).toBe(3000);
  });

  it('matches a seeded 22-card / $446.60 liability exactly', async () => {
    const ctx = await setup();
    // 21 cards of $20.00 + 1 card of $26.60 = $446.60 across 22 active cards.
    for (let i = 0; i < 21; i += 1) await create(ctx, ctx.A, '/gift-cards', { initial_cents: 2000 });
    await create(ctx, ctx.A, '/gift-cards', { initial_cents: 2660 });
    const liab = (await body(await ctx.req(ctx.A, '/gift-cards/liability'))).data;
    expect(liab.activeCount).toBe(22);
    expect(liab.outstandingCents).toBe(44660);
  });
});

describe('store credit ledger', () => {
  it('issues, redeems (balance-checked), and adjusts with reason', async () => {
    const ctx = await setup();
    await ctx.json(ctx.A, 'POST', '/store-credit/cust-1/issue', { cents: 5000, reason: 'refund' });
    let bal = (await body(await ctx.req(ctx.A, '/store-credit/cust-1'))).data;
    expect(bal.balance).toBe(5000);

    expect((await ctx.json(ctx.A, 'POST', '/store-credit/cust-1/redeem', { cents: 9999 })).status).toBe(409);
    const red = (await body(await ctx.json(ctx.A, 'POST', '/store-credit/cust-1/redeem', { cents: 2000, order_id: 'o1' }))).data;
    expect(red.balance).toBe(3000);

    // Adjust requires a reason.
    expect((await ctx.json(ctx.A, 'POST', '/store-credit/cust-1/adjust', { cents: -500 })).status).toBe(400);
    await ctx.json(ctx.A, 'POST', '/store-credit/cust-1/adjust', { cents: -500, reason: 'correction' });
    bal = (await body(await ctx.req(ctx.A, '/store-credit/cust-1'))).data;
    expect(bal.balance).toBe(2500);
  });
});

describe('expiry sweep', () => {
  it('expires only points earned before the program window; idempotent on re-run', async () => {
    const ctx = await setup();
    const prog = await create(ctx, ctx.A, '/programs', {
      name: 'Expiring',
      rules: { earnPerDollarBps: 10000 },
      reward_kind: 'store_credit_cents',
      reward_value: 1000,
      expiry_months: 12,
    });
    // Earn 30 pts.
    const e = (
      await body(
        await ctx.json(ctx.A, 'POST', '/earn', {
          program_id: prog.id,
          profile_id: 'cust-e',
          order_id: 'o1',
          total_cents: 3000,
          idempotency_key: 'o1',
        }),
      )
    ).data;
    const accountId = e.ledger.account_id;
    // Back-date the earn row to 2 years ago so it is outside the 12-month window.
    await ctx.db
      .updateTable('loyalty_ledger')
      .set({ created_at: '2024-01-01T00:00:00.000Z' })
      .where('tenant_id', '=', ctx.A)
      .where('account_id', '=', accountId)
      .execute();

    const now = '2026-07-12T00:00:00.000Z';
    const first = (await body(await ctx.json(ctx.A, 'POST', '/expire', { now }))).data;
    expect(first.expiredAccounts).toBe(1);
    expect(first.totalExpired).toBe(30);
    const acct = (await body(await ctx.req(ctx.A, `/accounts/${accountId}`))).data;
    expect(acct.balance).toBe(0);

    // Re-run: nothing left to expire.
    const second = (await body(await ctx.json(ctx.A, 'POST', '/expire', { now }))).data;
    expect(second.totalExpired).toBe(0);
  });
});
