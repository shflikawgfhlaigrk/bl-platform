/**
 * @blacklabel/reviews — Review Engine: request, track, and improve GENUINE
 * customer reviews. This module never fabricates reviews; it only asks real
 * customers for real feedback.
 *
 * Events emitted (module.entity.verb):
 * - `reviews.review.submitted`   { reviewId, requestId, customerId, rating, sentiment }  (catalog event)
 * - `reviews.campaign.created`   { campaignId, requestCount }
 * - `reviews.request.created`    { requestId, customerId, campaignId }
 * - `reviews.request.opted_out`  { requestId, customerId }
 * - `reviews.reminder.scheduled` { reminderId, requestId, sendAt }
 * - `reviews.testimonial.captured` { testimonialId, customerId }
 */
export const MODULE_KEY = 'reviews' as const;
export { listRequests, getRequestLink, processDueReminders } from './service';
export { createRequest } from './service';

// Migrations
export { reviewsMigrations } from './migrations';

// Router factory
export { reviewsRouter } from './router';

// Seed helper
export { seedReviews } from './seed';
export type { ReviewsSeedResult } from './seed';

// Provider interface + Google-Business-ready no-op stub (wired by apps/api)
export { GoogleBusinessProvider } from './service';
export type {
  ReviewProvider,
  ReviewProviderSendContext,
  ReviewProviderReminderContext,
  ReviewProviderSyncContext,
} from './service';

// Public types
export {
  DEFAULT_RATING_THRESHOLD,
  DEFAULT_THROTTLE_PER_DAY,
  reviewRequestPublicPath,
} from './service';
export type {
  ReviewPlatform,
  ReviewResponse,
  PublicReviewResponse,
  ReviewTestimonial,
  ReviewDashboard,
  RequestLink,
  DispatchResult,
  GatedSubmitResult,
  CampaignRequestStats,
} from './service';
export type {
  ReviewsDatabase,
  ReviewPlatformRow,
  ReviewCampaignRow,
  ReviewRequestRow,
  ReviewResponseRow,
  ReviewTestimonialRow,
  ReviewReminderRow,
  ReviewRequestStatus,
  ReviewCampaignStatus,
  ReviewSentiment,
  ReviewReminderStatus,
} from './schema';
