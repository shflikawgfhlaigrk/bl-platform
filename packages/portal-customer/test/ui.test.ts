import { describe, expect, it } from 'vitest';
import type { PortalInvoice, PortalQuote } from '@blacklabel/portal-customer';
import {
  api,
  createAccountViaApi,
  login,
  makeInvoicesProvider,
  makeQuotesProvider,
  setup,
  type TestCtx,
} from './helpers';

function cookieFrom(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = setCookie.match(/portal_session=([^;]+)/);
  if (!match) throw new Error(`no portal_session cookie in: ${setCookie}`);
  return `portal_session=${match[1]}`;
}

async function uiGet(ctx: TestCtx, tenantId: string, path: string, cookie?: string): Promise<Response> {
  return ctx.app.request(path, {
    headers: { 'x-tenant-id': tenantId, ...(cookie ? { cookie } : {}) },
  });
}

async function uiForm(
  ctx: TestCtx,
  tenantId: string,
  path: string,
  fields: Record<string, string>,
  cookie?: string,
): Promise<Response> {
  return ctx.app.request(path, {
    method: 'POST',
    headers: {
      'x-tenant-id': tenantId,
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** Sign in through the UI flow and return the session cookie. */
async function uiLogin(ctx: TestCtx, tenantId: string, email: string): Promise<string> {
  await uiForm(ctx, tenantId, '/ui/login', { email });
  const account = await ctx.db
    .selectFrom('portal_customer_accounts')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('email', '=', email.toLowerCase())
    .executeTakeFirstOrThrow();
  const token = await ctx.db
    .selectFrom('portal_customer_login_tokens')
    .select('token')
    .where('tenant_id', '=', tenantId)
    .where('account_id', '=', account.id)
    .where('used_at', 'is', null)
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .executeTakeFirstOrThrow();
  const res = await uiGet(ctx, tenantId, `/ui/session?token=${encodeURIComponent(token.token)}`);
  if (res.status !== 302) throw new Error(`ui session exchange failed: ${res.status}`);
  return cookieFrom(res);
}

describe('server-rendered portal UI', () => {
  it('renders a white-label mobile-first login page', async () => {
    const ctx = await setup();
    const res = await uiGet(ctx, ctx.tenantA, '/ui/login');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('type="email"');
    expect(html).toContain('action="/ui/login"');
    // Zero branding: generic title only.
    expect(html).toContain('Customer portal');
    expect(html.toLowerCase()).not.toContain('blacklabel');
  });

  it('POST /ui/login creates a token and shows the same generic page for unknown emails', async () => {
    const ctx = await setup();
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com' });

    const known = await uiForm(ctx, ctx.tenantA, '/ui/login', { email: 'ada@example.com' });
    expect(known.status).toBe(200);
    const knownHtml = await known.text();
    expect(knownHtml).toContain('Check your email');

    const unknown = await uiForm(ctx, ctx.tenantA, '/ui/login', { email: 'nobody@example.com' });
    const unknownHtml = await unknown.text();
    expect(unknownHtml).toContain('Check your email');

    const tokens = await ctx.db.selectFrom('portal_customer_login_tokens').selectAll().execute();
    expect(tokens).toHaveLength(1); // only the known account got one

    // The raw single-use token never leaks into the HTML response.
    expect(knownHtml).not.toContain(tokens[0].token);
  });

  it('exchanges the magic token for a cookie session and renders the dashboard', async () => {
    const seedQuotes: Array<{ tenantId: string; quote: PortalQuote }> = [];
    const seedInvoices: Array<{ tenantId: string; invoice: PortalInvoice }> = [];
    const quotes = makeQuotesProvider(seedQuotes);
    const ctx = await setup({
      providers: { quotes: quotes.provider, invoices: makeInvoicesProvider(seedInvoices) },
    });
    seedQuotes.push({
      tenantId: ctx.tenantA,
      quote: { id: 'q1', customerId: 'cust_ada', status: 'pending', totalCents: 12550, title: 'Spring service' },
    });
    seedInvoices.push({
      tenantId: ctx.tenantA,
      invoice: { id: 'inv1', customerId: 'cust_ada', status: 'open', totalCents: 45000, balanceCents: 30000 },
    });
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com', name: 'Ada Alvarez', customerId: 'cust_ada' });

    const cookie = await uiLogin(ctx, ctx.tenantA, 'ada@example.com');
    const res = await uiGet(ctx, ctx.tenantA, '/ui', cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Ada Alvarez');
    expect(html).toContain('Spring service');
    expect(html).toContain('$125.50');
    expect(html).toContain('Invoice inv1');
    expect(html).toContain('$300.00'); // outstanding balance
    expect(html).toContain('/ui/quotes/q1/approve');
  });

  it('renders a friendly HTML page (not JSON) for an invalid or spent magic link', async () => {
    const ctx = await setup();
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com' });

    // Unknown token.
    const bad = await uiGet(ctx, ctx.tenantA, '/ui/session?token=not-a-real-token');
    expect(bad.status).toBe(401);
    expect(bad.headers.get('content-type')).toContain('text/html');
    const badHtml = await bad.text();
    expect(badHtml).toContain('didn&#39;t work');
    expect(badHtml).toContain('/ui/login');

    // Spent token: exchange once via the UI, then replay the link.
    const cookie = await uiLogin(ctx, ctx.tenantA, 'ada@example.com');
    expect(cookie).toBeTruthy();
    const spent = await ctx.db
      .selectFrom('portal_customer_login_tokens')
      .select('token')
      .where('tenant_id', '=', ctx.tenantA)
      .executeTakeFirstOrThrow();
    const replay = await uiGet(ctx, ctx.tenantA, `/ui/session?token=${encodeURIComponent(spent.token)}`);
    expect(replay.status).toBe(401);
    expect((await replay.text())).toContain('didn&#39;t work');

    // Missing token still redirects straight to login.
    const missing = await uiGet(ctx, ctx.tenantA, '/ui/session');
    expect(missing.status).toBe(302);
    expect(missing.headers.get('location')).toBe('/ui/login');
  });

  it('redirects to the login page without a session cookie', async () => {
    const ctx = await setup();
    const res = await uiGet(ctx, ctx.tenantA, '/ui');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/ui/login');
  });

  it('escapes customer-provided content in the dashboard HTML', async () => {
    const ctx = await setup();
    await createAccountViaApi(ctx.app, ctx.tenantA, {
      email: 'ada@example.com',
      name: '<script>alert(1)</script>',
    });
    const session = await login(ctx, ctx.tenantA, 'ada@example.com');
    await api(ctx.app, ctx.tenantA, 'POST', '/me/messages', { body: '<img src=x onerror=alert(2)>' }, session);

    const cookie = await uiLogin(ctx, ctx.tenantA, 'ada@example.com');
    const html = await (await uiGet(ctx, ctx.tenantA, '/ui', cookie)).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<img src=x onerror=alert(2)>');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
  });

  it('approves a quote and sends a message through the UI forms', async () => {
    const seedQuotes: Array<{ tenantId: string; quote: PortalQuote }> = [];
    const quotes = makeQuotesProvider(seedQuotes);
    const ctx = await setup({ providers: { quotes: quotes.provider } });
    seedQuotes.push({
      tenantId: ctx.tenantA,
      quote: { id: 'q1', customerId: 'cust_ada', status: 'pending', totalCents: 9900 },
    });
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com', customerId: 'cust_ada' });
    const cookie = await uiLogin(ctx, ctx.tenantA, 'ada@example.com');

    const approve = await uiForm(ctx, ctx.tenantA, '/ui/quotes/q1/approve', {}, cookie);
    expect(approve.status).toBe(302);
    expect(quotes.approvalCalls).toHaveLength(1);
    expect(quotes.approvalCalls[0]).toMatchObject({ quoteId: 'q1', decision: 'approved', customerId: 'cust_ada' });

    const send = await uiForm(ctx, ctx.tenantA, '/ui/messages', { subject: 'Hi', body: 'From the UI' }, cookie);
    expect(send.status).toBe(302);
    const rows = await ctx.db
      .selectFrom('portal_customer_messages')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantA)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe('From the UI');
  });

  it('shows connected manual collection instructions without claiming payment completed', async () => {
    const seedInvoices: Array<{ tenantId: string; invoice: PortalInvoice }> = [];
    const ctx = await setup({ providers: { invoices: makeInvoicesProvider(seedInvoices), payments: {
      createPaymentIntent: async (input) => ({ id: 'manual-fixture', provider: 'manual', invoiceId: input.invoiceId,
        amountCents: input.amountCents, currency: 'usd', status: 'requires_action', instructions: 'Pay at the service desk.' }),
    } } });
    seedInvoices.push({
      tenantId: ctx.tenantA,
      invoice: { id: 'inv1', customerId: 'cust_ada', status: 'open', totalCents: 5000, balanceCents: 5000 },
    });
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com', customerId: 'cust_ada' });
    const cookie = await uiLogin(ctx, ctx.tenantA, 'ada@example.com');

    const res = await uiForm(ctx, ctx.tenantA, '/ui/invoices/inv1/pay', {}, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Payment instructions');
    expect(html).toContain('$50.00');
    expect(html).toContain('Pay at the service desk.');
    expect(html).not.toContain('was initiated');
  });

  it('logout clears the session: the dashboard redirects to login again', async () => {
    const ctx = await setup();
    await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'ada@example.com' });
    const cookie = await uiLogin(ctx, ctx.tenantA, 'ada@example.com');

    expect((await uiGet(ctx, ctx.tenantA, '/ui', cookie)).status).toBe(200);
    const out = await uiGet(ctx, ctx.tenantA, '/ui/logout', cookie);
    expect(out.status).toBe(302);
    // The revoked session no longer works even if the cookie is replayed.
    expect((await uiGet(ctx, ctx.tenantA, '/ui', cookie)).status).toBe(302);
  });
});


it('shows safe review links only after portal login and rejects unsafe provider URLs', async () => {
  const ctx = await setup({ providers: { reviews: { listPendingForCustomer: async () => [
    { id: 'good', requestedAt: '2026-09-13', url: '/review#synthetic-capability' },
    { id: 'https', requestedAt: '2026-09-13', url: 'https://reviews.example.test/feedback' },
    { id: 'script', requestedAt: '2026-09-13', url: 'javascript:alert(1)' },
    { id: 'authority', requestedAt: '2026-09-13', url: '//outside.example.test/feedback' },
    { id: 'backslash', requestedAt: '2026-09-13', url: '/\\outside.example.test/feedback' },
  ] } } });
  await createAccountViaApi(ctx.app, ctx.tenantA, { email: 'reviewer@example.test', customerId: 'reviewer' });
  const anonymous = await uiGet(ctx, ctx.tenantA, '/ui');
  expect(anonymous.status).toBe(302); expect(await anonymous.text()).not.toContain('synthetic-capability');
  const cookie = await uiLogin(ctx, ctx.tenantA, 'reviewer@example.test');
  const response = await uiGet(ctx, ctx.tenantA, '/ui', cookie);
  expect(response.status).toBe(200); const html = await response.text();
  expect(html).toContain('href="/review#synthetic-capability"');
  expect(html).toContain('href="https://reviews.example.test/feedback"');
  expect(html).not.toContain('javascript:'); expect(html).not.toContain('outside.example.test');
});
