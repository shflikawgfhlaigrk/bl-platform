/**
 * Demo data for the reviews module. Direct row inserts (no events, no audit)
 * — this is a dev/demo helper, not a business operation. Customer ids are
 * plain reference strings (cross-module references are ids only).
 */
import type { Kysely } from 'kysely';
import { id, nowIso } from '@blacklabel/core';
import type {
  ReviewCampaignRow,
  ReviewPlatformRow,
  ReviewReminderRow,
  ReviewRequestRow,
  ReviewResponseRow,
  ReviewTestimonialRow,
  ReviewsDatabase,
} from './schema';

export interface ReviewsSeedResult {
  platformIds: string[];
  campaignId: string;
  requestIds: string[];
  responseIds: string[];
  testimonialId: string;
  reminderId: string;
}

export async function seedReviews(
  db: Kysely<ReviewsDatabase>,
  tenantId: string,
): Promise<ReviewsSeedResult> {
  const now = nowIso();

  const platforms: ReviewPlatformRow[] = [
    {
      id: id(),
      tenant_id: tenantId,
      key: 'google_business',
      name: 'Google Business Profile',
      target_url: 'https://example.com/reviews/google-profile',
      provider: 'google_business',
      enabled: 1,
      created_at: now,
      updated_at: now,
    },
    {
      id: id(),
      tenant_id: tenantId,
      key: 'facebook',
      name: 'Facebook Page',
      target_url: 'https://example.com/reviews/facebook-page',
      provider: 'generic',
      enabled: 1,
      created_at: now,
      updated_at: now,
    },
  ];
  await db.insertInto('reviews_platforms').values(platforms).execute();

  const campaign: ReviewCampaignRow = {
    id: id(),
    tenant_id: tenantId,
    name: 'Post-visit review push',
    status: 'active',
    rating_threshold: 4,
    throttle_per_day: 25,
    schedule_start_at: null,
    created_at: now,
    updated_at: now,
  };
  await db.insertInto('reviews_campaigns').values(campaign).execute();

  const mkRequest = (customerId: string, status: string): ReviewRequestRow => ({
    id: id(),
    tenant_id: tenantId,
    campaign_id: campaign.id,
    customer_id: customerId,
    token: `${id()}${id()}`,
    status,
    rating_threshold: campaign.rating_threshold,
    sent_at: status === 'pending' ? null : now,
    clicked_at: status === 'pending' ? null : now,
    completed_at: status === 'completed' ? now : null,
    opted_out_at: null,
    created_at: now,
    updated_at: now,
  });
  const requests = [
    mkRequest('demo_customer_1', 'completed'),
    mkRequest('demo_customer_2', 'completed'),
    mkRequest('demo_customer_3', 'pending'),
  ];
  await db.insertInto('reviews_requests').values(requests).execute();

  const responses: ReviewResponseRow[] = [
    {
      id: id(),
      tenant_id: tenantId,
      request_id: requests[0].id,
      customer_id: requests[0].customer_id,
      rating: 5,
      comment: 'Fast, friendly, and exactly what we needed.',
      sentiment: 'positive',
      flagged_for_followup: 0,
      resolved_at: null,
      created_at: now,
    },
    {
      id: id(),
      tenant_id: tenantId,
      request_id: requests[1].id,
      customer_id: requests[1].customer_id,
      rating: 2,
      comment: 'The appointment started late and nobody told us.',
      sentiment: 'negative',
      flagged_for_followup: 1,
      resolved_at: null,
      created_at: now,
    },
  ];
  await db.insertInto('reviews_responses').values(responses).execute();

  const testimonial: ReviewTestimonialRow = {
    id: id(),
    tenant_id: tenantId,
    customer_id: requests[0].customer_id,
    response_id: responses[0].id,
    quote: 'Fast, friendly, and exactly what we needed.',
    author_name: 'Demo Customer',
    consent: 1, // testimonials are only ever stored with explicit consent
    created_at: now,
  };
  await db.insertInto('reviews_testimonials').values(testimonial).execute();

  const reminder: ReviewReminderRow = {
    id: id(),
    tenant_id: tenantId,
    request_id: requests[2].id,
    send_at: now,
    status: 'scheduled',
    sent_at: null,
    created_at: now,
  };
  await db.insertInto('reviews_reminders').values(reminder).execute();

  return {
    platformIds: platforms.map((p) => p.id),
    campaignId: campaign.id,
    requestIds: requests.map((r) => r.id),
    responseIds: responses.map((r) => r.id),
    testimonialId: testimonial.id,
    reminderId: reminder.id,
  };
}
