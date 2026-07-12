import { describe, expect, it } from 'vitest';
import { body, create, setup } from './helpers';

describe('identity resolution + merge apply/undo', () => {
  it('proposes merges by precedence email > phone > name+zip (never auto-destructive)', async () => {
    const ctx = await setup();
    // Pair 1: same email.
    const a1 = await create(ctx, ctx.A, '/profiles', { email: 'dup@x.com', first_name: 'A' });
    const a2 = await create(ctx, ctx.A, '/profiles', { email: 'DUP@x.com', first_name: 'A2' });
    // Pair 2: same phone.
    const b1 = await create(ctx, ctx.A, '/profiles', { phone: '4045552222', first_name: 'B' });
    const b2 = await create(ctx, ctx.A, '/profiles', { phone: '(404) 555-2222', first_name: 'B2' });
    // Pair 3: same name + zip (via zips map).
    const c1 = await create(ctx, ctx.A, '/profiles', { first_name: 'Sam', last_name: 'Lee' });
    const c2 = await create(ctx, ctx.A, '/profiles', { first_name: 'sam', last_name: 'LEE' });

    const res = await ctx.json(ctx.A, 'POST', '/merges/resolve', {
      zips: { [c1.id]: '30301', [c2.id]: '30301' },
    });
    expect(res.status).toBe(201);
    const proposals = (await body(res)).data;
    expect(proposals).toHaveLength(3);
    const fields = proposals.map((m: any) => JSON.parse(m.evidence).matched.field).sort();
    expect(fields).toEqual(['email', 'name_zip', 'phone']);
    // All still proposed, nothing merged.
    for (const m of proposals) expect(m.status).toBe('proposed');
    const a2row = (await body(await ctx.req(ctx.A, `/profiles/${a2.id}`))).data;
    expect(a2row.merged_into).toBeNull();
    // The email proposal covers exactly the a1/a2 pair (winner deterministic by created_at,id).
    const emailMerge = proposals.find((m: any) => JSON.parse(m.evidence).matched.field === 'email');
    expect([emailMerge.winner_profile_id, emailMerge.loser_profile_id].sort()).toEqual([a1.id, a2.id].sort());
    const phoneMerge = proposals.find((m: any) => JSON.parse(m.evidence).matched.field === 'phone');
    expect([phoneMerge.winner_profile_id, phoneMerge.loser_profile_id].sort()).toEqual([b1.id, b2.id].sort());
    const nameMerge = proposals.find((m: any) => JSON.parse(m.evidence).matched.field === 'name_zip');
    expect([nameMerge.winner_profile_id, nameMerge.loser_profile_id].sort()).toEqual([c1.id, c2.id].sort());
  });

  it('is idempotent: re-resolving does not re-propose an existing pair', async () => {
    const ctx = await setup();
    await create(ctx, ctx.A, '/profiles', { email: 'same@x.com' });
    await create(ctx, ctx.A, '/profiles', { email: 'same@x.com' });
    const first = (await body(await ctx.json(ctx.A, 'POST', '/merges/resolve', {}))).data;
    expect(first).toHaveLength(1);
    const second = (await body(await ctx.json(ctx.A, 'POST', '/merges/resolve', {}))).data;
    expect(second).toHaveLength(0);
  });

  it('apply re-points child rows; undo restores EXACTLY', async () => {
    const ctx = await setup();
    await create(ctx, ctx.A, '/profiles', { email: 'w@x.com', first_name: 'One' });
    await create(ctx, ctx.A, '/profiles', { email: 'w@x.com', first_name: 'Two' });

    // Resolve first, then attach child rows to the DETERMINISTIC loser.
    await ctx.json(ctx.A, 'POST', '/merges/resolve', {});
    const merges = (await body(await ctx.req(ctx.A, '/merges?status=proposed'))).data;
    const merge = merges[0];
    const winner = { id: merge.winner_profile_id };
    const loser = { id: merge.loser_profile_id };

    // Give the LOSER child rows: a consent, a preference, a restock, a service case.
    await create(ctx, ctx.A, `/profiles/${loser.id}/consents`, { channel: 'email', state: 'granted' });
    await ctx.json(ctx.A, 'PUT', `/profiles/${loser.id}/preferences/color`, { value: 'blue' });
    await create(ctx, ctx.A, '/restock-requests', { variation_id: 'v1', profile_id: loser.id });
    await create(ctx, ctx.A, '/service-cases', { profile_id: loser.id, kind: 'question', body: 'hi' });

    // Apply.
    const applied = (await body(await ctx.json(ctx.A, 'POST', `/merges/${merge.id}/apply`))).data;
    expect(applied.status).toBe('applied');
    const loserAfter = (await body(await ctx.req(ctx.A, `/profiles/${loser.id}`))).data;
    expect(loserAfter.merged_into).toBe(winner.id);

    // Winner now owns the child rows.
    const winnerConsents = (await body(await ctx.req(ctx.A, `/profiles/${winner.id}/consents`))).data;
    expect(winnerConsents.length).toBe(1);
    const winnerPrefs = (await body(await ctx.req(ctx.A, `/profiles/${winner.id}/preferences`))).data;
    expect(winnerPrefs.map((p: any) => p.key)).toContain('color');
    const winnerCases = (await body(await ctx.req(ctx.A, `/service-cases?profile_id=${winner.id}`))).data;
    expect(winnerCases.length).toBe(1);

    // Undo restores exactly.
    const undone = (await body(await ctx.json(ctx.A, 'POST', `/merges/${merge.id}/undo`))).data;
    expect(undone.status).toBe('undone');
    const loserRestored = (await body(await ctx.req(ctx.A, `/profiles/${loser.id}`))).data;
    expect(loserRestored.merged_into).toBeNull();
    expect((await body(await ctx.req(ctx.A, `/profiles/${loser.id}/consents`))).data.length).toBe(1);
    expect((await body(await ctx.req(ctx.A, `/service-cases?profile_id=${loser.id}`))).data.length).toBe(1);
    // Winner has none back.
    expect((await body(await ctx.req(ctx.A, `/profiles/${winner.id}/consents`))).data.length).toBe(0);
    expect((await body(await ctx.req(ctx.A, `/service-cases?profile_id=${winner.id}`))).data.length).toBe(0);
  });

  it('rejects applying a non-proposed merge and undoing a non-applied merge', async () => {
    const ctx = await setup();
    await create(ctx, ctx.A, '/profiles', { email: 'z@x.com' });
    await create(ctx, ctx.A, '/profiles', { email: 'z@x.com' });
    const merge = (await body(await ctx.json(ctx.A, 'POST', '/merges/resolve', {}))).data[0];
    // Undo before apply -> conflict.
    expect((await ctx.json(ctx.A, 'POST', `/merges/${merge.id}/undo`)).status).toBe(409);
    await ctx.json(ctx.A, 'POST', `/merges/${merge.id}/apply`);
    // Apply twice -> conflict.
    expect((await ctx.json(ctx.A, 'POST', `/merges/${merge.id}/apply`)).status).toBe(409);
  });
});
