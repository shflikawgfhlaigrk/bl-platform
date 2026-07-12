import { describe, expect, it } from 'vitest';
import { getInit, jsonInit, setup } from './helpers';

const platformBody = {
  key: 'google_business',
  name: 'Google Business Profile',
  targetUrl: 'https://example.com/reviews/profile',
  provider: 'google_business',
};

describe('reviews router — platforms', () => {
  it('creates and fetches a platform (enabled is a real boolean)', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request('/platforms', jsonInit(tenantA.id, platformBody));
    expect(res.status).toBe(201);
    const created = ((await res.json()) as any).data;
    expect(created.enabled).toBe(true);
    expect(created.tenant_id).toBe(tenantA.id);

    const get = await app.request(`/platforms/${created.id}`, getInit(tenantA.id));
    expect(get.status).toBe(200);
    expect(((await get.json()) as any).data.name).toBe('Google Business Profile');
  });

  it('lists platforms with the canonical list envelope', async () => {
    const { app, tenantA } = await setup();
    await app.request('/platforms', jsonInit(tenantA.id, platformBody));
    const res = await app.request('/platforms', getInit(tenantA.id));
    const body = (await res.json()) as any;
    expect(body.data).toHaveLength(1);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it('rejects a duplicate platform key with 409', async () => {
    const { app, tenantA } = await setup();
    await app.request('/platforms', jsonInit(tenantA.id, platformBody));
    const res = await app.request('/platforms', jsonInit(tenantA.id, platformBody));
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe('conflict');
  });

  it('patches and deletes a platform', async () => {
    const { app, tenantA } = await setup();
    const created = (
      (await (await app.request('/platforms', jsonInit(tenantA.id, platformBody))).json()) as any
    ).data;

    const patch = await app.request(
      `/platforms/${created.id}`,
      jsonInit(tenantA.id, { name: 'Renamed', enabled: false }, 'PATCH'),
    );
    expect(patch.status).toBe(200);
    const patched = ((await patch.json()) as any).data;
    expect(patched.name).toBe('Renamed');
    expect(patched.enabled).toBe(false);

    const del = await app.request(`/platforms/${created.id}`, jsonInit(tenantA.id, undefined, 'DELETE'));
    expect(del.status).toBe(200);
    const get = await app.request(`/platforms/${created.id}`, getInit(tenantA.id));
    expect(get.status).toBe(404);
  });

  it('returns 400 with validation details on a bad body', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request('/platforms', jsonInit(tenantA.id, { key: 'NOT VALID', name: '' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe('validation_error');
  });

  it('requires the x-tenant-id header on tenant routes', async () => {
    const { app } = await setup();
    const res = await app.request('/platforms', getInit(null));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe('tenant_header_missing');
  });
});

describe('reviews router — campaigns & requests', () => {
  it('creating a campaign creates one pending request per unique audience customer', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request(
      '/campaigns',
      jsonInit(tenantA.id, {
        name: 'Post-visit push',
        customerIds: ['cust_1', 'cust_2', 'cust_2', 'cust_3'],
        ratingThreshold: 4,
        throttlePerDay: 10,
      }),
    );
    expect(res.status).toBe(201);
    const { campaign, requests } = ((await res.json()) as any).data;
    expect(campaign.status).toBe('active');
    expect(requests).toHaveLength(3); // deduplicated audience
    expect(requests.every((r: any) => r.status === 'pending')).toBe(true);
    expect(requests.every((r: any) => r.rating_threshold === 4)).toBe(true);

    const list = await app.request(`/requests?campaign_id=${campaign.id}`, getInit(tenantA.id));
    expect(((await list.json()) as any).data).toHaveLength(3);

    const stats = await app.request(`/campaigns/${campaign.id}`, getInit(tenantA.id));
    expect(((await stats.json()) as any).data.requests).toEqual({
      total: 3,
      pending: 3,
      clicked: 0,
      completed: 0,
      opted_out: 0,
    });
  });

  it('dispatch endpoint sends pending requests up to the throttle', async () => {
    const { app, tenantA } = await setup();
    const { campaign } = (
      (await (
        await app.request(
          '/campaigns',
          jsonInit(tenantA.id, { name: 'Throttled', customerIds: ['c1', 'c2', 'c3'], throttlePerDay: 2 }),
        )
      ).json()) as any
    ).data;

    const res = await app.request(`/campaigns/${campaign.id}/dispatch`, jsonInit(tenantA.id, undefined));
    expect(((await res.json()) as any).data).toEqual({ dispatched: 2, reason: null });

    const again = await app.request(`/campaigns/${campaign.id}/dispatch`, jsonInit(tenantA.id, undefined));
    expect(((await again.json()) as any).data).toEqual({ dispatched: 0, reason: 'throttled' });
  });

  it('creates a standalone request and serves its tokenized link with the QR placeholder contract', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request('/requests', jsonInit(tenantA.id, { customerId: 'cust_9' }));
    expect(res.status).toBe(201);
    const request = ((await res.json()) as any).data;
    expect(request.status).toBe('pending');
    expect(request.token.length).toBeGreaterThanOrEqual(40);

    const linkRes = await app.request(`/requests/${request.id}/link`, getInit(tenantA.id));
    expect(linkRes.status).toBe(200);
    const link = ((await linkRes.json()) as any).data;
    expect(link).toEqual({
      requestId: request.id,
      token: request.token,
      url: `/api/reviews/public/requests/${request.token}`,
      qr: 'placeholder',
    });
  });

  it('writes audit entries for mutations', async () => {
    const { app, db, tenantA } = await setup();
    await app.request('/platforms', jsonInit(tenantA.id, platformBody));
    await app.request('/requests', jsonInit(tenantA.id, { customerId: 'cust_1' }));
    const entries = await db
      .selectFrom('audit_log')
      .select(['action', 'tenant_id'])
      .where('tenant_id', '=', tenantA.id)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('reviews.platform.created');
    expect(actions).toContain('reviews.request.created');
  });
});

describe('reviews router — testimonials', () => {
  it('rejects a testimonial without explicit consent', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request(
      '/testimonials',
      jsonInit(tenantA.id, { customerId: 'cust_1', quote: 'Great work', consent: false }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.message).toContain('consent');
  });

  it('captures a consented testimonial and emits reviews.testimonial.captured', async () => {
    const { app, events, tenantA } = await setup();
    const captured: any[] = [];
    events.on('reviews.testimonial.captured', (e) => {
      captured.push(e);
    });

    const res = await app.request(
      '/testimonials',
      jsonInit(tenantA.id, { customerId: 'cust_1', quote: 'Great work', authorName: 'Pat', consent: true }),
    );
    expect(res.status).toBe(201);
    const testimonial = ((await res.json()) as any).data;
    expect(testimonial.consent).toBe(true);

    expect(captured).toHaveLength(1);
    expect(captured[0].tenantId).toBe(tenantA.id);
    expect(captured[0].payload).toEqual({ testimonialId: testimonial.id, customerId: 'cust_1' });

    const list = await app.request('/testimonials', getInit(tenantA.id));
    expect(((await list.json()) as any).data).toHaveLength(1);
  });
});

describe('reviews router — dashboard', () => {
  it('aggregates volume, average rating, and response rate', async () => {
    const { app, tenantA } = await setup();
    const { requests } = (
      (await (
        await app.request(
          '/campaigns',
          jsonInit(tenantA.id, { name: 'Agg', customerIds: ['c1', 'c2'], ratingThreshold: 4 }),
        )
      ).json()) as any
    ).data;

    // One customer completes with a 5-star review; the other never responds.
    const submit = await app.request(
      `/public/requests/${requests[0].token}/submit`,
      jsonInit(null, { rating: 5 }),
    );
    expect(submit.status).toBe(201);

    const res = await app.request('/dashboard', getInit(tenantA.id));
    const dashboard = ((await res.json()) as any).data;
    expect(dashboard.requests.total).toBe(2);
    expect(dashboard.requests.completed).toBe(1);
    expect(dashboard.reviews.volume).toBe(1);
    expect(dashboard.reviews.averageRating).toBe(5);
    expect(dashboard.reviews.positive).toBe(1);
    expect(dashboard.responseRate).toBe(0.5);
  });
});
