import { describe, expect, it } from 'vitest';
import { listAuditEntries, asCoreDb, type PlatformEvent } from '@blacklabel/core';
import { WIDGET_CATALOG } from '../src/service';
import { headers, setup } from './fixtures';

describe('widget configuration', () => {
  it('GET /config returns the full catalog enabled by default when unconfigured', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request('/config', { headers: headers(tenantA) });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.configured).toBe(false);
    expect(body.data.widgets).toHaveLength(WIDGET_CATALOG.length);
    expect(body.data.widgets[0]).toMatchObject({ widgetKey: 'revenue', enabled: true, position: 0 });
  });

  it('PUT /config replaces the layout (order, enabled, settings) and emits dashboard.config.updated', async () => {
    const { app, tenantA, events } = await setup();
    const received: PlatformEvent[] = [];
    events.on('dashboard.config.updated', (e) => {
      received.push(e);
    });

    const res = await app.request('/config', {
      method: 'PUT',
      headers: headers(tenantA),
      body: JSON.stringify({
        widgets: [
          { widgetKey: 'reviews', settings: { minRating: 3 } },
          { widgetKey: 'revenue', enabled: false },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.configured).toBe(true);
    expect(body.data.widgets).toEqual([
      expect.objectContaining({ widgetKey: 'reviews', position: 0, enabled: true, settings: { minRating: 3 } }),
      expect.objectContaining({ widgetKey: 'revenue', position: 1, enabled: false, settings: {} }),
    ]);

    expect(received).toHaveLength(1);
    expect(received[0].tenantId).toBe(tenantA.id);
    expect(received[0].payload).toEqual({ widgetKeys: ['reviews', 'revenue'] });
  });

  it('PUT /config rejects unknown and duplicate widget keys', async () => {
    const { app, tenantA } = await setup();
    const unknown = await app.request('/config', {
      method: 'PUT',
      headers: headers(tenantA),
      body: JSON.stringify({ widgets: [{ widgetKey: 'nope' }] }),
    });
    expect(unknown.status).toBe(400);
    expect((await unknown.json() as any).error.message).toMatch(/unknown widget key/);

    const dupes = await app.request('/config', {
      method: 'PUT',
      headers: headers(tenantA),
      body: JSON.stringify({ widgets: [{ widgetKey: 'revenue' }, { widgetKey: 'revenue' }] }),
    });
    expect(dupes.status).toBe(400);
    expect((await dupes.json() as any).error.message).toMatch(/duplicate widget key/);
  });

  it('DELETE /config resets to defaults and audits the mutation', async () => {
    const { app, tenantA, db } = await setup();
    await app.request('/config', {
      method: 'PUT',
      headers: headers(tenantA),
      body: JSON.stringify({ widgets: [{ widgetKey: 'alerts' }] }),
    });
    const reset = await app.request('/config', { method: 'DELETE', headers: headers(tenantA) });
    expect(reset.status).toBe(200);
    expect((await reset.json() as any).data.configured).toBe(false);

    const auditTrail = await listAuditEntries(asCoreDb(db), tenantA.id, 'dashboard.widget_config', 'config');
    const actions = auditTrail.map((a) => a.action);
    expect(actions).toContain('dashboard.widget_config.updated');
    expect(actions).toContain('dashboard.widget_config.reset');
  });

  it('is tenant-isolated: B never sees A\'s configuration and A\'s rows survive B\'s writes', async () => {
    const { app, tenantA, tenantB } = await setup();
    await app.request('/config', {
      method: 'PUT',
      headers: headers(tenantA),
      body: JSON.stringify({ widgets: [{ widgetKey: 'reviews' }] }),
    });

    // B still gets defaults (unconfigured).
    const bRes = await app.request('/config', { headers: headers(tenantB) });
    expect((await bRes.json() as any).data.configured).toBe(false);

    // B writing its own config does not disturb A.
    await app.request('/config', {
      method: 'PUT',
      headers: headers(tenantB),
      body: JSON.stringify({ widgets: [{ widgetKey: 'alerts' }, { widgetKey: 'revenue' }] }),
    });
    const aRes = await app.request('/config', { headers: headers(tenantA) });
    const aBody = await aRes.json() as any;
    expect(aBody.data.configured).toBe(true);
    expect(aBody.data.widgets).toHaveLength(1);
    expect(aBody.data.widgets[0].widgetKey).toBe('reviews');
  });
});
