import { describe, expect, it } from 'vitest';
import { seedReviews } from '@blacklabel/reviews';
import { getInit, setup } from './helpers';

describe('seedReviews', () => {
  it('seeds demo data scoped to one tenant and consistent with the dashboard', async () => {
    const { app, db, tenantA, tenantB } = await setup();
    const result = await seedReviews(db, tenantA.id);

    expect(result.platformIds).toHaveLength(2);
    expect(result.requestIds).toHaveLength(3);
    expect(result.responseIds).toHaveLength(2);

    const dashboard = ((await (await app.request('/dashboard', getInit(tenantA.id))).json()) as any).data;
    expect(dashboard.requests.total).toBe(3);
    expect(dashboard.requests.completed).toBe(2);
    expect(dashboard.reviews.volume).toBe(2);
    expect(dashboard.reviews.averageRating).toBe(3.5); // (5 + 2) / 2
    expect(dashboard.reviews.flaggedOpen).toBe(1);
    expect(dashboard.testimonials).toBe(1);

    // Seeded data never leaks into another tenant.
    const other = ((await (await app.request('/dashboard', getInit(tenantB.id))).json()) as any).data;
    expect(other.requests.total).toBe(0);
    expect(other.testimonials).toBe(0);

    // Seeded testimonial carries explicit consent — never stored without it.
    const testimonials = ((await (await app.request('/testimonials', getInit(tenantA.id))).json()) as any)
      .data;
    expect(testimonials).toHaveLength(1);
    expect(testimonials[0].consent).toBe(true);
  });
});
