import { Hono } from 'hono';
import { z } from 'zod';
import {
  ApiError,
  asCoreDb,
  errorHandler,
  parseFilters,
  parsePagination,
  parseSort,
  tenantMiddleware,
  type ModuleDeps,
  type TenantEnv,
} from '@blacklabel/core';
import type { OrdersDatabase } from './schema';
import type { CheckoutProvider } from './providers';
import {
  addTender,
  advanceFulfillment,
  buildProviderRegistry,
  cancelPaymentAttempt,
  cancelOrder,
  createCheckoutSession,
  createFulfillment,
  createOrder,
  createPaymentAttempt,
  createRefund,
  deleteOrder,
  getOrder,
  getPaymentAttempt,
  listFulfillments,
  listOrders,
  listPaymentAttempts,
  listRefunds,
  listTenders,
  listWebhookEvents,
  markOrderSent,
  packingSlip,
  payOrder,
  pickList,
  processWebhook,
  reserveOrder,
  updateOrder,
  type OrdersCtx,
} from './service';

const bpsSchema = z.number().int().min(0).max(10000);
const centsSchema = z.number().int().min(0);

const lineSchema = z.object({
  variationId: z.string().min(1).optional(),
  locationId: z.string().min(1).optional(),
  description: z.string().min(1),
  qty: z.number().finite().positive(),
  unitPriceCents: centsSchema,
  discountBps: bpsSchema.optional(),
  discountFixedCents: centsSchema.optional(),
});

const createOrderSchema = z.object({
  channel: z.enum(['pos', 'storefront', 'manual', 'phone', 'invoice', 'show']),
  customerId: z.string().min(1).optional(),
  showId: z.string().min(1).optional(),
  registerId: z.string().min(1).optional(),
  deviceId: z.string().min(1).optional(),
  cashierId: z.string().min(1).optional(),
  cashSessionId: z.string().min(1).optional(),
  source: z.enum(['mags', 'square']).optional(),
  sourceOrderId: z.string().min(1).optional(),
  lines: z.array(lineSchema).optional(),
  discountBps: bpsSchema.optional(),
  discountFixedCents: centsSchema.optional(),
  taxBps: bpsSchema.optional(),
  tipCents: centsSchema.optional(),
  note: z.string().optional(),
});

const updateOrderSchema = z.object({
  customerId: z.string().min(1).nullable().optional(),
  showId: z.string().min(1).nullable().optional(),
  registerId: z.string().min(1).nullable().optional(),
  deviceId: z.string().min(1).nullable().optional(),
  cashierId: z.string().min(1).nullable().optional(),
  cashSessionId: z.string().min(1).nullable().optional(),
  note: z.string().nullable().optional(),
  discountBps: bpsSchema.nullable().optional(),
  discountFixedCents: centsSchema.nullable().optional(),
  taxBps: bpsSchema.nullable().optional(),
  tipCents: centsSchema.optional(),
  lines: z.array(lineSchema).optional(),
});

const tenderSchema = z.object({
  kind: z.enum(['card', 'cash', 'external', 'gift_card', 'store_credit', 'provider']),
  amountCents: z.number().int().positive(),
  cashReceivedCents: centsSchema.optional(),
  idempotencyKey: z.string().min(1),
  provider: z.string().min(1).optional(),
  providerRef: z.string().min(1).optional(),
});

const paySchema = z.object({
  tenders: z.array(tenderSchema).optional(),
});

const checkoutSchema = z.object({
  provider: z.string().min(1),
  returnUrl: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional(),
  readerId: z.string().min(1).optional(),
});

const paymentAttemptSchema = z.object({
  amountCents: z.number().int().positive().optional(),
  provider: z.string().min(1),
  idempotencyKey: z.string().min(1),
  returnUrl: z.string().min(1).optional(),
  readerId: z.string().min(1).optional(),
});

const refundSchema = z.object({
  tenderId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  cashSessionId: z.string().min(1).optional(),
  amountCents: z.number().int().positive(),
  reason: z.string().optional(),
  lines: z
    .array(
      z.object({
        lineId: z.string().min(1),
        qty: z.number().finite().positive(),
        disposition: z.enum(['restock', 'quarantine', 'damaged', 'none']),
      }),
    )
    .min(1),
});

const fulfillmentSchema = z.object({
  kind: z.enum(['pickup_show', 'pickup_local', 'ship']),
  address: z.record(z.unknown()).optional(),
  tracking: z.string().min(1).optional(),
  lines: z
    .array(z.object({ lineId: z.string().min(1), qty: z.number().finite().positive() }))
    .min(1),
});

const advanceSchema = z.object({
  status: z.enum(['pending', 'picking', 'packed', 'ready', 'shipped', 'delivered', 'picked_up', 'canceled']),
  tracking: z.string().min(1).optional(),
});

const ORDER_SORT_COLUMNS = ['created_at', 'status', 'total_cents', 'channel'] as const;

export interface OrdersRouterOptions {
  /** Checkout provider adapters keyed by CheckoutProvider.key. */
  providers?: readonly CheckoutProvider[];
}

export function ordersRouter(
  deps: ModuleDeps<OrdersDatabase>,
  options: OrdersRouterOptions = {},
): Hono<TenantEnv> {
  const ctx: OrdersCtx = { db: deps.db, events: deps.events };
  const providers = buildProviderRegistry(options.providers ?? []);

  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(deps.db)));

  const actorOf = (c: { req: { header: (n: string) => string | undefined } }): string =>
    c.req.header('x-user-id') ?? 'system';

  /* ---------------- webhooks (raw body, before json routes) ---------------- */

  app.post('/webhooks/:provider', async (c) => {
    // Raw body is required for signature verification — read text, never re-parse.
    const rawBody = await c.req.text();
    const headers = c.req.header() as Record<string, string | undefined>;
    const result = await processWebhook(
      ctx,
      providers,
      c.get('tenantId'),
      c.req.param('provider'),
      headers,
      rawBody,
    );
    const status = result.outcome === 'invalid_signature' ? 400 : 200;
    return c.json({ data: { event: result.event, outcome: result.outcome, orderId: result.orderId } }, status);
  });

  app.get('/webhooks', async (c) => {
    const page = parsePagination(c.req.query());
    const data = await listWebhookEvents(deps.db, c.get('tenantId'), page);
    return c.json({ data, limit: page.limit, offset: page.offset });
  });

  /* ---------------- orders ---------------- */

  app.post('/orders', async (c) => {
    const body = createOrderSchema.parse(await c.req.json());
    const result = await createOrder(ctx, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: { ...result.order, lines: result.lines } }, 201);
  });

  app.get('/orders', async (c) => {
    const query = c.req.query();
    const page = parsePagination(query);
    const sort = parseSort(query, ORDER_SORT_COLUMNS, { column: 'created_at', direction: 'asc' });
    const filters = parseFilters(query, ['status', 'channel', 'customer_id', 'show_id', 'source']);
    const data = await listOrders(deps.db, c.get('tenantId'), page, filters, sort);
    return c.json({ data, limit: page.limit, offset: page.offset });
  });

  app.get('/orders/:id', async (c) => {
    const result = await getOrder(deps.db, c.get('tenantId'), c.req.param('id'));
    if (!result) throw ApiError.notFound(`order not found: ${c.req.param('id')}`);
    return c.json({ data: { ...result.order, lines: result.lines } });
  });

  app.put('/orders/:id', async (c) => {
    const body = updateOrderSchema.parse(await c.req.json());
    const result = await updateOrder(ctx, c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: { ...result.order, lines: result.lines } });
  });

  app.delete('/orders/:id', async (c) => {
    await deleteOrder(ctx, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: { deleted: true } });
  });

  /* ---------------- transitions ---------------- */

  app.post('/orders/:id/reserve', async (c) => {
    const order = await reserveOrder(ctx, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: order });
  });

  app.post('/orders/:id/pay', async (c) => {
    const body = paySchema.parse(await c.req.json().catch(() => ({})));
    const order = await payOrder(ctx, c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: order });
  });

  app.post('/orders/:id/cancel', async (c) => {
    const order = await cancelOrder(ctx, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: order });
  });

  app.post('/orders/:id/send', async (c) => {
    const order = await markOrderSent(ctx, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: order });
  });

  /* ---------------- tenders ---------------- */

  app.post('/orders/:id/tenders', async (c) => {
    const body = tenderSchema.parse(await c.req.json());
    const result = await addTender(ctx, c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: result.tender, created: result.created }, result.created ? 201 : 200);
  });

  app.get('/orders/:id/tenders', async (c) => {
    const data = await listTenders(deps.db, c.get('tenantId'), c.req.param('id'));
    return c.json({ data });
  });

  /* ---------------- checkout sessions ---------------- */

  app.post('/orders/:id/checkout-sessions', async (c) => {
    const body = checkoutSchema.parse(await c.req.json());
    const result = await createCheckoutSession(
      ctx,
      providers,
      c.get('tenantId'),
      actorOf(c),
      c.req.param('id'),
      body.provider,
      body.returnUrl,
      { idempotencyKey: body.idempotencyKey, readerId: body.readerId },
    );
    return c.json({ data: result }, result.created ? 201 : 200);
  });

  /* ---------------- payment attempts ---------------- */

  app.post('/orders/:id/payment-attempts', async (c) => {
    const body = paymentAttemptSchema.parse(await c.req.json());
    const result = await createPaymentAttempt(
      ctx,
      providers,
      c.get('tenantId'),
      actorOf(c),
      c.req.param('id'),
      body,
    );
    return c.json({ data: result }, result.created ? 201 : 200);
  });

  app.get('/orders/:id/payment-attempts', async (c) => {
    const data = await listPaymentAttempts(deps.db, c.get('tenantId'), c.req.param('id'));
    return c.json({ data });
  });

  app.get('/payment-attempts/:id', async (c) => {
    const data = await getPaymentAttempt(deps.db, c.get('tenantId'), c.req.param('id'));
    if (!data) throw ApiError.notFound(`payment attempt not found: ${c.req.param('id')}`);
    return c.json({ data });
  });

  app.post('/payment-attempts/:id/cancel', async (c) => {
    const data = await cancelPaymentAttempt(
      ctx,
      providers,
      c.get('tenantId'),
      actorOf(c),
      c.req.param('id'),
    );
    return c.json({ data });
  });

  /* ---------------- refunds ---------------- */

  app.post('/orders/:id/refunds', async (c) => {
    const body = refundSchema.parse(await c.req.json());
    const result = await createRefund(
      ctx,
      c.get('tenantId'),
      actorOf(c),
      c.req.param('id'),
      body,
      providers,
    );
    return c.json(
      {
        data: { refund: result.refund, lines: result.lines, order: result.order },
        created: result.created,
      },
      result.refund.status === 'pending' ? 202 : result.created ? 201 : 200,
    );
  });

  app.get('/orders/:id/refunds', async (c) => {
    const data = await listRefunds(deps.db, c.get('tenantId'), c.req.param('id'));
    return c.json({ data });
  });

  /* ---------------- fulfillments ---------------- */

  app.post('/orders/:id/fulfillments', async (c) => {
    const body = fulfillmentSchema.parse(await c.req.json());
    const result = await createFulfillment(ctx, c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: { fulfillment: result.fulfillment, lines: result.lines } }, 201);
  });

  app.get('/orders/:id/fulfillments', async (c) => {
    const data = await listFulfillments(deps.db, c.get('tenantId'), c.req.param('id'));
    return c.json({ data });
  });

  app.post('/fulfillments/:id/advance', async (c) => {
    const body = advanceSchema.parse(await c.req.json());
    const fulfillment = await advanceFulfillment(
      ctx,
      c.get('tenantId'),
      actorOf(c),
      c.req.param('id'),
      body.status,
      body.tracking,
    );
    return c.json({ data: fulfillment });
  });

  app.get('/fulfillments/:id/packing-slip', async (c) => {
    const slip = await packingSlip(deps.db, c.get('tenantId'), c.req.param('id'));
    return c.json({ data: slip });
  });

  /* ---------------- projections ---------------- */

  app.get('/orders/:id/pick-list', async (c) => {
    const list = await pickList(deps.db, c.get('tenantId'), c.req.param('id'));
    return c.json({ data: list });
  });

  return app;
}
