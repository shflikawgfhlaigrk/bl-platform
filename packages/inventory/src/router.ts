import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  ApiError,
  asCoreDb,
  errorHandler,
  nowIso,
  parsePagination,
  tenantMiddleware,
  type ModuleDeps,
  type TenantEnv,
} from '@blacklabel/core';
import type { InventoryDatabase, MovementReason } from './schema';
import * as svc from './service';

const LOCATION_KINDS = [
  'warehouse',
  'trailer',
  'show',
  'fulfillment_staging',
  'reserved',
  'damaged',
  'quarantine',
  'custom',
] as const;
const OVERSELL = ['deny', 'allow_flag'] as const;
const REASONS: readonly MovementReason[] = [
  'received',
  'sold',
  'returned',
  'counted',
  'adjusted',
  'transfer_out',
  'transfer_in',
  'reserved',
  'released',
  'damaged',
  'shrink',
  'kit_assembled',
  'kit_disassembled',
  'correction',
];

const createLocationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(LOCATION_KINDS),
  showId: z.string().nullable().optional(),
  oversellPolicy: z.enum(OVERSELL).optional(),
});

const updateLocationSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  kind: z.enum(LOCATION_KINDS).optional(),
  show_id: z.string().nullable().optional(),
  oversell_policy: z.enum(OVERSELL).optional(),
});

const movementSchema = z.object({
  variationId: z.string().min(1),
  locationId: z.string().min(1),
  delta: z.number().int(),
  reason: z.enum(REASONS as unknown as [string, ...string[]]),
  refType: z.string().nullable().optional(),
  refId: z.string().nullable().optional(),
  idempotencyKey: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});

const correctionSchema = z.object({
  delta: z.number().int(),
  note: z.string().nullable().optional(),
});

const reserveSchema = z.object({
  variationId: z.string().min(1),
  locationId: z.string().min(1),
  qty: z.number().int().positive(),
  refType: z.string().nullable().optional(),
  refId: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
});

const sellSchema = z.object({
  orderId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  lines: z
    .array(
      z.object({
        variationId: z.string().min(1),
        qty: z.number().int().positive(),
        locationId: z.string().min(1),
      }),
    )
    .min(1),
});

const openSessionSchema = z.object({
  locationId: z.string().min(1),
  kind: z.enum(['full', 'cycle']),
  blind: z.boolean().optional(),
  assignedTo: z.string().nullable().optional(),
  recountThreshold: z.number().int().min(0).optional(),
});

const addLineSchema = z.object({ variationId: z.string().min(1) });
const linePatchSchema = z.object({
  countedQty: z.number().int().optional(),
  recountQty: z.number().int().optional(),
  approved: z.boolean().optional(),
});
const closeSessionSchema = z.object({ signedBy: z.string().min(1) });
const sessionStatusSchema = z.object({ status: z.enum(['paused', 'open', 'review', 'abandoned']) });

const createTransferSchema = z.object({
  fromLocationId: z.string().min(1),
  toLocationId: z.string().min(1),
  lines: z.array(z.object({ variationId: z.string().min(1), qtySent: z.number().int().positive() })).min(1),
});
const receiveTransferSchema = z.object({
  receipts: z.array(z.object({ lineId: z.string().min(1), qtyReceived: z.number().int().min(0) })).min(1),
});
const closeTransferSchema = z.object({ reason: z.string().nullable().optional() });

const reorderSchema = z.object({
  variationId: z.string().min(1),
  locationId: z.string().nullable().optional(),
  reorderPoint: z.number().int().min(0),
  safetyStock: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
});
const reorderPatchSchema = z.object({
  reorderPoint: z.number().int().min(0).optional(),
  safetyStock: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
});

const kitSchema = z.object({
  kitVariationId: z.string().min(1),
  qty: z.number().int().positive(),
  locationId: z.string().min(1),
  components: z.array(z.object({ variationId: z.string().min(1), qtyPer: z.number().int().positive() })).min(1),
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

export function inventoryRouter(deps: ModuleDeps<InventoryDatabase>): Hono<TenantEnv> {
  const { db, events } = deps;
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(db)));

  const t = (c: Context) => c.get('tenantId');

  /* ---------------- Locations ---------------- */
  app.post('/locations', async (c) => {
    const body = createLocationSchema.parse(await jsonBody(c));
    const row = await svc.createLocation(db, t(c), actorOf(c), body);
    return c.json({ data: row }, 201);
  });
  app.get('/locations', async (c) => {
    const includeArchived = c.req.query('includeArchived') === 'true';
    const rows = await svc.listLocations(db, t(c), { includeArchived });
    return c.json({ data: rows });
  });
  app.get('/locations/:id', async (c) => {
    const row = await svc.getLocation(db, t(c), c.req.param('id'));
    return c.json({ data: row });
  });
  app.patch('/locations/:id', async (c) => {
    const body = updateLocationSchema.parse(await jsonBody(c));
    const row = await svc.updateLocation(db, t(c), actorOf(c), c.req.param('id'), body);
    return c.json({ data: row });
  });
  app.post('/locations/:id/archive', async (c) => {
    const row = await svc.archiveLocation(db, t(c), actorOf(c), c.req.param('id'));
    return c.json({ data: row });
  });

  /* ---------------- Movements (single write path) ---------------- */
  app.post('/movements', async (c) => {
    const body = movementSchema.parse(await jsonBody(c));
    const result = await svc.applyMovement(db, events, t(c), actorOf(c), {
      ...body,
      reason: body.reason as MovementReason,
    });
    return c.json({ data: result }, 201);
  });
  app.get('/movements', async (c) => {
    const page = parsePagination(c.req.query());
    const q = c.req.query();
    const rows = await svc.listMovements(
      db,
      t(c),
      {
        variationId: q.variationId,
        locationId: q.locationId,
        reason: q.reason as MovementReason | undefined,
      },
      page,
    );
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });
  app.post('/movements/:id/correct', async (c) => {
    const body = correctionSchema.parse(await jsonBody(c));
    const result = await svc.correctMovement(db, events, t(c), actorOf(c), c.req.param('id'), body.delta, body.note);
    return c.json({ data: result }, 201);
  });

  /* ---------------- Stock ---------------- */
  app.get('/stock', async (c) => {
    const q = c.req.query();
    const rows = await svc.getStock(db, t(c), { variationId: q.variationId, locationId: q.locationId });
    return c.json({ data: rows });
  });

  /* ---------------- Reservations ---------------- */
  app.post('/reservations', async (c) => {
    const body = reserveSchema.parse(await jsonBody(c));
    const result = await svc.reserve(db, events, t(c), actorOf(c), body);
    return c.json({ data: result }, 201);
  });
  app.get('/reservations', async (c) => {
    const q = c.req.query();
    const rows = await svc.listReservations(db, t(c), {
      status: q.status as never,
      variationId: q.variationId,
    });
    return c.json({ data: rows });
  });
  app.post('/reservations/expire', async (c) => {
    const now = c.req.query('now') ?? nowIso();
    const result = await svc.expireReservations(db, events, t(c), actorOf(c), now);
    return c.json({ data: result });
  });
  app.post('/reservations/:id/release', async (c) => {
    const result = await svc.releaseReservation(db, events, t(c), actorOf(c), c.req.param('id'));
    return c.json({ data: result });
  });

  /* ---------------- Sell for order ---------------- */
  app.post('/sell-for-order', async (c) => {
    const body = sellSchema.parse(await jsonBody(c));
    const result = await svc.sellForOrder(db, events, t(c), actorOf(c), body);
    return c.json({ data: result }, 201);
  });

  /* ---------------- Count sessions ---------------- */
  app.post('/count-sessions', async (c) => {
    const body = openSessionSchema.parse(await jsonBody(c));
    const row = await svc.openCountSession(db, t(c), actorOf(c), body);
    return c.json({ data: row }, 201);
  });
  app.get('/count-sessions/:id', async (c) => {
    const row = await svc.getCountSession(db, t(c), c.req.param('id'));
    return c.json({ data: row });
  });
  app.get('/count-sessions/:id/lines', async (c) => {
    const rows = await svc.listCountLines(db, t(c), c.req.param('id'));
    return c.json({ data: rows });
  });
  app.post('/count-sessions/:id/lines', async (c) => {
    const body = addLineSchema.parse(await jsonBody(c));
    const row = await svc.addCountLine(db, t(c), actorOf(c), c.req.param('id'), body.variationId);
    return c.json({ data: row }, 201);
  });
  app.patch('/count-sessions/:id/lines/:lineId', async (c) => {
    const body = linePatchSchema.parse(await jsonBody(c));
    const sessionId = c.req.param('id');
    const lineId = c.req.param('lineId');
    let row;
    if (body.countedQty !== undefined) {
      row = await svc.recordCount(db, t(c), actorOf(c), sessionId, lineId, body.countedQty);
    }
    if (body.recountQty !== undefined) {
      row = await svc.recordRecount(db, t(c), actorOf(c), sessionId, lineId, body.recountQty);
    }
    if (body.approved === true) {
      row = await svc.approveCountLine(db, t(c), actorOf(c), sessionId, lineId);
    }
    if (!row) throw ApiError.badRequest('no line change provided');
    return c.json({ data: row });
  });
  app.post('/count-sessions/:id/status', async (c) => {
    const body = sessionStatusSchema.parse(await jsonBody(c));
    const row = await svc.setCountSessionStatus(db, t(c), actorOf(c), c.req.param('id'), body.status);
    return c.json({ data: row });
  });
  app.post('/count-sessions/:id/close', async (c) => {
    const body = closeSessionSchema.parse(await jsonBody(c));
    const result = await svc.closeCountSession(db, events, t(c), actorOf(c), c.req.param('id'), body.signedBy);
    return c.json({ data: result });
  });

  /* ---------------- Transfers ---------------- */
  app.post('/transfers', async (c) => {
    const body = createTransferSchema.parse(await jsonBody(c));
    const result = await svc.createTransfer(db, t(c), actorOf(c), body.fromLocationId, body.toLocationId, body.lines);
    return c.json({ data: result }, 201);
  });
  app.get('/transfers/:id', async (c) => {
    const result = await svc.getTransfer(db, t(c), c.req.param('id'));
    return c.json({ data: result });
  });
  app.post('/transfers/:id/ship', async (c) => {
    const row = await svc.shipTransfer(db, events, t(c), actorOf(c), c.req.param('id'));
    return c.json({ data: row });
  });
  app.post('/transfers/:id/receive', async (c) => {
    const body = receiveTransferSchema.parse(await jsonBody(c));
    const row = await svc.receiveTransfer(db, events, t(c), actorOf(c), c.req.param('id'), body.receipts);
    return c.json({ data: row });
  });
  app.post('/transfers/:id/close', async (c) => {
    const body = closeTransferSchema.parse(await jsonBody(c));
    const result = await svc.closeTransfer(db, events, t(c), actorOf(c), c.req.param('id'), body.reason);
    return c.json({ data: result });
  });

  /* ---------------- Reorder points ---------------- */
  app.post('/reorder-points', async (c) => {
    const body = reorderSchema.parse(await jsonBody(c));
    const row = await svc.createReorderPoint(db, t(c), actorOf(c), body);
    return c.json({ data: row }, 201);
  });
  app.get('/reorder-points', async (c) => {
    const rows = await svc.listReorderPoints(db, t(c), { variationId: c.req.query('variationId') });
    return c.json({ data: rows });
  });
  app.patch('/reorder-points/:id', async (c) => {
    const body = reorderPatchSchema.parse(await jsonBody(c));
    const row = await svc.updateReorderPoint(db, t(c), actorOf(c), c.req.param('id'), body);
    return c.json({ data: row });
  });
  app.delete('/reorder-points/:id', async (c) => {
    await svc.deleteReorderPoint(db, t(c), actorOf(c), c.req.param('id'));
    return c.json({ data: { ok: true } });
  });

  /* ---------------- Kits ---------------- */
  app.post('/kits/assemble', async (c) => {
    const body = kitSchema.parse(await jsonBody(c));
    const result = await svc.assembleKit(db, events, t(c), actorOf(c), body.kitVariationId, body.components, body.qty, body.locationId);
    return c.json({ data: result }, 201);
  });
  app.post('/kits/disassemble', async (c) => {
    const body = kitSchema.parse(await jsonBody(c));
    const result = await svc.disassembleKit(db, events, t(c), actorOf(c), body.kitVariationId, body.components, body.qty, body.locationId);
    return c.json({ data: result }, 201);
  });

  /* ---------------- Analytics ---------------- */
  app.get('/analytics/aging', async (c) => {
    const rows = await svc.stockAging(db, t(c));
    return c.json({ data: rows });
  });
  app.get('/analytics/velocity', async (c) => {
    const variationId = c.req.query('variationId');
    if (!variationId) throw ApiError.badRequest('variationId is required');
    const windowDays = Number(c.req.query('windowDays') ?? 28);
    const result = await svc.velocity(db, t(c), variationId, windowDays);
    return c.json({ data: result });
  });
  app.get('/analytics/days-of-supply', async (c) => {
    const variationId = c.req.query('variationId');
    if (!variationId) throw ApiError.badRequest('variationId is required');
    const windowDays = Number(c.req.query('windowDays') ?? 28);
    const result = await svc.daysOfSupply(db, t(c), variationId, windowDays);
    return c.json({ data: result });
  });
  app.get('/analytics/stockouts', async (c) => {
    const rows = await svc.stockoutList(db, t(c));
    return c.json({ data: rows });
  });
  app.get('/analytics/shrink', async (c) => {
    const q = c.req.query();
    const result = await svc.shrinkSummary(db, t(c), { from: q.from, to: q.to });
    return c.json({ data: result });
  });

  /* ---------------- Conservation ---------------- */
  app.get('/conservation', async (c) => {
    const report = await svc.verifyConservation(db, t(c));
    return c.json({ data: report });
  });

  return app;
}
