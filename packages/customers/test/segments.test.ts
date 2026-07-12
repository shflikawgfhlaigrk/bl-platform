import { describe, expect, it } from 'vitest';
import { builtinSegments, evaluateSegment, type StatsInputMap } from '@blacklabel/customers';
import { body, create, setup } from './helpers';

const NOW = '2026-07-12T00:00:00.000Z';

describe('segment evaluation: purity + built-in rules', () => {
  it('is pure and reproducible: same inputs -> same members + same hash', () => {
    const rules = { all: [{ field: 'orderCount', op: 'gte' as const, value: 2 }] };
    const stats: StatsInputMap = {
      p1: { orderCount: 3 },
      p2: { orderCount: 1 },
      p3: { orderCount: 2 },
    };
    const a = evaluateSegment(rules, stats, NOW);
    const b = evaluateSegment(rules, stats, NOW);
    expect(a.members).toEqual(['p1', 'p3']);
    expect(a.members).toEqual(b.members);
    expect(a.inputsHash).toBe(b.inputsHash);
    // Changing a non-member's stats does not change members OR hash.
    const c = evaluateSegment(rules, { ...stats, p2: { orderCount: 0 } }, NOW);
    expect(c.members).toEqual(a.members);
    expect(c.inputsHash).toBe(a.inputsHash);
    // Changing a member's stats DOES change the hash.
    const d = evaluateSegment(rules, { ...stats, p1: { orderCount: 9 } }, NOW);
    expect(d.inputsHash).not.toBe(a.inputsHash);
  });

  it('asserts each built-in definition', () => {
    const defs = Object.fromEntries(builtinSegments().map((d) => [d.name, d.rules]));
    const stats: StatsInputMap = {
      newbie: { firstOrderAt: '2026-06-20T00:00:00.000Z', orderCount: 1, lifetimeCents: 5000 },
      repeater: { orderCount: 4, lifetimeCents: 20000, firstOrderAt: '2025-01-01T00:00:00.000Z' },
      whale: { orderCount: 5, lifetimeCents: 250000, firstOrderAt: '2025-01-01T00:00:00.000Z' },
      sleeper: {
        orderCount: 3,
        lifetimeCents: 60000,
        lastOrderAt: '2025-01-01T00:00:00.000Z',
        firstOrderAt: '2024-01-01T00:00:00.000Z',
      },
      subscribed: { emailConsentState: 'granted' },
    };
    expect(evaluateSegment(defs.new, stats, NOW).members).toContain('newbie');
    expect(evaluateSegment(defs.repeat, stats, NOW).members).toEqual(
      expect.arrayContaining(['repeater', 'whale', 'sleeper']),
    );
    expect(evaluateSegment(defs.vip, stats, NOW).members).toEqual(['whale']);
    expect(evaluateSegment(defs.lapsed, stats, NOW).members).toEqual(['sleeper']);
    expect(evaluateSegment(defs.consented_email, stats, NOW).members).toEqual(['subscribed']);
  });

  it('vip threshold is configurable', () => {
    const [, , vip] = builtinSegments({ vipThresholdCents: 500000 });
    const stats: StatsInputMap = { a: { lifetimeCents: 250000 }, b: { lifetimeCents: 600000 } };
    expect(evaluateSegment(vip.rules, stats, NOW).members).toEqual(['b']);
  });
});

describe('segment persistence via router', () => {
  it('seeds built-ins, evaluates against a stats map, and stores members with the hash', async () => {
    const ctx = await setup();
    const p1 = await create(ctx, ctx.A, '/profiles', { email: 'p1@x.com' });
    const p2 = await create(ctx, ctx.A, '/profiles', { email: 'p2@x.com' });

    const seeded = (await body(await ctx.json(ctx.A, 'POST', '/segments/seed-builtins', {}))).data;
    expect(seeded.map((s: any) => s.name).sort()).toEqual(['consented_email', 'lapsed', 'new', 'repeat', 'vip']);
    const repeat = seeded.find((s: any) => s.name === 'repeat');

    const stats = { [p1.id]: { orderCount: 3 }, [p2.id]: { orderCount: 1 } };
    const evalRes = (
      await body(await ctx.json(ctx.A, 'POST', `/segments/${repeat.id}/evaluate`, { stats, now: NOW }))
    ).data;
    expect(evalRes.members).toEqual([p1.id]);

    const members = (await body(await ctx.req(ctx.A, `/segments/${repeat.id}/members`))).data;
    expect(members).toHaveLength(1);
    expect(members[0].profile_id).toBe(p1.id);
    expect(members[0].inputs_hash).toBe(evalRes.inputsHash);

    // Re-evaluate identical inputs -> same hash, still one member row.
    const again = (
      await body(await ctx.json(ctx.A, 'POST', `/segments/${repeat.id}/evaluate`, { stats, now: NOW }))
    ).data;
    expect(again.inputsHash).toBe(evalRes.inputsHash);
    expect((await body(await ctx.req(ctx.A, `/segments/${repeat.id}/members`))).data).toHaveLength(1);
  });

  it('supports custom segment CRUD and blocks deleting a built-in', async () => {
    const ctx = await setup();
    const seeded = (await body(await ctx.json(ctx.A, 'POST', '/segments/seed-builtins', {}))).data;
    const builtin = seeded[0];
    expect((await ctx.json(ctx.A, 'DELETE', `/segments/${builtin.id}`)).status).toBe(409);

    const custom = await create(ctx, ctx.A, '/segments', {
      name: 'ga-buyers',
      rules: { all: [{ field: 'region', op: 'eq', value: 'GA' }] },
    });
    expect(custom.builtin).toBe(0);
    expect((await ctx.json(ctx.A, 'DELETE', `/segments/${custom.id}`)).status).toBe(204);
  });
});
