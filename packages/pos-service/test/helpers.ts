import { asCoreDb, coreMigrations, createTenant, EventBus, type TenantEnv } from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import {
  createStripeClient,
  posServiceMigrations,
  posServiceRouter,
  stripeSignatureHeader,
  type MerchantRecord,
  type PosServiceDatabase,
  type PosServiceRouterOptions,
} from '@blacklabel/pos-service';
import type { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { fakeStripe } from './fake-stripe';

export const WEBHOOK_SECRET = 'whsec_router_test';
export const CLOCK_SECONDS = 1_800_000_000;
export const NOW = '2026-09-15T20:00:00.000Z';
export const address = { line1: '100 Beach Blvd', city: 'Gulf Shores', state: 'AL', postalCode: '36542', country: 'US' as const };
export const purchase = { purchaseRef: 'cs_test_router_1', businessName: 'Salt Life Cafe', contactEmail: 'owner@saltlife.test', address };

export interface SeenEvent {
  tenantId: string;
  type: string;
  payload: any;
}

export async function setupRouter(
  stripeState: Parameters<typeof fakeStripe>[0] = {},
  overrides: Partial<PosServiceRouterOptions> = {},
) {
  const db = createTestDb<PosServiceDatabase>();
  await runMigrations(db, [...coreMigrations, ...posServiceMigrations]);
  const A = (await createTenant(asCoreDb(db), { name: 'Tenant A' })).id;
  const B = (await createTenant(asCoreDb(db), { name: 'Tenant B' })).id;
  const events = new EventBus();
  const seen: SeenEvent[] = [];
  events.on('*', (event) => {
    seen.push({ tenantId: event.tenantId, type: event.type, payload: event.payload });
  });
  const stripe = fakeStripe(stripeState);
  const app: Hono<TenantEnv> = posServiceRouter(
    { db, events, contracts: {} },
    {
      stripe: createStripeClient({ secretKey: 'sk_test_platform', fetch: stripe.fetch }),
      webhookSecrets: ['whsec_thin_destination', WEBHOOK_SECRET],
      onboarding: { returnUrl: 'https://pos.example.test/setup/done', refreshUrl: 'https://pos.example.test/setup/refresh' },
      now: () => new Date(NOW),
      webhookClockSeconds: () => CLOCK_SECONDS,
      ...overrides,
    },
  );

  const json = (tenantId: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { 'x-tenant-id': tenantId, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const data = async (response: Response | Promise<Response>) => ((await (await response).json()) as { data: any }).data;

  const webhook = (tenantId: string, event: Record<string, unknown>, secret = WEBHOOK_SECRET) => {
    const payload = JSON.stringify(event);
    return app.request('/webhooks/stripe', {
      method: 'POST',
      headers: {
        'x-tenant-id': tenantId,
        'content-type': 'application/json',
        'stripe-signature': stripeSignatureHeader(secret, CLOCK_SECONDS, payload),
      },
      body: payload,
    });
  };

  return { db: db as Kysely<PosServiceDatabase>, events, seen, stripe, app, A, B, json, data, webhook };
}

export function sampleMerchant(id: string, purchaseRef: string, at = NOW): MerchantRecord {
  return {
    id,
    version: 1,
    livemode: false,
    purchaseRef,
    businessName: 'Salt Life Cafe',
    contactEmail: 'owner@saltlife.test',
    address,
    stage: 'purchased',
    blocked: null,
    stripeAccountId: null,
    cardPayments: 'unrequested',
    requirementsDue: [],
    onboardingLink: null,
    locationId: null,
    hardwareOrder: null,
    reader: null,
    testSale: { attempt: 0, paymentIntentId: null, status: 'not_started', refundId: null, failure: null },
    messages: [],
    history: [],
    createdAt: at,
    updatedAt: at,
  };
}
