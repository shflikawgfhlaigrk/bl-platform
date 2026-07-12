import { describe, expect, it } from 'vitest';
import type { PollRequest, PollResponse } from '../src/polling-adapter';
import type { WebhookSignatureConfig } from '../src/webhook-adapter';
import { computeWebhookSignature } from '../src/webhook-adapter';
import { headers, setup, squarePayment } from './helpers';

const webhookConfig: WebhookSignatureConfig = {
  signatureKey: 'k',
  notificationUrl: 'https://mags.local/webhooks/square',
};

describe('import router — export-drop', () => {
  it('imports records and exposes the manifest + status', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request('/imports/export-drop', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ kind: 'payments', records: [squarePayment('p1', 1000), squarePayment('p2', 2000)] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.data.accepted).toBe(2);

    const manifests = await app.request('/imports/manifests', { headers: headers(tenantA) });
    expect(((await manifests.json()) as any).data).toHaveLength(1);

    const status = await app.request('/imports/status', { headers: headers(tenantA) });
    const payStatus = ((await status.json()) as any).data.find((s: any) => s.kind === 'payments');
    expect(payStatus.totalAccepted).toBe(2);
  });

  it('accepts raw json text and reconciliation matches', async () => {
    const { app, tenantA } = await setup();
    await app.request('/imports/export-drop', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ kind: 'payments', json: JSON.stringify([squarePayment('p1', 1000)]) }),
    });
    const recon = await app.request('/imports/reconciliation', { headers: headers(tenantA) });
    const rows = ((await recon.json()) as any).data;
    expect(rows.find((r: any) => r.kind === 'payments').ok).toBe(true);
  });

  it('quarantine surfaces via the router and supports repair + discard', async () => {
    const { app, tenantA } = await setup();
    await app.request('/imports/export-drop', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ kind: 'payments', records: [{ id: 'bad1' }, { id: 'bad2' }] }),
    });
    const list = await app.request('/quarantine?status=quarantined', { headers: headers(tenantA) });
    const q = ((await list.json()) as any).data;
    expect(q).toHaveLength(2);

    const repair = await app.request(`/quarantine/${q[0].id}/repair`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ record: squarePayment(q[0].id, 500) }),
    });
    expect(((await repair.json()) as any).data.status).toBe('repaired');

    const discard = await app.request(`/quarantine/${q[1].id}/discard`, {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ reason: 'junk' }),
    });
    expect(((await discard.json()) as any).data.status).toBe('discarded');
  });
});

describe('import router — webhook', () => {
  it('501 when no signature key is wired', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request('/imports/webhook', { method: 'POST', headers: headers(tenantA), body: '{}' });
    expect(res.status).toBe(501);
  });

  it('401 on a bad signature, 201 on a valid one, replay is a no-op', async () => {
    const { app, tenantA } = await setup({ webhook: webhookConfig });
    const body = JSON.stringify({
      event_id: 'evt_1',
      type: 'payment.updated',
      data: { type: 'payment', id: 'p1', object: { payment: squarePayment('p1', 700) } },
    });

    const bad = await app.request('/imports/webhook', {
      method: 'POST',
      headers: { ...headers(tenantA), 'x-square-hmacsha256-signature': 'wrong' },
      body,
    });
    expect(bad.status).toBe(401);

    const sig = computeWebhookSignature(body, webhookConfig);
    const good = await app.request('/imports/webhook', {
      method: 'POST',
      headers: { ...headers(tenantA), 'x-square-hmacsha256-signature': sig },
      body,
    });
    expect(good.status).toBe(201);
    expect(((await good.json()) as any).data.replayed).toBe(false);

    // Same event id again → replay no-op (no duplicate payment).
    const replay = await app.request('/imports/webhook', {
      method: 'POST',
      headers: { ...headers(tenantA), 'x-square-hmacsha256-signature': sig },
      body,
    });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as any).data.replayed).toBe(true);
  });
});

describe('import router — polling', () => {
  it('501 when no transport is wired (honest)', async () => {
    const { app, tenantA } = await setup();
    const res = await app.request('/imports/poll', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ kind: 'payments' }),
    });
    expect(res.status).toBe(501);
  });

  it('runs the injected transport, imports, and persists the cursor', async () => {
    const transport = async (req: PollRequest): Promise<PollResponse> => {
      if (req.cursor === null) {
        return { records: [{ ...squarePayment('p1', 1000), updated_at: '2026-03-01T00:00:00.000Z' }], cursor: 'c1' };
      }
      return { records: [{ ...squarePayment('p2', 2000), updated_at: '2026-03-05T00:00:00.000Z' }], cursor: null };
    };
    const { app, tenantA } = await setup({ pollTransport: transport });
    const res = await app.request('/imports/poll', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ kind: 'payments' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.data.accepted).toBe(2);
    expect(body.data.pagesFetched).toBe(2);

    const cursors = await app.request('/imports/cursors', { headers: headers(tenantA) });
    const rows = ((await cursors.json()) as any).data;
    expect(rows[0].cursor).toBe('2026-03-05T00:00:00.000Z');
  });

  it('overlap window re-fetch dedups on the second poll (skipped_duplicates)', async () => {
    let run = 0;
    const transport = async (): Promise<PollResponse> => {
      run += 1;
      // Both runs return the same record (overlap re-fetch) — pipeline dedups.
      return { records: [{ ...squarePayment('p1', 1000), updated_at: '2026-03-01T00:00:00.000Z' }], cursor: null };
    };
    const { app, tenantA } = await setup({ pollTransport: transport, pollOverlapSeconds: 3600 });
    await app.request('/imports/poll', { method: 'POST', headers: headers(tenantA), body: JSON.stringify({ kind: 'payments' }) });
    const second = await app.request('/imports/poll', { method: 'POST', headers: headers(tenantA), body: JSON.stringify({ kind: 'payments' }) });
    const body = (await second.json()) as any;
    expect(run).toBe(2);
    expect(body.data.accepted).toBe(0);
    expect(body.data.skippedDuplicates).toBe(1);
  });
});

describe('import router — tenancy denial', () => {
  it('requires the tenant header and isolates new import surfaces', async () => {
    const { app, tenantA, tenantB } = await setup();
    await app.request('/imports/export-drop', {
      method: 'POST',
      headers: headers(tenantA),
      body: JSON.stringify({ kind: 'payments', records: [squarePayment('p1', 1000)] }),
    });
    // Missing header → 400.
    const missing = await app.request('/imports/manifests');
    expect(missing.status).toBe(400);
    // Tenant B sees nothing.
    const bManifests = await app.request('/imports/manifests', { headers: headers(tenantB) });
    expect(((await bManifests.json()) as any).data).toEqual([]);
    const bQuarantine = await app.request('/quarantine', { headers: headers(tenantB) });
    expect(((await bQuarantine.json()) as any).data).toEqual([]);
  });
});
