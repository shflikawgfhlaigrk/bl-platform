/**
 * Row types for the billing module tables. All tables are tenant-scoped and
 * follow /CONVENTIONS.md: text ids from id(), ISO-8601 UTC text timestamps,
 * integer cents for money, basis points for percentages, integer 0/1 booleans.
 */
import type { CoreDatabase } from '@blacklabel/core';

/**
 * Invoice payment-status lifecycle. Computed from recorded payments vs the
 * invoice total (see computeInvoiceStatus in service.ts):
 *
 *   draft -> sent -> partial -> paid
 *                 \-> overdue (sent/partial and past due_at)
 *   void: terminal, manual, only while unpaid
 */
export type InvoiceStatus = 'draft' | 'sent' | 'partial' | 'paid' | 'overdue' | 'void';

export type SubscriptionStatus = 'active' | 'paused' | 'canceled';

export type SubscriptionInterval = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export type MembershipStatus = 'active' | 'paused' | 'canceled' | 'expired';

/** A customer's billing profile. `customer_id` is an id-string reference to the crm module. */
export interface BillingAccountRow {
  id: string;
  tenant_id: string;
  customer_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface BillingInvoiceRow {
  id: string;
  tenant_id: string;
  /** Optional link to a billing_accounts row (same tenant). */
  billing_account_id: string | null;
  /** id-string reference to the crm customer. */
  customer_id: string;
  /** Per-tenant sequential number: INV-{seq}. Unique per tenant. */
  number: string;
  status: InvoiceStatus;
  /** Invoice-level discount (applied after line discounts, before tax). */
  discount_bps: number | null;
  discount_fixed_cents: number | null;
  /** Tax in basis points, applied after all discounts. */
  tax_bps: number | null;
  /** Stored outputs of core computeTotals — integer cents. */
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  total_cents: number;
  /** Sum of succeeded payments — denormalized for status math + CSV. */
  paid_cents: number;
  due_at: string | null;
  sent_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
  memo: string | null;
  /** Provenance, e.g. "quoting.quote" + quote id when converted from a quote. */
  source_entity_type: string | null;
  source_entity_id: string | null;
  /** 0/1 — whether the customer portal may show this invoice. */
  portal_visible: number;
  /** JSON object of custom-field values (keys = core custom-field definition keys). */
  custom: string | null;
  created_at: string;
  updated_at: string;
}

export interface BillingInvoiceLineRow {
  id: string;
  tenant_id: string;
  invoice_id: string;
  /** 0-based ordering within the invoice. */
  position: number;
  description: string;
  /** May be fractional (e.g. 2.5 hours). */
  quantity: number;
  unit_price_cents: number;
  /** Line-level discount (applied before the invoice-level discount). */
  discount_bps: number | null;
  discount_fixed_cents: number | null;
  /** round(quantity * unit_price_cents) after the line discount. */
  line_total_cents: number;
  created_at: string;
}

export interface BillingPaymentRow {
  id: string;
  tenant_id: string;
  invoice_id: string;
  amount_cents: number;
  /** How it was collected: "manual", "cash", "check", "card", "provider:<key>", ... */
  method: string;
  /** Payment provider key when provider-originated (e.g. "stub"), else null. */
  provider: string | null;
  /** Provider-side reference (e.g. a payment-intent id), else null. */
  provider_ref: string | null;
  /** Only "succeeded" payments count toward paid_cents. */
  status: 'succeeded' | 'refunded';
  note: string | null;
  received_at: string;
  created_at: string;
}

/** Recurring-invoice placeholder: one line-item template + a schedule. */
export interface BillingSubscriptionRow {
  id: string;
  tenant_id: string;
  customer_id: string;
  billing_account_id: string | null;
  plan_name: string;
  amount_cents: number;
  tax_bps: number | null;
  interval: SubscriptionInterval;
  status: SubscriptionStatus;
  /** Next time generateDueInvoices() should produce an invoice. ISO-8601 UTC. */
  next_invoice_at: string;
  created_at: string;
  updated_at: string;
}

/** Links a customer to a plan with a status. `plan_key` is an industry-neutral identifier. */
export interface BillingMembershipRow {
  id: string;
  tenant_id: string;
  customer_id: string;
  plan_key: string;
  status: MembershipStatus;
  /** Optional link to the subscription that bills this membership. */
  subscription_id: string | null;
  started_at: string;
  ends_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Per-tenant invoice-number sequence (INV-{seq}). */
export interface BillingInvoiceCounterRow {
  tenant_id: string;
  next_seq: number;
}

/** Raw payment-provider webhook events, stored before processing. */
export interface BillingWebhookEventRow {
  id: string;
  tenant_id: string;
  provider: string;
  event_type: string | null;
  /** Raw JSON payload as received. */
  payload: string;
  /** JSON-serialized normalized outcome, or null if ignored/unprocessed. */
  outcome: string | null;
  /** 0/1 — whether the event resulted in a recorded payment. */
  processed: number;
  created_at: string;
}

export interface BillingDatabase extends CoreDatabase {
  billing_accounts: BillingAccountRow;
  billing_invoices: BillingInvoiceRow;
  billing_invoice_lines: BillingInvoiceLineRow;
  billing_payments: BillingPaymentRow;
  billing_subscriptions: BillingSubscriptionRow;
  billing_memberships: BillingMembershipRow;
  billing_invoice_counters: BillingInvoiceCounterRow;
  billing_webhook_events: BillingWebhookEventRow;
}
