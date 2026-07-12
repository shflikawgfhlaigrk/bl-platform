import { Hono } from 'hono';
import type { Context } from 'hono';
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
import type { ShowStatus, ShowsDatabase } from './schema';
import {
  completeCloseout,
  createManifest,
  createShow,
  createTemplate,
  createVenue,
  finalizeManifest,
  getManifest,
  getOrCreateCloseout,
  getShow,
  getTemplate,
  getVenue,
  listDiscrepancies,
  listManifestLines,
  listManifests,
  listShows,
  listTemplates,
  listVenues,
  mapCloseout,
  mapDiscrepancy,
  mapManifestLine,
  mapShow,
  mapTemplate,
  mapVenue,
  markPacked,
  postDiscrepancies,
  recordReturns,
  reconcileManifest,
  resolveDiscrepancy,
  setShowLocation,
  showPnl,
  transitionShow,
  updateCloseout,
  updateShow,
  updateTemplate,
  updateVenue,
} from './service';

const SHOW_STATUSES = [
  'planned',
  'packing',
  'active',
  'returned',
  'closing',
  'closed',
  'canceled',
] as const;

const jsonObject = z.record(z.string(), z.unknown());
const intCents = z.number().int();

const venueSchema = z.object({
  name: z.string().trim().min(1).max(200),
  address: jsonObject.optional(),
  state: z.string().trim().length(2),
  notes: z.string().nullable().optional(),
});

const showSchema = z.object({
  venueId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  startsOn: z.string().min(1),
  endsOn: z.string().min(1),
  setupWindow: jsonObject.nullable().optional(),
  teardownWindow: jsonObject.nullable().optional(),
  boothAssignment: z.string().nullable().optional(),
  travel: jsonObject.nullable().optional(),
  boothFeeCents: intCents.nullable().optional(),
  travelCostCents: intCents.nullable().optional(),
  staffing: z.array(jsonObject).optional(),
  locationId: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const templateLineSchema = z.object({
  category: z.string().nullable().optional(),
  variationId: z.string().nullable().optional(),
  targetQty: z.number().nullable().optional(),
  displayMin: z.number().nullable().optional(),
});

const templateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  showType: z.string().nullable().optional(),
  season: z.string().nullable().optional(),
  lines: z.array(templateLineSchema).default([]),
});

const suggestInputsSchema = z.object({
  templateLines: z.array(templateLineSchema).default([]),
  variationStats: z
    .array(
      z.object({
        variationId: z.string().min(1),
        name: z.string(),
        unitsPerWeekVelocity: z.number(),
        categoryShowShare: z.number(),
        onHand: z.number(),
        reserved: z.number(),
        displayMin: z.number(),
        safetyStock: z.number(),
      }),
    )
    .default([]),
  vehicleCapacityUnits: z.number().nullable().optional(),
});

const createManifestSchema = z.object({
  templateId: z.string().nullable().optional(),
  suggestInputs: suggestInputsSchema,
});

const packSchema = z.object({
  lines: z.array(
    z.object({
      variationId: z.string().min(1),
      qty: z.number().int().min(0),
      reason: z.enum(['missing', 'substituted', 'deliberate']).optional(),
      substitutionOf: z.string().nullable().optional(),
    }),
  ),
});

const returnsSchema = z.object({
  lines: z.array(
    z.object({ variationId: z.string().min(1), qty: z.number().int().min(0) }),
  ),
});

const discrepancySchema = z.object({
  manifestId: z.string().nullable().optional(),
  entries: z.array(
    z.object({
      variationId: z.string().min(1),
      expectedQty: z.number().int(),
      returnedQty: z.number().int(),
    }),
  ),
});

const resolveSchema = z.object({
  resolution: z.enum(['found', 'damaged', 'shrink', 'sold_unrecorded']),
});

const closeoutPatchSchema = z.object({
  salesTotalCents: intCents.nullable().optional(),
  cashVarianceCents: intCents.nullable().optional(),
  refundsCents: intCents.nullable().optional(),
  laborCents: intCents.nullable().optional(),
  travelCents: intCents.nullable().optional(),
  boothFeeCents: intCents.nullable().optional(),
  damagesCount: z.number().int().nullable().optional(),
  review: z.record(z.string(), z.number().int()).optional(),
});

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw ApiError.badRequest('invalid JSON body');
  }
}

function actorOf(c: Context): string {
  const header = c.req.header('x-user-id');
  return header && header.trim() !== '' ? header.trim() : 'system';
}

export function showsRouter(deps: ModuleDeps<ShowsDatabase>): Hono<TenantEnv> {
  const { db, events } = deps;
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(db)));

  /* ---------------------------- Venues ---------------------------- */
  app.post('/venues', async (c) => {
    const body = venueSchema.parse(await jsonBody(c));
    const row = await createVenue(db, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: mapVenue(row) }, 201);
  });
  app.get('/venues', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await listVenues(db, c.get('tenantId'), { state: c.req.query('state'), page });
    return c.json({ data: rows.map(mapVenue), limit: page.limit, offset: page.offset });
  });
  app.get('/venues/:id', async (c) => {
    const row = await getVenue(db, c.get('tenantId'), c.req.param('id'));
    return c.json({ data: mapVenue(row) });
  });
  app.patch('/venues/:id', async (c) => {
    const body = venueSchema.partial().parse(await jsonBody(c));
    const row = await updateVenue(db, c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: mapVenue(row) });
  });

  /* ----------------------------- Shows ---------------------------- */
  app.post('/shows', async (c) => {
    const body = showSchema.parse(await jsonBody(c));
    const row = await createShow(db, events, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: mapShow(row) }, 201);
  });
  app.get('/shows', async (c) => {
    const page = parsePagination(c.req.query());
    const statusQ = c.req.query('status');
    const status = statusQ && (SHOW_STATUSES as readonly string[]).includes(statusQ)
      ? (statusQ as ShowStatus)
      : undefined;
    const rows = await listShows(db, c.get('tenantId'), {
      from: c.req.query('from'),
      state: c.req.query('state'),
      status,
      page,
    });
    return c.json({ data: rows.map(mapShow), limit: page.limit, offset: page.offset });
  });
  app.get('/shows/:id', async (c) => {
    const row = await getShow(db, c.get('tenantId'), c.req.param('id'));
    return c.json({ data: mapShow(row) });
  });
  app.patch('/shows/:id', async (c) => {
    const body = showSchema.partial().parse(await jsonBody(c));
    const row = await updateShow(db, c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: mapShow(row) });
  });
  app.post('/shows/:id/transition', async (c) => {
    const body = z.object({ to: z.enum(SHOW_STATUSES) }).parse(await jsonBody(c));
    const row = await transitionShow(db, events, c.get('tenantId'), actorOf(c), c.req.param('id'), body.to);
    return c.json({ data: mapShow(row) });
  });
  app.post('/shows/:id/location', async (c) => {
    const body = z.object({ locationId: z.string().min(1) }).parse(await jsonBody(c));
    const row = await setShowLocation(db, c.get('tenantId'), actorOf(c), c.req.param('id'), body.locationId);
    return c.json({ data: mapShow(row) });
  });

  /* --------------------------- Templates -------------------------- */
  app.post('/templates', async (c) => {
    const body = templateSchema.parse(await jsonBody(c));
    const row = await createTemplate(db, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: mapTemplate(row) }, 201);
  });
  app.get('/templates', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await listTemplates(db, c.get('tenantId'), page);
    return c.json({ data: rows.map(mapTemplate), limit: page.limit, offset: page.offset });
  });
  app.get('/templates/:id', async (c) => {
    const row = await getTemplate(db, c.get('tenantId'), c.req.param('id'));
    return c.json({ data: mapTemplate(row) });
  });
  app.patch('/templates/:id', async (c) => {
    const body = templateSchema.partial().parse(await jsonBody(c));
    const row = await updateTemplate(db, c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: mapTemplate(row) });
  });

  /* --------------------------- Manifests -------------------------- */
  app.post('/shows/:id/manifests', async (c) => {
    const body = createManifestSchema.parse(await jsonBody(c));
    const { manifest, lines } = await createManifest(db, c.get('tenantId'), actorOf(c), {
      showId: c.req.param('id'),
      templateId: body.templateId ?? null,
      suggestInputs: body.suggestInputs,
    });
    return c.json({ data: { manifest, lines: lines.map(mapManifestLine) } }, 201);
  });
  app.get('/shows/:id/manifests', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await listManifests(db, c.get('tenantId'), c.req.param('id'), page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });
  app.get('/manifests/:id', async (c) => {
    const manifest = await getManifest(db, c.get('tenantId'), c.req.param('id'));
    const lines = await listManifestLines(db, c.get('tenantId'), c.req.param('id'));
    return c.json({ data: { manifest, lines: lines.map(mapManifestLine) } });
  });
  app.post('/manifests/:id/finalize', async (c) => {
    const row = await finalizeManifest(db, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: row });
  });
  app.post('/manifests/:id/pack', async (c) => {
    const body = packSchema.parse(await jsonBody(c));
    const res = await markPacked(db, events, c.get('tenantId'), actorOf(c), c.req.param('id'), body.lines);
    return c.json({ data: { manifest: res.manifest, lines: res.lines.map(mapManifestLine) } });
  });
  app.post('/manifests/:id/returns', async (c) => {
    const body = returnsSchema.parse(await jsonBody(c));
    const res = await recordReturns(db, events, c.get('tenantId'), actorOf(c), c.req.param('id'), body.lines);
    return c.json({ data: { manifest: res.manifest, lines: res.lines.map(mapManifestLine) } });
  });
  app.post('/manifests/:id/reconcile', async (c) => {
    const row = await reconcileManifest(db, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: row });
  });

  /* ------------------------- Discrepancies ------------------------ */
  app.post('/shows/:id/discrepancies', async (c) => {
    const body = discrepancySchema.parse(await jsonBody(c));
    const rows = await postDiscrepancies(
      db,
      c.get('tenantId'),
      actorOf(c),
      c.req.param('id'),
      body.manifestId ?? null,
      body.entries,
    );
    return c.json({ data: rows.map(mapDiscrepancy) }, 201);
  });
  app.get('/shows/:id/discrepancies', async (c) => {
    const rows = await listDiscrepancies(db, c.get('tenantId'), c.req.param('id'), {
      unresolvedOnly: c.req.query('unresolved') === 'true',
    });
    return c.json({ data: rows.map(mapDiscrepancy) });
  });
  app.post('/discrepancies/:id/resolve', async (c) => {
    const body = resolveSchema.parse(await jsonBody(c));
    const row = await resolveDiscrepancy(db, c.get('tenantId'), actorOf(c), c.req.param('id'), body.resolution);
    return c.json({ data: mapDiscrepancy(row) });
  });

  /* ---------------------------- Closeout -------------------------- */
  app.get('/shows/:id/closeout', async (c) => {
    const row = await getOrCreateCloseout(db, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: mapCloseout(row) });
  });
  app.patch('/shows/:id/closeout', async (c) => {
    const body = closeoutPatchSchema.parse(await jsonBody(c));
    const row = await updateCloseout(db, c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: mapCloseout(row) });
  });
  app.post('/shows/:id/closeout/complete', async (c) => {
    const row = await completeCloseout(db, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: mapCloseout(row) });
  });
  app.get('/shows/:id/pnl', async (c) => {
    const pnl = await showPnl(db, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: pnl });
  });

  return app;
}
