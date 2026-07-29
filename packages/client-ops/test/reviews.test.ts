import { describe, expect, it } from 'vitest';
import { createActiveInstallation, createRun, headers, setup } from './helpers';

describe('client-ops review inbox', () => {
  it('supports pending, held, approved, and denied decisions', async () => {
    const { app, tenantA } = await setup();
    const installation = await createActiveInstallation(app, tenantA);
    const run = await createRun(app, tenantA, installation);

    async function makeReview(title: string) {
      const response = await app.request('/reviews', {
        method: 'POST', headers: headers(tenantA),
        body: JSON.stringify({ installationId: installation.id, runId: run.id, workflowId: run.workflowId, title, context: { proposed: 'external change' } }),
      });
      expect(response.status).toBe(201);
      return ((await response.json()) as any).data;
    }

    const held = await makeReview('Hold then approve');
    expect(held.status).toBe('pending');
    const holdResponse = await app.request(`/reviews/${held.id}/hold`, {
      method: 'POST', headers: headers(tenantA), body: JSON.stringify({ note: 'Need owner context' }),
    });
    expect(((await holdResponse.json()) as any).data).toMatchObject({ status: 'held', decisionNote: 'Need owner context' });
    const approveResponse = await app.request(`/reviews/${held.id}/approve`, {
      method: 'POST', headers: headers(tenantA), body: JSON.stringify({ note: 'Owner confirmed' }),
    });
    expect(((await approveResponse.json()) as any).data.status).toBe('approved');

    const denied = await makeReview('Deny this');
    const denyResponse = await app.request(`/reviews/${denied.id}/deny`, {
      method: 'POST', headers: headers(tenantA), body: JSON.stringify({ note: 'Outside policy' }),
    });
    expect(((await denyResponse.json()) as any).data.status).toBe('denied');
    expect((await app.request(`/reviews/${denied.id}/approve`, {
      method: 'POST', headers: headers(tenantA), body: JSON.stringify({}),
    })).status).toBe(409);

    const approved = await makeReview('Approve this');
    expect((await app.request(`/reviews/${approved.id}/approve`, {
      method: 'POST', headers: headers(tenantA), body: JSON.stringify({}),
    })).status).toBe(200);

    const heldList = await app.request('/reviews?status=held', { headers: headers(tenantA) });
    expect(((await heldList.json()) as any).data).toEqual([]);
    const all = await app.request('/reviews', { headers: headers(tenantA) });
    expect(((await all.json()) as any).data).toHaveLength(3);
  });

  it('denies tenant B read and decisions on tenant A review items', async () => {
    const { app, tenantA, tenantB } = await setup();
    const installation = await createActiveInstallation(app, tenantA);
    const response = await app.request('/reviews', {
      method: 'POST', headers: headers(tenantA), body: JSON.stringify({ installationId: installation.id, title: 'Private decision' }),
    });
    const review = ((await response.json()) as any).data;
    expect((await app.request(`/reviews/${review.id}`, { headers: headers(tenantB) })).status).toBe(404);
    expect((await app.request(`/reviews/${review.id}/deny`, {
      method: 'POST', headers: headers(tenantB), body: JSON.stringify({ note: 'cross tenant' }),
    })).status).toBe(404);
    expect(((await (await app.request('/reviews', { headers: headers(tenantB) })).json()) as any).data).toEqual([]);
  });
});
