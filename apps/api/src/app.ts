/**
 * @blacklabel/api — application factory (composition root).
 *
 * The ONLY place that:
 *   - assembles ALL migrations in dependency order (core first),
 *   - constructs the single shared EventBus,
 *   - wires the concrete cross-module Contracts implementations
 *     (task -> workflows, appointment -> scheduling, invoice -> billing,
 *     message -> messaging),
 *   - attaches the workflows engine's event subscriptions,
 *   - mounts every module router under /api/<module-key>.
 *
 * `createApp` is db-agnostic so the boot test can run it on an in-memory db
 * while `server.ts` runs it on the real file db.
 */
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { runMigrations, type Migration } from '@blacklabel/db';
import {
  EventBus,
  coreMigrations,
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
  IndustriesDatabase;

/** Module keys in mount order (also the /api/<key> mount points). */
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
] as const;

/**
 * ALL migrations, dependency order: core (tenants/users/audit/custom fields)
 * strictly first, then domain modules (crm before the modules that reference
 * customers by id), then read-side/config modules (dashboard, industries).
 * Order is otherwise decoupled — modules never FK into each other (§9).
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
];

export interface CreateAppOptions {
  /** The one shared Kysely database (file-backed in prod, in-memory in tests). */
  db: Kysely<PlatformDatabase>;
  /**
   * Storage adapter for the files module. Defaults to in-memory; server.ts
   * passes a LocalDiskStorageProvider rooted under the repo.
   */
  storage?: StorageProvider;
  /** Skip running migrations (when the caller already ran them). */
  skipMigrations?: boolean;
}

export interface PlatformApp {
  app: Hono;
  db: Kysely<PlatformDatabase>;
  events: EventBus;
  contracts: Contracts;
  /** The attached workflows engine (event subscriptions live). */
  engine: WorkflowEngine;
  /** Unsubscribe the workflows engine from the event bus. */
  detachEngine: () => void;
  modules: readonly string[];
}

/** One shared db, narrowed per module. All tables coexist in the same file. */
function dbFor<T>(db: Kysely<PlatformDatabase>): Kysely<T> {
  return db as unknown as Kysely<T>;
}

export async function createApp(options: CreateAppOptions): Promise<PlatformApp> {
  const { db } = options;

  if (!options.skipMigrations) {
    await runMigrations(db, allMigrations);
  }

  const events = new EventBus();

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

  // Workflows: subscribe the automation engine to the shared bus.
  const { engine, detach: detachEngine } = attachWorkflowEngine(deps<WorkflowsDatabase>());

  const storage = options.storage ?? new MemoryStorageProvider();

  const app = new Hono();

  app.get('/api/health', (c) =>
    c.json({
      data: {
        status: 'ok',
        modules: MODULE_KEYS,
        time: new Date().toISOString(),
      },
    }),
  );

  // Every module router applies the core tenant middleware itself
  // (x-tenant-id header) in front of its routes; reviews additionally exposes
  // tokenized /public/* endpoints that are deliberately tenant-header-free.
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

  return { app, db, events, contracts, engine, detachEngine, modules: MODULE_KEYS };
}
