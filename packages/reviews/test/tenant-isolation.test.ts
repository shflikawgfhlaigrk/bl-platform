/**
 * Tenant-isolation denial tests (CONVENTIONS §5/§10): data created in tenant A
 * must be invisible and immutable from tenant B, and must remain untouched
 * after B's attempts.
 */
import { describe, expect, it } from 'vitest';
import { getInit, jsonInit, setup } from './helpers';

async function seedTenantA(app: any, tenantId: string) {
  const platform = (
    (await (
      await app.request(
        '/platforms',
        jsonInit(tenantId, { key: 'alpha', name: 'Alpha', targetUrl: 'https://example.com/a' }),
      )
    ).json()) as any
  ).data;
  const { campaign, requests } = (
    (await (
      await app.request('/campaigns', jsonInit(tenantId, { name: 'Camp', customerIds: ['c1'] }))
    ).json()) as any
  ).data;
  return { platform, campaign, request: requests[0] };
}

describe('tenant isolation — platforms', () => {
  it('tenant B cannot read, update, or delete tenant A platforms', async () => {
    const { app, tenantA, tenantB } = await setup();
    const { platform } = await seedTenantA(app, tenantA.id);

    const list = await app.request('/platforms', getInit(tenantB.id));
    expect(((await list.json()) as any).data).toEqual([]);

    expect((await app.request(`/platforms/${platform.id}`, getInit(tenantB.id))).status).toBe(404);
    expect(
      (await app.request(`/platforms/${platform.id}`, jsonInit(tenantB.id, { name: 'Stolen' }, 'PATCH')))
        .status,
    ).toBe(404);
    expect(
      (await app.request(`/platforms/${platform.id}`, jsonInit(tenantB.id, undefined, 'DELETE'))).status,
    ).toBe(404);

    // A's platform is untouched.
    const still = await app.request(`/platforms/${platform.id}`, getInit(tenantA.id));
    expect(still.status).toBe(200);
    expect(((await still.json()) as any).data.name).toBe('Alpha');
  });
});

describe('tenant isolation — campaigns', () => {
  it('tenant B cannot read, patch, or dispatch tenant A campaigns', async () => {
    const { app, tenantA, tenantB } = await setup();
    const { campaign } = await seedTenantA(app, tenantA.id);

    expect((await app.request(`/campaigns/${campaign.id}`, getInit(tenantB.id))).status).toBe(404);
    expect(
      (await app.request(`/campaigns/${campaign.id}`, jsonInit(tenantB.id, { status: 'paused' }, 'PATCH')))
        .status,
    ).toBe(404);
    expect(
      (await app.request(`/campaigns/${campaign.id}/dispatch`, jsonInit(tenantB.id, undefined))).status,
    ).toBe(404);

    const listB = await app.request('/campaigns', getInit(tenantB.id));
    expect(((await listB.json()) as any).data).toEqual([]);

    // A's campaign is untouched and still active.
    const still = await app.request(`/campaigns/${campaign.id}`, getInit(tenantA.id));
    expect(((await still.json()) as any).data.status).toBe('active');
  });
});

describe('tenant isolation — requests & reminders', () => {
  it('tenant B cannot see A requests, mint links, or schedule reminders on them', async () => {
    const { app, tenantA, tenantB } = await setup();
    const { request } = await seedTenantA(app, tenantA.id);

    const list = await app.request('/requests', getInit(tenantB.id));
    expect(((await list.json()) as any).data).toEqual([]);

    expect((await app.request(`/requests/${request.id}`, getInit(tenantB.id))).status).toBe(404);
    expect((await app.request(`/requests/${request.id}/link`, getInit(tenantB.id))).status).toBe(404);
    expect(
      (
        await app.request(
          `/requests/${request.id}/reminders`,
          jsonInit(tenantB.id, { sendAt: '2020-01-01T00:00:00.000Z' }),
        )
      ).status,
    ).toBe(404);
  });

  it("tenant B cannot create a request attached to tenant A's campaign", async () => {
    const { app, tenantA, tenantB } = await setup();
    const { campaign } = await seedTenantA(app, tenantA.id);

    const res = await app.request(
      '/requests',
      jsonInit(tenantB.id, { customerId: 'b_cust', campaignId: campaign.id }),
    );
    expect(res.status).toBe(404);

    // No request row leaked into either tenant from the attempt.
    const bList = await app.request('/requests', getInit(tenantB.id));
    expect(((await bList.json()) as any).data).toEqual([]);
    const aList = await app.request(`/requests?campaign_id=${campaign.id}`, getInit(tenantA.id));
    expect(((await aList.json()) as any).data).toHaveLength(1); // only A's original seed request
  });

  it("tenant B processing reminders never touches tenant A's due reminders", async () => {
    const { app, tenantA, tenantB } = await setup();
    const { request } = await seedTenantA(app, tenantA.id);
    await app.request(
      `/requests/${request.id}/reminders`,
      jsonInit(tenantA.id, { sendAt: '2020-01-01T00:00:00.000Z' }),
    );

    const bList = await app.request('/reminders', getInit(tenantB.id));
    expect(((await bList.json()) as any).data).toEqual([]);

    const bProcess = await app.request('/reminders/process', jsonInit(tenantB.id, undefined));
    expect(((await bProcess.json()) as any).data).toEqual({ sent: 0, canceled: 0 });

    // A's reminder is still scheduled and A can process it.
    const aList = await app.request('/reminders', getInit(tenantA.id));
    const aReminders = ((await aList.json()) as any).data;
    expect(aReminders).toHaveLength(1);
    expect(aReminders[0].status).toBe('scheduled');

    const aProcess = await app.request('/reminders/process', jsonInit(tenantA.id, undefined));
    expect(((await aProcess.json()) as any).data).toEqual({ sent: 1, canceled: 0 });
  });
});

describe('tenant isolation — responses, testimonials, dashboard', () => {
  it('submitted feedback and testimonials are invisible to the other tenant', async () => {
    const { app, tenantA, tenantB } = await setup();
    const { request } = await seedTenantA(app, tenantA.id);

    const submit = await app.request(
      `/public/requests/${request.token}/submit`,
      jsonInit(null, { rating: 1, comment: 'private feedback' }),
    );
    const response = ((await submit.json()) as any).data.response;
    await app.request(
      '/testimonials',
      jsonInit(tenantA.id, { customerId: 'c1', quote: 'Ace', consent: true }),
    );

    expect((((await (await app.request('/responses', getInit(tenantB.id))).json()) as any).data)).toEqual([]);
    expect(
      (((await (await app.request('/testimonials', getInit(tenantB.id))).json()) as any).data),
    ).toEqual([]);
    expect(
      (await app.request(`/responses/${response.id}/resolve`, jsonInit(tenantB.id, undefined))).status,
    ).toBe(404);

    // A still sees its flagged response, unresolved.
    const aResponses = ((await (await app.request('/responses', getInit(tenantA.id))).json()) as any).data;
    expect(aResponses).toHaveLength(1);
    expect(aResponses[0].resolved_at).toBeNull();
  });

  it("tenant B's dashboard stays at zero while tenant A has activity", async () => {
    const { app, tenantA, tenantB } = await setup();
    const { request } = await seedTenantA(app, tenantA.id);
    await app.request(`/public/requests/${request.token}/submit`, jsonInit(null, { rating: 5 }));

    const b = ((await (await app.request('/dashboard', getInit(tenantB.id))).json()) as any).data;
    expect(b.requests.total).toBe(0);
    expect(b.reviews.volume).toBe(0);
    expect(b.reviews.averageRating).toBeNull();
    expect(b.responseRate).toBe(0);

    const a = ((await (await app.request('/dashboard', getInit(tenantA.id))).json()) as any).data;
    expect(a.requests.total).toBe(1);
    expect(a.reviews.volume).toBe(1);
  });
});
