import { describe, expect, it } from 'vitest';
import { getInit, jsonInit, setup } from './helpers';

async function makeRequest(app: any, tenantId: string, threshold = 4) {
  const res = await app.request(
    '/requests',
    jsonInit(tenantId, { customerId: 'cust_pub', ratingThreshold: threshold }),
  );
  return ((await res.json()) as any).data;
}

async function addPlatform(app: any, tenantId: string, key: string, enabled = true) {
  const res = await app.request(
    '/platforms',
    jsonInit(tenantId, {
      key,
      name: `Platform ${key}`,
      targetUrl: `https://example.com/${key}`,
      enabled,
    }),
  );
  return ((await res.json()) as any).data;
}

describe('public tokenized flow', () => {
  it('serves the landing view with NO tenant header and marks the request clicked', async () => {
    const { app, db, tenantA } = await setup();
    const request = await makeRequest(app, tenantA.id);

    const res = await app.request(`/public/requests/${request.token}`, getInit(null));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data).toEqual({ status: 'clicked', submitted: false });

    const row = await db
      .selectFrom('reviews_requests')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .where('id', '=', request.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('clicked');
    expect(row.clicked_at).not.toBeNull();

    // A second visit does not reset clicked_at.
    await app.request(`/public/requests/${request.token}`, getInit(null));
    const again = await db
      .selectFrom('reviews_requests')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .where('id', '=', request.id)
      .executeTakeFirstOrThrow();
    expect(again.clicked_at).toBe(row.clicked_at);
  });

  it('token security: an invalid token is a 404 on every public endpoint', async () => {
    const { app } = await setup();
    expect((await app.request('/public/requests/not-a-real-token', getInit(null))).status).toBe(404);
    expect(
      (await app.request('/public/requests/not-a-real-token/submit', jsonInit(null, { rating: 5 }))).status,
    ).toBe(404);
    expect(
      (await app.request('/public/requests/not-a-real-token/opt-out', jsonInit(null, undefined))).status,
    ).toBe(404);
  });

  it('positive gate: rating >= threshold returns enabled platform links and completes the request', async () => {
    const { app, db, events, tenantA } = await setup();
    const enabledPlatform = await addPlatform(app, tenantA.id, 'alpha', true);
    await addPlatform(app, tenantA.id, 'bravo', false); // disabled — must never be offered
    const request = await makeRequest(app, tenantA.id, 4);

    const emitted: any[] = [];
    events.on('reviews.review.submitted', (e) => {
      emitted.push(e);
    });

    const res = await app.request(
      `/public/requests/${request.token}/submit`,
      jsonInit(null, { rating: 5, comment: 'Wonderful' }),
    );
    expect(res.status).toBe(201);
    const result = ((await res.json()) as any).data;
    expect(result.gate).toBe('positive');
    expect(result.platforms).toEqual([
      { id: enabledPlatform.id, key: 'alpha', name: 'Platform alpha', url: 'https://example.com/alpha' },
    ]);
    expect(result.response.sentiment).toBe('positive');
    expect(result.response.flagged_for_followup).toBe(false);

    const row = await db
      .selectFrom('reviews_requests')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .where('id', '=', request.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('completed');
    expect(row.completed_at).not.toBeNull();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe('reviews.review.submitted');
    expect(emitted[0].tenantId).toBe(tenantA.id);
    expect(emitted[0].payload).toEqual({
      reviewId: result.response.id,
      requestId: request.id,
      customerId: 'cust_pub',
      rating: 5,
      sentiment: 'positive',
    });
  });

  it('boundary: a rating exactly at the threshold gates positive', async () => {
    const { app, tenantA } = await setup();
    await addPlatform(app, tenantA.id, 'alpha');
    const request = await makeRequest(app, tenantA.id, 3);
    const res = await app.request(`/public/requests/${request.token}/submit`, jsonInit(null, { rating: 3 }));
    expect(((await res.json()) as any).data.gate).toBe('positive');
  });

  it('negative gate: below-threshold captures private feedback flagged for follow-up, no platform links', async () => {
    const { app, events, tenantA } = await setup();
    await addPlatform(app, tenantA.id, 'alpha');
    const request = await makeRequest(app, tenantA.id, 4);

    const emitted: any[] = [];
    events.on('reviews.review.submitted', (e) => {
      emitted.push(e);
    });

    const res = await app.request(
      `/public/requests/${request.token}/submit`,
      jsonInit(null, { rating: 2, comment: 'The crew arrived two hours late.' }),
    );
    expect(res.status).toBe(201);
    const result = ((await res.json()) as any).data;
    expect(result.gate).toBe('negative');
    expect(result.platforms).toEqual([]); // never funnel unhappy customers to public platforms
    expect(result.response.flagged_for_followup).toBe(true);
    expect(result.response.comment).toBe('The crew arrived two hours late.');

    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload.rating).toBe(2);
    expect(emitted[0].payload.sentiment).toBe('negative');

    // Flagged feedback is visible to the tenant for follow-up.
    const flagged = await app.request('/responses?flagged=true', getInit(tenantA.id));
    const list = ((await flagged.json()) as any).data;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(result.response.id);
  });

  it('rejects a second submission for the same request with 409', async () => {
    const { app, tenantA } = await setup();
    const request = await makeRequest(app, tenantA.id);
    await app.request(`/public/requests/${request.token}/submit`, jsonInit(null, { rating: 5 }));
    const second = await app.request(
      `/public/requests/${request.token}/submit`,
      jsonInit(null, { rating: 1 }),
    );
    expect(second.status).toBe(409);
  });

  it('validates the public rating body (rating 1..5)', async () => {
    const { app, tenantA } = await setup();
    const request = await makeRequest(app, tenantA.id);
    const res = await app.request(`/public/requests/${request.token}/submit`, jsonInit(null, { rating: 9 }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe('validation_error');
  });

  it('opt-out stops everything: status, reminders, and future submissions', async () => {
    const { app, db, events, tenantA } = await setup();
    const request = await makeRequest(app, tenantA.id);
    await app.request(
      `/requests/${request.id}/reminders`,
      jsonInit(tenantA.id, { sendAt: '2020-01-01T00:00:00.000Z' }),
    );

    const emitted: any[] = [];
    events.on('reviews.request.opted_out', (e) => {
      emitted.push(e);
    });

    const res = await app.request(`/public/requests/${request.token}/opt-out`, jsonInit(null, undefined));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.status).toBe('opted_out');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload).toEqual({ requestId: request.id, customerId: 'cust_pub' });

    const reminders = await db
      .selectFrom('reviews_reminders')
      .selectAll()
      .where('tenant_id', '=', tenantA.id)
      .where('request_id', '=', request.id)
      .execute();
    expect(reminders).toHaveLength(1);
    expect(reminders[0].status).toBe('canceled');

    const submit = await app.request(
      `/public/requests/${request.token}/submit`,
      jsonInit(null, { rating: 5 }),
    );
    expect(submit.status).toBe(409);

    // Opt-out is idempotent.
    const again = await app.request(`/public/requests/${request.token}/opt-out`, jsonInit(null, undefined));
    expect(again.status).toBe(200);
  });

  it('never leaks internal ids (tenant_id, customer_id, request_id) on the public endpoints', async () => {
    const { app, tenantA } = await setup();
    await addPlatform(app, tenantA.id, 'alpha');
    const request = await makeRequest(app, tenantA.id);

    // tenant_id is the header credential for every tenant-scoped route —
    // exposing it on a public, token-only endpoint would hand any review
    // recipient the whole tenant. It must never appear in a public payload.
    const landing = (await (
      await app.request(`/public/requests/${request.token}`, getInit(null))
    ).json()) as any;
    expect(JSON.stringify(landing)).not.toContain(tenantA.id);

    const submit = (await (
      await app.request(`/public/requests/${request.token}/submit`, jsonInit(null, { rating: 5 }))
    ).json()) as any;
    expect(JSON.stringify(submit)).not.toContain(tenantA.id);
    expect(submit.data.response.tenant_id).toBeUndefined();
    expect(submit.data.response.customer_id).toBeUndefined();
    expect(submit.data.response.request_id).toBeUndefined();
    expect(submit.data.response.id).toBeDefined();

    const optOutRequest = await makeRequest(app, tenantA.id);
    const optOut = (await (
      await app.request(`/public/requests/${optOutRequest.token}/opt-out`, jsonInit(null, undefined))
    ).json()) as any;
    expect(JSON.stringify(optOut)).not.toContain(tenantA.id);
  });

  it('cross-tenant safety: a positive gate only ever offers the token tenant platforms', async () => {
    const { app, tenantA, tenantB } = await setup();
    await addPlatform(app, tenantA.id, 'tenant_a_place');
    await addPlatform(app, tenantB.id, 'tenant_b_place');
    const request = await makeRequest(app, tenantA.id);

    const res = await app.request(`/public/requests/${request.token}/submit`, jsonInit(null, { rating: 5 }));
    const result = ((await res.json()) as any).data;
    expect(result.platforms).toHaveLength(1);
    expect(result.platforms[0].key).toBe('tenant_a_place');
  });
});
