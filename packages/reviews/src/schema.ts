/**
 * Row types for the reviews module tables.
 *
 * Conventions (see /CONVENTIONS.md):
 * - ids: TEXT, nanoid, generated in code via id()
 * - timestamps: TEXT, ISO-8601 UTC via nowIso()
 * - booleans: INTEGER 0/1 (converted to real booleans at the service boundary)
 * - cross-module references (customer_id) are id STRINGS only — no FKs, no joins
 */
import type { CoreDatabase } from '@blacklabel/core';

/** Lifecycle of a per-customer review request. */
export type ReviewRequestStatus = 'pending' | 'clicked' | 'completed' | 'opted_out';

export type ReviewCampaignStatus = 'active' | 'paused' | 'completed';

/** Gating outcome of a submitted rating. */
export type ReviewSentiment = 'positive' | 'negative';

export type ReviewReminderStatus = 'scheduled' | 'sent' | 'canceled';

/** A per-tenant configured review destination (e.g. a business profile page). */
export interface ReviewPlatformRow {
  id: string;
  tenant_id: string;
  /** Machine key, /^[a-z][a-z0-9_]*$/, unique per tenant. */
  key: string;
  name: string;
  /** Where a happy customer is sent to leave a public review. */
  target_url: string;
  /** Provider implementation key, e.g. "google_business" or "generic". */
  provider: string;
  /** 0/1 — disabled platforms are never shown to customers. */
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ReviewCampaignRow {
  id: string;
  tenant_id: string;
  name: string;
  status: string; // ReviewCampaignStatus
  /** Ratings >= threshold gate to public platform links; below → private feedback. */
  rating_threshold: number;
  /** Max requests dispatched per UTC day. */
  throttle_per_day: number;
  /** ISO-8601 UTC; dispatch is a no-op before this instant. Null = immediately. */
  schedule_start_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewRequestRow {
  id: string;
  tenant_id: string;
  /** Null for standalone (non-campaign) requests. */
  campaign_id: string | null;
  /** CRM customer id — cross-module reference by id string only. */
  customer_id: string;
  /** Secret, globally-unique public-link token. The token IS the credential. */
  token: string;
  status: string; // ReviewRequestStatus
  /** Copied from the campaign (or default) at creation time. */
  rating_threshold: number;
  sent_at: string | null;
  clicked_at: string | null;
  completed_at: string | null;
  opted_out_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A real customer's submitted rating/feedback. Positive gates record the
 * rating before hand-off to platform links; negative gates capture the
 * private feedback form and are flagged for follow-up.
 */
export interface ReviewResponseRow {
  id: string;
  tenant_id: string;
  request_id: string;
  customer_id: string;
  rating: number;
  comment: string | null;
  sentiment: string; // ReviewSentiment
  /** 0/1 — negative responses are flagged until resolved. */
  flagged_for_followup: number;
  resolved_at: string | null;
  created_at: string;
}

export interface ReviewTestimonialRow {
  id: string;
  tenant_id: string;
  customer_id: string;
  /** Optional link back to the response the quote came from. */
  response_id: string | null;
  quote: string;
  author_name: string | null;
  /** 0/1 — explicit customer consent. Always 1: capture without consent is rejected. */
  consent: number;
  created_at: string;
}

export interface ReviewReminderRow {
  id: string;
  tenant_id: string;
  request_id: string;
  /** ISO-8601 UTC — when the follow-up should go out. */
  send_at: string;
  status: string; // ReviewReminderStatus
  sent_at: string | null;
  created_at: string;
}

export interface ReviewsDatabase extends CoreDatabase {
  reviews_platforms: ReviewPlatformRow;
  reviews_campaigns: ReviewCampaignRow;
  reviews_requests: ReviewRequestRow;
  reviews_responses: ReviewResponseRow;
  reviews_testimonials: ReviewTestimonialRow;
  reviews_reminders: ReviewReminderRow;
}
