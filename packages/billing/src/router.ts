import { Hono } from 'hono';
import { z } from 'zod';
import {
  asCoreDb,
  errorHandler,
  parseFilters,
  parsePagination,
  parseSort,
  tenantMiddleware,
  type ModuleDeps,
  type TenantEnv,
} from '@blacklabel/core';
import type { BillingDatabase } from './schema';
import { defaultPaymentProviders, type PaymentProvider } from './providers';
import {
  buildProviderRegistry,
  convertQuoteToInvoice,
  createBillingAccount,
  createInvoice,
  createMembership,
  createPaymentIntent,
  createSubscription,
  deleteBillingAccount,
  deleteInvoice,
  exportInvoicesCsv,
  generateDueInvoices,
  getBillingAccount,
  getInvoice,
  getMembership,
  getSubscription,
  listBillingAccounts,
  listInvoices,
  listMemberships,
  listPayments,
  listSubscriptions,
  markOverdueInvoices,
  recordPayment,
  recordWebhookEvent,
  sendInvoice,
  updateBillingAccount,
  updateInvoice,
  updateMembership,
  updateSubscription,
  voidInvoice,
  type BillingCtx,
} from './service';
import { ApiError } from '@blacklabel/core';

/* ------------------------------------------------------------------ *
 * Request schemas (zod). Money = integer cents; percents = basis points.
 * ------------------------------------------------------------------ */

const bpsSchema = z.number().int().min(0).max(10000);
const centsSchema = z.number().int().min(0);
const isoSchema = z.string().datetime();

const lineSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().finite().positive(),
  unitPriceCents: centsSchema,
  discountBps: bpsSchema.optional(),
  discountFixedCents: centsSchema.optional(),
});

const createInvoiceSchema = z.object({
  customerId: z.string().min(1),
  billingAccountId: z.string().min(1).optional(),
  lines: z.array(lineSchema).min(1),
  discountBps: bpsSchema.optional(),
  discountFixedCents: centsSchema.optional(),
  taxBps: bpsSchema.optional(),
  dueAt: isoSchema.optional(),
  memo: z.string().optional(),
  portalVisible: z.boolean().optional(),
  custom: z.record(z.unknown()).optional(),
});

const updateInvoiceSchema = z.object({
  billingAccountId: z.string().min(1).nullable().optional(),
  lines: z.array(lineSchema).min(1).optional(),
  discountBps: bpsSchema.nullable().optional(),
  discountFixedCents: centsSchema.nullable().optional(),
  taxBps: bpsSchema.nullable().optional(),
  dueAt: isoSchema.nullable().optional(),
  memo: z.string().nullable().optional(),
  portalVisible: z.boolean().optional(),
  custom: z.record(z.unknown()).nullable().optional(),
});

const fromQuoteSchema = z.object({
  quoteId: z.string().min(1),
  customerId: z.string().min(1),
  lines: z.array(lineSchema).min(1),
  discountBps: bpsSchema.optional(),
  discountFixedCents: centsSchema.optional(),
  taxBps: bpsSchema.optional(),
  dueAt: isoSchema.optional(),
  memo: z.string().optional(),
  portalVisible: z.boolean().optional(),
  billingAccountId: z.string().min(1).optional(),
});

const recordPaymentSchema = z.object({
  amountCents: z.number().int().positive(),
  method: z.string().min(1).optional(),
  providerRef: z.string().optional(),
  note: z.string().optional(),
  receivedAt: isoSchema.optional(),
});

const paymentIntentSchema = z.object({
  provider: z.string().min(1).default('manual'),
});

const intervalSchema = z.enum(['daily', 'weekly', 'monthly', 'quarterly', 'yearly']);

const createSubscriptionSchema = z.object({
  customerId: z.string().min(1),
  planName: z.string().min(1),
  amountCents: centsSchema,
  interval: intervalSchema,
  nextInvoiceAt: isoSchema,
  taxBps: bpsSchema.optional(),
  billingAccountId: z.string().min(1).optional(),
});

const updateSubscriptionSchema = z.object({
  status: z.enum(['active', 'paused', 'canceled']).optional(),
  planName: z.string().min(1).optional(),
  amountCents: centsSchema.optional(),
  interval: intervalSchema.optional(),
  nextInvoiceAt: isoSchema.optional(),
  taxBps: bpsSchema.nullable().optional(),
});

const createMembershipSchema = z.object({
  customerId: z.string().min(1),
  planKey: z.string().min(1),
  startedAt: isoSchema.optional(),
  endsAt: isoSchema.optional(),
  subscriptionId: z.string().min(1).optional(),
});

const updateMembershipSchema = z.object({
  status: z.enum(['active', 'paused', 'canceled', 'expired']).optional(),
  planKey: z.string().min(1).optional(),
  endsAt: isoSchema.nullable().optional(),
});

const createAccountSchema = z.object({
  customerId: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
});

const updateAccountSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export interface BillingRouterOptions {
  /**
   * Payment provider adapters, keyed by PaymentProvider.key. Defaults to the
   * manual (offline) adapter only; simulators and real processors must be
   * explicitly injected by the integrator.
   */
  providers?: readonly PaymentProvider[];
}

const INVOICE_SORT_COLUMNS = ['created_at', 'due_at', 'number', 'total_cents', 'status'] as const;

export function billingRouter(
  deps: ModuleDeps<BillingDatabase>,
  options: BillingRouterOptions = {},
): Hono<TenantEnv> {
  const ctx: BillingCtx = { db: deps.db, events: deps.events };
  const providers = buildProviderRegistry(options.providers ?? defaultPaymentProviders);

  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(deps.db)));

  const actorOf = (c: { req: { header: (name: string) => string | undefined } }): string =>
    c.req.header('x-user-id') ?? 'system';

  /* ---------------- invoices ---------------- */

  app.post('/invoices', async (c) => {
    const body = createInvoiceSchema.parse(await c.req.json());
    const result = await createInvoice(ctx, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: { ...result.invoice, lines: result.lines } }, 201);
  });

  app.get('/invoices', async (c) => {
    const query = c.req.query();
    const page = parsePagination(query);
    const sort = parseSort(query, INVOICE_SORT_COLUMNS, {
      column: 'created_at',
      direction: 'asc',
    });
    const filters = parseFilters(query, ['status', 'customer_id', 'portal_visible']);
    const data = await listInvoices(deps.db, c.get('tenantId'), page, filters, sort);
    return c.json({ data, limit: page.limit, offset: page.offset });
  });

  app.get('/invoices/export.csv', async (c) => {
    const csv = await exportInvoicesCsv(deps.db, c.get('tenantId'));
    return c.body(csv, 200, { 'Content-Type': 'text/csv; charset=utf-8' });
  });

  app.post('/invoices/from-quote', async (c) => {
    const body = fromQuoteSchema.parse(await c.req.json());
    const result = await convertQuoteToInvoice(ctx, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: { ...result.invoice, lines: result.lines } }, 201);
  });

  app.post('/invoices/refresh-overdue', async (c) => {
    const count = await markOverdueInvoices(ctx, c.get('tenantId'));
    return c.json({ data: { markedOverdue: count } });
  });

  app.get('/invoices/:id', async (c) => {
    const result = await getInvoice(deps.db, c.get('tenantId'), c.req.param('id'));
    if (!result) throw ApiError.notFound(`invoice not found: ${c.req.param('id')}`);
    return c.json({ data: { ...result.invoice, lines: result.lines } });
  });

  app.put('/invoices/:id', async (c) => {
    const body = updateInvoiceSchema.parse(await c.req.json());
    const result = await updateInvoice(ctx, c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: { ...result.invoice, lines: result.lines } });
  });

  app.delete('/invoices/:id', async (c) => {
    await deleteInvoice(ctx, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: { deleted: true } });
  });

  app.post('/invoices/:id/send', async (c) => {
    const invoice = await sendInvoice(ctx, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: invoice });
  });

  app.post('/invoices/:id/void', async (c) => {
    const invoice = await voidInvoice(ctx, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: invoice });
  });

  app.post('/invoices/:id/payments', async (c) => {
    const body = recordPaymentSchema.parse(await c.req.json());
    const result = await recordPayment(ctx, c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: { payment: result.payment, invoice: result.invoice } }, 201);
  });

  app.get('/invoices/:id/payments', async (c) => {
    const page = parsePagination(c.req.query());
    const data = await listPayments(deps.db, c.get('tenantId'), page, {
      invoice_id: c.req.param('id'),
    });
    return c.json({ data, limit: page.limit, offset: page.offset });
  });

  app.post('/invoices/:id/payment-intents', async (c) => {
    const body = paymentIntentSchema.parse(await c.req.json().catch(() => ({})));
    const intent = await createPaymentIntent(
      ctx,
      providers,
      c.get('tenantId'),
      c.req.param('id'),
      body.provider,
    );
    return c.json({ data: intent }, 201);
  });

  /* ---------------- payments ---------------- */

  app.get('/payments', async (c) => {
    const query = c.req.query();
    const page = parsePagination(query);
    const filters = parseFilters(query, ['invoice_id']);
    const data = await listPayments(deps.db, c.get('tenantId'), page, filters);
    return c.json({ data, limit: page.limit, offset: page.offset });
  });

  app.post('/payments/webhooks/:provider', async (c) => {
    const rawBody = await c.req.text();
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw ApiError.badRequest('webhook payload must be JSON');
    }
    const result = await recordWebhookEvent(
      ctx,
      providers,
      c.get('tenantId'),
      c.req.param('provider'),
      {
        rawBody,
        headers: Object.fromEntries(c.req.raw.headers.entries()),
        payload,
      },
    );
    return c.json({ data: { event: result.event, outcome: result.outcome } }, 201);
  });

  /* ---------------- subscriptions ---------------- */

  app.post('/subscriptions', async (c) => {
    const body = createSubscriptionSchema.parse(await c.req.json());
    const subscription = await createSubscription(ctx, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: subscription }, 201);
  });

  app.get('/subscriptions', async (c) => {
    const query = c.req.query();
    const page = parsePagination(query);
    const filters = parseFilters(query, ['status', 'customer_id']);
    const data = await listSubscriptions(deps.db, c.get('tenantId'), page, filters);
    return c.json({ data, limit: page.limit, offset: page.offset });
  });

  app.post('/subscriptions/tick', async (c) => {
    const generated = await generateDueInvoices(ctx, c.get('tenantId'));
    return c.json({ data: { generated, count: generated.length } });
  });

  app.get('/subscriptions/:id', async (c) => {
    const subscription = await getSubscription(deps.db, c.get('tenantId'), c.req.param('id'));
    if (!subscription) throw ApiError.notFound(`subscription not found: ${c.req.param('id')}`);
    return c.json({ data: subscription });
  });

  app.put('/subscriptions/:id', async (c) => {
    const body = updateSubscriptionSchema.parse(await c.req.json());
    const subscription = await updateSubscription(
      ctx,
      c.get('tenantId'),
      actorOf(c),
      c.req.param('id'),
      body,
    );
    return c.json({ data: subscription });
  });

  /* ---------------- memberships ---------------- */

  app.post('/memberships', async (c) => {
    const body = createMembershipSchema.parse(await c.req.json());
    const membership = await createMembership(ctx, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: membership }, 201);
  });

  app.get('/memberships', async (c) => {
    const query = c.req.query();
    const page = parsePagination(query);
    const filters = parseFilters(query, ['status', 'customer_id', 'plan_key']);
    const data = await listMemberships(deps.db, c.get('tenantId'), page, filters);
    return c.json({ data, limit: page.limit, offset: page.offset });
  });

  app.get('/memberships/:id', async (c) => {
    const membership = await getMembership(deps.db, c.get('tenantId'), c.req.param('id'));
    if (!membership) throw ApiError.notFound(`membership not found: ${c.req.param('id')}`);
    return c.json({ data: membership });
  });

  app.put('/memberships/:id', async (c) => {
    const body = updateMembershipSchema.parse(await c.req.json());
    const membership = await updateMembership(
      ctx,
      c.get('tenantId'),
      actorOf(c),
      c.req.param('id'),
      body,
    );
    return c.json({ data: membership });
  });

  /* ---------------- billing accounts ---------------- */

  app.post('/accounts', async (c) => {
    const body = createAccountSchema.parse(await c.req.json());
    const account = await createBillingAccount(ctx, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: account }, 201);
  });

  app.get('/accounts', async (c) => {
    const query = c.req.query();
    const page = parsePagination(query);
    const filters = parseFilters(query, ['customer_id']);
    const data = await listBillingAccounts(deps.db, c.get('tenantId'), page, filters);
    return c.json({ data, limit: page.limit, offset: page.offset });
  });

  app.get('/accounts/:id', async (c) => {
    const account = await getBillingAccount(deps.db, c.get('tenantId'), c.req.param('id'));
    if (!account) throw ApiError.notFound(`billing account not found: ${c.req.param('id')}`);
    return c.json({ data: account });
  });

  app.put('/accounts/:id', async (c) => {
    const body = updateAccountSchema.parse(await c.req.json());
    const account = await updateBillingAccount(ctx, c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: account });
  });

  app.delete('/accounts/:id', async (c) => {
    await deleteBillingAccount(ctx, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: { deleted: true } });
  });

  return app;
}
