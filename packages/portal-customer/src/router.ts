import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import {
  ApiError,
  asCoreDb,
  errorHandler,
  id,
  parsePagination,
  tenantMiddleware,
  type ModuleDeps,
  type TenantEnv,
} from '@blacklabel/core';
import type { PortalCustomerAccountRow, PortalCustomerDatabase } from './schema';
import {
  authenticateSession,
  createAccount,
  createInvoicePaymentIntent,
  createServiceRequest,
  decideQuote,
  exchangeLoginToken,
  getAccount,
  listAccounts,
  listMessages,
  listUploads,
  listServiceRequests,
  getServiceRequest,
  notWired,
  recordUpload,
  requestLoginLink,
  respondServiceRequest,
  revokeSession,
  sendPortalMessage,
  updateContact,
  type PortalCustomerProviders,
  type PortalQuote,
} from './service';

/**
 * Dependencies for the portal-customer router. Extends the standard
 * ModuleDeps with an OPTIONAL provider bag; a plain
 * `ModuleDeps<PortalCustomerDatabase>` is accepted as-is (every provider is
 * optional and absence degrades to 501/skip per CONVENTIONS §9).
 */
export interface PortalCustomerDeps extends ModuleDeps<PortalCustomerDatabase> {
  providers?: PortalCustomerProviders;
  brandName?: string;
}

const SESSION_HEADER = 'x-portal-session';
const SESSION_COOKIE = 'portal_session';

/* ------------------------- request schemas ------------------------- */

const createAccountSchema = z.object({
  customerId: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
  phone: z.string().max(50).optional(),
});

const requestLinkSchema = z.object({ email: z.string().email() });

const exchangeSchema = z.object({ token: z.string().min(1) });

const contactPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    phone: z.string().max(50).nullable().optional(),
    email: z.string().email().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });

const decisionSchema = z.object({ comment: z.string().max(2000).optional(), expectedPayloadHash: z.string().regex(/^[0-9a-f]{64}$/).optional() });

const messageSchema = z.object({
  subject: z.string().max(200).optional(),
  body: z.string().min(1).max(5000),
});

const uploadSchema = z.object({
  fileName: z.string().min(1).max(255),
  contentType: z.string().min(1).max(255),
  sizeBytes: z.number().int().min(0).max(100 * 1024 * 1024),
  contentBase64: z.string().max(14 * 1024 * 1024).optional(),
  kind: z.enum(['photo', 'document']).default('document'),
  relatedEntityType: z.string().max(100).optional(),
  relatedEntityId: z.string().max(100).optional(),
});

const serviceRequestSchema = z.object({
  kind: z.enum(['repeat', 'reschedule']),
  referenceId: z.string().min(1).max(100),
  idempotencyKey: z.string().min(1).max(100),
  requestedStartsAt: z.string().min(1).max(100).optional(),
  requestedEndsAt: z.string().min(1).max(100).optional(),
  timezone: z.string().min(1).max(100).optional(),
  note: z.string().max(2000).optional(),
}).strict();
const requestResponseSchema = z.object({
  status: z.enum(['acknowledged', 'declined', 'resolved']),
  response: z.string().max(2000).optional(),
  expectedVersion: z.number().int().positive(),
}).strict();

function publicServiceRequest(row: Awaited<ReturnType<typeof getServiceRequest>>) {
  const { tenant_id: _tenant, payload_hash: _hash, idempotency_key: _key, ...publicRow } = row;
  return publicRow;
}

/* ----------------------------- helpers ----------------------------- */

async function readJson(c: Context<TenantEnv>): Promise<unknown> {
  return c.req.json().catch(() => ({}));
}

function publicAccount(a: PortalCustomerAccountRow) {
  return {
    id: a.id,
    customerId: a.customer_id,
    email: a.email,
    name: a.name,
    phone: a.phone,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

/* --------------------------- HTML helpers -------------------------- */

function reviewHref(value: unknown): string | null {
  if (typeof value !== 'string' || !(/^(?:https?:\/\/|\/(?![\/\\]))/.test(value)) || /[\x00-\x20\\]/.test(value)) return null;
  try {
    const url = new URL(value, 'https://portal.invalid');
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? value : null;
  } catch { return null; }
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Mount-prefix-safe base path for the UI ("/ui" or "/api/portal-customer/ui"). */
function uiBase(c: Context<TenantEnv>): string {
  const path = c.req.path;
  const idx = path.indexOf('/ui');
  return idx === -1 ? '/ui' : path.slice(0, idx + 3);
}

function signInUrl(c: Context<TenantEnv>, token: string): string {
  const route = c.req.path;
  const auth = route.indexOf('/auth/');
  const base = auth >= 0 ? `${route.slice(0, auth)}/ui` : uiBase(c);
  return `${new URL(c.req.url).origin}${base}/session?token=${encodeURIComponent(token)}`;
}

function portalPage(title: string, body: string, brandName = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${brandName ? `${esc(brandName)} · ` : ''}${esc(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #10110f; color: #eeeae0; font: 16px/1.5 system-ui, -apple-system, sans-serif; }
  main { max-width: 740px; margin: 0 auto; padding: 28px 18px; }
  .brand { color: #d3b77a; letter-spacing: .18em; font-weight: 650; padding: 10px 0 24px; }
  h1 { font-size: 1.35rem; margin: 8px 0 16px; }
  h2 { font-size: 1.05rem; margin: 24px 0 8px; }
  .card { border: 1px solid #363b2d; background: #1a1c17; border-radius: 10px; padding: 16px; margin: 10px 0; }
  .muted { color: #acaf9d; font-size: 0.9rem; }
  .row { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
  label { display: block; margin: 12px 0 4px; font-weight: 600; }
  input, textarea { width: 100%; padding: 10px; border: 1px solid #625438; border-radius: 6px; font: inherit; color: #eeeae0; background: #10110f; }
  button { padding: 10px 16px; border: 1px solid #cfb478; border-radius: 6px; background: #cfb478; color: #15180f; font: inherit; cursor: pointer; margin-top: 12px; }
  button.secondary { background: transparent; color: #d9c79f; }
  form.inline { display: inline; }
  form.inline button { margin-top: 8px; margin-right: 8px; }
  .pill { display: inline-block; padding: 2px 8px; border: 1px solid #ccc; border-radius: 999px; font-size: 0.8rem; }
  a { color: #d3b77a; }
</style>
</head>
<body><main>${brandName ? `<div class="brand">${esc(brandName.toUpperCase())} · CUSTOMER PORTAL</div>` : ''}${body}</main></body>
</html>`;
}

/* ------------------------------ router ----------------------------- */

export function portalCustomerRouter(deps: PortalCustomerDeps): Hono<TenantEnv> {
  const { db, events, contracts } = deps;
  const providers = deps.providers ?? {};
  const page = (title: string, body: string) => portalPage(title, body, deps.brandName);

  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(db)));

  /** Session token from Authorization: Bearer, x-portal-session, or cookie. */
  function sessionToken(c: Context<TenantEnv>): string | undefined {
    const auth = c.req.header('authorization');
    const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1];
    return bearer ?? c.req.header(SESSION_HEADER) ?? getCookie(c, SESSION_COOKIE);
  }

  /**
   * Resolve the calling customer from the session or throw 401. Every
   * customer-facing endpoint derives the customer identity from THIS —
   * never from a param, body, or query value.
   */
  async function requireAccount(c: Context<TenantEnv>): Promise<PortalCustomerAccountRow> {
    const token = sessionToken(c);
    if (!token) throw ApiError.unauthorized('missing portal session');
    const account = await authenticateSession(db, c.get('tenantId'), token);
    if (!account) throw ApiError.unauthorized('invalid or expired portal session');
    return account;
  }

  /* ---------------- business-side account management ---------------- */

  app.post('/accounts', async (c) => {
    const body = createAccountSchema.parse(await readJson(c));
    const row = await createAccount(db, events, c.get('tenantId'), body);
    return c.json({ data: publicAccount(row) }, 201);
  });

  app.get('/accounts', async (c) => {
    const pageq = parsePagination(c.req.query());
    const rows = await listAccounts(db, c.get('tenantId'), pageq);
    return c.json({ data: rows.map(publicAccount), limit: pageq.limit, offset: pageq.offset });
  });

  app.get('/accounts/:accountId', async (c) => {
    const row = await getAccount(db, c.get('tenantId'), c.req.param('accountId'));
    if (!row) throw ApiError.notFound(`portal account not found: ${c.req.param('accountId')}`);
    return c.json({ data: publicAccount(row) });
  });

  app.get('/requests', async (c) => {
    const pageq = parsePagination(c.req.query());
    const status = z.enum(['pending', 'acknowledged', 'declined', 'resolved']).optional().parse(c.req.query('status'));
    const rows = await listServiceRequests(db, c.get('tenantId'), { status }, pageq);
    return c.json({ data: rows.map(publicServiceRequest), limit: pageq.limit, offset: pageq.offset });
  });
  app.get('/requests/:requestId', async (c) => c.json({ data: publicServiceRequest(await getServiceRequest(db, c.get('tenantId'), c.req.param('requestId'))) }));
  app.patch('/requests/:requestId', async (c) => {
    const body = requestResponseSchema.parse(await readJson(c));
    const row = await respondServiceRequest(db, events, c.get('tenantId'), c.req.param('requestId'), c.req.header('x-user-id') ?? 'system', body);
    return c.json({ data: publicServiceRequest(row) });
  });

  /* ----------------------------- auth ------------------------------ */

  app.post('/auth/request-link', async (c) => {
    const body = requestLinkSchema.parse(await readJson(c));
    const result = await requestLoginLink(db, events, c.get('tenantId'), body.email);
    // Deliver the link out-of-band via the messaging contract when wired.
    if (result && contracts.sendMessage) {
      const message = {
        idempotencyKey: `portal-login:${result.row.id}`,
        tenantId: c.get('tenantId'),
        channel: 'email' as const,
        to: result.account.email,
        subject: 'Your sign-in link',
        body: `Sign in to your customer portal: ${signInUrl(c, result.token)}\n\nThis single-use link expires ${result.row.expires_at}.`,
        relatedEntityType: 'portal_customer.account',
        relatedEntityId: result.account.id,
      };
      try { await contracts.sendMessage.sendMessage(message); }
      catch { await events.emit(c.get('tenantId'), 'portal_customer.login.delivery_failed', { accountId: result.account.id }); }
    }
    // Identical response whether or not the email matched (no enumeration).
    return c.json({ data: { requested: true } });
  });

  app.post('/auth/exchange', async (c) => {
    const body = exchangeSchema.parse(await readJson(c));
    const { session, account } = await exchangeLoginToken(db, events, c.get('tenantId'), body.token);
    return c.json({
      data: {
        sessionToken: session.token,
        expiresAt: session.expires_at,
        account: publicAccount(account),
      },
    });
  });

  app.post('/auth/logout', async (c) => {
    await requireAccount(c);
    await revokeSession(db, c.get('tenantId'), sessionToken(c)!);
    return c.json({ data: { revoked: true } });
  });

  /* -------------------------- self-service -------------------------- */

  app.get('/me', async (c) => {
    const account = await requireAccount(c);
    return c.json({ data: publicAccount(account) });
  });

  app.patch('/me/contact', async (c) => {
    const account = await requireAccount(c);
    const patch = contactPatchSchema.parse(await readJson(c));
    const updated = await updateContact(db, events, c.get('tenantId'), account.id, patch);
    return c.json({ data: publicAccount(updated) });
  });

  /* ------------------------- appointments --------------------------- */

  app.get('/me/appointments', async (c) => {
    const account = await requireAccount(c);
    if (!providers.appointments) throw notWired('appointments');
    const rows = await providers.appointments.listForCustomer(c.get('tenantId'), account.customer_id);
    return c.json({ data: rows });
  });

  /* ----------------------------- quotes ----------------------------- */

  app.get('/me/quotes', async (c) => {
    const account = await requireAccount(c);
    if (!providers.quotes) throw notWired('quotes');
    const rows = await providers.quotes.listForCustomer(c.get('tenantId'), account.customer_id);
    return c.json({ data: rows });
  });

  app.get('/me/quotes/:quoteId', async (c) => {
    const account = await requireAccount(c);
    if (!providers.quotes) throw notWired('quotes');
    const quote = await providers.quotes.getForCustomer(
      c.get('tenantId'),
      account.customer_id,
      c.req.param('quoteId'),
    );
    if (!quote) throw ApiError.notFound(`quote not found: ${c.req.param('quoteId')}`);
    return c.json({ data: quote });
  });

  app.post('/me/quotes/:quoteId/approve', async (c) => {
    const account = await requireAccount(c);
    const body = decisionSchema.parse(await readJson(c));
    const result = await decideQuote(
      db, events, providers.quotes, c.get('tenantId'), account,
      c.req.param('quoteId'), 'approved', body.comment, body.expectedPayloadHash,
    );
    return c.json({ data: { quoteId: result.quote.id, decision: 'approved', approvalEventId: result.approvalEventId } });
  });

  app.post('/me/quotes/:quoteId/decline', async (c) => {
    const account = await requireAccount(c);
    const body = decisionSchema.parse(await readJson(c));
    const result = await decideQuote(
      db, events, providers.quotes, c.get('tenantId'), account,
      c.req.param('quoteId'), 'declined', body.comment, body.expectedPayloadHash,
    );
    return c.json({ data: { quoteId: result.quote.id, decision: 'declined', approvalEventId: result.approvalEventId } });
  });

  /* ---------------------------- invoices ---------------------------- */

  app.get('/me/invoices', async (c) => {
    const account = await requireAccount(c);
    if (!providers.invoices) throw notWired('invoices');
    const rows = await providers.invoices.listForCustomer(c.get('tenantId'), account.customer_id);
    return c.json({ data: rows });
  });

  app.post('/me/invoices/:invoiceId/pay', async (c) => {
    const account = await requireAccount(c);
    const body = z.object({ purpose: z.enum(['deposit', 'balance']).default('balance') }).parse(await readJson(c));
    const intent = await createInvoicePaymentIntent(
      db, events, providers.invoices, providers.payments,
      c.get('tenantId'), account, c.req.param('invoiceId'), body.purpose,
    );
    return c.json({ data: intent }, 201);
  });

  app.put('/me/invoices/:invoiceId/reminder-preference', async c => {
    const account = await requireAccount(c);
    const body = z.object({ optedOut: z.boolean() }).parse(await readJson(c));
    if (!providers.invoices?.setReminderOptOut) throw notWired('invoice reminder preferences');
    await providers.invoices.setReminderOptOut(c.get('tenantId'), account.customer_id, c.req.param('invoiceId'), body.optedOut);
    return c.json({ data: { optedOut: body.optedOut } });
  });

  /* ------------------------- jobs & reviews -------------------------- */

  app.get('/me/jobs', async (c) => {
    const account = await requireAccount(c);
    if (!providers.jobs) throw notWired('jobs');
    const rows = await providers.jobs.listForCustomer(c.get('tenantId'), account.customer_id);
    return c.json({ data: rows });
  });

  app.get('/me/requests', async (c) => {
    const account = await requireAccount(c);
    const pageq = parsePagination(c.req.query());
    const rows = await listServiceRequests(db, c.get('tenantId'), { accountId: account.id }, pageq);
    return c.json({ data: rows.map(publicServiceRequest), limit: pageq.limit, offset: pageq.offset });
  });
  app.post('/me/requests', async (c) => {
    const account = await requireAccount(c);
    const input = serviceRequestSchema.parse(await readJson(c));
    const result = await createServiceRequest(db, events, providers, c.get('tenantId'), account, input);
    return c.json({ data: { request: publicServiceRequest(result.request), replayed: result.replayed } }, result.replayed ? 200 : 201);
  });

  app.get('/me/reviews/pending', async (c) => {
    const account = await requireAccount(c);
    if (!providers.reviews) throw notWired('reviews');
    const rows = await providers.reviews.listPendingForCustomer(c.get('tenantId'), account.customer_id);
    return c.json({ data: rows });
  });

  /* ---------------------------- messages ---------------------------- */

  app.get('/me/messages', async (c) => {
    const account = await requireAccount(c);
    const pageq = parsePagination(c.req.query());
    const rows = await listMessages(db, c.get('tenantId'), account.id, pageq);
    return c.json({ data: rows, limit: pageq.limit, offset: pageq.offset });
  });

  app.post('/me/messages', async (c) => {
    const account = await requireAccount(c);
    const body = messageSchema.parse(await readJson(c));
    const row = await sendPortalMessage(db, events, contracts, c.get('tenantId'), account, body);
    return c.json({ data: row }, 201);
  });

  /* ----------------------------- uploads ---------------------------- */

  app.get('/me/uploads', async (c) => {
    const account = await requireAccount(c);
    const pageq = parsePagination(c.req.query());
    const rows = await listUploads(db, c.get('tenantId'), account.id, pageq);
    return c.json({ data: rows, limit: pageq.limit, offset: pageq.offset });
  });

  app.get('/me/files', async (c) => {
    const account = await requireAccount(c);
    if (!providers.files?.listForCustomer) throw notWired('files');
    return c.json({ data: await providers.files.listForCustomer(c.get('tenantId'), account.customer_id) });
  });
  app.get('/me/files/:fileId/content', async (c) => {
    const account = await requireAccount(c);
    if (!providers.files?.readForCustomer) throw notWired('files');
    const file = await providers.files.readForCustomer(c.get('tenantId'), account.customer_id, c.req.param('fileId'));
    return new Response(new Uint8Array(file.content).buffer, { headers: {
      'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'Cache-Control': 'no-store',
    } });
  });

  app.post('/me/uploads', async (c) => {
    const account = await requireAccount(c);
    const body = uploadSchema.parse(await readJson(c));
    const row = await recordUpload(db, events, providers.files, c.get('tenantId'), account, body);
    return c.json({ data: row }, 201);
  });

  /* ------------------------------------------------------------------ *
   * Server-rendered UI — minimal, mobile-first, white-label.
   * ------------------------------------------------------------------ */

  async function uiAccount(c: Context<TenantEnv>): Promise<PortalCustomerAccountRow | undefined> {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return undefined;
    return authenticateSession(db, c.get('tenantId'), token);
  }

  app.get('/ui/login', (c) => {
    const base = uiBase(c);
    return c.html(page('Sign in', `
      <h1>Customer portal</h1>
      <div class="card">
        <form method="post" action="${esc(base)}/login">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" required autocomplete="email" placeholder="you@example.com">
          <button type="submit">Email me a sign-in link</button>
        </form>
      </div>
      <p class="muted">We&#39;ll send a single-use sign-in link to your email if it matches an account.</p>
    `));
  });

  app.post('/ui/login', async (c) => {
    const form = await c.req.parseBody();
    const email = typeof form.email === 'string' ? form.email : '';
    if (requestLinkSchema.safeParse({ email }).success) {
      const result = await requestLoginLink(db, events, c.get('tenantId'), email);
      if (result && contracts.sendMessage) {
        await contracts.sendMessage.sendMessage({
          tenantId: c.get('tenantId'),
          channel: 'email',
          to: result.account.email,
          subject: 'Your sign-in link',
          body: `Sign in to your customer portal: ${signInUrl(c, result.token)}\n\nThis single-use link expires ${result.row.expires_at}.`,
          relatedEntityType: 'portal_customer.account',
          relatedEntityId: result.account.id,
        });
      }
    }
    return c.html(page('Check your email', `
      <h1>Check your email</h1>
      <div class="card">If that address matches an account, a single-use sign-in link is on its way.</div>
      <p><a href="${esc(uiBase(c))}/login">Back to sign in</a></p>
    `));
  });

  app.get('/ui/session', async (c) => {
    const token = c.req.query('token') ?? '';
    const base = uiBase(c);
    if (!token) return c.redirect(`${base}/login`);
    try {
      const { session } = await exchangeLoginToken(db, events, c.get('tenantId'), token);
      setCookie(c, SESSION_COOKIE, session.token, { httpOnly: true, sameSite: 'Lax', secure: new URL(c.req.url).protocol === 'https:', path: '/' });
      return c.redirect(base);
    } catch (err) {
      // Expired/spent/unknown magic links are the common failure path in a
      // browser — render a friendly HTML page instead of the JSON 401.
      if (err instanceof ApiError && err.status === 401) {
        return c.html(page('Link expired', `
          <h1>That sign-in link didn&#39;t work</h1>
          <div class="card">The link is invalid, already used, or expired. Request a fresh one below.</div>
          <p><a href="${esc(base)}/login">Back to sign in</a></p>
        `), 401);
      }
      throw err;
    }
  });

  app.get('/ui/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await revokeSession(db, c.get('tenantId'), token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect(`${uiBase(c)}/login`);
  });

  app.get('/ui', async (c) => {
    const account = await uiAccount(c);
    const base = uiBase(c);
    if (!account) return c.redirect(`${base}/login`);
    const tenantId = c.get('tenantId');

    const sections: string[] = [];

    if (providers.appointments) {
      const rows = await providers.appointments.listForCustomer(tenantId, account.customer_id);
      sections.push(`<h2>Appointments</h2>${rows.length === 0 ? '<p class="muted">No appointments.</p>' : rows.map((a) => `
        <div class="card"><div class="row"><strong>${esc(a.title ?? a.serviceKey ?? 'Appointment')}</strong><span class="pill">${esc(a.status)}</span></div>
        <div class="muted">${esc(a.startsAt)} &rarr; ${esc(a.endsAt)}</div>${a.notes ? `<div>${esc(a.notes)}</div>` : ''}
        ${['requested', 'confirmed'].includes(a.status) ? `<details><summary>Request a different time</summary>
          <form method="post" action="${esc(base)}/requests">
            <input type="hidden" name="kind" value="reschedule"><input type="hidden" name="referenceId" value="${esc(a.id)}"><input type="hidden" name="idempotencyKey" value="${id()}">
            <label for="start-${esc(a.id)}">Preferred start</label><input id="start-${esc(a.id)}" name="requestedStartsAt" type="datetime-local" required>
            <label for="zone-${esc(a.id)}">Timezone for your preferred time</label><input id="zone-${esc(a.id)}" name="timezone" value="${esc(a.timezone ?? 'UTC')}" required>
            <label for="note-${esc(a.id)}">Anything we should know?</label><textarea id="note-${esc(a.id)}" name="note" maxlength="2000" rows="2"></textarea>
            <p class="muted">Your current appointment stays in place until the business confirms a change.</p><button>Request a reschedule</button>
          </form></details>` : ''}</div>`).join('')}`);
    }

    if (providers.quotes) {
      const rows = await providers.quotes.listForCustomer(tenantId, account.customer_id);
      const renderQuote = (q: PortalQuote) => `
        <div class="card">
          <div class="row"><strong>${esc(q.title ?? `Quote ${q.id}`)}</strong><span class="pill">${esc(q.status)}</span></div>
          ${q.revisionNumber ? `<div class="muted">Version ${esc(q.revisionNumber)}</div>` : ''}
          ${q.lines?.length ? `<table><thead><tr><th>Work</th><th>Quantity</th><th>Unit price</th><th>Amount</th></tr></thead><tbody>${q.lines.map(line => `<tr><td>${esc(line.description)}</td><td>${esc(line.quantity)}</td><td>${money(line.unitPriceCents)}</td><td>${money(line.totalCents)}</td></tr>`).join('')}</tbody></table>` : ''}
          ${q.notes ? `<p>${esc(q.notes)}</p>` : ''}
          ${q.subtotalCents !== undefined ? `<div>Subtotal: ${money(q.subtotalCents)} · Discount: ${money(q.discountCents ?? 0)} · Tax: ${money(q.taxCents ?? 0)}</div>` : ''}
          <div><strong>Total: ${money(q.totalCents)}</strong></div>
          ${q.expiresAt ? `<div class="muted">Valid until ${esc(q.expiresAt)}</div>` : ''}
          ${['pending', 'sent', 'viewed'].includes(q.status) && (!q.expiresAt || Date.parse(q.expiresAt) > Date.now()) ? `
            <form class="inline" method="post" action="${esc(base)}/quotes/${esc(q.id)}/approve">${q.payloadHash ? `<input type="hidden" name="expectedPayloadHash" value="${esc(q.payloadHash)}">` : ''}<button type="submit">Approve this scope</button></form>
            <form class="inline" method="post" action="${esc(base)}/quotes/${esc(q.id)}/decline">${q.payloadHash ? `<input type="hidden" name="expectedPayloadHash" value="${esc(q.payloadHash)}">` : ''}<button type="submit" class="secondary">Decline</button></form>
          ` : ''}
        </div>`;
      sections.push(`<h2>Quotes</h2>${rows.length === 0 ? '<p class="muted">No quotes.</p>' : rows.map(renderQuote).join('')}`);
    }

    if (providers.invoices) {
      const rows = await providers.invoices.listForCustomer(tenantId, account.customer_id);
      sections.push(`<h2>Invoices</h2>${rows.length === 0 ? '<p class="muted">No invoices.</p>' : rows.map((i) => `
        <div class="card">
          <div class="row"><strong>Invoice ${esc(i.id)}</strong><span class="pill">${esc(i.status)}</span></div>
          <div>Total ${money(i.totalCents)} &middot; Due ${money(i.balanceCents)}</div>
          ${(i.depositRemainingCents ?? 0) > 0 ? `<div>Deposit due: ${money(i.depositRemainingCents!)}${i.depositDueAt ? ` · ${esc(i.depositDueAt)}` : ''}</div><form class="inline" method="post" action="${esc(base)}/invoices/${esc(i.id)}/pay"><input type="hidden" name="purpose" value="deposit"><button type="submit">Deposit instructions</button></form>` : ''}
          ${i.balanceCents > 0 ? `<form class="inline" method="post" action="${esc(base)}/invoices/${esc(i.id)}/pay"><input type="hidden" name="purpose" value="balance"><button type="submit">Balance instructions</button></form>` : ''}
          ${providers.invoices?.setReminderOptOut ? `<form class="inline" method="post" action="${esc(base)}/invoices/${esc(i.id)}/reminder-preference"><input type="hidden" name="optedOut" value="${i.remindersOptedOut ? 'false' : 'true'}"><button type="submit" class="secondary">${i.remindersOptedOut ? 'Allow payment reminders' : 'Stop payment reminders'}</button></form>` : ''}
        </div>`).join('')}`);
    }

    if (providers.jobs) {
      const rows = await providers.jobs.listForCustomer(tenantId, account.customer_id);
      sections.push(`<h2>Jobs</h2>${rows.length === 0 ? '<p class="muted">No jobs.</p>' : rows.map((j) => `
        <div class="card"><div class="row"><strong>${esc(j.title)}</strong><span class="pill">${esc(j.status)}</span></div>${j.detail ? `<div class="muted">${esc(j.detail)}</div>` : ''}
        ${j.status === 'completed' ? `<details><summary>Request this service again</summary><form method="post" action="${esc(base)}/requests">
          <input type="hidden" name="kind" value="repeat"><input type="hidden" name="referenceId" value="${esc(j.id)}"><input type="hidden" name="idempotencyKey" value="${id()}">
          <label for="repeat-${esc(j.id)}">What would you like this time?</label><textarea id="repeat-${esc(j.id)}" name="note" rows="2" maxlength="2000"></textarea>
          <p class="muted">The business will confirm the work, timing, and price with you.</p><button>Request repeat service</button>
        </form></details>` : ''}</div>`).join('')}`);
    }

    const serviceRequests = await listServiceRequests(db, tenantId, { accountId: account.id }, { limit: 20, offset: 0 });
    if (serviceRequests.length) sections.push(`<h2>Your requests</h2>${serviceRequests.map((row) => `<div class="card"><div class="row"><strong>${esc(row.source_title)} · ${row.kind === 'repeat' ? 'Repeat service' : 'Reschedule'}</strong><span class="pill">${esc(row.status)}</span></div>${row.response ? `<p>${esc(row.response)}</p>` : '<p class="muted">Recorded for the business to review.</p>'}<a href="${esc(base)}/requests/${encodeURIComponent(row.id)}">View receipt</a></div>`).join('')}`);

    if (providers.reviews) {
      const rows = await providers.reviews.listPendingForCustomer(tenantId, account.customer_id);
      if (rows.length > 0) {
        sections.push(`<h2>We&#39;d love your feedback</h2>${rows.map((r) => `
          <div class="card">${esc(r.subject ?? 'How did we do?')} <span class="muted">requested ${esc(r.requestedAt)}</span>${reviewHref(r.url) ? `<p><a href="${esc(reviewHref(r.url))}" rel="noreferrer">Leave feedback</a></p>` : ''}</div>`).join('')}`);
      }
    }

    const messages = await listMessages(db, tenantId, account.id, { limit: 10, offset: 0 });
    sections.push(`<h2>Messages</h2>
      <div class="card">
        <form method="post" action="${esc(base)}/messages">
          <label for="subject">Subject</label>
          <input id="subject" name="subject" maxlength="200">
          <label for="body">Message</label>
          <textarea id="body" name="body" rows="3" required maxlength="5000"></textarea>
          <button type="submit">Send</button>
        </form>
      </div>
      ${messages.map((m) => `<div class="card">${m.subject ? `<strong>${esc(m.subject)}</strong><br>` : ''}${esc(m.body)}<div class="muted">${esc(m.created_at)}</div></div>`).join('')}`);

    const uploads = await listUploads(db, tenantId, account.id, { limit: 10, offset: 0 });
    if (uploads.length > 0) {
      sections.push(`<h2>Your uploads</h2>${uploads.map((u) => `
        <div class="card">${esc(u.file_name)} <span class="muted">${esc(u.content_type)}, ${u.size_bytes} bytes</span></div>`).join('')}`);
    }

    if (providers.files) {
      const files = await providers.files.listForCustomer?.(tenantId, account.customer_id) ?? [];
      sections.push(`<h2>Files and photos</h2>${files.map((file) => `<div class="card"><a href="${esc(base)}/files/${encodeURIComponent(file.id)}/content">Download ${esc(file.name)}</a><div class="muted">${file.sizeBytes} bytes</div></div>`).join('')}
        <div class="card"><form method="post" action="${esc(base)}/uploads" enctype="multipart/form-data">
          <label for="customer-file">Send a file or photo to the business</label><input id="customer-file" type="file" name="file" required>
          <p class="muted">Original files are kept. Maximum 10 MB.</p><button>Upload file</button>
        </form></div>`);
    }

    return c.html(page('Customer portal', `
      <div class="row"><h1>Hi ${esc(account.name)}</h1><a href="${esc(base)}/logout">Sign out</a></div>
      <div class="card"><strong>Your contact info</strong><br>${esc(account.email)}${account.phone ? ` &middot; ${esc(account.phone)}` : ''}</div>
      ${sections.join('\n')}
    `));
  });

  function uiError(c: Context<TenantEnv>, title: string, error: unknown) {
    const detail = error instanceof ApiError ? error.message : error instanceof z.ZodError ? 'Check the form details and try again.' : 'The request could not be completed. Try again using the same request.';
    return new Response(page(title, `<h1>${esc(title)}</h1><p>${esc(detail)}</p><a href="${esc(uiBase(c))}">Back to your portal</a>`), {
      status: error instanceof ApiError ? error.status : error instanceof z.ZodError ? 400 : 500,
      headers: { 'Content-Type': 'text/html; charset=UTF-8' },
    });
  }

  app.post('/ui/requests', async (c) => {
    const account = await uiAccount(c);
    if (!account) return c.redirect(`${uiBase(c)}/login`);
    try {
      const form = await c.req.parseBody();
      const input = serviceRequestSchema.parse(Object.fromEntries(Object.entries(form).filter(([, value]) => typeof value === 'string' && value !== '')));
      const result = await createServiceRequest(db, events, providers, c.get('tenantId'), account, input);
      return c.redirect(`${uiBase(c)}/requests/${encodeURIComponent(result.request.id)}`, 303);
    } catch (error) { return uiError(c, 'Request needs attention', error); }
  });

  app.get('/ui/requests/:requestId', async (c) => {
    const account = await uiAccount(c);
    if (!account) return c.redirect(`${uiBase(c)}/login`);
    const row = await getServiceRequest(db, c.get('tenantId'), c.req.param('requestId'));
    if (row.account_id !== account.id) throw ApiError.notFound('service request not found');
    return c.html(page('Request receipt', `<h1>Your request is recorded</h1><div class="card"><strong>${esc(row.source_title)}</strong><p>${row.kind === 'repeat' ? 'Repeat service request' : 'Reschedule request'} · ${esc(row.status)}</p>${row.requested_starts_at ? `<p>Preferred time: ${esc(row.requested_starts_at)} · ${esc(row.requested_timezone)}</p>` : ''}${row.note ? `<p>${esc(row.note)}</p>` : ''}${row.response ? `<p><strong>Business response</strong><br>${esc(row.response)}</p>` : '<p>The business will review your request. Your existing booking stays in place until a change is confirmed.</p>'}<p class="muted">Receipt ${esc(row.id)} · ${esc(row.created_at)}</p></div><a href="${esc(uiBase(c))}">Back to your portal</a>`));
  });

  app.get('/ui/files/:fileId/content', async (c) => {
    const account = await uiAccount(c);
    if (!account) return c.redirect(`${uiBase(c)}/login`);
    if (!providers.files?.readForCustomer) throw notWired('files');
    const file = await providers.files.readForCustomer(c.get('tenantId'), account.customer_id, c.req.param('fileId'));
    return new Response(new Uint8Array(file.content).buffer, { headers: {
      'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'Cache-Control': 'no-store',
    } });
  });

  app.post('/ui/uploads', async (c) => {
    const account = await uiAccount(c);
    if (!account) return c.redirect(`${uiBase(c)}/login`);
    try {
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File) || !file.name) throw ApiError.badRequest('choose a file to upload');
      if (file.size > 10 * 1024 * 1024) throw new ApiError(413, 'file exceeds 10 MB', 'payload_too_large');
      const content = Buffer.from(await file.arrayBuffer());
      const body = uploadSchema.parse({ fileName: file.name, contentType: file.type || 'application/octet-stream', sizeBytes: file.size,
        contentBase64: content.toString('base64'), kind: file.type.startsWith('image/') ? 'photo' : 'document' });
      await recordUpload(db, events, providers.files, c.get('tenantId'), account, body);
      return c.redirect(uiBase(c), 303);
    } catch (error) { return uiError(c, 'Upload needs attention', error); }
  });

  app.post('/ui/messages', async (c) => {
    const account = await uiAccount(c);
    const base = uiBase(c);
    if (!account) return c.redirect(`${base}/login`);
    const form = await c.req.parseBody();
    const parsed = messageSchema.safeParse({
      subject: typeof form.subject === 'string' && form.subject !== '' ? form.subject : undefined,
      body: typeof form.body === 'string' ? form.body : '',
    });
    if (parsed.success) {
      await sendPortalMessage(db, events, contracts, c.get('tenantId'), account, parsed.data);
    }
    return c.redirect(base);
  });

  app.post('/ui/quotes/:quoteId/:decision', async (c) => {
    const account = await uiAccount(c);
    const base = uiBase(c);
    if (!account) return c.redirect(`${base}/login`);
    const decision = c.req.param('decision');
    if (decision !== 'approve' && decision !== 'decline') {
      throw ApiError.badRequest(`unknown decision: ${decision}`);
    }
    const body = decisionSchema.parse(await c.req.parseBody());
    await decideQuote(
      db, events, providers.quotes, c.get('tenantId'), account,
      c.req.param('quoteId'), decision === 'approve' ? 'approved' : 'declined', body.comment, body.expectedPayloadHash,
    );
    return c.redirect(base);
  });

  app.post('/ui/invoices/:invoiceId/reminder-preference', async c => {
    const account = await uiAccount(c); const base = uiBase(c);
    if (!account) return c.redirect(`${base}/login`);
    const body = z.object({ optedOut: z.enum(['true', 'false']) }).parse(await c.req.parseBody());
    if (!providers.invoices?.setReminderOptOut) throw notWired('invoice reminder preferences');
    await providers.invoices.setReminderOptOut(c.get('tenantId'), account.customer_id, c.req.param('invoiceId'), body.optedOut === 'true');
    return c.redirect(base, 303);
  });

  app.post('/ui/invoices/:invoiceId/pay', async (c) => {
    const account = await uiAccount(c);
    const base = uiBase(c);
    if (!account) return c.redirect(`${base}/login`);
    const body = z.object({ purpose: z.enum(['deposit', 'balance']).default('balance') }).parse(await c.req.parseBody());
    const intent = await createInvoicePaymentIntent(
      db, events, providers.invoices, providers.payments,
      c.get('tenantId'), account, c.req.param('invoiceId'), body.purpose,
    );
    return c.html(page('Payment instructions', `
      <h1>Payment instructions</h1>
      <div class="card">
        Amount to collect: <strong>${money(intent.amountCents)}</strong> for invoice ${esc(intent.invoiceId)}.<br>
        <p>${esc(intent.instructions ?? 'Complete payment with the connected payment provider.')}</p>
        <span class="muted">Reference ${esc(intent.id)} &middot; status ${esc(intent.status)}</span>
      </div>
      <p><a href="${esc(base)}">Back to portal</a></p>
    `));
  });

  return app;
}
