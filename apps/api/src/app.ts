/**
 * @blacklabel/api — application factory (composition root).
 *
 * The ONLY place that:
 *   - assembles ALL migrations in dependency order (core first, then every
 *     module, then the api-owned config/dedupe tables),
 *   - constructs the single shared EventBus,
 *   - wires the concrete cross-module Contracts implementations,
 *   - attaches the workflows engine + automation + actions subscriptions and
 *     the deterministic cross-module wiring (orders→inventory, shows→inventory,
 *     purchasing→inventory, customers/retail→actions),
 *   - applies security hardening (headers, CSRF, rate limit, body cap, logging)
 *     and RBAC in front of every route,
 *   - mounts every module router under /api/<module-key> with the extra
 *     dependencies each one requires (automation: DispatcherRegistry; orders:
 *     providers; outreach: adapters; admin: masterKey/providers/probes).
 *
 * `createApp` is db-agnostic and env-free so the boot test runs it on an
 * in-memory db; server.ts runs it on the real file db with real fs injections.
 */
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { runMigrations, type Migration } from '@blacklabel/db';
import {
  ApiError,
  EventBus,
  coreMigrations,
  createUser,
  errorHandler,
  id,
  listUsers,
  nowIso,
  type Contracts,
  type CoreDatabase,
  type ModuleDeps,
} from '@blacklabel/core';

import { crmMigrations, crmRouter, type CrmDatabase } from '@blacklabel/crm';
import {
  schedulingMigrations,
  schedulingRouter,
  createSchedulingContract,
  createSchedulingAppointmentTypeContract,
  type SchedulingDatabase,
} from '@blacklabel/scheduling';
import { quotingMigrations, quotingRouter, type QuotingDatabase } from '@blacklabel/quoting';
import {
  portalCustomerMigrations,
  portalCustomerRouter,
  type PortalCustomerDatabase,
} from '@blacklabel/portal-customer';
import {
  portalEmployeeMigrations,
  portalEmployeeRouter,
  type PortalEmployeeDatabase,
} from '@blacklabel/portal-employee';
import {
  dashboardMigrations,
  dashboardRouter,
  type DashboardDatabase,
} from '@blacklabel/dashboard';
import {
  messagingMigrations,
  messagingRouter,
  createMessagingSendContract,
  type MessagingDatabase,
} from '@blacklabel/messaging';
import { reviewsMigrations, reviewsRouter, type ReviewsDatabase } from '@blacklabel/reviews';
import {
  workflowsMigrations,
  workflowsRouter,
  workflowsCreateTaskContract,
  attachWorkflowEngine,
  type WorkflowsDatabase,
  type WorkflowEngine,
} from '@blacklabel/workflows';
import {
  billingMigrations,
  billingRouter,
  billingCreateInvoiceContract,
  type BillingDatabase,
} from '@blacklabel/billing';
import {
  filesMigrations,
  filesRouter,
  MemoryStorageProvider,
  type FilesDatabase,
  type StorageProvider,
} from '@blacklabel/files';
import {
  industriesMigrations,
  industriesRouter,
  type IndustriesDatabase,
} from '@blacklabel/industries';
import { retailMigrations, retailRouter, type RetailDatabase } from '@blacklabel/retail';

// ── New Mags Commerce OS modules ────────────────────────────────────────────
import {
  automationMigrations,
  automationRouter,
  registerAutomationSubscriptions,
  type AutomationDatabase,
} from '@blacklabel/automation';
import {
  actionsMigrations,
  actionsRouter,
  registerActionsSubscriptions,
  type ActionsDatabase,
} from '@blacklabel/actions';
import { catalogMigrations, catalogRouter, type CatalogDatabase } from '@blacklabel/catalog';
import { inventoryMigrations, inventoryRouter, type InventoryDatabase } from '@blacklabel/inventory';
import { showsMigrations, showsRouter, type ShowsDatabase } from '@blacklabel/shows';
import { vendorsMigrations, vendorsRouter, type VendorsDatabase } from '@blacklabel/vendors';
import { purchasingMigrations, purchasingRouter, type PurchasingDatabase } from '@blacklabel/purchasing';
import {
  ordersMigrations,
  ordersRouter,
  simulatorCheckoutProvider,
  type OrdersDatabase,
} from '@blacklabel/orders';
import {
  customersMigrations,
  customersRouter,
  isSuppressed as customersIsSuppressed,
  normalizeSuppressionValue,
  type CustomersDatabase,
} from '@blacklabel/customers';
import { loyaltyMigrations, loyaltyRouter, type LoyaltyDatabase } from '@blacklabel/loyalty';
import { outreachMigrations, outreachRouter, type OutreachDatabase, type OutreachAdapters } from '@blacklabel/outreach';
import { financeMigrations, financeRouter, type FinanceDatabase } from '@blacklabel/finance';
import {
  workforceMigrations,
  workforceRouter,
  seedBuiltinRoles,
  type WorkforceDatabase,
} from '@blacklabel/workforce';
import {
  adminMigrations,
  adminRouter,
  createLogger,
  HealthService,
  type AdminDatabase,
  type BackupProvider,
  type CountProbe,
  type Logger,
} from '@blacklabel/admin';

import {
  storefrontMigrations,
  storefrontPublicRouter,
  type StorefrontDatabase,
  type PlaceOrderInput,
} from '@blacklabel/storefront';
import {
  createOrder as ordersCreateOrder,
  reserveOrder as ordersReserveOrder,
} from '@blacklabel/orders';
import {
  createProfile as customersCreateProfile,
  searchProfiles as customersSearchProfiles,
  startDoubleOptIn as customersStartDoubleOptIn,
  createRestockRequest as customersCreateRestockRequest,
} from '@blacklabel/customers';
import { apiMigrations, type ApiDatabase } from './migrations';
import { CONFIG_KEYS, coerceKey, deriveCheckoutSecret, setConfig } from './config';
import {
  RateLimiter,
  bodyLimit,
  csrfGuard,
  requestLogger,
  securityHeaders,
  type RateLimitOptions,
} from './security';
import { defaultRbacRules, makeGetActingUser, rbacGuard } from './rbac';
import { buildDispatcherRegistry, registerCrossModuleWiring } from './wiring';
import { buildHealthProbes } from './admin-wiring';

/** Every module's tables in the one shared database. */
export type PlatformDatabase = CoreDatabase &
  CrmDatabase &
  SchedulingDatabase &
  QuotingDatabase &
  PortalCustomerDatabase &
  PortalEmployeeDatabase &
  DashboardDatabase &
  MessagingDatabase &
  ReviewsDatabase &
  WorkflowsDatabase &
  BillingDatabase &
  FilesDatabase &
  IndustriesDatabase &
  RetailDatabase &
  AutomationDatabase &
  ActionsDatabase &
  CatalogDatabase &
  InventoryDatabase &
  ShowsDatabase &
  VendorsDatabase &
  PurchasingDatabase &
  OrdersDatabase &
  CustomersDatabase &
  LoyaltyDatabase &
  OutreachDatabase &
  FinanceDatabase &
  WorkforceDatabase &
  AdminDatabase &
  StorefrontDatabase &
  ApiDatabase;

/** Module keys in mount order (also the /api/<key> mount points + health list). */
export const MODULE_KEYS = [
  'crm',
  'scheduling',
  'quoting',
  'portal-customer',
  'portal-employee',
  'dashboard',
  'messaging',
  'reviews',
  'workflows',
  'billing',
  'files',
  'industries',
  'retail',
  'automation',
  'actions',
  'catalog',
  'inventory',
  'shows',
  'vendors',
  'purchasing',
  'orders',
  'customers',
  'loyalty',
  'outreach',
  'finance',
  'workforce',
  'admin',
] as const;

/**
 * ALL migrations, dependency order: core first, then the existing V1 modules,
 * then the new Mags modules (automation/actions/catalog/inventory before the
 * wave-2 modules that emit events they consume), then retail (extended import
 * lane), then the api-owned config/dedupe tables. Modules never FK into each
 * other (§9) so ordering beyond core-first is for readability.
 */
export const allMigrations: readonly Migration[] = [
  ...coreMigrations,
  ...crmMigrations,
  ...schedulingMigrations,
  ...quotingMigrations,
  ...billingMigrations,
  ...messagingMigrations,
  ...reviewsMigrations,
  ...workflowsMigrations,
  ...filesMigrations,
  ...portalCustomerMigrations,
  ...portalEmployeeMigrations,
  ...dashboardMigrations,
  ...industriesMigrations,
  // New modules (wave 1 spine first, then wave 2).
  ...automationMigrations,
  ...actionsMigrations,
  ...catalogMigrations,
  ...inventoryMigrations,
  ...showsMigrations,
  ...vendorsMigrations,
  ...purchasingMigrations,
  ...ordersMigrations,
  ...customersMigrations,
  ...loyaltyMigrations,
  ...outreachMigrations,
  ...financeMigrations,
  ...workforceMigrations,
  ...adminMigrations,
  // retail (extended by the concurrent import-lane agent) + api-owned tables.
  ...retailMigrations,
  ...storefrontMigrations,
  ...apiMigrations,
];

export interface CreateAppOptions {
  db: Kysely<PlatformDatabase>;
  storage?: StorageProvider;
  skipMigrations?: boolean;

  /** AES-256-GCM master key (base64/hex/passphrase or Buffer). Ephemeral if unset. */
  adminMasterKey?: Buffer | string;
  /** better-sqlite3 backup provider (server.ts). Absent → backup routes 501. */
  backupProvider?: BackupProvider;
  /** Critical-table count probe used by backup verification (server.ts). */
  countProbe?: CountProbe;
  /** Real db file path (for diagnostics; null/undefined for in-memory). */
  dbPath?: string | null;
  /** Storage dir for the disk-free health probe. */
  storageDir?: string;

  /** Checkout-simulator HMAC secret. Derived from the master key when unset. */
  checkoutSimSecret?: string;
  /** Public unsubscribe base URL for outreach links. */
  unsubscribeBaseUrl?: string;

  /** Process-wide default inventory location fallback (single-tenant dev). */
  envDefaultLocationId?: string;
  /** Env override for the default acting owner user id. */
  ownerUserIdEnv?: string;

  /** Rate-limit tuning + injectable clock (tests). */
  rateLimit?: RateLimitOptions;
  /** Skip the rate limiter entirely (batch/CLI tools like the ledger importer). */
  disableRateLimit?: boolean;
  /** Structured-log sink. Default silent (server.ts passes console). */
  logSink?: (line: string) => void;

  /** App version for the diagnostics bundle. */
  version?: string;

  /**
   * Mount the PUBLIC storefront at /store for local live mode (single-tenant).
   * The tenant is fixed at construction — public requests carry no tenant
   * header. placeOrder/consent/restock are wired to the orders + customers
   * modules below; the storefront itself only ever reads projection tables.
   */
  storefront?: { tenantId: string; imageSourceDir?: string };
}

export interface SeedTenantOptions {
  ownerName?: string;
  ownerEmail?: string;
  actor?: string;
}

export interface SeedTenantResult {
  ownerUserId: string;
  createdOwner: boolean;
}

export interface PlatformApp {
  app: Hono;
  db: Kysely<PlatformDatabase>;
  events: EventBus;
  contracts: Contracts;
  engine: WorkflowEngine;
  health: HealthService;
  logger: Logger;
  /** Detach the workflows engine + every subscription/wiring handler. */
  detachEngine: () => void;
  /** Idempotently seed workforce built-in roles + an owner user for a tenant. */
  seedTenant: (tenantId: string, opts?: SeedTenantOptions) => Promise<SeedTenantResult>;
  modules: readonly string[];
}

/** One shared db, narrowed per module. All tables coexist in the same file. */
function dbFor<T>(db: Kysely<PlatformDatabase>): Kysely<T> {
  return db as unknown as Kysely<T>;
}

/**
 * Mount the PUBLIC storefront at /store on an existing app (single tenant,
 * fixed at mount time — public requests carry no tenant header). The storefront
 * reads ONLY its projection tables; placeOrder/consent/restock forward into the
 * orders + customers modules. server.ts calls this after resolving the tenant.
 */
export function mountPublicStorefront(args: {
  app: Hono;
  db: Kysely<PlatformDatabase>;
  events: EventBus;
  tenantId: string;
  imageSourceDir?: string;
}): void {
  const { app, db, events, tenantId, imageSourceDir } = args;
  const ordersCtx = { db: dbFor<OrdersDatabase>(db), events };
  const customersDb = dbFor<CustomersDatabase>(db);
  app.route(
    '/store',
    storefrontPublicRouter({
      db: dbFor<StorefrontDatabase>(db),
      tenantId,
      imageSourceDir,
      placeOrder: async (input: PlaceOrderInput) => {
        // Price truth = the published projection (exactly what the shopper saw).
        const lines: Array<{
          variationId: string;
          description: string;
          qty: number;
          unitPriceCents: number;
        }> = [];
        for (const l of input.lines) {
          const pub = await db
            .selectFrom('storefront_published_variations')
            .selectAll()
            .where('tenant_id', '=', tenantId)
            .where('source_variation_id', '=', l.variationId)
            .orderBy('id')
            .executeTakeFirst();
          if (!pub) throw ApiError.badRequest(`unknown variation: ${l.variationId}`);
          if (pub.price_cents === null) {
            throw ApiError.badRequest(`price not listed for variation: ${l.variationId}`);
          }
          lines.push({
            variationId: l.variationId,
            description: pub.name,
            qty: l.qty,
            unitPriceCents: pub.price_cents,
          });
        }
        const created = await ordersCreateOrder(ordersCtx, tenantId, 'storefront', {
          channel: 'storefront',
          lines,
        });
        const reserved = await ordersReserveOrder(ordersCtx, tenantId, 'storefront', created.order.id);
        return { orderId: created.order.id, status: reserved.status, totalCents: reserved.total_cents };
      },
      submitConsent: async ({ email }: { email: string }) => {
        const existing = await customersSearchProfiles(customersDb, tenantId, {
          email,
          page: { limit: 1, offset: 0 },
        });
        const profile =
          existing[0] ??
          (await customersCreateProfile(customersDb, tenantId, 'storefront', {
            email,
            source: 'storefront',
          }));
        const result = await customersStartDoubleOptIn(
          customersDb,
          tenantId,
          'storefront',
          events,
          profile.id,
          { channel: 'email', source: 'storefront' },
        );
        // Confirmation tokens are reserved for an out-of-band delivery lane and
        // must never be returned to the public requester.
        return { profileId: profile.id, expiresAt: result.expiresAt };
      },
      submitRestock: async ({ variationId, email }: { variationId: string; email?: string }) => {
        let profileId: string | null = null;
        if (email) {
          const found = await customersSearchProfiles(customersDb, tenantId, {
            email,
            page: { limit: 1, offset: 0 },
          });
          profileId = found[0]?.id ?? null;
        }
        const row = await customersCreateRestockRequest(customersDb, tenantId, 'storefront', events, {
          variationId,
          profileId,
          source: 'storefront',
        });
        return { requestId: row.id };
      },
    }),
  );
}

export async function createApp(options: CreateAppOptions): Promise<PlatformApp> {
  const { db } = options;

  if (!options.skipMigrations) {
    await runMigrations(db, allMigrations);
  }

  const events = new EventBus();
  const logger = createLogger({ sink: options.logSink ?? (() => {}) });
  const masterKey = coerceKey(options.adminMasterKey);
  const checkoutSecret = deriveCheckoutSecret(masterKey, options.checkoutSimSecret);

  // Cross-module contract implementations (CONVENTIONS §9).
  const contracts: Contracts = {
    createTask: workflowsCreateTaskContract(dbFor<WorkflowsDatabase>(db), events),
    createAppointment: createSchedulingContract({ db: dbFor<SchedulingDatabase>(db), events }),
    createAppointmentType: createSchedulingAppointmentTypeContract({
      db: dbFor<SchedulingDatabase>(db),
      events,
    }),
    createInvoice: billingCreateInvoiceContract(dbFor<BillingDatabase>(db), events),
    sendMessage: createMessagingSendContract(dbFor<MessagingDatabase>(db), events),
  };

  const deps = <T>(): ModuleDeps<T> => ({ db: dbFor<T>(db), events, contracts });

  // Workflows engine subscriptions.
  const { engine, detach: detachEngine } = attachWorkflowEngine(deps<WorkflowsDatabase>());

  // Automation + actions subscriptions (the primary '*' subscribers).
  const detachAutomation = registerAutomationSubscriptions(deps<AutomationDatabase>());
  const detachActions = registerActionsSubscriptions(deps<ActionsDatabase>());

  // The deterministic cross-module glue (orders/shows/purchasing → inventory,
  // customers/retail → actions).
  const detachWiring = registerCrossModuleWiring({
    db: db as unknown as never,
    events,
    logger,
    envDefaultLocationId: options.envDefaultLocationId,
  });

  // Outbox dispatcher registry (honest 501 handlers for gated transports).
  const dispatcher = buildDispatcherRegistry(logger);

  // Orders checkout providers: simulator wired (real HMAC); square_hosted is a
  // founder gate (not wired here).
  const checkoutProviders = [simulatorCheckoutProvider({ secret: checkoutSecret })];

  // Outreach adapters: no transport/reader (cold — 'no_provider' honestly).
  // isSuppressed → customers; suppress → customers suppression ledger.
  const outreachAdapters: OutreachAdapters = {
    unsubscribeBaseUrl: options.unsubscribeBaseUrl ?? 'http://127.0.0.1:8477',
    isSuppressed: (tenantId, email) =>
      customersIsSuppressed(dbFor<CustomersDatabase>(db), tenantId, 'email', email),
    // customers does not export addSuppression; the integrator records the
    // suppression through the module's exported normalizer + a check-then-insert
    // (documented deviation — keeps unsubscribe→suppression non-silent).
    suppress: async (tenantId, email, reason) => {
      const normalized = normalizeSuppressionValue('email', email);
      if (!normalized) return;
      const cdb = dbFor<CustomersDatabase>(db);
      const existing = await cdb
        .selectFrom('customers_suppressions')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('scope', '=', 'email')
        .where('value_normalized', '=', normalized)
        .executeTakeFirst();
      if (existing) return;
      const mapped =
        reason === 'bounced' || reason === 'complaint' || reason === 'manual' ? reason : 'unsubscribed';
      await cdb
        .insertInto('customers_suppressions')
        .values({
          id: id(),
          tenant_id: tenantId,
          scope: 'email',
          value_normalized: normalized,
          reason: mapped as never,
          created_at: nowIso(),
        })
        .execute();
    },
  };

  // Health probes (ops-level infra signals).
  const health = new HealthService(dbFor<AdminDatabase>(db));
  health.registerMany(
    buildHealthProbes({
      db: dbFor<Record<string, unknown>>(db),
      storageDir: options.storageDir,
    }),
  );

  const storage = options.storage ?? new MemoryStorageProvider();

  /* ------------------------------- app ------------------------------- */

  const app = new Hono();
  app.onError(errorHandler);

  // Security + RBAC, in front of everything (order matters).
  const rateLimiter = new RateLimiter(options.rateLimit);
  const getActingUser = makeGetActingUser(dbFor<CoreDatabase>(db), {
    ownerUserIdEnv: options.ownerUserIdEnv,
  });
  app.use('*', requestLogger(logger));
  app.use('*', securityHeaders());
  app.use('*', bodyLimit());
  if (!options.disableRateLimit) app.use('*', rateLimiter.middleware());
  app.use('*', csrfGuard());
  app.use(
    '/api/*',
    rbacGuard(dbFor<WorkforceDatabase & CoreDatabase>(db), getActingUser, defaultRbacRules()),
  );

  app.get('/api/health', (c) => {
    return c.json({
      data: {
        status: 'ok',
        modules: MODULE_KEYS,
        time: new Date().toISOString(),
      },
    });
  });

  // Existing V1 module routers.
  app.route('/api/crm', crmRouter(deps<CrmDatabase>()));
  app.route('/api/scheduling', schedulingRouter(deps<SchedulingDatabase>()));
  app.route('/api/quoting', quotingRouter(deps<QuotingDatabase>()));
  app.route('/api/portal-customer', portalCustomerRouter(deps<PortalCustomerDatabase>()));
  app.route('/api/portal-employee', portalEmployeeRouter(deps<PortalEmployeeDatabase>()));
  app.route('/api/dashboard', dashboardRouter(deps<DashboardDatabase>()));
  app.route('/api/messaging', messagingRouter(deps<MessagingDatabase>()));
  app.route('/api/reviews', reviewsRouter(deps<ReviewsDatabase>()));
  app.route('/api/workflows', workflowsRouter(deps<WorkflowsDatabase>()));
  app.route('/api/billing', billingRouter(deps<BillingDatabase>()));
  app.route('/api/files', filesRouter({ ...deps<FilesDatabase>(), storage }));
  app.route('/api/industries', industriesRouter(deps<IndustriesDatabase>()));
  app.route('/api/retail', retailRouter(deps<RetailDatabase>()));

  // New modules with their extra-arg injections.
  app.route('/api/automation', automationRouter(deps<AutomationDatabase>(), dispatcher));
  app.route('/api/actions', actionsRouter(deps<ActionsDatabase>()));
  app.route('/api/catalog', catalogRouter(deps<CatalogDatabase>()));
  app.route('/api/inventory', inventoryRouter(deps<InventoryDatabase>()));
  app.route('/api/shows', showsRouter(deps<ShowsDatabase>()));
  app.route('/api/vendors', vendorsRouter(deps<VendorsDatabase>()));
  app.route('/api/purchasing', purchasingRouter(deps<PurchasingDatabase>()));
  app.route('/api/orders', ordersRouter(deps<OrdersDatabase>(), { providers: checkoutProviders }));
  app.route('/api/customers', customersRouter(deps<CustomersDatabase>()));
  app.route('/api/loyalty', loyaltyRouter(deps<LoyaltyDatabase>()));
  app.route('/api/outreach', outreachRouter(deps<OutreachDatabase>(), outreachAdapters));
  app.route('/api/finance', financeRouter(deps<FinanceDatabase>()));
  app.route('/api/workforce', workforceRouter(deps<WorkforceDatabase>()));
  app.route(
    '/api/admin',
    adminRouter({
      ...deps<AdminDatabase>(),
      masterKey,
      healthService: health,
      backupProvider: options.backupProvider,
      countProbe: options.countProbe,
      diagnostics: { version: options.version ?? '0.0.1' },
    }),
  );

  // PUBLIC storefront (local live mode, single tenant fixed at construction).
  if (options.storefront) {
    mountPublicStorefront({ app, db, events, ...options.storefront });
  }

  // Non-API root: honest api-only fallback (server.ts serves the UI at / when
  // UI_DIR is set). CSP + security headers still apply via the global middleware.
  app.get('/', (c) => c.json({ status: 'api-only' }));

  const detachAll = () => {
    detachEngine();
    detachAutomation();
    detachActions();
    detachWiring();
  };

  const seedTenant = async (
    tenantId: string,
    opts: SeedTenantOptions = {},
  ): Promise<SeedTenantResult> => {
    const actor = opts.actor ?? 'system';
    const wdb = dbFor<WorkforceDatabase>(db);
    const cdb = dbFor<CoreDatabase>(db);
    const { roleIds } = await seedBuiltinRoles(wdb, tenantId, actor);

    // Owner core user (role 'owner'), idempotent.
    let ownerId: string | undefined;
    for (let offset = 0; ; offset += 100) {
      const page = await listUsers(cdb, tenantId, { limit: 100, offset });
      const found = page.find((u) => u.role === 'owner');
      if (found) {
        ownerId = found.id;
        break;
      }
      if (page.length < 100) break;
    }
    let createdOwner = false;
    if (!ownerId) {
      const owner = await createUser(cdb, tenantId, {
        name: opts.ownerName ?? 'Owner',
        email: opts.ownerEmail ?? `owner+${tenantId}@local.invalid`,
        role: 'owner',
      });
      ownerId = owner.id;
      createdOwner = true;
    }

    // Assign the owner user to the workforce 'owner' role. workforce does not
    // export assignRole; the integrator check-then-inserts the link (documented
    // deviation) so the owner unions to every permission.
    const link = await wdb
      .selectFrom('workforce_user_roles')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('user_id', '=', ownerId)
      .where('role_id', '=', roleIds.owner)
      .executeTakeFirst();
    if (!link) {
      await wdb
        .insertInto('workforce_user_roles')
        .values({
          id: id(),
          tenant_id: tenantId,
          user_id: ownerId,
          role_id: roleIds.owner,
          created_at: nowIso(),
        })
        .execute();
    }

    await setConfig(dbFor<ApiDatabase>(db), tenantId, CONFIG_KEYS.ownerUserId, ownerId);
    return { ownerUserId: ownerId, createdOwner };
  };

  return {
    app,
    db,
    events,
    contracts,
    engine,
    health,
    logger,
    detachEngine: detachAll,
    seedTenant,
    modules: MODULE_KEYS,
  };
}
