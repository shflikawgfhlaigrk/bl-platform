import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  ApiError,
  asCoreDb,
  errorHandler,
  parsePagination,
  tenantMiddleware,
  type ModuleDeps,
  type TenantEnv,
} from '@blacklabel/core';
import type { ServiceFoundationRegistry } from './adapters';
import { CLIENT_OPS_CATALOG } from './catalog';
import { CLIENT_OPS_MANIFEST_SHA256 } from './manifest';
import { executeRun, type RunnerOutcome } from './runner';
import type { ClientOpsDatabase, ReviewStatus } from './schema';
import { ClientOpsService, type ReviewItem, type Run } from './service';
import { PortfolioService } from './portfolio-service';
import { resolveTenantFoundations } from './tenant-foundations';

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw ApiError.badRequest('invalid JSON body');
  }
}

function actorOf(c: Context): string {
  const actor = c.req.header('x-user-id');
  return actor && actor.trim() !== '' ? actor.trim() : 'system';
}

const createInstallationSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  catalogKind: z.enum(['service', 'vertical_pack']),
  catalogId: z.string().trim().min(1).max(200),
  engagementModelId: z.string().trim().min(1).max(200).nullable().optional(),
}).strict();

const updateInstallationSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  status: z.enum(['onboarding', 'active', 'paused']).optional(),
  engagementModelId: z.string().trim().min(1).max(200).nullable().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, 'at least one field is required');

const updateWorkflowSchema = z.object({
  enabled: z.boolean().optional(),
  status: z.enum(['ready', 'blocked', 'paused']).optional(),
}).strict().refine((body) => Object.keys(body).length > 0, 'at least one field is required');

const updateConnectorSchema = z.object({
  status: z.enum(['pending', 'connected', 'unhealthy', 'disabled']).optional(),
  credentialRef: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,499}$/).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  health: z.record(z.unknown()).nullable().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, 'at least one field is required');

const updateOnboardingSchema = z.object({
  status: z.enum(['pending', 'completed', 'blocked']),
  evidence: z.unknown().optional(),
}).strict();

const requestRunSchema = z.object({
  installationId: z.string().trim().min(1),
  workflowId: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1).max(300),
  input: z.unknown().optional(),
}).strict();

const retryRunSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(300),
  input: z.unknown().optional(),
}).strict();

const updateRunSchema = z.object({
  status: z.enum(['running', 'succeeded', 'failed', 'canceled']),
  output: z.unknown().optional(),
  error: z.string().max(4000).nullable().optional(),
}).strict();

const createReviewSchema = z.object({
  installationId: z.string().trim().min(1),
  runId: z.string().trim().min(1).nullable().optional(),
  workflowId: z.string().trim().min(1).nullable().optional(),
  title: z.string().trim().min(1).max(300),
  context: z.unknown().optional(),
}).strict();

const optionalNoteSchema = z.object({ note: z.string().trim().min(1).max(2000).nullable().optional() }).strict();
const requiredNoteSchema = z.object({ note: z.string().trim().min(1).max(2000) }).strict();

const createArtifactSchema = z.object({
  installationId: z.string().trim().min(1),
  runId: z.string().trim().min(1).nullable().optional(),
  reviewItemId: z.string().trim().min(1).nullable().optional(),
  kind: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(300),
  uri: z.string().trim().min(1).max(2000),
  mediaType: z.string().trim().min(1).max(200),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  metadata: z.unknown().optional(),
}).strict();

const createReceiptSchema = z.object({
  installationId: z.string().trim().min(1),
  runId: z.string().trim().min(1),
  summary: z.string().trim().min(1).max(4000),
  verification: z.unknown().default({}),
  artifactIds: z.array(z.string().trim().min(1)).default([]),
}).strict();

const createUsageSchema = z.object({
  installationId: z.string().trim().min(1),
  runId: z.string().trim().min(1).nullable().optional(),
  provider: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  metric: z.string().trim().min(1).max(200),
  quantity: z.number().int().nonnegative(),
  unit: z.string().trim().min(1).max(100),
  costCents: z.number().int().nonnegative(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  metadata: z.unknown().optional(),
}).strict();

const reviewStatuses: ReviewStatus[] = ['pending', 'approved', 'denied', 'held'];

const portfolioTargetSchema = z.object({
  targetKind: z.enum(['product', 'feature']).optional(),
  targetKey: z.string().trim().min(1).max(300).optional(),
});

const requestPortfolioTestSchema = portfolioTargetSchema.extend({
  suiteKey: z.string().trim().regex(/^[a-z][a-z0-9.-]{2,199}$/),
  sourceRevision: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/).optional(),
}).strict();

const requestPortfolioPackageSchema = portfolioTargetSchema.extend({
  version: z.string().trim().regex(/^[0-9][a-zA-Z0-9._-]{0,99}$/),
}).strict();

export interface ClientOpsRouterOptions {
  /**
   * Execution registry backing `GET /foundations` and `POST /runs/:id/execute`.
   * Without it those routes answer 501 honestly — mounting the router never
   * implies the engine can execute anything.
   */
  registry?: ServiceFoundationRegistry;
}

/**
 * Tenant-scoped client operations product API. No cross-module imports or
 * reads; apps/api owns eventual mounting and integration wiring.
 */
export function clientOpsRouter(
  deps: ModuleDeps<ClientOpsDatabase>,
  options: ClientOpsRouterOptions = {},
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  const service = new ClientOpsService(deps.db, deps.events);
  const portfolio = new PortfolioService(deps.db, deps.events);
  const registry = options.registry;
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(deps.db)));

  const requireRegistry = (): ServiceFoundationRegistry => {
    if (!registry) throw new ApiError(501, 'execution registry not configured', 'not_implemented');
    return registry;
  };

  /** RunnerOutcome → response body. Every field is the runner's real result — never synthesized. */
  const outcomeBody = (outcome: RunnerOutcome): Record<string, unknown> => {
    switch (outcome.status) {
      case 'succeeded':
        return { status: outcome.status, run: outcome.run, receiptId: outcome.receiptId, results: outcome.results };
      case 'failed':
        return { status: outcome.status, run: outcome.run, error: outcome.error, results: outcome.results };
      case 'not_ready':
        // The honest "awaiting client connection" state — report the reason verbatim.
        return { status: outcome.status, run: outcome.run, reason: outcome.reason };
      case 'needs_approval':
        return { status: outcome.status, run: outcome.run, mutatingActionIds: outcome.mutatingActionIds };
    }
  };

  /** One pending approval review per run; re-executing never piles up duplicates. */
  const ensureRunApprovalReview = async (
    tenantId: string,
    run: Run,
    mutatingActionIds: string[],
    actor: string,
  ): Promise<ReviewItem> => {
    const reviews = await service.listReviewsForRun(tenantId, run.id);
    const open = reviews.find((item) => item.status === 'pending' || item.status === 'held');
    if (open) return open;
    return service.createReview(tenantId, {
      installationId: run.installationId,
      runId: run.id,
      workflowId: run.workflowId,
      title: 'Approve external-state-mutating run',
      context: { source: 'client_ops.runner', mutatingActionIds },
    }, actor);
  };

  app.get('/catalog', (c) => c.json({ data: CLIENT_OPS_CATALOG }));
  app.get('/catalog/manifest', (c) => c.json({ data: {
    schemaVersion: CLIENT_OPS_CATALOG.schemaVersion,
    catalogVersion: CLIENT_OPS_CATALOG.catalogVersion,
    sha256: CLIENT_OPS_MANIFEST_SHA256,
  } }));

  // Per-tenant, never process-wide: `connected` here means THIS tenant can
  // execute against its OWN source, not merely that an adapter is loaded.
  app.get('/foundations', async (c) => c.json({
    data: await resolveTenantFoundations(service, c.get('tenantId'), requireRegistry()),
  }));

  app.get('/portfolio', async (c) => c.json({ data: await portfolio.listPortfolio(c.get('tenantId')) }));

  app.get('/portfolio/:productKey/features', async (c) => {
    const product = await portfolio.getProduct(c.get('tenantId'), c.req.param('productKey'));
    return c.json({ data: product.features });
  });

  app.get('/portfolio/:productKey/test-runs', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await portfolio.listTestRuns(c.get('tenantId'), c.req.param('productKey'), page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });

  app.post('/portfolio/:productKey/test-runs', async (c) => {
    const body = requestPortfolioTestSchema.parse(await jsonBody(c));
    const result = await portfolio.requestTestRun(c.get('tenantId'), c.req.param('productKey'), body, actorOf(c));
    return c.json({ data: result }, 202);
  });

  app.get('/portfolio/:productKey/packages', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await portfolio.listPackages(c.get('tenantId'), c.req.param('productKey'), page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });

  app.post('/portfolio/:productKey/packages', async (c) => {
    const body = requestPortfolioPackageSchema.parse(await jsonBody(c));
    const result = await portfolio.requestPackage(c.get('tenantId'), c.req.param('productKey'), body, actorOf(c));
    return c.json({ data: result }, 202);
  });

  app.get('/portfolio/:productKey', async (c) => {
    const product = await portfolio.getProduct(c.get('tenantId'), c.req.param('productKey'));
    return c.json({ data: { product } });
  });

  app.post('/installations', async (c) => {
    const body = createInstallationSchema.parse(await jsonBody(c));
    const result = await service.createInstallation(c.get('tenantId'), body, actorOf(c));
    return c.json({ data: result }, 201);
  });

  app.get('/installations', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await service.listInstallations(c.get('tenantId'), page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });

  app.get('/installations/:id', async (c) => {
    const result = await service.getInstallation(c.get('tenantId'), c.req.param('id'));
    return c.json({ data: result });
  });

  app.patch('/installations/:id', async (c) => {
    const body = updateInstallationSchema.parse(await jsonBody(c));
    const result = await service.updateInstallation(c.get('tenantId'), c.req.param('id'), body, actorOf(c));
    return c.json({ data: result });
  });

  app.delete('/installations/:id', async (c) => {
    const result = await service.archiveInstallation(c.get('tenantId'), c.req.param('id'), actorOf(c));
    return c.json({ data: result });
  });

  app.patch('/installations/:id/workflows/:workflowId', async (c) => {
    const body = updateWorkflowSchema.parse(await jsonBody(c));
    const result = await service.updateWorkflow(c.get('tenantId'), c.req.param('id'), c.req.param('workflowId'), body, actorOf(c));
    return c.json({ data: result });
  });

  app.patch('/installations/:id/connectors/:bindingId', async (c) => {
    const body = updateConnectorSchema.parse(await jsonBody(c));
    const result = await service.updateConnector(c.get('tenantId'), c.req.param('id'), c.req.param('bindingId'), body, actorOf(c));
    return c.json({ data: result });
  });

  app.patch('/installations/:id/onboarding/:stepId', async (c) => {
    const body = updateOnboardingSchema.parse(await jsonBody(c));
    const result = await service.updateOnboardingStep(c.get('tenantId'), c.req.param('id'), c.req.param('stepId'), body, actorOf(c));
    return c.json({ data: result });
  });

  app.post('/runs', async (c) => {
    const body = requestRunSchema.parse(await jsonBody(c));
    const result = await service.requestRun(c.get('tenantId'), body, actorOf(c));
    return c.json({ data: result.run, created: result.created }, result.created ? 201 : 200);
  });

  app.get('/runs', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await service.listRuns(c.get('tenantId'), page, c.req.query('installation_id'));
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });

  app.get('/runs/:id', async (c) => c.json({ data: await service.getRun(c.get('tenantId'), c.req.param('id')) }));

  app.patch('/runs/:id', async (c) => {
    const body = updateRunSchema.parse(await jsonBody(c));
    const result = await service.updateRun(c.get('tenantId'), c.req.param('id'), body, actorOf(c));
    return c.json({ data: result });
  });

  app.post('/runs/:id/execute', async (c) => {
    const executionRegistry = requireRegistry();
    const tenantId = c.get('tenantId');
    const runId = c.req.param('id');
    const actor = actorOf(c);
    const run = await service.getRun(tenantId, runId);
    if (run.status !== 'requested') throw ApiError.conflict(`run is not executable (status=${run.status})`);
    const reviews = await service.listReviewsForRun(tenantId, runId);
    if (reviews.some((item) => item.status === 'denied')) {
      throw ApiError.conflict('run approval was denied; request a new run');
    }
    const approved = reviews.some((item) => item.status === 'approved');
    const outcome = await executeRun({ service, registry: executionRegistry }, { tenantId, runId, approved, actor });
    if (outcome.status === 'needs_approval') {
      const review = await ensureRunApprovalReview(tenantId, outcome.run, outcome.mutatingActionIds, actor);
      return c.json({ data: { ...outcomeBody(outcome), reviewId: review.id } }, 202);
    }
    return c.json({ data: outcomeBody(outcome) });
  });

  app.post('/runs/:id/retry', async (c) => {
    const body = retryRunSchema.parse(await jsonBody(c));
    const result = await service.retryRun(c.get('tenantId'), c.req.param('id'), body, actorOf(c));
    return c.json({ data: result.run, created: result.created }, result.created ? 201 : 200);
  });

  app.post('/reviews', async (c) => {
    const body = createReviewSchema.parse(await jsonBody(c));
    const result = await service.createReview(c.get('tenantId'), body, actorOf(c));
    return c.json({ data: result }, 201);
  });

  app.get('/reviews', async (c) => {
    const page = parsePagination(c.req.query());
    const status = c.req.query('status');
    if (status !== undefined && !reviewStatuses.includes(status as ReviewStatus)) throw ApiError.badRequest('invalid review status');
    const rows = await service.listReviews(c.get('tenantId'), page, status as ReviewStatus | undefined);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });

  app.get('/reviews/:id', async (c) => c.json({ data: await service.getReview(c.get('tenantId'), c.req.param('id')) }));

  app.post('/reviews/:id/approve', async (c) => {
    const body = optionalNoteSchema.parse(await jsonBody(c));
    const tenantId = c.get('tenantId');
    const actor = actorOf(c);
    const review = await service.decideReview(tenantId, c.req.param('id'), 'approved', body.note ?? null, actor);
    // Approval loop: an approved run-scoped review re-invokes the runner with the
    // approval recorded. The execution result is the runner's real outcome.
    if (review.runId && registry) {
      const run = await service.getRun(tenantId, review.runId);
      if (run.status === 'requested') {
        const outcome = await executeRun({ service, registry }, { tenantId, runId: run.id, approved: true, actor });
        return c.json({ data: review, execution: outcomeBody(outcome) });
      }
    }
    return c.json({ data: review });
  });

  app.post('/reviews/:id/deny', async (c) => {
    const body = requiredNoteSchema.parse(await jsonBody(c));
    const tenantId = c.get('tenantId');
    const actor = actorOf(c);
    const review = await service.decideReview(tenantId, c.req.param('id'), 'denied', body.note, actor);
    // A denied run-scoped review cancels the still-requested run so it can never execute.
    if (review.runId) {
      const run = await service.getRun(tenantId, review.runId);
      if (run.status === 'requested') {
        const canceled = await service.updateRun(
          tenantId, run.id,
          { status: 'canceled', error: `review ${review.id} denied: ${body.note}` },
          actor,
        );
        return c.json({ data: review, run: canceled });
      }
    }
    return c.json({ data: review });
  });

  app.post('/reviews/:id/hold', async (c) => {
    const body = requiredNoteSchema.parse(await jsonBody(c));
    return c.json({ data: await service.decideReview(c.get('tenantId'), c.req.param('id'), 'held', body.note, actorOf(c)) });
  });

  app.post('/artifacts', async (c) => {
    const body = createArtifactSchema.parse(await jsonBody(c));
    return c.json({ data: await service.createArtifact(c.get('tenantId'), body, actorOf(c)) }, 201);
  });

  app.get('/artifacts', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await service.listArtifacts(c.get('tenantId'), page, c.req.query('installation_id'));
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });

  app.get('/artifacts/:id', async (c) => c.json({ data: await service.getArtifact(c.get('tenantId'), c.req.param('id')) }));

  app.post('/receipts', async (c) => {
    const body = createReceiptSchema.parse(await jsonBody(c));
    return c.json({ data: await service.createCompletionReceipt(c.get('tenantId'), body, actorOf(c)) }, 201);
  });

  app.get('/receipts', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await service.listCompletionReceipts(c.get('tenantId'), page, c.req.query('installation_id'));
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });

  app.get('/receipts/:id', async (c) => c.json({ data: await service.getCompletionReceipt(c.get('tenantId'), c.req.param('id')) }));

  app.post('/usage-events', async (c) => {
    const body = createUsageSchema.parse(await jsonBody(c));
    return c.json({ data: await service.recordUsage(c.get('tenantId'), body, actorOf(c)) }, 201);
  });

  app.get('/usage-events', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await service.listUsage(c.get('tenantId'), page, c.req.query('installation_id'));
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });

  app.get('/usage-summary', async (c) => c.json({ data: await service.usageSummary(c.get('tenantId'), c.req.query('installation_id')) }));
  app.get('/overview', async (c) => c.json({ data: await service.overview(c.get('tenantId')) }));

  return app;
}
