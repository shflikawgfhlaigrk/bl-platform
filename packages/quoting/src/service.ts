import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import {
  ApiError,
  applyDiscount,
  asCoreDb,
  audit,
  computeTotals,
  id,
  nowIso,
  type Contracts,
  type Discount,
  type EventBus,
  type Pagination,
  type Sort,
  type TotalsLine,
} from '@blacklabel/core';
import {
  applyLineAction,
  matchesAllConditions,
  parseStoredRule,
  quoteActionDiscountCents,
  type ParsedPricingRule,
  type RuleAttributes,
} from './rules';
import type {
  ApprovalEventRow,
  ApprovalEventType,
  DiscountRow,
  PricingRuleRow,
  PricingRuleScope,
  QuoteLineRow,
  QuoteRow,
  QuoteStatus,
  QuotingDatabase,
  ServiceTemplateRow,
  TaxRow,
  TemplateLineItem,
} from './schema';

/** Per-request context assembled by the router. */
export interface QuotingCtx {
  db: Kysely<QuotingDatabase>;
  events: EventBus;
  contracts: Contracts;
  tenantId: string;
  /** User id or "system" — used for audit rows. */
  actor: string;
}

/* ------------------------------------------------------------------ *
 * Input types
 * ------------------------------------------------------------------ */

export interface QuoteLineInput {
  description: string;
  quantity: number;
  unitPriceCents: number;
  unitCostCents?: number;
  discountBps?: number;
  discountFixedCents?: number;
  serviceTemplateId?: string;
}

export interface CreateQuoteInput {
  customerId: string;
  title: string;
  notes?: string;
  validUntil?: string;
  discountBps?: number;
  discountFixedCents?: number;
  taxBps?: number;
  lines?: QuoteLineInput[];
  /** Expand this template (bundles recurse) into initial lines. */
  templateId?: string;
}

export interface UpdateQuoteInput {
  customerId?: string;
  title?: string;
  notes?: string | null;
  validUntil?: string | null;
  discountBps?: number | null;
  discountFixedCents?: number | null;
  taxBps?: number | null;
}

export interface UpdateQuoteLineInput {
  description?: string;
  quantity?: number;
  unitPriceCents?: number;
  unitCostCents?: number;
  discountBps?: number | null;
  discountFixedCents?: number | null;
}

export interface PricingRuleInput {
  name: string;
  scope: PricingRuleScope;
  conditions: { field: string; op: string; value: unknown }[];
  action: { type: string; amount: number };
  active?: boolean;
  priority?: number;
}

export interface ServiceTemplateInput {
  name: string;
  description?: string;
  lineItems?: TemplateLineItem[];
  childTemplateIds?: string[];
  active?: boolean;
}

export interface DiscountInput {
  name: string;
  bps?: number;
  fixedCents?: number;
  active?: boolean;
}

export interface TaxInput {
  name: string;
  rateBps: number;
  active?: boolean;
}

export interface QuoteWithDetails {
  quote: QuoteRow;
  lines: QuoteLineRow[];
  approvalEvents: ApprovalEventRow[];
}

export interface ConvertQuoteResult {
  /** Contract-shaped job payload for downstream systems (plain JSON). */
  job: {
    customerId: string;
    title: string;
    notes: string | null;
    sourceEntityType: 'quoting.quote';
    sourceEntityId: string;
    lines: {
      description: string;
      quantity: number;
      unitPriceCents: number;
      discountBps?: number;
      discountFixedCents?: number;
    }[];
    discountFixedCents: number;
    taxBps?: number;
    subtotalCents: number;
    totalCents: number;
  };
  /** Billing invoice id when the createInvoice contract is wired, else null. */
  invoiceId: string | null;
}

/* ------------------------------------------------------------------ *
 * Internal helpers
 * ------------------------------------------------------------------ */

async function getQuoteRow(ctx: QuotingCtx, quoteId: string): Promise<QuoteRow> {
  const quote = await ctx.db
    .selectFrom('quoting_quotes')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', quoteId)
    .executeTakeFirst();
  if (!quote) throw ApiError.notFound(`quote not found: ${quoteId}`);
  return quote;
}

async function getQuoteLines(ctx: QuotingCtx, quoteId: string): Promise<QuoteLineRow[]> {
  return ctx.db
    .selectFrom('quoting_quote_lines')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('quote_id', '=', quoteId)
    .orderBy('position')
    .orderBy('id')
    .execute();
}

function assertEditable(quote: QuoteRow): void {
  if (quote.status !== 'draft') {
    throw ApiError.conflict(`quote is ${quote.status}; only draft quotes can be edited`);
  }
}

function lineDiscount(row: {
  discount_bps: number | null;
  discount_fixed_cents: number | null;
}): Discount | undefined {
  if (row.discount_bps === null && row.discount_fixed_cents === null) return undefined;
  return {
    bps: row.discount_bps ?? undefined,
    fixedCents: row.discount_fixed_cents ?? undefined,
  };
}

async function loadActiveRules(ctx: QuotingCtx): Promise<ParsedPricingRule[]> {
  const rows = await ctx.db
    .selectFrom('quoting_pricing_rules')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('active', '=', 1)
    .orderBy('priority')
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const parsed: ParsedPricingRule[] = [];
  for (const row of rows) {
    const rule = parseStoredRule(row);
    if (rule) parsed.push(rule);
  }
  return parsed;
}

/**
 * Recompute a quote's pricing and persist it. The ONLY place money math
 * happens, and it delegates to core's computeTotals/applyDiscount:
 *
 *   1. line-scope pricing rules -> effective unit price per line
 *   2. core computeTotals: line discounts -> quote discount -> tax
 *      (quote-scope rule discounts are folded into the quote-level
 *       discount as fixed cents computed on the post-line-discount subtotal)
 *   3. margin: pre-tax revenue minus internal cost
 */
async function recomputeQuote(ctx: QuotingCtx, quoteId: string): Promise<QuoteRow> {
  const quote = await getQuoteRow(ctx, quoteId);
  const lines = await getQuoteLines(ctx, quoteId);
  const rules = await loadActiveRules(ctx);
  const lineRules = rules.filter((r) => r.scope === 'line');
  const quoteRules = rules.filter((r) => r.scope === 'quote');

  // 1. effective unit prices via line-scope rules (conditions see the values
  //    as entered; actions chain on the effective price in priority order).
  const effectivePrices = lines.map((line) => {
    const attrs: RuleAttributes = {
      description: line.description,
      quantity: line.quantity,
      unit_price_cents: line.unit_price_cents,
      unit_cost_cents: line.unit_cost_cents,
      line_total_cents: Math.round(line.quantity * line.unit_price_cents),
      service_template_id: line.service_template_id,
    };
    let effective = line.unit_price_cents;
    for (const rule of lineRules) {
      if (matchesAllConditions(attrs, rule.conditions)) {
        effective = applyLineAction(effective, rule.action);
      }
    }
    return effective;
  });

  const totalsLines: TotalsLine[] = lines.map((line, i) => ({
    quantity: line.quantity,
    unitPriceCents: effectivePrices[i]!,
    discount: lineDiscount(line),
  }));

  // Post-line-discount subtotal (needed for quote-scope rule evaluation).
  const preTotals = computeTotals(totalsLines);
  const subtotalCents = preTotals.subtotalCents;

  // 2. quote-scope rules -> extra fixed discount cents.
  const quoteAttrs: RuleAttributes = {
    subtotal_cents: subtotalCents,
    line_count: lines.length,
    total_quantity: lines.reduce((a, l) => a + l.quantity, 0),
    customer_id: quote.customer_id,
    status: quote.status,
  };
  let ruleDiscountCents = 0;
  for (const rule of quoteRules) {
    if (matchesAllConditions(quoteAttrs, rule.conditions)) {
      ruleDiscountCents += quoteActionDiscountCents(subtotalCents, rule.action);
    }
  }

  const fixedCents = (quote.discount_fixed_cents ?? 0) + ruleDiscountCents;
  const quoteDiscount: Discount | undefined =
    quote.discount_bps === null && fixedCents === 0
      ? undefined
      : { bps: quote.discount_bps ?? undefined, fixedCents };

  const totals = computeTotals(totalsLines, {
    discount: quoteDiscount,
    taxBps: quote.tax_bps ?? undefined,
  });

  // 3. margin on pre-tax revenue.
  const totalCostCents = lines.reduce(
    (a, l) => a + Math.round(l.quantity * l.unit_cost_cents),
    0,
  );
  const revenueCents = totals.subtotalCents - totals.discountCents;
  const marginCents = revenueCents - totalCostCents;
  const marginBps = revenueCents > 0 ? Math.round((marginCents * 10000) / revenueCents) : 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    await ctx.db
      .updateTable('quoting_quote_lines')
      .set({
        effective_unit_price_cents: effectivePrices[i]!,
        total_cents: totals.lineTotalsCents[i]!,
      })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', line.id)
      .execute();
  }

  await ctx.db
    .updateTable('quoting_quotes')
    .set({
      subtotal_cents: totals.subtotalCents,
      discount_cents: totals.discountCents,
      tax_cents: totals.taxCents,
      total_cents: totals.totalCents,
      total_cost_cents: totalCostCents,
      margin_cents: marginCents,
      margin_bps: marginBps,
      updated_at: nowIso(),
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', quoteId)
    .execute();

  return getQuoteRow(ctx, quoteId);
}

/**
 * sha256 hex of the canonical quote payload — stored on every ApprovalEvent
 * so an approval can later be verified against exactly what was approved
 * (e-signature-ready).
 */
export function quotePayloadHash(quote: QuoteRow, lines: QuoteLineRow[]): string {
  const payload = {
    id: quote.id,
    customer_id: quote.customer_id,
    title: quote.title,
    valid_until: quote.valid_until,
    discount_bps: quote.discount_bps,
    discount_fixed_cents: quote.discount_fixed_cents,
    tax_bps: quote.tax_bps,
    subtotal_cents: quote.subtotal_cents,
    discount_cents: quote.discount_cents,
    tax_cents: quote.tax_cents,
    total_cents: quote.total_cents,
    lines: lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unit_price_cents: l.unit_price_cents,
      effective_unit_price_cents: l.effective_unit_price_cents,
      discount_bps: l.discount_bps,
      discount_fixed_cents: l.discount_fixed_cents,
      total_cents: l.total_cents,
    })),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function recordApprovalEvent(
  ctx: QuotingCtx,
  quote: QuoteRow,
  eventType: ApprovalEventType,
  extra: { signerName?: string; signerIp?: string; note?: string } = {},
): Promise<ApprovalEventRow> {
  const lines = await getQuoteLines(ctx, quote.id);
  const prior = await ctx.db
    .selectFrom('quoting_approval_events')
    .select('seq')
    .where('tenant_id', '=', ctx.tenantId)
    .where('quote_id', '=', quote.id)
    .orderBy('seq', 'desc')
    .orderBy('id')
    .limit(1)
    .executeTakeFirst();
  const row: ApprovalEventRow = {
    id: id(),
    tenant_id: ctx.tenantId,
    quote_id: quote.id,
    seq: (prior?.seq ?? -1) + 1,
    event_type: eventType,
    signer_name: extra.signerName ?? null,
    signer_ip: extra.signerIp ?? null,
    payload_hash: quotePayloadHash(quote, lines),
    note: extra.note ?? null,
    created_at: nowIso(),
  };
  await ctx.db.insertInto('quoting_approval_events').values(row).execute();
  return row;
}

async function setQuoteStatus(ctx: QuotingCtx, quoteId: string, status: QuoteStatus): Promise<QuoteRow> {
  await ctx.db
    .updateTable('quoting_quotes')
    .set({ status, updated_at: nowIso() })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', quoteId)
    .execute();
  return getQuoteRow(ctx, quoteId);
}

/* ------------------------------------------------------------------ *
 * Quotes
 * ------------------------------------------------------------------ */

export async function createQuote(ctx: QuotingCtx, input: CreateQuoteInput): Promise<QuoteWithDetails> {
  const now = nowIso();
  const quote: QuoteRow = {
    id: id(),
    tenant_id: ctx.tenantId,
    customer_id: input.customerId,
    title: input.title.trim(),
    notes: input.notes ?? null,
    status: 'draft',
    discount_bps: input.discountBps ?? null,
    discount_fixed_cents: input.discountFixedCents ?? null,
    discount_id: null,
    tax_id: null,
    tax_bps: input.taxBps ?? null,
    valid_until: input.validUntil ?? null,
    attachments: '[]',
    subtotal_cents: 0,
    discount_cents: 0,
    tax_cents: 0,
    total_cents: 0,
    total_cost_cents: 0,
    margin_cents: 0,
    margin_bps: 0,
    converted_at: null,
    invoice_id: null,
    created_at: now,
    updated_at: now,
  };
  if (quote.title === '') throw ApiError.badRequest('quote title is required');
  await ctx.db.insertInto('quoting_quotes').values(quote).execute();

  let position = 0;
  const insertLine = async (line: QuoteLineInput) => {
    const row: QuoteLineRow = {
      id: id(),
      tenant_id: ctx.tenantId,
      quote_id: quote.id,
      description: line.description,
      quantity: line.quantity,
      unit_price_cents: line.unitPriceCents,
      unit_cost_cents: line.unitCostCents ?? 0,
      effective_unit_price_cents: line.unitPriceCents,
      discount_bps: line.discountBps ?? null,
      discount_fixed_cents: line.discountFixedCents ?? null,
      total_cents: 0,
      position,
      service_template_id: line.serviceTemplateId ?? null,
      created_at: nowIso(),
    };
    position += 1;
    await ctx.db.insertInto('quoting_quote_lines').values(row).execute();
  };

  for (const line of input.lines ?? []) {
    await insertLine(line);
  }
  if (input.templateId) {
    for (const line of await expandTemplate(ctx, input.templateId)) {
      await insertLine(line);
    }
  }

  const updated = await recomputeQuote(ctx, quote.id);
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.quote.created', 'quoting.quote', quote.id, {
    customerId: quote.customer_id,
    title: quote.title,
  });
  await ctx.events.emit(ctx.tenantId, 'quoting.quote.created', {
    quoteId: quote.id,
    customerId: quote.customer_id,
  });
  return { quote: updated, lines: await getQuoteLines(ctx, quote.id), approvalEvents: [] };
}

export async function getQuote(ctx: QuotingCtx, quoteId: string): Promise<QuoteWithDetails> {
  const quote = await getQuoteRow(ctx, quoteId);
  const lines = await getQuoteLines(ctx, quoteId);
  const approvalEvents = await ctx.db
    .selectFrom('quoting_approval_events')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('quote_id', '=', quoteId)
    .orderBy('seq')
    .orderBy('id')
    .execute();
  return { quote, lines, approvalEvents };
}

export async function listQuotes(
  ctx: QuotingCtx,
  options: {
    page: Pagination;
    sort?: Sort;
    filters?: { status?: string; customer_id?: string };
  },
): Promise<QuoteRow[]> {
  let query = ctx.db
    .selectFrom('quoting_quotes')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId);
  if (options.filters?.status) query = query.where('status', '=', options.filters.status as QuoteStatus);
  if (options.filters?.customer_id) query = query.where('customer_id', '=', options.filters.customer_id);
  const sort = options.sort ?? { column: 'created_at', direction: 'asc' as const };
  return query
    .orderBy(sort.column as 'created_at', sort.direction)
    .orderBy('id')
    .limit(options.page.limit)
    .offset(options.page.offset)
    .execute();
}

export async function updateQuote(
  ctx: QuotingCtx,
  quoteId: string,
  patch: UpdateQuoteInput,
): Promise<QuoteWithDetails> {
  const quote = await getQuoteRow(ctx, quoteId);
  assertEditable(quote);
  const set: Partial<QuoteRow> = {};
  if (patch.customerId !== undefined) set.customer_id = patch.customerId;
  if (patch.title !== undefined) {
    if (patch.title.trim() === '') throw ApiError.badRequest('quote title cannot be blank');
    set.title = patch.title.trim();
  }
  if (patch.notes !== undefined) set.notes = patch.notes;
  if (patch.validUntil !== undefined) set.valid_until = patch.validUntil;
  if (patch.discountBps !== undefined) {
    set.discount_bps = patch.discountBps;
    set.discount_id = null;
  }
  if (patch.discountFixedCents !== undefined) {
    set.discount_fixed_cents = patch.discountFixedCents;
    set.discount_id = null;
  }
  if (patch.taxBps !== undefined) {
    set.tax_bps = patch.taxBps;
    set.tax_id = null;
  }
  if (Object.keys(set).length > 0) {
    set.updated_at = nowIso();
    await ctx.db
      .updateTable('quoting_quotes')
      .set(set)
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', quoteId)
      .execute();
  }
  const updated = await recomputeQuote(ctx, quoteId);
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.quote.updated', 'quoting.quote', quoteId, patch);
  return { quote: updated, lines: await getQuoteLines(ctx, quoteId), approvalEvents: [] };
}

export async function deleteQuote(ctx: QuotingCtx, quoteId: string): Promise<void> {
  const quote = await getQuoteRow(ctx, quoteId);
  assertEditable(quote);
  await ctx.db
    .deleteFrom('quoting_quote_lines')
    .where('tenant_id', '=', ctx.tenantId)
    .where('quote_id', '=', quoteId)
    .execute();
  await ctx.db
    .deleteFrom('quoting_approval_events')
    .where('tenant_id', '=', ctx.tenantId)
    .where('quote_id', '=', quoteId)
    .execute();
  await ctx.db
    .deleteFrom('quoting_quotes')
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', quoteId)
    .execute();
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.quote.deleted', 'quoting.quote', quoteId);
}

/* ------------------------------------------------------------------ *
 * Quote lines
 * ------------------------------------------------------------------ */

export async function addQuoteLine(
  ctx: QuotingCtx,
  quoteId: string,
  input: QuoteLineInput,
): Promise<QuoteWithDetails> {
  const quote = await getQuoteRow(ctx, quoteId);
  assertEditable(quote);
  const existing = await getQuoteLines(ctx, quoteId);
  const position = existing.length === 0 ? 0 : Math.max(...existing.map((l) => l.position)) + 1;
  const row: QuoteLineRow = {
    id: id(),
    tenant_id: ctx.tenantId,
    quote_id: quoteId,
    description: input.description,
    quantity: input.quantity,
    unit_price_cents: input.unitPriceCents,
    unit_cost_cents: input.unitCostCents ?? 0,
    effective_unit_price_cents: input.unitPriceCents,
    discount_bps: input.discountBps ?? null,
    discount_fixed_cents: input.discountFixedCents ?? null,
    total_cents: 0,
    position,
    service_template_id: input.serviceTemplateId ?? null,
    created_at: nowIso(),
  };
  await ctx.db.insertInto('quoting_quote_lines').values(row).execute();
  const updated = await recomputeQuote(ctx, quoteId);
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.quote_line.created', 'quoting.quote_line', row.id, {
    quoteId,
    description: row.description,
  });
  return { quote: updated, lines: await getQuoteLines(ctx, quoteId), approvalEvents: [] };
}

export async function updateQuoteLine(
  ctx: QuotingCtx,
  quoteId: string,
  lineId: string,
  patch: UpdateQuoteLineInput,
): Promise<QuoteWithDetails> {
  const quote = await getQuoteRow(ctx, quoteId);
  assertEditable(quote);
  const set: Partial<QuoteLineRow> = {};
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.quantity !== undefined) set.quantity = patch.quantity;
  if (patch.unitPriceCents !== undefined) set.unit_price_cents = patch.unitPriceCents;
  if (patch.unitCostCents !== undefined) set.unit_cost_cents = patch.unitCostCents;
  if (patch.discountBps !== undefined) set.discount_bps = patch.discountBps;
  if (patch.discountFixedCents !== undefined) set.discount_fixed_cents = patch.discountFixedCents;
  if (Object.keys(set).length > 0) {
    const result = await ctx.db
      .updateTable('quoting_quote_lines')
      .set(set)
      .where('tenant_id', '=', ctx.tenantId)
      .where('quote_id', '=', quoteId)
      .where('id', '=', lineId)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) throw ApiError.notFound(`quote line not found: ${lineId}`);
  } else {
    const exists = await ctx.db
      .selectFrom('quoting_quote_lines')
      .select('id')
      .where('tenant_id', '=', ctx.tenantId)
      .where('quote_id', '=', quoteId)
      .where('id', '=', lineId)
      .executeTakeFirst();
    if (!exists) throw ApiError.notFound(`quote line not found: ${lineId}`);
  }
  const updated = await recomputeQuote(ctx, quoteId);
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.quote_line.updated', 'quoting.quote_line', lineId, patch);
  return { quote: updated, lines: await getQuoteLines(ctx, quoteId), approvalEvents: [] };
}

export async function deleteQuoteLine(
  ctx: QuotingCtx,
  quoteId: string,
  lineId: string,
): Promise<QuoteWithDetails> {
  const quote = await getQuoteRow(ctx, quoteId);
  assertEditable(quote);
  const result = await ctx.db
    .deleteFrom('quoting_quote_lines')
    .where('tenant_id', '=', ctx.tenantId)
    .where('quote_id', '=', quoteId)
    .where('id', '=', lineId)
    .executeTakeFirst();
  if (result.numDeletedRows === 0n) throw ApiError.notFound(`quote line not found: ${lineId}`);
  const updated = await recomputeQuote(ctx, quoteId);
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.quote_line.deleted', 'quoting.quote_line', lineId, {
    quoteId,
  });
  return { quote: updated, lines: await getQuoteLines(ctx, quoteId), approvalEvents: [] };
}

/* ------------------------------------------------------------------ *
 * Service templates (packages/bundles = template composed of templates)
 * ------------------------------------------------------------------ */

export async function createServiceTemplate(
  ctx: QuotingCtx,
  input: ServiceTemplateInput,
): Promise<ServiceTemplateRow> {
  const now = nowIso();
  const row: ServiceTemplateRow = {
    id: id(),
    tenant_id: ctx.tenantId,
    name: input.name,
    description: input.description ?? null,
    line_items: JSON.stringify(input.lineItems ?? []),
    child_template_ids: JSON.stringify(input.childTemplateIds ?? []),
    active: input.active === false ? 0 : 1,
    created_at: now,
    updated_at: now,
  };
  // Bundles may only reference this tenant's templates.
  for (const childId of input.childTemplateIds ?? []) {
    const child = await ctx.db
      .selectFrom('quoting_service_templates')
      .select('id')
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', childId)
      .executeTakeFirst();
    if (!child) throw ApiError.badRequest(`child template not found: ${childId}`);
  }
  await ctx.db.insertInto('quoting_service_templates').values(row).execute();
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.service_template.created', 'quoting.service_template', row.id, {
    name: row.name,
  });
  return row;
}

export async function getServiceTemplate(ctx: QuotingCtx, templateId: string): Promise<ServiceTemplateRow> {
  const row = await ctx.db
    .selectFrom('quoting_service_templates')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', templateId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`service template not found: ${templateId}`);
  return row;
}

export async function listServiceTemplates(
  ctx: QuotingCtx,
  page: Pagination,
): Promise<ServiceTemplateRow[]> {
  return ctx.db
    .selectFrom('quoting_service_templates')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .orderBy('name')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export async function updateServiceTemplate(
  ctx: QuotingCtx,
  templateId: string,
  patch: Partial<ServiceTemplateInput>,
): Promise<ServiceTemplateRow> {
  await getServiceTemplate(ctx, templateId);
  const set: Partial<ServiceTemplateRow> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description ?? null;
  if (patch.lineItems !== undefined) set.line_items = JSON.stringify(patch.lineItems);
  if (patch.childTemplateIds !== undefined) {
    for (const childId of patch.childTemplateIds) {
      if (childId === templateId) throw ApiError.badRequest('a template cannot contain itself');
      const child = await ctx.db
        .selectFrom('quoting_service_templates')
        .select('id')
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', childId)
        .executeTakeFirst();
      if (!child) throw ApiError.badRequest(`child template not found: ${childId}`);
    }
    set.child_template_ids = JSON.stringify(patch.childTemplateIds);
  }
  if (patch.active !== undefined) set.active = patch.active ? 1 : 0;
  if (Object.keys(set).length > 0) {
    set.updated_at = nowIso();
    await ctx.db
      .updateTable('quoting_service_templates')
      .set(set)
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', templateId)
      .execute();
  }
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.service_template.updated', 'quoting.service_template', templateId, patch);
  return getServiceTemplate(ctx, templateId);
}

export async function deleteServiceTemplate(ctx: QuotingCtx, templateId: string): Promise<void> {
  const result = await ctx.db
    .deleteFrom('quoting_service_templates')
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', templateId)
    .executeTakeFirst();
  if (result.numDeletedRows === 0n) throw ApiError.notFound(`service template not found: ${templateId}`);
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.service_template.deleted', 'quoting.service_template', templateId);
}

/**
 * Expand a template into concrete line inputs. Bundles recurse depth-first:
 * the template's own line items first, then each child template. A visited
 * set makes cycles harmless (a template is expanded at most once per call).
 */
export async function expandTemplate(
  ctx: QuotingCtx,
  templateId: string,
  visited: Set<string> = new Set(),
): Promise<QuoteLineInput[]> {
  if (visited.has(templateId)) return [];
  visited.add(templateId);
  const template = await getServiceTemplate(ctx, templateId);
  if (template.active !== 1) {
    throw ApiError.conflict(`service template is inactive: ${templateId}`);
  }
  const out: QuoteLineInput[] = [];
  const items = JSON.parse(template.line_items) as TemplateLineItem[];
  for (const item of items) {
    out.push({
      description: item.description,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      unitCostCents: item.unitCostCents ?? 0,
      discountBps: item.discountBps,
      discountFixedCents: item.discountFixedCents,
      serviceTemplateId: template.id,
    });
  }
  const childIds = JSON.parse(template.child_template_ids) as string[];
  for (const childId of childIds) {
    const exists = await ctx.db
      .selectFrom('quoting_service_templates')
      .select('id')
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', childId)
      .executeTakeFirst();
    if (!exists) continue; // deleted since bundling — skip, never crash
    out.push(...(await expandTemplate(ctx, childId, visited)));
  }
  return out;
}

export async function applyTemplateToQuote(
  ctx: QuotingCtx,
  quoteId: string,
  templateId: string,
): Promise<QuoteWithDetails> {
  const quote = await getQuoteRow(ctx, quoteId);
  assertEditable(quote);
  const lines = await expandTemplate(ctx, templateId);
  if (lines.length === 0) throw ApiError.badRequest(`template has no line items: ${templateId}`);
  const existing = await getQuoteLines(ctx, quoteId);
  let position = existing.length === 0 ? 0 : Math.max(...existing.map((l) => l.position)) + 1;
  for (const line of lines) {
    const row: QuoteLineRow = {
      id: id(),
      tenant_id: ctx.tenantId,
      quote_id: quoteId,
      description: line.description,
      quantity: line.quantity,
      unit_price_cents: line.unitPriceCents,
      unit_cost_cents: line.unitCostCents ?? 0,
      effective_unit_price_cents: line.unitPriceCents,
      discount_bps: line.discountBps ?? null,
      discount_fixed_cents: line.discountFixedCents ?? null,
      total_cents: 0,
      position,
      service_template_id: line.serviceTemplateId ?? templateId,
      created_at: nowIso(),
    };
    position += 1;
    await ctx.db.insertInto('quoting_quote_lines').values(row).execute();
  }
  const updated = await recomputeQuote(ctx, quoteId);
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.quote.template_applied', 'quoting.quote', quoteId, {
    templateId,
    linesAdded: lines.length,
  });
  return { quote: updated, lines: await getQuoteLines(ctx, quoteId), approvalEvents: [] };
}

/* ------------------------------------------------------------------ *
 * Pricing rules
 * ------------------------------------------------------------------ */

export async function createPricingRule(ctx: QuotingCtx, input: PricingRuleInput): Promise<PricingRuleRow> {
  const now = nowIso();
  const row: PricingRuleRow = {
    id: id(),
    tenant_id: ctx.tenantId,
    name: input.name,
    scope: input.scope,
    conditions: JSON.stringify(input.conditions),
    action: JSON.stringify(input.action),
    active: input.active === false ? 0 : 1,
    priority: input.priority ?? 100,
    created_at: now,
    updated_at: now,
  };
  await ctx.db.insertInto('quoting_pricing_rules').values(row).execute();
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.pricing_rule.created', 'quoting.pricing_rule', row.id, {
    name: row.name,
    scope: row.scope,
  });
  return row;
}

export async function getPricingRule(ctx: QuotingCtx, ruleId: string): Promise<PricingRuleRow> {
  const row = await ctx.db
    .selectFrom('quoting_pricing_rules')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', ruleId)
    .executeTakeFirst();
  if (!row) throw ApiError.notFound(`pricing rule not found: ${ruleId}`);
  return row;
}

export async function listPricingRules(ctx: QuotingCtx, page: Pagination): Promise<PricingRuleRow[]> {
  return ctx.db
    .selectFrom('quoting_pricing_rules')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .orderBy('priority')
    .orderBy('created_at')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export async function updatePricingRule(
  ctx: QuotingCtx,
  ruleId: string,
  patch: Partial<PricingRuleInput>,
): Promise<PricingRuleRow> {
  await getPricingRule(ctx, ruleId);
  const set: Partial<PricingRuleRow> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.scope !== undefined) set.scope = patch.scope;
  if (patch.conditions !== undefined) set.conditions = JSON.stringify(patch.conditions);
  if (patch.action !== undefined) set.action = JSON.stringify(patch.action);
  if (patch.active !== undefined) set.active = patch.active ? 1 : 0;
  if (patch.priority !== undefined) set.priority = patch.priority;
  if (Object.keys(set).length > 0) {
    set.updated_at = nowIso();
    await ctx.db
      .updateTable('quoting_pricing_rules')
      .set(set)
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', ruleId)
      .execute();
  }
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.pricing_rule.updated', 'quoting.pricing_rule', ruleId, patch);
  return getPricingRule(ctx, ruleId);
}

/** Round-trip a stored rule row back into input shape (used for PATCH merges). */
export async function getPricingRuleAsInput(ctx: QuotingCtx, ruleId: string): Promise<PricingRuleInput> {
  const row = await getPricingRule(ctx, ruleId);
  return {
    name: row.name,
    scope: row.scope,
    conditions: JSON.parse(row.conditions),
    action: JSON.parse(row.action),
    active: row.active === 1,
    priority: row.priority,
  };
}

export async function deletePricingRule(ctx: QuotingCtx, ruleId: string): Promise<void> {
  const result = await ctx.db
    .deleteFrom('quoting_pricing_rules')
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', ruleId)
    .executeTakeFirst();
  if (result.numDeletedRows === 0n) throw ApiError.notFound(`pricing rule not found: ${ruleId}`);
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.pricing_rule.deleted', 'quoting.pricing_rule', ruleId);
}

/* ------------------------------------------------------------------ *
 * Discounts & taxes (named, reusable; applied to quotes as snapshots)
 * ------------------------------------------------------------------ */

export async function createDiscount(ctx: QuotingCtx, input: DiscountInput): Promise<DiscountRow> {
  if (input.bps === undefined && input.fixedCents === undefined) {
    throw ApiError.badRequest('discount needs bps and/or fixedCents');
  }
  const row: DiscountRow = {
    id: id(),
    tenant_id: ctx.tenantId,
    name: input.name,
    bps: input.bps ?? null,
    fixed_cents: input.fixedCents ?? null,
    active: input.active === false ? 0 : 1,
    created_at: nowIso(),
  };
  await ctx.db.insertInto('quoting_discounts').values(row).execute();
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.discount.created', 'quoting.discount', row.id, {
    name: row.name,
  });
  return row;
}

export async function listDiscounts(ctx: QuotingCtx, page: Pagination): Promise<DiscountRow[]> {
  return ctx.db
    .selectFrom('quoting_discounts')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .orderBy('name')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export async function deleteDiscount(ctx: QuotingCtx, discountId: string): Promise<void> {
  const result = await ctx.db
    .deleteFrom('quoting_discounts')
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', discountId)
    .executeTakeFirst();
  if (result.numDeletedRows === 0n) throw ApiError.notFound(`discount not found: ${discountId}`);
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.discount.deleted', 'quoting.discount', discountId);
}

/** Snapshot a named discount onto a draft quote (bps + fixed cents copied). */
export async function applyDiscountToQuote(
  ctx: QuotingCtx,
  quoteId: string,
  discountId: string,
): Promise<QuoteWithDetails> {
  const quote = await getQuoteRow(ctx, quoteId);
  assertEditable(quote);
  const discount = await ctx.db
    .selectFrom('quoting_discounts')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', discountId)
    .executeTakeFirst();
  if (!discount) throw ApiError.notFound(`discount not found: ${discountId}`);
  if (discount.active !== 1) throw ApiError.conflict(`discount is inactive: ${discountId}`);
  await ctx.db
    .updateTable('quoting_quotes')
    .set({
      discount_bps: discount.bps,
      discount_fixed_cents: discount.fixed_cents,
      discount_id: discount.id,
      updated_at: nowIso(),
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', quoteId)
    .execute();
  const updated = await recomputeQuote(ctx, quoteId);
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.quote.discount_applied', 'quoting.quote', quoteId, {
    discountId,
  });
  return { quote: updated, lines: await getQuoteLines(ctx, quoteId), approvalEvents: [] };
}

export async function createTax(ctx: QuotingCtx, input: TaxInput): Promise<TaxRow> {
  const row: TaxRow = {
    id: id(),
    tenant_id: ctx.tenantId,
    name: input.name,
    rate_bps: input.rateBps,
    active: input.active === false ? 0 : 1,
    created_at: nowIso(),
  };
  await ctx.db.insertInto('quoting_taxes').values(row).execute();
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.tax.created', 'quoting.tax', row.id, {
    name: row.name,
    rateBps: row.rate_bps,
  });
  return row;
}

export async function listTaxes(ctx: QuotingCtx, page: Pagination): Promise<TaxRow[]> {
  return ctx.db
    .selectFrom('quoting_taxes')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .orderBy('name')
    .orderBy('id')
    .limit(page.limit)
    .offset(page.offset)
    .execute();
}

export async function deleteTax(ctx: QuotingCtx, taxId: string): Promise<void> {
  const result = await ctx.db
    .deleteFrom('quoting_taxes')
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', taxId)
    .executeTakeFirst();
  if (result.numDeletedRows === 0n) throw ApiError.notFound(`tax not found: ${taxId}`);
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.tax.deleted', 'quoting.tax', taxId);
}

/** Snapshot a named tax rate onto a draft quote. */
export async function applyTaxToQuote(
  ctx: QuotingCtx,
  quoteId: string,
  taxId: string,
): Promise<QuoteWithDetails> {
  const quote = await getQuoteRow(ctx, quoteId);
  assertEditable(quote);
  const tax = await ctx.db
    .selectFrom('quoting_taxes')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', taxId)
    .executeTakeFirst();
  if (!tax) throw ApiError.notFound(`tax not found: ${taxId}`);
  if (tax.active !== 1) throw ApiError.conflict(`tax is inactive: ${taxId}`);
  await ctx.db
    .updateTable('quoting_quotes')
    .set({ tax_id: tax.id, tax_bps: tax.rate_bps, updated_at: nowIso() })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', quoteId)
    .execute();
  const updated = await recomputeQuote(ctx, quoteId);
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.quote.tax_applied', 'quoting.quote', quoteId, {
    taxId,
  });
  return { quote: updated, lines: await getQuoteLines(ctx, quoteId), approvalEvents: [] };
}

/* ------------------------------------------------------------------ *
 * Attachments (file id string references — files module owns the bytes)
 * ------------------------------------------------------------------ */

export async function addAttachment(ctx: QuotingCtx, quoteId: string, fileId: string): Promise<QuoteRow> {
  const quote = await getQuoteRow(ctx, quoteId);
  const attachments = JSON.parse(quote.attachments) as string[];
  if (!attachments.includes(fileId)) attachments.push(fileId);
  await ctx.db
    .updateTable('quoting_quotes')
    .set({ attachments: JSON.stringify(attachments), updated_at: nowIso() })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', quoteId)
    .execute();
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.quote.attachment_added', 'quoting.quote', quoteId, {
    fileId,
  });
  return getQuoteRow(ctx, quoteId);
}

export async function removeAttachment(ctx: QuotingCtx, quoteId: string, fileId: string): Promise<QuoteRow> {
  const quote = await getQuoteRow(ctx, quoteId);
  const attachments = (JSON.parse(quote.attachments) as string[]).filter((f) => f !== fileId);
  await ctx.db
    .updateTable('quoting_quotes')
    .set({ attachments: JSON.stringify(attachments), updated_at: nowIso() })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', quoteId)
    .execute();
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.quote.attachment_removed', 'quoting.quote', quoteId, {
    fileId,
  });
  return getQuoteRow(ctx, quoteId);
}

/* ------------------------------------------------------------------ *
 * Approval flow: draft -> sent -> viewed -> approved | declined | expired
 * ------------------------------------------------------------------ */

const TRANSITIONS: Record<ApprovalEventType, { from: QuoteStatus[]; to: QuoteStatus }> = {
  sent: { from: ['draft'], to: 'sent' },
  viewed: { from: ['sent', 'viewed'], to: 'viewed' },
  approved: { from: ['sent', 'viewed'], to: 'approved' },
  declined: { from: ['sent', 'viewed'], to: 'declined' },
  expired: { from: ['sent', 'viewed'], to: 'expired' },
};

function assertTransition(quote: QuoteRow, eventType: ApprovalEventType): void {
  const t = TRANSITIONS[eventType];
  if (!t.from.includes(quote.status)) {
    throw ApiError.conflict(`cannot mark a ${quote.status} quote as ${t.to}`);
  }
}

async function expireQuote(ctx: QuotingCtx, quote: QuoteRow, note: string): Promise<QuoteRow> {
  const updated = await setQuoteStatus(ctx, quote.id, 'expired');
  await recordApprovalEvent(ctx, updated, 'expired', { note });
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.quote.expired', 'quoting.quote', quote.id);
  await ctx.events.emit(ctx.tenantId, 'quoting.quote.expired', { quoteId: quote.id });
  return updated;
}

function isPastValidUntil(quote: QuoteRow): boolean {
  return quote.valid_until !== null && nowIso() > quote.valid_until;
}

export async function sendQuote(ctx: QuotingCtx, quoteId: string): Promise<QuoteWithDetails> {
  let quote = await getQuoteRow(ctx, quoteId);
  assertTransition(quote, 'sent');
  // Final recompute so the sent snapshot reflects current rules/prices.
  await recomputeQuote(ctx, quoteId);
  quote = await setQuoteStatus(ctx, quoteId, 'sent');
  await recordApprovalEvent(ctx, quote, 'sent');
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.quote.sent', 'quoting.quote', quoteId);
  await ctx.events.emit(ctx.tenantId, 'quoting.quote.sent', {
    quoteId,
    customerId: quote.customer_id,
    totalCents: quote.total_cents,
  });
  return getQuote(ctx, quoteId);
}

export async function markQuoteViewed(
  ctx: QuotingCtx,
  quoteId: string,
  extra: { signerIp?: string } = {},
): Promise<QuoteWithDetails> {
  let quote = await getQuoteRow(ctx, quoteId);
  if (isPastValidUntil(quote) && (quote.status === 'sent' || quote.status === 'viewed')) {
    await expireQuote(ctx, quote, 'auto-expired on view (valid_until passed)');
    throw ApiError.conflict('quote has expired');
  }
  assertTransition(quote, 'viewed');
  quote = await setQuoteStatus(ctx, quoteId, 'viewed');
  await recordApprovalEvent(ctx, quote, 'viewed', { signerIp: extra.signerIp });
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.quote.viewed', 'quoting.quote', quoteId);
  await ctx.events.emit(ctx.tenantId, 'quoting.quote.viewed', { quoteId });
  return getQuote(ctx, quoteId);
}

export async function approveQuote(
  ctx: QuotingCtx,
  quoteId: string,
  input: { signerName: string; signerIp?: string; note?: string },
): Promise<QuoteWithDetails> {
  let quote = await getQuoteRow(ctx, quoteId);
  if (isPastValidUntil(quote) && (quote.status === 'sent' || quote.status === 'viewed')) {
    await expireQuote(ctx, quote, 'auto-expired on approval attempt (valid_until passed)');
    throw ApiError.conflict('quote has expired');
  }
  assertTransition(quote, 'approved');
  if (!input.signerName || input.signerName.trim() === '') {
    throw ApiError.badRequest('signerName is required to approve a quote');
  }
  quote = await setQuoteStatus(ctx, quoteId, 'approved');
  await recordApprovalEvent(ctx, quote, 'approved', {
    signerName: input.signerName.trim(),
    signerIp: input.signerIp,
    note: input.note,
  });
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.quote.approved', 'quoting.quote', quoteId, {
    signerName: input.signerName.trim(),
  });
  await ctx.events.emit(ctx.tenantId, 'quoting.quote.approved', {
    quoteId,
    customerId: quote.customer_id,
    totalCents: quote.total_cents,
  });
  return getQuote(ctx, quoteId);
}

export async function declineQuote(
  ctx: QuotingCtx,
  quoteId: string,
  input: { signerName?: string; signerIp?: string; note?: string } = {},
): Promise<QuoteWithDetails> {
  let quote = await getQuoteRow(ctx, quoteId);
  assertTransition(quote, 'declined');
  quote = await setQuoteStatus(ctx, quoteId, 'declined');
  await recordApprovalEvent(ctx, quote, 'declined', input);
  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.quote.declined', 'quoting.quote', quoteId, {
    note: input.note ?? null,
  });
  await ctx.events.emit(ctx.tenantId, 'quoting.quote.declined', {
    quoteId,
    customerId: quote.customer_id,
  });
  return getQuote(ctx, quoteId);
}

export async function expireQuoteManually(ctx: QuotingCtx, quoteId: string): Promise<QuoteWithDetails> {
  const quote = await getQuoteRow(ctx, quoteId);
  assertTransition(quote, 'expired');
  await expireQuote(ctx, quote, 'manually expired');
  return getQuote(ctx, quoteId);
}

/* ------------------------------------------------------------------ *
 * Convert quote -> job (+ invoice via the createInvoice contract)
 * ------------------------------------------------------------------ */

export async function convertQuote(ctx: QuotingCtx, quoteId: string): Promise<ConvertQuoteResult> {
  const quote = await getQuoteRow(ctx, quoteId);
  if (quote.status !== 'approved') {
    throw ApiError.conflict(`only approved quotes can be converted (status: ${quote.status})`);
  }
  if (quote.converted_at !== null) {
    throw ApiError.conflict('quote has already been converted');
  }
  const lines = await getQuoteLines(ctx, quoteId);

  // The stored discount_cents already folds in quote-scope rule discounts,
  // so the job/invoice uses it as a single fixed discount — totals match the
  // approved quote to the cent.
  const job: ConvertQuoteResult['job'] = {
    customerId: quote.customer_id,
    title: quote.title,
    notes: quote.notes,
    sourceEntityType: 'quoting.quote',
    sourceEntityId: quote.id,
    lines: lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPriceCents: l.effective_unit_price_cents,
      discountBps: l.discount_bps ?? undefined,
      discountFixedCents: l.discount_fixed_cents ?? undefined,
    })),
    discountFixedCents: quote.discount_cents,
    taxBps: quote.tax_bps ?? undefined,
    subtotalCents: quote.subtotal_cents,
    totalCents: quote.total_cents,
  };

  let invoiceId: string | null = null;
  if (ctx.contracts.createInvoice) {
    const invoice = await ctx.contracts.createInvoice.createInvoice({
      tenantId: ctx.tenantId,
      customerId: quote.customer_id,
      lines: job.lines,
      discountFixedCents: quote.discount_cents,
      taxBps: quote.tax_bps ?? undefined,
      memo: quote.title,
      sourceEntityType: 'quoting.quote',
      sourceEntityId: quote.id,
    });
    invoiceId = invoice.id;
  }

  await ctx.db
    .updateTable('quoting_quotes')
    .set({ converted_at: nowIso(), invoice_id: invoiceId, updated_at: nowIso() })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', quoteId)
    .execute();

  await audit(asCoreDb(ctx.db), ctx.tenantId, ctx.actor, 'quoting.quote.converted', 'quoting.quote', quoteId, {
    invoiceId,
  });
  await ctx.events.emit(ctx.tenantId, 'quoting.quote.converted', { quoteId, invoiceId });

  return { job, invoiceId };
}
