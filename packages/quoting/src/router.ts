import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  ApiError,
  asCoreDb,
  errorHandler,
  getTenant,
  parseFilters,
  parsePagination,
  parseSort,
  tenantMiddleware,
  nowIso,
  type ModuleDeps,
  type TenantEnv,
} from '@blacklabel/core';
import { HtmlQuoteDocumentAdapter, type QuoteDocumentProvider } from './pdf';
import { LINE_RULE_ACTION_TYPES, QUOTE_RULE_ACTION_TYPES } from './rules';
import type { QuotingDatabase } from './schema';
import * as svc from './service';

/* ------------------------------------------------------------------ *
 * zod request schemas
 * ------------------------------------------------------------------ */

const bpsSchema = z.number().int().min(0).max(10000);
const centsSchema = z.number().int().min(0).max(Math.floor(Number.MAX_SAFE_INTEGER / 10000));
const quantitySchema = z.number().finite().min(0);

const lineInputSchema = z.object({
  description: z.string().min(1),
  quantity: quantitySchema,
  unitPriceCents: centsSchema,
  unitCostCents: centsSchema.optional(),
  discountBps: bpsSchema.optional(),
  discountFixedCents: centsSchema.optional(),
});

const createQuoteSchema = z.object({
  customerId: z.string().min(1),
  title: z.string().min(1),
  notes: z.string().optional(),
  validUntil: z.string().datetime().optional(),
  discountBps: bpsSchema.optional(),
  discountFixedCents: centsSchema.optional(),
  taxBps: bpsSchema.optional(),
  lines: z.array(lineInputSchema).optional(),
  templateId: z.string().min(1).optional(),
});

const updateQuoteSchema = z.object({
  customerId: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  notes: z.string().nullable().optional(),
  validUntil: z.string().datetime().nullable().optional(),
  discountBps: bpsSchema.nullable().optional(),
  discountFixedCents: centsSchema.nullable().optional(),
  taxBps: bpsSchema.nullable().optional(),
});

const updateLineSchema = z.object({
  description: z.string().min(1).optional(),
  quantity: quantitySchema.optional(),
  unitPriceCents: centsSchema.optional(),
  unitCostCents: centsSchema.optional(),
  discountBps: bpsSchema.nullable().optional(),
  discountFixedCents: centsSchema.nullable().optional(),
});

const ruleConditionSchema = z.object({
  field: z.string().min(1),
  op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in']),
  value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number(), z.boolean()]))]),
});

const pricingRuleSchema = z
  .object({
    name: z.string().min(1),
    scope: z.enum(['line', 'quote']),
    conditions: z.array(ruleConditionSchema),
    action: z.object({ type: z.string().min(1), amount: z.number().int().min(-Math.floor(Number.MAX_SAFE_INTEGER / 10000)).max(Math.floor(Number.MAX_SAFE_INTEGER / 10000)) }),
    active: z.boolean().optional(),
    priority: z.number().int().optional(),
  })
  .superRefine((rule, ctx) => {
    const allowed: readonly string[] =
      rule.scope === 'line' ? LINE_RULE_ACTION_TYPES : QUOTE_RULE_ACTION_TYPES;
    if (!allowed.includes(rule.action.type)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['action', 'type'],
        message: `action type for scope "${rule.scope}" must be one of: ${allowed.join(', ')}`,
      });
    }
    if (
      (rule.action.type === 'percent_discount' || rule.action.type === 'fixed_discount') &&
      rule.action.amount < 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['action', 'amount'],
        message: 'quote-scope discount amounts must be >= 0',
      });
    }
  });

const templateLineItemSchema = z.object({
  description: z.string().min(1),
  quantity: quantitySchema,
  unitPriceCents: centsSchema,
  unitCostCents: centsSchema.optional(),
  discountBps: bpsSchema.optional(),
  discountFixedCents: centsSchema.optional(),
});

const templateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  lineItems: z.array(templateLineItemSchema).optional(),
  childTemplateIds: z.array(z.string().min(1)).optional(),
  active: z.boolean().optional(),
});

const discountSchema = z.object({
  name: z.string().min(1),
  bps: bpsSchema.optional(),
  fixedCents: centsSchema.optional(),
  active: z.boolean().optional(),
});

const taxSchema = z.object({
  name: z.string().min(1),
  rateBps: bpsSchema,
  active: z.boolean().optional(),
});

const approveSchema = z.object({
  signerName: z.string().min(1),
  signerIp: z.string().optional(),
  note: z.string().optional(),
  expectedPayloadHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

const declineSchema = z.object({
  signerName: z.string().optional(),
  signerIp: z.string().optional(),
  note: z.string().optional(),
  expectedPayloadHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

const viewSchema = z.object({ signerIp: z.string().optional() });

const attachmentSchema = z.object({ fileId: z.string().min(1) });

const applyTemplateSchema = z.object({ templateId: z.string().min(1) });
const applyDiscountSchema = z.object({ discountId: z.string().min(1) });
const applyTaxSchema = z.object({ taxId: z.string().min(1) });

/* ------------------------------------------------------------------ *
 * Router factory
 * ------------------------------------------------------------------ */

export interface QuotingRouterOptions {
  /** Defaults to the HTML print-ready stub adapter. */
  documentProvider?: QuoteDocumentProvider;
  /** Optional composition-owned atomic quote -> CRM job -> billing invoice operation. */
  convert?: (tenantId: string, actor: string, quoteId: string) => Promise<unknown>;
}

export function quotingRouter(
  deps: ModuleDeps<QuotingDatabase>,
  options: QuotingRouterOptions = {},
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  const documentProvider = options.documentProvider ?? new HtmlQuoteDocumentAdapter();
  app.onError(errorHandler);
  app.use('*', tenantMiddleware(asCoreDb(deps.db)));

  const ctxOf = (c: Context<TenantEnv>): svc.QuotingCtx => ({
    db: deps.db,
    events: deps.events,
    contracts: deps.contracts,
    tenantId: c.get('tenantId'),
    actor: c.req.header('x-user-id') ?? 'system',
  });

  /* ---------------- quotes ---------------- */

  app.post('/quotes', async (c) => {
    const input = createQuoteSchema.parse(await c.req.json());
    const result = await svc.createQuote(ctxOf(c), input);
    return c.json({ data: result }, 201);
  });

  app.get('/quotes', async (c) => {
    const query = c.req.query();
    const page = parsePagination(query);
    const sort = parseSort(query, ['created_at', 'updated_at', 'total_cents', 'status', 'customer_id'], {
      column: 'created_at',
      direction: 'asc',
    });
    const filters = parseFilters(query, ['status', 'customer_id']);
    const data = await svc.listQuotes(ctxOf(c), { page, sort, filters });
    return c.json({ data, limit: page.limit, offset: page.offset });
  });

  app.get('/quotes/:id', async (c) => {
    const data = await svc.getQuote(ctxOf(c), c.req.param('id'));
    return c.json({ data });
  });

  app.patch('/quotes/:id', async (c) => {
    const patch = updateQuoteSchema.parse(await c.req.json());
    const data = await svc.updateQuote(ctxOf(c), c.req.param('id'), patch);
    return c.json({ data });
  });

  app.delete('/quotes/:id', async (c) => {
    await svc.deleteQuote(ctxOf(c), c.req.param('id'));
    return c.json({ data: { deleted: true } });
  });

  /* ---------------- lines ---------------- */

  app.post('/quotes/:id/lines', async (c) => {
    const input = lineInputSchema.parse(await c.req.json());
    const data = await svc.addQuoteLine(ctxOf(c), c.req.param('id'), input);
    return c.json({ data }, 201);
  });

  app.patch('/quotes/:id/lines/:lineId', async (c) => {
    const patch = updateLineSchema.parse(await c.req.json());
    const data = await svc.updateQuoteLine(ctxOf(c), c.req.param('id'), c.req.param('lineId'), patch);
    return c.json({ data });
  });

  app.delete('/quotes/:id/lines/:lineId', async (c) => {
    const data = await svc.deleteQuoteLine(ctxOf(c), c.req.param('id'), c.req.param('lineId'));
    return c.json({ data });
  });

  /* ---------------- template/discount/tax application ---------------- */

  app.post('/quotes/:id/apply-template', async (c) => {
    const { templateId } = applyTemplateSchema.parse(await c.req.json());
    const data = await svc.applyTemplateToQuote(ctxOf(c), c.req.param('id'), templateId);
    return c.json({ data });
  });

  app.post('/quotes/:id/apply-discount', async (c) => {
    const { discountId } = applyDiscountSchema.parse(await c.req.json());
    const data = await svc.applyDiscountToQuote(ctxOf(c), c.req.param('id'), discountId);
    return c.json({ data });
  });

  app.post('/quotes/:id/apply-tax', async (c) => {
    const { taxId } = applyTaxSchema.parse(await c.req.json());
    const data = await svc.applyTaxToQuote(ctxOf(c), c.req.param('id'), taxId);
    return c.json({ data });
  });

  /* ---------------- attachments ---------------- */

  app.post('/quotes/:id/attachments', async (c) => {
    const { fileId } = attachmentSchema.parse(await c.req.json());
    const data = await svc.addAttachment(ctxOf(c), c.req.param('id'), fileId);
    return c.json({ data }, 201);
  });

  app.delete('/quotes/:id/attachments/:fileId', async (c) => {
    const data = await svc.removeAttachment(ctxOf(c), c.req.param('id'), c.req.param('fileId'));
    return c.json({ data });
  });

  /* ---------------- approval flow ---------------- */

  app.post('/quotes/:id/revise', async (c) => {
    const data = await svc.reviseQuote(ctxOf(c), c.req.param('id'));
    return c.json({ data }, 201);
  });

  app.post('/quotes/:id/send', async (c) => {
    const data = await svc.sendQuote(ctxOf(c), c.req.param('id'));
    return c.json({ data });
  });

  app.post('/quotes/:id/view', async (c) => {
    const body = viewSchema.parse(await c.req.json().catch(() => ({})));
    const data = await svc.markQuoteViewed(ctxOf(c), c.req.param('id'), body);
    return c.json({ data });
  });

  app.post('/quotes/:id/approve', async (c) => {
    const body = approveSchema.parse(await c.req.json());
    const data = await svc.approveQuote(ctxOf(c), c.req.param('id'), body);
    return c.json({ data });
  });

  app.post('/quotes/:id/decline', async (c) => {
    const body = declineSchema.parse(await c.req.json().catch(() => ({})));
    const data = await svc.declineQuote(ctxOf(c), c.req.param('id'), body);
    return c.json({ data });
  });

  app.post('/quotes/:id/expire', async (c) => {
    const data = await svc.expireQuoteManually(ctxOf(c), c.req.param('id'));
    return c.json({ data });
  });

  /* ---------------- convert to job ---------------- */

  app.get('/quotes/:id/conversion', async (c) => {
    const ctx = ctxOf(c); await svc.getQuote(ctx, c.req.param('id'));
    const conversion = await svc.getQuoteConversion(ctx, c.req.param('id'));
    if (!conversion) throw ApiError.notFound('Quote conversion not found.');
    return c.json({ data: conversion });
  });

  app.post('/quotes/:id/convert', async (c) => {
    const ctx = ctxOf(c);
    const data = options.convert ? await options.convert(ctx.tenantId, ctx.actor, c.req.param('id')) : await svc.convertQuote(ctx, c.req.param('id'));
    return c.json({ data });
  });

  /* ---------------- printable document (PDF provider) ---------------- */

  app.get('/quotes/:id/document', async (c) => {
    const ctx = ctxOf(c);
    const { quote, lines } = await svc.getQuote(ctx, c.req.param('id'));
    const tenant = await getTenant(asCoreDb(deps.db), ctx.tenantId);
    const rendered = await documentProvider.render({
      quote,
      lines,
      tenantName: tenant?.name ?? ctx.tenantId,
      generatedAt: nowIso(),
    });
    const body =
      typeof rendered.content === 'string'
        ? rendered.content
        : (rendered.content.slice().buffer as ArrayBuffer);
    return c.body(body, 200, { 'content-type': rendered.contentType });
  });

  /* ---------------- service templates ---------------- */

  app.post('/templates', async (c) => {
    const input = templateSchema.parse(await c.req.json());
    const data = await svc.createServiceTemplate(ctxOf(c), input);
    return c.json({ data }, 201);
  });

  app.get('/templates', async (c) => {
    const page = parsePagination(c.req.query());
    const data = await svc.listServiceTemplates(ctxOf(c), page);
    return c.json({ data, limit: page.limit, offset: page.offset });
  });

  app.get('/templates/:id', async (c) => {
    const data = await svc.getServiceTemplate(ctxOf(c), c.req.param('id'));
    return c.json({ data });
  });

  app.patch('/templates/:id', async (c) => {
    const patch = templateSchema.partial().parse(await c.req.json());
    const data = await svc.updateServiceTemplate(ctxOf(c), c.req.param('id'), patch);
    return c.json({ data });
  });

  app.delete('/templates/:id', async (c) => {
    await svc.deleteServiceTemplate(ctxOf(c), c.req.param('id'));
    return c.json({ data: { deleted: true } });
  });

  /* ---------------- pricing rules ---------------- */

  app.post('/pricing-rules', async (c) => {
    const input = pricingRuleSchema.parse(await c.req.json());
    const data = await svc.createPricingRule(ctxOf(c), input as svc.PricingRuleInput);
    return c.json({ data }, 201);
  });

  app.get('/pricing-rules', async (c) => {
    const page = parsePagination(c.req.query());
    const data = await svc.listPricingRules(ctxOf(c), page);
    return c.json({ data, limit: page.limit, offset: page.offset });
  });

  app.get('/pricing-rules/:id', async (c) => {
    const data = await svc.getPricingRule(ctxOf(c), c.req.param('id'));
    return c.json({ data });
  });

  app.patch('/pricing-rules/:id', async (c) => {
    // Partial update still validates scope/action pairing when both present.
    const raw: unknown = await c.req.json();
    const touchesScopeOrAction =
      typeof raw === 'object' &&
      raw !== null &&
      !Array.isArray(raw) &&
      ((raw as Record<string, unknown>).scope !== undefined ||
        (raw as Record<string, unknown>).action !== undefined);
    const patch = touchesScopeOrAction
      ? pricingRuleSchema.parse({
          ...(await svc.getPricingRuleAsInput(ctxOf(c), c.req.param('id'))),
          ...(raw as Record<string, unknown>),
        })
      : pricingRuleSchema.innerType().partial().parse(raw);
    const data = await svc.updatePricingRule(ctxOf(c), c.req.param('id'), patch as Partial<svc.PricingRuleInput>);
    return c.json({ data });
  });

  app.delete('/pricing-rules/:id', async (c) => {
    await svc.deletePricingRule(ctxOf(c), c.req.param('id'));
    return c.json({ data: { deleted: true } });
  });

  /* ---------------- discounts & taxes ---------------- */

  app.post('/discounts', async (c) => {
    const input = discountSchema.parse(await c.req.json());
    const data = await svc.createDiscount(ctxOf(c), input);
    return c.json({ data }, 201);
  });

  app.get('/discounts', async (c) => {
    const page = parsePagination(c.req.query());
    const data = await svc.listDiscounts(ctxOf(c), page);
    return c.json({ data, limit: page.limit, offset: page.offset });
  });

  app.delete('/discounts/:id', async (c) => {
    await svc.deleteDiscount(ctxOf(c), c.req.param('id'));
    return c.json({ data: { deleted: true } });
  });

  app.post('/taxes', async (c) => {
    const input = taxSchema.parse(await c.req.json());
    const data = await svc.createTax(ctxOf(c), input);
    return c.json({ data }, 201);
  });

  app.get('/taxes', async (c) => {
    const page = parsePagination(c.req.query());
    const data = await svc.listTaxes(ctxOf(c), page);
    return c.json({ data, limit: page.limit, offset: page.offset });
  });

  app.delete('/taxes/:id', async (c) => {
    await svc.deleteTax(ctxOf(c), c.req.param('id'));
    return c.json({ data: { deleted: true } });
  });

  return app;
}
