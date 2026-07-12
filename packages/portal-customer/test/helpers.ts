import type { Hono } from 'hono';
import type { Kysely } from 'kysely';
import {
  EventBus,
  asCoreDb,
  coreMigrations,
  createTenant,
  type Contracts,
  type PlatformEvent,
  type TenantEnv,
} from '@blacklabel/core';
import { createTestDb, runMigrations } from '@blacklabel/db';
import {
  portalCustomerMigrations,
  portalCustomerRouter,
  type PortalAppointment,
  type PortalCustomerDatabase,
  type PortalCustomerProviders,
  type PortalInvoice,
  type PortalQuote,
  type PortalQuotesProvider,
  type QuoteApprovalEventInput,
} from '@blacklabel/portal-customer';

export interface TestCtx {
  db: Kysely<PortalCustomerDatabase>;
  events: EventBus;
  app: Hono<TenantEnv>;
  tenantA: string;
  tenantB: string;
}

export async function setup(
  options: { providers?: PortalCustomerProviders; contracts?: Contracts } = {},
): Promise<TestCtx> {
  const db = createTestDb<PortalCustomerDatabase>();
  await runMigrations(db, [...coreMigrations, ...portalCustomerMigrations]);
  const events = new EventBus();
  const tenantA = (await createTenant(asCoreDb(db), { name: 'Tenant A' })).id;
  const tenantB = (await createTenant(asCoreDb(db), { name: 'Tenant B' })).id;
  const app = portalCustomerRouter({
    db,
    events,
    contracts: options.contracts ?? {},
    providers: options.providers,
  });
  return { db, events, app, tenantA, tenantB };
}

/** JSON request through the router with the tenant header (+ optional session). */
export async function api(
  app: Hono<TenantEnv>,
  tenantId: string,
  method: string,
  path: string,
  body?: unknown,
  session?: string,
): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      'x-tenant-id': tenantId,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(session ? { 'x-portal-session': session } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

let accountSeq = 0;

/** Create a portal account through the router; returns the public account. */
export async function createAccountViaApi(
  app: Hono<TenantEnv>,
  tenantId: string,
  overrides: Partial<{ customerId: string; email: string; name: string; phone: string }> = {},
): Promise<{ id: string; customerId: string; email: string; name: string; phone: string | null }> {
  accountSeq += 1;
  const res = await api(app, tenantId, 'POST', '/accounts', {
    customerId: overrides.customerId ?? `cust_${accountSeq}`,
    email: overrides.email ?? `customer${accountSeq}@example.com`,
    name: overrides.name ?? `Customer ${accountSeq}`,
    ...(overrides.phone ? { phone: overrides.phone } : {}),
  });
  if (res.status !== 201) throw new Error(`createAccountViaApi failed: ${res.status} ${await res.text()}`);
  return (await res.json() as any).data;
}

/** Full magic-link login flow through the router; returns a session token. */
export async function login(
  ctx: TestCtx,
  tenantId: string,
  email: string,
): Promise<string> {
  const requested = await api(ctx.app, tenantId, 'POST', '/auth/request-link', { email });
  if (requested.status !== 200) throw new Error(`request-link failed: ${requested.status}`);
  const account = await ctx.db
    .selectFrom('portal_customer_accounts')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('email', '=', email.toLowerCase())
    .executeTakeFirstOrThrow();
  const tokenRow = await ctx.db
    .selectFrom('portal_customer_login_tokens')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('account_id', '=', account.id)
    .where('used_at', 'is', null)
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .executeTakeFirstOrThrow();
  const exchanged = await api(ctx.app, tenantId, 'POST', '/auth/exchange', { token: tokenRow.token });
  if (exchanged.status !== 200) throw new Error(`exchange failed: ${exchanged.status}`);
  return ((await exchanged.json()) as any).data.sessionToken;
}

/** Collect emitted events of one type. */
export function capture(events: EventBus, type: string): PlatformEvent[] {
  const seen: PlatformEvent[] = [];
  events.on(type, (e) => {
    seen.push(e);
  });
  return seen;
}

/* ------------------------- fake providers ------------------------- */

export function makeQuotesProvider(seed: Array<{ tenantId: string; quote: PortalQuote }>): {
  provider: PortalQuotesProvider;
  approvalCalls: QuoteApprovalEventInput[];
} {
  const approvalCalls: QuoteApprovalEventInput[] = [];
  const provider: PortalQuotesProvider = {
    async listForCustomer(tenantId, customerId) {
      return seed
        .filter((s) => s.tenantId === tenantId && s.quote.customerId === customerId)
        .map((s) => s.quote);
    },
    async getForCustomer(tenantId, customerId, quoteId) {
      return seed.find(
        (s) => s.tenantId === tenantId && s.quote.customerId === customerId && s.quote.id === quoteId,
      )?.quote;
    },
    async recordApprovalEvent(input) {
      approvalCalls.push(input);
      return { id: `approval_${approvalCalls.length}` };
    },
  };
  return { provider, approvalCalls };
}

export function makeInvoicesProvider(seed: Array<{ tenantId: string; invoice: PortalInvoice }>) {
  return {
    async listForCustomer(tenantId: string, customerId: string) {
      return seed
        .filter((s) => s.tenantId === tenantId && s.invoice.customerId === customerId)
        .map((s) => s.invoice);
    },
    async getForCustomer(tenantId: string, customerId: string, invoiceId: string) {
      return seed.find(
        (s) => s.tenantId === tenantId && s.invoice.customerId === customerId && s.invoice.id === invoiceId,
      )?.invoice;
    },
  };
}

export function makeAppointmentsProvider(
  seed: Array<{ tenantId: string; customerId: string; appointment: PortalAppointment }>,
): {
  provider: { listForCustomer(tenantId: string, customerId: string): Promise<PortalAppointment[]> };
  calls: Array<{ tenantId: string; customerId: string }>;
} {
  const calls: Array<{ tenantId: string; customerId: string }> = [];
  return {
    provider: {
      async listForCustomer(tenantId, customerId) {
        calls.push({ tenantId, customerId });
        return seed
          .filter((s) => s.tenantId === tenantId && s.customerId === customerId)
          .map((s) => s.appointment);
      },
    },
    calls,
  };
}
