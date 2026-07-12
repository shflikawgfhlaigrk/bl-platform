import { describe, expect, it } from 'vitest';
import { headers, setup } from './helpers';

const transactional = {
  name: 'Order receipt',
  kind: 'transactional',
  subjectTemplate: 'Your Mags Tack order {{order_id}}',
  bodyTemplate: 'Hi {{name}}, thanks for your order.',
  requiredPlaceholders: ['name', 'order_id'],
};

describe('templates', () => {
  it('creates a transactional template and stores required placeholders', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request('/templates', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify(transactional),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as any;
    expect(data.kind).toBe('transactional');
    expect(JSON.parse(data.required_placeholders)).toEqual(['name', 'order_id']);
    expect(data.unsubscribe_footer_required).toBe(0);
  });

  it('rejects a promotional template missing the unsubscribe footer', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request('/templates', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({
        name: 'Spring sale',
        kind: 'promotional',
        subjectTemplate: 'Spring sale for {{name}}',
        bodyTemplate: 'Big sale! (no footer here)',
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toMatch(/unsubscribe_url/);
  });

  it('accepts a promotional template with the footer and auto-requires unsubscribe_url', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request('/templates', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({
        name: 'Spring sale',
        kind: 'promotional',
        subjectTemplate: 'Spring sale for {{name}}',
        bodyTemplate: 'Big sale, {{name}}! Unsubscribe: {{unsubscribe_url}} — {{postal_address}}',
        requiredPlaceholders: ['name'],
      }),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as any;
    expect(data.unsubscribe_footer_required).toBe(1);
    expect(JSON.parse(data.required_placeholders)).toContain('unsubscribe_url');
  });

  it('lists, gets, updates and deletes; tenant-isolated', async () => {
    const { app, tenantA, tenantB } = await setup();
    const created = (await (
      await app.request('/templates', { method: 'POST', headers: headers(tenantA), body: JSON.stringify(transactional) })
    ).json()) as any;
    const id = created.data.id;

    // Tenant B cannot see or fetch it.
    const listB = (await (await app.request('/templates', { headers: headers(tenantB) })).json()) as any;
    expect(listB.data).toEqual([]);
    const getB = await app.request(`/templates/${id}`, { headers: headers(tenantB) });
    expect(getB.status).toBe(404);

    const upd = await app.request(`/templates/${id}`, {
      method: 'PUT',
      headers: headers(tenantA),
      body: JSON.stringify({ ...transactional, name: 'Receipt v2' }),
    });
    expect(((await upd.json()) as any).data.name).toBe('Receipt v2');

    const del = await app.request(`/templates/${id}`, { method: 'DELETE', headers: headers(tenantA) });
    expect(del.status).toBe(200);
    const after = await app.request(`/templates/${id}`, { headers: headers(tenantA) });
    expect(after.status).toBe(404);
  });
});
