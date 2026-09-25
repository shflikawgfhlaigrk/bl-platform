/**
 * @blacklabel/quoting — universal quoting/estimate engine.
 *
 * Events emitted (module.entity.verb):
 * - quoting.quote.created     { quoteId, customerId }
 * - quoting.quote.sent        { quoteId, customerId, totalCents }
 * - quoting.quote.viewed      { quoteId }
 * - quoting.quote.approved    { quoteId, customerId, totalCents }   (catalog)
 * - quoting.quote.declined    { quoteId, customerId }
 * - quoting.quote.expired     { quoteId }
 * - quoting.quote.converted   { quoteId, invoiceId }                (catalog)
 */

export const MODULE_KEY = 'quoting' as const;
export { getQuote, listQuotes, approveQuote, declineQuote, convertQuote, getQuoteConversion, recordQuoteConversion } from './service';

// Migrations
export { quotingMigrations } from './migrations';

// Router factory
export { quotingRouter, type QuotingRouterOptions } from './router';

// Seed helper
export { seedQuoting, type QuotingSeedResult } from './seed';

// Public row/database types
export type {
  QuotingDatabase,
  QuoteRow,
  QuoteLineRow,
  QuoteStatus,
  PricingRuleRow,
  PricingRuleScope,
  ServiceTemplateRow,
  TemplateLineItem,
  DiscountRow,
  TaxRow,
  ApprovalEventRow,
  ApprovalEventType,
} from './schema';
export { QUOTE_STATUSES } from './schema';

// Pricing-rule interpreter (safe, data-driven — no eval)
export {
  matchesCondition,
  matchesAllConditions,
  applyLineAction,
  quoteActionDiscountCents,
  parseStoredRule,
  RULE_OPS,
  LINE_RULE_ACTION_TYPES,
  QUOTE_RULE_ACTION_TYPES,
  LINE_RULE_FIELDS,
  QUOTE_RULE_FIELDS,
} from './rules';
export type {
  RuleCondition,
  RuleAction,
  RuleActionType,
  LineRuleActionType,
  QuoteRuleActionType,
  RuleOp,
  RuleAttributes,
  ParsedPricingRule,
} from './rules';

// Document (PDF) provider interface + HTML stub adapter
export { HtmlQuoteDocumentAdapter } from './pdf';
export type { QuoteDocumentProvider, QuoteDocumentModel, RenderedQuoteDocument } from './pdf';

// Payload hash (e-signature verification) + service types callers may need
export { quotePayloadHash } from './service';
export type {
  QuotingCtx,
  QuoteLineInput,
  CreateQuoteInput,
  UpdateQuoteInput,
  UpdateQuoteLineInput,
  PricingRuleInput,
  ServiceTemplateInput,
  DiscountInput,
  TaxInput,
  QuoteWithDetails,
  ConvertQuoteResult,
} from './service';
