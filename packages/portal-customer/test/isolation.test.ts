import { describe, expect, it } from 'vitest';
import type { PortalQuote } from '@blacklabel/portal-customer';
import { api, createAccountViaApi, login, makeQuotesProvider, setup } from './helpers';

describe('tenant isolation (the iron rule)', () => {
  it('tenant B cannot see tenant A accounts; A stays untouched', async () => {
    const ctx = await setup();
    const account = await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com', name: 'Ada' });

    const listB = await api(ctx.app, ctx.tenantB, 'GET', '/accounts');
    expect(listB.status).toBe(200);
    expect(((await listB.json()) as any).data).toEqual([]);

    const getB = await api(ctx.app, ctx.tenantB, 'GET', `/accounts/${account.id}`);
    expect(getB.status).toBe(404);

    // A's data is untouched.
    const getA = await api(ctx.app, ctx.tenantA, 'GET', `/accounts/${account.id}`);
    expect(getA.status).toBe(200);
    expect(((await getA.json()) as any).data.name).toBe('Ada');
  });

  it('a login token minted in tenant A cannot be exchanged under tenant B (and stays valid for A)', async () => {
    const ctx = await setup();
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com' });
    await api(ctx.app, ctx.tenantA, 'POST', '/auth/request-link', { email: 'ada@example.com' });
    const tokenRow = await ctx.db
      .selectFrom('portal_customer_login_tokens')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantA)
      .executeTakeFirstOrThrow();

    const crossExchange = await api(ctx.app, ctx.tenantB, 'POST', '/auth/exchange', { token: tokenRow.token });
    expect(crossExchange.status).toBe(401);

    // Not consumed by the cross-tenant attempt — still exchangeable in A.
    const properExchange = await api(ctx.app, ctx.tenantA, 'POST', '/auth/exchange', { token: tokenRow.token });
    expect(properExchange.status).toBe(200);
  });

  it('a session from tenant A is rejected under tenant B for every /me route', async () => {
    const ctx = await setup();
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com' });
    const session = await login(ctx, ctx.tenantA, 'ada@example.com');

    expect((await api(ctx.app, ctx.tenantB, 'GET', '/me', undefined, session)).status).toBe(401);
    expect((await api(ctx.app, ctx.tenantB, 'PATCH', '/me/contact', { name: 'Hacked' }, session)).status).toBe(401);
    expect((await api(ctx.app, ctx.tenantB, 'GET', '/me/messages', undefined, session)).status).toBe(401);
    expect((await api(ctx.app, ctx.tenantB, 'POST', '/me/messages', { body: 'x' }, session)).status).toBe(401);

    // A's account name unchanged after the cross-tenant PATCH attempt.
    const me = await api(ctx.app, ctx.tenantA, 'GET', '/me', undefined, session);
    expect(((await me.json()) as any).data.name).not.toBe('Hacked');
  });

  it('a quote living under tenant A is 404 for a tenant B customer even with the same customer id', async () => {
    const seed: Array<{ tenantId: string; quote: PortalQuote }> = [];
    const quotes = makeQuotesProvider(seed);
    const ctx = await setup({ providers: { quotes: quotes.provider } });
    seed.push({
      tenantId: ctx.tenantA,
      quote: { id: 'q1', customerId: 'cust_shared', status: 'pending', totalCents: 5000 },
    });
    // Same customer id string exists in tenant B — must still be denied.
    await createAccountViaApi(ctx.app, ctx.tenantB, { email: 'evil@example.com', customerId: 'cust_shared' });
    const sessionB = await login(ctx, ctx.tenantB, 'evil@example.com');

    expect((await api(ctx.app, ctx.tenantB, 'GET', '/me/quotes/q1', undefined, sessionB)).status).toBe(404);
    expect((await api(ctx.app, ctx.tenantB, 'POST', '/me/quotes/q1/approve', {}, sessionB)).status).toBe(404);
    expect(quotes.approvalCalls).toHaveLength(0);
  });

  it('missing tenant header is 400, unknown tenant is 404', async () => {
    const ctx = await setup();
    const missing = await ctx.app.request('/accounts');
    expect(missing.status).toBe(400);
    const unknown = await api(ctx.app, 'no-such-tenant', 'GET', '/accounts');
    expect(unknown.status).toBe(404);
  });
});

describe('cross-customer isolation (same tenant)', () => {
  it('one customer never sees another customer’s messages or uploads', async () => {
    const ctx = await setup();
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com', customerId: 'cust_ada' });
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'sam@example.com', customerId: 'cust_sam' });
    const adaSession = await login(ctx, ctx.tenantA, 'ada@example.com');
    const samSession = await login(ctx, ctx.tenantA, 'sam@example.com');

    await api(ctx.app, ctx.tenantA, 'POST', '/me/messages', { body: 'Ada private note' }, adaSession);
    await api(ctx.app, ctx.tenantA, 'POST', '/me/uploads', {
      fileName: 'ada.jpg', contentType: 'image/jpeg', sizeBytes: 10, kind: 'photo',
    }, adaSession);

    const samMessages = await api(ctx.app, ctx.tenantA, 'GET', '/me/messages', undefined, samSession);
    expect(((await samMessages.json()) as any).data).toEqual([]);
    const samUploads = await api(ctx.app, ctx.tenantA, 'GET', '/me/uploads', undefined, samSession);
    expect(((await samUploads.json()) as any).data).toEqual([]);

    const adaMessages = await api(ctx.app, ctx.tenantA, 'GET', '/me/messages', undefined, adaSession);
    expect(((await adaMessages.json()) as any).data).toHaveLength(1);
  });

  it('a customer cannot read or decide another customer’s quote in the same tenant', async () => {
    const seed: Array<{ tenantId: string; quote: PortalQuote }> = [];
    const quotes = makeQuotesProvider(seed);
    const ctx = await setup({ providers: { quotes: quotes.provider } });
    seed.push({
      tenantId: ctx.tenantA,
      quote: { id: 'q_ada', customerId: 'cust_ada', status: 'pending', totalCents: 7500 },
    });
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com', customerId: 'cust_ada' });
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'sam@example.com', customerId: 'cust_sam' });
    const samSession = await login(ctx, ctx.tenantA, 'sam@example.com');

    expect((await api(ctx.app, ctx.tenantA, 'GET', '/me/quotes/q_ada', undefined, samSession)).status).toBe(404);
    expect((await api(ctx.app, ctx.tenantA, 'POST', '/me/quotes/q_ada/approve', {}, samSession)).status).toBe(404);
    expect((await api(ctx.app, ctx.tenantA, 'POST', '/me/quotes/q_ada/decline', {}, samSession)).status).toBe(404);
    // The quoting service was never asked to write an ApprovalEvent.
    expect(quotes.approvalCalls).toHaveLength(0);

    // Ada can still see and decide her quote.
    const adaSession = await login(ctx, ctx.tenantA, 'ada@example.com');
    expect((await api(ctx.app, ctx.tenantA, 'GET', '/me/quotes/q_ada', undefined, adaSession)).status).toBe(200);
  });

  it('contact updates only ever touch the session’s own account', async () => {
    const ctx = await setup();
    const ada = await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com', name: 'Ada' });
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'sam@example.com', name: 'Sam' });
    const samSession = await login(ctx, ctx.tenantA, 'sam@example.com');

    // Sam updates his contact info; any ids smuggled into the body are ignored.
    const res = await api(ctx.app, ctx.tenantA, 'PATCH', '/me/contact', {
      name: 'Sam Updated',
      id: ada.id,
      accountId: ada.id,
      customerId: 'cust_ada',
    }, samSession);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.email).toBe('sam@example.com');

    const adaRow = await api(ctx.app, ctx.tenantA, 'GET', `/accounts/${ada.id}`);
    expect(((await adaRow.json()) as any).data.name).toBe('Ada'); // untouched
  });
});
