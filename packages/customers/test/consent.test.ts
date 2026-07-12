import { describe, expect, it } from 'vitest';
import { body, create, setup } from './helpers';

describe('consents: append-only history, double-opt-in, event without PII', () => {
  it('appends history; current state = latest row per (profile, channel)', async () => {
    const ctx = await setup();
    const p = await create(ctx, ctx.A, '/profiles', { email: 'c@x.com' });
    await create(ctx, ctx.A, `/profiles/${p.id}/consents`, { channel: 'email', state: 'granted', text_shown: 'Subscribe?' });
    await create(ctx, ctx.A, `/profiles/${p.id}/consents`, { channel: 'email', state: 'withdrawn' });

    const history = (await body(await ctx.req(ctx.A, `/profiles/${p.id}/consents?channel=email`))).data;
    expect(history).toHaveLength(2); // append-only, nothing overwritten
    const current = (await body(await ctx.req(ctx.A, `/profiles/${p.id}/consents/current?channel=email`))).data;
    expect(current.state).toBe('withdrawn');
  });

  it('emits customers.consent.changed with v:1 and NO PII (ids/channel/state only)', async () => {
    const ctx = await setup();
    const p = await create(ctx, ctx.A, '/profiles', { email: 'evt@x.com', first_name: 'Secret', phone: '4045559999' });
    const seen: any[] = [];
    ctx.events.on('customers.consent.changed', (e) => {
      seen.push(e);
    });
    await create(ctx, ctx.A, `/profiles/${p.id}/consents`, { channel: 'sms', state: 'granted' });

    expect(seen).toHaveLength(1);
    expect(seen[0].tenantId).toBe(ctx.A);
    expect(seen[0].payload).toEqual({ v: 1, customerId: p.id, channel: 'sms', state: 'granted' });
    const serialized = JSON.stringify(seen[0].payload);
    expect(serialized).not.toContain('Secret');
    expect(serialized).not.toContain('evt@x.com');
    expect(serialized).not.toContain('4045559999');
  });

  it('double-opt-in: pending -> granted only via valid token; expired token rejected', async () => {
    const ctx = await setup();
    const p = await create(ctx, ctx.A, '/profiles', { email: 'dopt@x.com' });
    const start = (
      await body(
        await ctx.json(ctx.A, 'POST', `/profiles/${p.id}/consents/double-opt-in/start`, {
          channel: 'email',
          text_shown: 'Confirm your subscription',
        }),
      )
    ).data;
    expect(start.consent.state).toBe('pending_double_opt_in');
    expect(typeof start.token).toBe('string');

    // Before confirm, current state is pending (NOT granted).
    let cur = (await body(await ctx.req(ctx.A, `/profiles/${p.id}/consents/current?channel=email`))).data;
    expect(cur.state).toBe('pending_double_opt_in');

    // Confirm.
    const confirmed = await ctx.json(ctx.A, 'POST', '/consents/double-opt-in/confirm', { token: start.token });
    expect(confirmed.status).toBe(200);
    cur = (await body(await ctx.req(ctx.A, `/profiles/${p.id}/consents/current?channel=email`))).data;
    expect(cur.state).toBe('granted');

    // Re-using the same token -> 409.
    expect((await ctx.json(ctx.A, 'POST', '/consents/double-opt-in/confirm', { token: start.token })).status).toBe(409);
    // Unknown token -> 404.
    expect((await ctx.json(ctx.A, 'POST', '/consents/double-opt-in/confirm', { token: 'nope' })).status).toBe(404);
  });

  it('rejects an expired confirmation token', async () => {
    const ctx = await setup();
    const p = await create(ctx, ctx.A, '/profiles', { email: 'exp@x.com' });
    // Start with a positive ttl, then hand-expire the token row in the db.
    const start = (
      await body(
        await ctx.json(ctx.A, 'POST', `/profiles/${p.id}/consents/double-opt-in/start`, {
          channel: 'email',
          ttl_minutes: 60,
        }),
      )
    ).data;
    await ctx.db
      .updateTable('customers_consent_tokens')
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where('tenant_id', '=', ctx.A)
      .where('token', '=', start.token)
      .execute();
    const res = await ctx.json(ctx.A, 'POST', '/consents/double-opt-in/confirm', { token: start.token });
    expect(res.status).toBe(409);
    const cur = (await body(await ctx.req(ctx.A, `/profiles/${p.id}/consents/current?channel=email`))).data;
    expect(cur.state).toBe('pending_double_opt_in'); // never granted
  });
});
