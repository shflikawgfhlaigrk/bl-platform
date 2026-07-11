import { Hono } from 'hono';
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
import { getIndustryConfig, listIndustries } from './registry';
import type { IndustriesDatabase } from './schema';
import { applyIndustry, getAppliedIndustry, getTerminology } from './service';

const applyBodySchema = z
  .object({
    /** Optional audit actor (user id). Defaults to "system". */
    actor: z.string().min(1).optional(),
  })
  .strict();

/**
 * Industries REST API (mounted by apps/api at /api/industries):
 *
 *   GET  /                  list available industries (paginated summaries)
 *   GET  /applied           this tenant's applied industry state (404 if none)
 *   GET  /terminology       this tenant's terminology map (404 if none)
 *   GET  /:key              full config of one available industry
 *   POST /:key/apply        apply the industry's defaults to this tenant
 */
export function industriesRouter(deps: ModuleDeps<IndustriesDatabase>): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(deps.db)));

  app.get('/', (c) => {
    const { limit, offset } = parsePagination(c.req.query());
    const industries = listIndustries();
    return c.json({ data: industries.slice(offset, offset + limit), limit, offset });
  });

  app.get('/applied', async (c) => {
    const applied = await getAppliedIndustry(deps.db, c.get('tenantId'));
    if (!applied) {
      throw ApiError.notFound('no industry applied for this tenant');
    }
    return c.json({ data: applied });
  });

  app.get('/terminology', async (c) => {
    const terminology = await getTerminology(deps.db, c.get('tenantId'));
    if (!terminology) {
      throw ApiError.notFound('no industry applied for this tenant');
    }
    return c.json({ data: terminology });
  });

  app.get('/:key', (c) => {
    const key = c.req.param('key');
    const config = getIndustryConfig(key);
    if (!config) {
      throw ApiError.notFound(`unknown industry: ${key}`);
    }
    return c.json({ data: config });
  });

  app.post('/:key/apply', async (c) => {
    const text = await c.req.text();
    let body: z.infer<typeof applyBodySchema> = {};
    if (text.trim() !== '') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw ApiError.badRequest('request body must be valid JSON');
      }
      body = applyBodySchema.parse(parsed);
    }
    const applied = await applyIndustry(deps.db, c.get('tenantId'), c.req.param('key'), {
      events: deps.events,
      actor: body.actor,
      contracts: deps.contracts,
    });
    return c.json({ data: applied });
  });

  return app;
}
