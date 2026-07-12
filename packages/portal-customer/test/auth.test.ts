import { describe, expect, it } from 'vitest';
import { nowIso, type SendMessageInput } from '@blacklabel/core';
import { api, capture, createAccountViaApi, login, setup } from './helpers';

describe('magic-token login', () => {
  it('request-link creates a single-use token row with a future expiry and emits the event', async () => {
    const ctx = await setup();
    const events = capture(ctx.events, 'portal_customer.login_link.requested');
    const account = await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com' });

    const res = await api(ctx.app, ctx.tenantA, 'POST', '/auth/request-link', { email: 'ADA@example.com' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data).toEqual({ requested: true });

    const tokens = await ctx.db
      .selectFrom('portal_customer_login_tokens')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantA)
      .execute();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].account_id).toBe(account.id);
    expect(tokens[0].used_at).toBeNull();
    expect(tokens[0].expires_at > nowIso()).toBe(true);
    expect(tokens[0].token.length).toBeGreaterThanOrEqual(32);

    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ accountId: account.id, tokenId: tokens[0].id });
    // The raw token never appears in the event payload.
    expect(JSON.stringify(events[0].payload)).not.toContain(tokens[0].token);
  });

  it('request-link for an unknown email returns the identical 200 and creates no token (no enumeration)', async () => {
    const ctx = await setup();
    const res = await api(ctx.app, ctx.tenantA, 'POST', '/auth/request-link', { email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data).toEqual({ requested: true });
    const tokens = await ctx.db.selectFrom('portal_customer_login_tokens').selectAll().execute();
    expect(tokens).toHaveLength(0);
  });

  it('relays the login token through the messaging contract when wired', async () => {
    const sent: SendMessageInput[] = [];
    const ctx = await setup({
      contracts: {
        sendMessage: {
          async sendMessage(input) {
            sent.push(input);
            return { id: `msg_${sent.length}` };
          },
        },
      },
    });
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com' });
    await api(ctx.app, ctx.tenantA, 'POST', '/auth/request-link', { email: 'ada@example.com' });

    const token = await ctx.db
      .selectFrom('portal_customer_login_tokens')
      .select('token')
      .where('tenant_id', '=', ctx.tenantA)
      .executeTakeFirstOrThrow();
    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe('email');
    expect(sent[0].to).toBe('ada@example.com');
    expect(sent[0].body).toContain(token.token);
  });

  it('exchange issues a session that authenticates /me and marks the token used', async () => {
    const ctx = await setup();
    const sessionEvents = capture(ctx.events, 'portal_customer.session.created');
    const account = await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com', name: 'Ada' });

    const session = await login(ctx, ctx.tenantA, 'ada@example.com');
    const me = await api(ctx.app, ctx.tenantA, 'GET', '/me', undefined, session);
    expect(me.status).toBe(200);
    const body = (await me.json()) as any;
    expect(body.data.id).toBe(account.id);
    expect(body.data.name).toBe('Ada');

    const tokenRow = await ctx.db
      .selectFrom('portal_customer_login_tokens')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantA)
      .executeTakeFirstOrThrow();
    expect(tokenRow.used_at).not.toBeNull();
    expect(sessionEvents).toHaveLength(1);
    expect(sessionEvents[0].payload).toMatchObject({ accountId: account.id });
  });

  it('a login token is single-use: the second exchange gets 401', async () => {
    const ctx = await setup();
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com' });
    await api(ctx.app, ctx.tenantA, 'POST', '/auth/request-link', { email: 'ada@example.com' });
    const tokenRow = await ctx.db
      .selectFrom('portal_customer_login_tokens')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantA)
      .executeTakeFirstOrThrow();

    const first = await api(ctx.app, ctx.tenantA, 'POST', '/auth/exchange', { token: tokenRow.token });
    expect(first.status).toBe(200);
    const second = await api(ctx.app, ctx.tenantA, 'POST', '/auth/exchange', { token: tokenRow.token });
    expect(second.status).toBe(401);
  });

  it('an expired login token gets 401', async () => {
    const ctx = await setup();
    const account = await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com' });
    await ctx.db
      .insertInto('portal_customer_login_tokens')
      .values({
        id: 'tok1',
        tenant_id: ctx.tenantA,
        account_id: account.id,
        token: 'expired-token',
        expires_at: '2000-01-01T00:00:00.000Z',
        used_at: null,
        created_at: nowIso(),
      })
      .execute();
    const res = await api(ctx.app, ctx.tenantA, 'POST', '/auth/exchange', { token: 'expired-token' });
    expect(res.status).toBe(401);
  });

  it('unknown token and malformed bodies are rejected', async () => {
    const ctx = await setup();
    expect((await api(ctx.app, ctx.tenantA, 'POST', '/auth/exchange', { token: 'nope' })).status).toBe(401);
    expect((await api(ctx.app, ctx.tenantA, 'POST', '/auth/exchange', {})).status).toBe(400);
    expect((await api(ctx.app, ctx.tenantA, 'POST', '/auth/request-link', { email: 'not-an-email' })).status).toBe(400);
  });
});

describe('sessions', () => {
  it('/me requires a valid session: missing and garbage tokens get 401', async () => {
    const ctx = await setup();
    expect((await api(ctx.app, ctx.tenantA, 'GET', '/me')).status).toBe(401);
    expect((await api(ctx.app, ctx.tenantA, 'GET', '/me', undefined, 'garbage')).status).toBe(401);
  });

  it('an expired session gets 401', async () => {
    const ctx = await setup();
    const account = await createAccountViaApi(ctx.app, ctx.tenantA);
    await ctx.db
      .insertInto('portal_customer_sessions')
      .values({
        id: 'sess1',
        tenant_id: ctx.tenantA,
        account_id: account.id,
        token: 'expired-session',
        expires_at: '2000-01-01T00:00:00.000Z',
        revoked: 0,
        created_at: nowIso(),
      })
      .execute();
    expect((await api(ctx.app, ctx.tenantA, 'GET', '/me', undefined, 'expired-session')).status).toBe(401);
  });

  it('accepts the session via Authorization: Bearer as well', async () => {
    const ctx = await setup();
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com' });
    const session = await login(ctx, ctx.tenantA, 'ada@example.com');
    const res = await ctx.app.request('/me', {
      headers: { 'x-tenant-id': ctx.tenantA, authorization: `Bearer ${session}` },
    });
    expect(res.status).toBe(200);
  });

  it('logout revokes the session', async () => {
    const ctx = await setup();
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com' });
    const session = await login(ctx, ctx.tenantA, 'ada@example.com');

    const out = await api(ctx.app, ctx.tenantA, 'POST', '/auth/logout', undefined, session);
    expect(out.status).toBe(200);
    expect((await api(ctx.app, ctx.tenantA, 'GET', '/me', undefined, session)).status).toBe(401);
  });
});
