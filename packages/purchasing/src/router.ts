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
import type { PurchasingDatabase, PurchaseOrderStatus, SuggestionStatus } from './schema';
import {
  createReorderPolicy,
  getReorderPolicy,
  listReorderPolicies,
  updateReorderPolicy,
  deleteReorderPolicy,
  runSuggestion,
  getSuggestion,
  listSuggestions,
  acceptSuggestion,
  dismissSuggestion,
  createPurchaseOrder,
  addPoLine,
  getPurchaseOrder,
  listPurchaseOrders,
  listPoLines,
  listPoEvents,
  getLatestPoDocument,
  submitPurchaseOrder,
  approvePurchaseOrder,
  rejectPurchaseOrder,
  sendPurchaseOrder,
  acknowledgePurchaseOrder,
  cancelPurchaseOrder,
  closePurchaseOrder,
  createReceipt,
  listDiscrepancies,
  createVendorBill,
  getVendorBill,
  listVendorBills,
  listBillExceptions,
  matchVendorBill,
} from './service';

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

const policySchema = z.object({
  variationId: z.string().min(1),
  vendorId: z.string().min(1),
  reorderPoint: z.number().int(),
  safetyStock: z.number().int(),
  targetDaysOfSupply: z.number().int().nullable().optional(),
  orderMultiple: z.number().int().min(1),
  minQty: z.number().int().min(0),
  enabled: z.boolean().optional(),
  ownerOverrideQty: z.number().int().nullable().optional(),
});

const suggestInputsSchema = z.object({
  onHand: z.number(),
  reserved: z.number(),
  inbound: z.number(),
  unitsPerWeekVelocity: z.number(),
  seasonalFactor: z.number(),
  leadTimeDays: z.number(),
  casePackQty: z.number(),
  minOrderQty: z.number(),
  safetyStock: z.number(),
  upcomingShowDemand: z.number(),
  ownerOverrideQty: z.number().nullable().optional(),
});

const runSuggestionSchema = z.object({
  variationId: z.string().min(1),
  vendorId: z.string().min(1),
  inputs: suggestInputsSchema,
});

const poLineSchema = z.object({
  variationId: z.string().min(1),
  vendorSku: z.string().nullable().optional(),
  qtyOrdered: z.number().int().min(1),
  unitCostCents: z.number().int().min(0),
});

const createPoSchema = z.object({
  vendorId: z.string().min(1),
  shipTo: z.string().optional(),
  freightCents: z.number().int().min(0).optional(),
  expectedAt: z.string().nullable().optional(),
  lines: z.array(poLineSchema).optional(),
});

const billSchema = z.object({
  vendorId: z.string().min(1),
  billNumber: z.string().min(1),
  amountCents: z.number().int(),
  lines: z.array(z.object({
    variationId: z.string().min(1),
    qty: z.number().int(),
    unitCostCents: z.number().int(),
  })),
});

const receiveSchema = z.object({
  note: z.string().optional(),
  lines: z.array(z.object({
    poLineId: z.string().min(1),
    qtyReceived: z.number().int().min(0),
    condition: z.enum(['ok', 'damaged', 'wrong_item']).optional(),
    final: z.boolean().optional(),
  })).min(1),
});

export function purchasingRouter(deps: ModuleDeps<PurchasingDatabase>): Hono<TenantEnv> {
  const { db, events } = deps;
  const app = new Hono<TenantEnv>();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(db)));

  /* ---- reorder policies ---- */
  app.post('/reorder-policies', async (c) => {
    const body = policySchema.parse(await jsonBody(c));
    const row = await createReorderPolicy(db, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: row }, 201);
  });
  app.get('/reorder-policies', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await listReorderPolicies(db, c.get('tenantId'), page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });
  app.get('/reorder-policies/:id', async (c) => {
    const row = await getReorderPolicy(db, c.get('tenantId'), c.req.param('id'));
    if (!row) throw ApiError.notFound('reorder policy not found');
    return c.json({ data: row });
  });
  app.patch('/reorder-policies/:id', async (c) => {
    const body = policySchema.partial().parse(await jsonBody(c));
    const row = await updateReorderPolicy(db, c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: row });
  });
  app.delete('/reorder-policies/:id', async (c) => {
    await deleteReorderPolicy(db, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: { deleted: true } });
  });

  /* ---- suggestions ---- */
  app.post('/suggestions/run', async (c) => {
    const body = runSuggestionSchema.parse(await jsonBody(c));
    const row = await runSuggestion(db, c.get('tenantId'), actorOf(c), body.variationId, body.vendorId, body.inputs);
    return c.json({ data: row }, 201);
  });
  app.get('/suggestions', async (c) => {
    const page = parsePagination(c.req.query());
    const status = c.req.query('status') as SuggestionStatus | undefined;
    const rows = await listSuggestions(db, c.get('tenantId'), page, status);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });
  app.get('/suggestions/:id', async (c) => {
    const row = await getSuggestion(db, c.get('tenantId'), c.req.param('id'));
    if (!row) throw ApiError.notFound('suggestion not found');
    return c.json({ data: row });
  });
  app.post('/suggestions/:id/accept', async (c) => {
    const body = z.object({
      unitCostCents: z.number().int().min(0),
      vendorSku: z.string().nullable().optional(),
      shipTo: z.string().optional(),
    }).parse(await jsonBody(c));
    const result = await acceptSuggestion(db, c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: result }, 201);
  });
  app.post('/suggestions/:id/dismiss', async (c) => {
    const row = await dismissSuggestion(db, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: row });
  });

  /* ---- purchase orders ---- */
  app.post('/purchase-orders', async (c) => {
    const body = createPoSchema.parse(await jsonBody(c));
    const row = await createPurchaseOrder(db, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: row }, 201);
  });
  app.get('/purchase-orders', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await listPurchaseOrders(db, c.get('tenantId'), page, {
      vendorId: c.req.query('vendorId'),
      status: c.req.query('status') as PurchaseOrderStatus | undefined,
    });
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });
  app.get('/purchase-orders/:id', async (c) => {
    const po = await getPurchaseOrder(db, c.get('tenantId'), c.req.param('id'));
    if (!po) throw ApiError.notFound('purchase order not found');
    const lines = await listPoLines(db, c.get('tenantId'), po.id);
    return c.json({ data: { ...po, lines } });
  });
  app.post('/purchase-orders/:id/lines', async (c) => {
    const body = poLineSchema.parse(await jsonBody(c));
    const row = await addPoLine(db, c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: row }, 201);
  });
  app.get('/purchase-orders/:id/events', async (c) => {
    const rows = await listPoEvents(db, c.get('tenantId'), c.req.param('id'));
    return c.json({ data: rows });
  });
  app.get('/purchase-orders/:id/document', async (c) => {
    const doc = await getLatestPoDocument(db, c.get('tenantId'), c.req.param('id'));
    if (!doc) throw ApiError.notFound('no document rendered for this PO');
    return c.json({ data: doc });
  });
  app.post('/purchase-orders/:id/submit', async (c) => {
    const body = z.object({ approvalPolicy: z.unknown().optional() }).parse(await jsonBody(c).catch(() => ({})));
    const po = await submitPurchaseOrder(db, c.get('tenantId'), actorOf(c), c.req.param('id'), body.approvalPolicy);
    return c.json({ data: po });
  });
  app.post('/purchase-orders/:id/approve', async (c) => {
    const po = await approvePurchaseOrder(db, events, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: po });
  });
  app.post('/purchase-orders/:id/reject', async (c) => {
    const body = z.object({ reason: z.string().min(1) }).parse(await jsonBody(c));
    const po = await rejectPurchaseOrder(db, c.get('tenantId'), actorOf(c), c.req.param('id'), body.reason);
    return c.json({ data: po });
  });
  app.post('/purchase-orders/:id/send', async (c) => {
    const body = z.object({ paymentTerms: z.string().nullable().optional(), note: z.string().optional() })
      .parse(await jsonBody(c).catch(() => ({})));
    const result = await sendPurchaseOrder(db, c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: result });
  });
  app.post('/purchase-orders/:id/acknowledge', async (c) => {
    const body = z.object({ expectedAt: z.string().nullable().optional() }).parse(await jsonBody(c).catch(() => ({})));
    const po = await acknowledgePurchaseOrder(db, c.get('tenantId'), actorOf(c), c.req.param('id'), body.expectedAt);
    return c.json({ data: po });
  });
  app.post('/purchase-orders/:id/cancel', async (c) => {
    const body = z.object({ reason: z.string().optional() }).parse(await jsonBody(c).catch(() => ({})));
    const po = await cancelPurchaseOrder(db, c.get('tenantId'), actorOf(c), c.req.param('id'), body.reason);
    return c.json({ data: po });
  });
  app.post('/purchase-orders/:id/close', async (c) => {
    const po = await closePurchaseOrder(db, c.get('tenantId'), actorOf(c), c.req.param('id'));
    return c.json({ data: po });
  });

  /* ---- receiving ---- */
  app.post('/purchase-orders/:id/receipts', async (c) => {
    const body = receiveSchema.parse(await jsonBody(c));
    const result = await createReceipt(db, events, c.get('tenantId'), actorOf(c), c.req.param('id'), body);
    return c.json({ data: result }, 201);
  });
  app.get('/discrepancies', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await listDiscrepancies(db, c.get('tenantId'), page, c.req.query('poId'));
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });

  /* ---- vendor bills + match ---- */
  app.post('/vendor-bills', async (c) => {
    const body = billSchema.parse(await jsonBody(c));
    const row = await createVendorBill(db, c.get('tenantId'), actorOf(c), body);
    return c.json({ data: row }, 201);
  });
  app.get('/vendor-bills', async (c) => {
    const page = parsePagination(c.req.query());
    const rows = await listVendorBills(db, c.get('tenantId'), page);
    return c.json({ data: rows, limit: page.limit, offset: page.offset });
  });
  app.get('/vendor-bills/:id', async (c) => {
    const row = await getVendorBill(db, c.get('tenantId'), c.req.param('id'));
    if (!row) throw ApiError.notFound('vendor bill not found');
    const exceptions = await listBillExceptions(db, c.get('tenantId'), row.id);
    return c.json({ data: { ...row, exceptions } });
  });
  app.post('/vendor-bills/:id/match', async (c) => {
    const body = z.object({
      purchaseOrderId: z.string().min(1),
      receiptId: z.string().nullable().optional(),
    }).parse(await jsonBody(c));
    const result = await matchVendorBill(
      db, c.get('tenantId'), actorOf(c), c.req.param('id'), body.purchaseOrderId, body.receiptId ?? null,
    );
    return c.json({ data: result });
  });

  return app;
}
