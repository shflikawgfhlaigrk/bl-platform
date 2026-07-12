import type { CoreDatabase } from '@blacklabel/core';

/**
 * Row types for the quoting module. Conventions (see /CONVENTIONS.md):
 * - ids TEXT (nanoid via id()), timestamps TEXT ISO-8601 UTC (nowIso())
 * - money INTEGER cents, percentages INTEGER basis points (bps)
 * - booleans INTEGER 0/1, JSON serialized to TEXT
 * - cross-module references (customer_id, file ids, invoice_id) are id
 *   strings ONLY — no foreign keys into other modules' tables.
 */

export type QuoteStatus = 'draft' | 'sent' | 'viewed' | 'approved' | 'declined' | 'expired';

export const QUOTE_STATUSES: readonly QuoteStatus[] = [
  'draft',
  'sent',
  'viewed',
  'approved',
  'declined',
  'expired',
];

export interface QuoteRow {
  id: string;
  tenant_id: string;
  /** CRM customer id (string reference only). */
  customer_id: string;
  title: string;
  notes: string | null;
  status: QuoteStatus;
  /** Quote-level discount (percent part, bps). */
  discount_bps: number | null;
  /** Quote-level discount (fixed part, cents). */
  discount_fixed_cents: number | null;
  /** Provenance: quoting_discounts id the discount was applied from, if any. */
  discount_id: string | null;
  /** Provenance: quoting_taxes id the tax was applied from, if any. */
  tax_id: string | null;
  /** Tax rate snapshot in bps (survives later edits to the tax record). */
  tax_bps: number | null;
  /** ISO-8601 UTC; quote expires after this instant. */
  valid_until: string | null;
  /** JSON array of file id strings (files module references). */
  attachments: string;
  /* --- computed & stored on every recompute --- */
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  total_cents: number;
  /** Internal cost across all lines (cents). */
  total_cost_cents: number;
  /** Pre-tax revenue minus cost (cents, may be negative). */
  margin_cents: number;
  /** margin_cents / pre-tax revenue, in bps (0 when revenue is 0). */
  margin_bps: number;
  /* --- conversion --- */
  converted_at: string | null;
  /** Billing invoice id created on conversion (string reference only). */
  invoice_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuoteLineRow {
  id: string;
  tenant_id: string;
  quote_id: string;
  description: string;
  /** May be fractional (e.g. 2.5 hours). */
  quantity: number;
  /** Customer price per unit as entered (cents). */
  unit_price_cents: number;
  /** Internal cost per unit (cents). */
  unit_cost_cents: number;
  /** Unit price after pricing rules were applied (cents). */
  effective_unit_price_cents: number;
  /** Per-line discount (percent part, bps). */
  discount_bps: number | null;
  /** Per-line discount (fixed part, cents). */
  discount_fixed_cents: number | null;
  /** Line total after rules + line discount (cents). */
  total_cents: number;
  /** Sort order within the quote. */
  position: number;
  /** Provenance: template that produced this line, if any. */
  service_template_id: string | null;
  created_at: string;
}

export type PricingRuleScope = 'line' | 'quote';

export interface PricingRuleRow {
  id: string;
  tenant_id: string;
  name: string;
  scope: PricingRuleScope;
  /** JSON array of RuleCondition ({field, op, value}); all must match (AND). */
  conditions: string;
  /** JSON RuleAction ({type, amount}). */
  action: string;
  active: number;
  /** Lower runs first. */
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface ServiceTemplateRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  /** JSON array of TemplateLineItem. */
  line_items: string;
  /** JSON array of child template ids (bundles/packages). */
  child_template_ids: string;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface DiscountRow {
  id: string;
  tenant_id: string;
  name: string;
  bps: number | null;
  fixed_cents: number | null;
  active: number;
  created_at: string;
}

export interface TaxRow {
  id: string;
  tenant_id: string;
  name: string;
  rate_bps: number;
  active: number;
  created_at: string;
}

export type ApprovalEventType = 'sent' | 'viewed' | 'approved' | 'declined' | 'expired';

export interface ApprovalEventRow {
  id: string;
  tenant_id: string;
  quote_id: string;
  /** Monotonic per-quote sequence (deterministic event ordering). */
  seq: number;
  event_type: ApprovalEventType;
  /** E-signature-ready fields. */
  signer_name: string | null;
  signer_ip: string | null;
  /** sha256 hex of the canonical quote payload at event time. */
  payload_hash: string;
  note: string | null;
  created_at: string;
}

/** Default line item stored inside a ServiceTemplate (JSON, not a table). */
export interface TemplateLineItem {
  description: string;
  quantity: number;
  unitPriceCents: number;
  unitCostCents?: number;
  discountBps?: number;
  discountFixedCents?: number;
}

export interface QuotingDatabase extends CoreDatabase {
  quoting_quotes: QuoteRow;
  quoting_quote_lines: QuoteLineRow;
  quoting_pricing_rules: PricingRuleRow;
  quoting_service_templates: ServiceTemplateRow;
  quoting_discounts: DiscountRow;
  quoting_taxes: TaxRow;
  quoting_approval_events: ApprovalEventRow;
}
