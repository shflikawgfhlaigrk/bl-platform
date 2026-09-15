import { Hono, type Context } from 'hono';
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
import { merchantChecklist } from './checklist';
import { createDbMerchantStore } from './db-store';
import type { MerchantRecord } from './lifecycle';
import { posServiceObserver } from './observer';
import type { PosServiceDatabase } from './schema';
import {
  CONNECT_ACCOUNT_SETTINGS,
  PosServiceError,
  createPosService,
  resolvePosServiceConfig,
  type PosServiceConfig,
} from './service';
import { MerchantConflictError } from './store';
import { StripeRequestError, type StripeClient } from './stripe-client';

export interface PosServiceRouterOptions extends PosServiceConfig {
  /** Platform Stripe client. Without it, every route that needs Stripe answers 501. */
  stripe?: StripeClient | null;
  /**
   * Signing secrets of every Stripe event destination that posts to POST /webhooks/stripe: the thin
   * destination for v2 account events and the Connect snapshot destination for payment and reader events.
   */
  webhookSecrets?: readonly string[];
  now?: () => Date;
  /** Clock for webhook signature tolerance, in Unix seconds. Tests only. */
  webhookClockSeconds?: () => number;
}

type Ctx = Context<TenantEnv>;

const purchaseSchema = z
  .object({
    purchaseRef: z.string().trim().min(1).max(200),
    businessName: z.string().trim().min(1).max(200),
    contactEmail: z.string().trim().max(254).email(),
    address: z
      .object({
        line1: z.string().trim().min(1).max(200),
        line2: z.string().trim().max(200).optional(),
        city: z.string().trim().min(1).max(100),
        state: z.string().trim().length(2),
        postalCode: z.string().trim().regex(/^\d{5}(-\d{4})?$/),
        country: z.literal('US'),
      })
      .strict(),
  })
  .strict();

const readerSchema = z
  .object({
    registrationCode: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(64),
  })
  .strict();

/** A Terminal hardware order as Stripe returns it (placed from the Dashboard or the API). */
const hardwareOrderSchema = z.object({ id: z.string().regex(/^thor_[A-Za-z0-9]+$/), status: z.string().min(1) }).passthrough();

function toApiError(err: Error): Error {
  if (err instanceof PosServiceError) return new ApiError(err.status, err.message, err.code);
  if (err instanceof MerchantConflictError) return ApiError.conflict(err.message);
  if (err instanceof StripeRequestError) {
    return new ApiError(502, 'Stripe did not accept the request.', 'stripe_error', {
      stripeStatus: err.status,
      stripeCode: err.code,
      stripeMessage: err.stripeMessage,
      requestId: err.requestId,
    });
  }
  return err;
}

async function readJson(c: Ctx): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw ApiError.badRequest('request body must be JSON');
  }
}

const summary = (record: MerchantRecord) => ({
  id: record.id,
  businessName: record.businessName,
  stage: record.stage,
  blocked: record.blocked,
  livemode: record.livemode,
  stripeAccountId: record.stripeAccountId,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

/**
 * Done-for-you POS service: sell the setup, onboard the merchant onto Stripe Connect, track the
 * card reader to their door, register it, and prove it with a refunded test sale.
 */
export function posServiceRouter(deps: ModuleDeps<PosServiceDatabase>, options: PosServiceRouterOptions): Hono<TenantEnv> {
  // Reject a bad configuration when the app is assembled, not on a customer's first request.
  const config = resolvePosServiceConfig(options);
  const webhookSecrets = (options.webhookSecrets ?? []).filter((secret) => typeof secret === 'string' && secret.length > 0);

  const app = new Hono<TenantEnv>();
  app.onError((err, c) => errorHandler(toApiError(err), c));
  app.use('*', tenantMiddleware(asCoreDb(deps.db)));

  const actorOf = (c: Ctx) => c.req.header('x-user-id') ?? 'system';
  const storeFor = (c: Ctx) => createDbMerchantStore(deps.db, c.get('tenantId'));
  const serviceFor = (c: Ctx, actor: string) => {
    if (!options.stripe) {
      throw new ApiError(501, 'Stripe Connect is not configured for the POS service.', 'stripe_not_configured');
    }
    const tenantId = c.get('tenantId');
    return createPosService({
      ...options,
      store: createDbMerchantStore(deps.db, tenantId),
      stripe: options.stripe,
      observer: posServiceObserver(deps, tenantId, actor),
      newId: () => id(),
    });
  };

  /* ------------- Stripe webhooks (raw body, verified before anything is parsed) ------------- */

  app.post('/webhooks/stripe', async (c) => {
    if (!options.stripe || webhookSecrets.length === 0) {
      throw new ApiError(501, 'The POS service webhook is not configured.', 'webhook_not_configured');
    }
    const payload = await c.req.text();
    const result = await serviceFor(c, 'system').handleWebhook({
      payload,
      signatureHeader: c.req.header('stripe-signature') ?? null,
      secret: webhookSecrets,
      nowSeconds: options.webhookClockSeconds?.(),
    });
    return c.json({ data: result });
  });

  /* ------------------------------------ configuration ------------------------------------ */

  app.get('/config', (c) =>
    c.json({
      data: {
        stripeConfigured: Boolean(options.stripe),
        webhookConfigured: Boolean(options.stripe && webhookSecrets.length > 0),
        livemode: options.stripe?.livemode ?? null,
        connect: CONNECT_ACCOUNT_SETTINGS,
        platformFee: config.fee,
        testSaleAmountCents: config.testSaleAmount,
        compatibleReaderTypes: [...config.compatibleReaders],
      },
    }),
  );

  /* -------------------------------------- merchants -------------------------------------- */

  app.get('/merchants', async (c) => {
    const page = parsePagination(c.req.query());
    const data = (await storeFor(c).list(page)).map(summary);
    return c.json({ data, limit: page.limit, offset: page.offset });
  });

  app.post('/merchants', async (c) => {
    const body = purchaseSchema.parse(await readJson(c));
    const service = serviceFor(c, actorOf(c));
    const replayed = Boolean(await storeFor(c).findByPurchaseRef(body.purchaseRef));
    const merchant = await service.purchase(body);
    return c.json({ data: { ...merchant, checklist: merchantChecklist(merchant), replayed } }, replayed ? 200 : 201);
  });

  app.get('/merchants/:id', async (c) => {
    const merchant = await storeFor(c).get(c.req.param('id'));
    if (!merchant) throw ApiError.notFound('merchant not found');
    return c.json({ data: { ...merchant, checklist: merchantChecklist(merchant) } });
  });

  const respond = (c: Ctx, merchant: MerchantRecord) => c.json({ data: { ...merchant, checklist: merchantChecklist(merchant) } });

  app.post('/merchants/:id/onboarding', async (c) => respond(c, await serviceFor(c, actorOf(c)).startOnboarding(c.req.param('id'))));

  app.post('/merchants/:id/sync', async (c) =>
    respond(c, await serviceFor(c, actorOf(c)).syncAccount({ merchantId: c.req.param('id') })),
  );

  app.post('/merchants/:id/hardware-orders', async (c) => {
    const order = hardwareOrderSchema.parse(await readJson(c));
    return respond(c, await serviceFor(c, actorOf(c)).recordHardwareOrder(c.req.param('id'), order));
  });

  app.post('/merchants/:id/readers', async (c) => {
    const body = readerSchema.parse(await readJson(c));
    return respond(c, await serviceFor(c, actorOf(c)).registerReader(c.req.param('id'), body));
  });

  app.post('/merchants/:id/test-sale', async (c) => respond(c, await serviceFor(c, actorOf(c)).startTestSale(c.req.param('id'))));

  app.post('/merchants/:id/test-sale/advance', async (c) =>
    respond(c, await serviceFor(c, actorOf(c)).advanceTestSale(c.req.param('id'))),
  );

  app.post('/merchants/:id/test-sale/cancel', async (c) =>
    respond(c, await serviceFor(c, actorOf(c)).cancelTestSale(c.req.param('id'))),
  );

  app.post('/merchants/:id/messages/:messageId/sent', async (c) => {
    const merchant = await storeFor(c).get(c.req.param('id'));
    if (!merchant) throw ApiError.notFound('merchant not found');
    return respond(c, await serviceFor(c, actorOf(c)).markMessageSent(merchant.id, c.req.param('messageId')));
  });

  return app;
}
