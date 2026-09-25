import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHmac } from 'node:crypto';
import { asCoreDb, createTenant, errorHandler } from '@blacklabel/core';
import { createTestDb } from '@blacklabel/db';
import { MemoryStorageProvider } from '@blacklabel/files';
import { createApp, type PlatformDatabase } from '../src/app';
import { bodyLimit } from '../src/security';

const MiB = 1024 * 1024;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(cleanup.splice(0).map(fn => fn())); });

function streamed(path: string, text: string, headers: Record<string, string> = {}) {
  const bytes = Buffer.from(text);
  let offset = 0;
  return new Request(`http://localhost${path}`, {
    method: 'POST', headers,
    body: new ReadableStream({ pull(controller) {
      if (offset === bytes.length) return controller.close();
      const end = Math.min(offset + 16384, bytes.length);
      controller.enqueue(bytes.subarray(offset, end)); offset = end;
    } }), duplex: 'half',
  } as RequestInit);
}

function harness(timeoutMs = 30000) {
  const app = new Hono();
  app.onError(errorHandler);
  // Configuration is injectable for deadline tests; production uses 30 seconds.
  app.use('*', bodyLimit({ timeoutMs }));
  app.post('*', async c => c.json({ length: (await c.req.arrayBuffer()).byteLength }));
  return app;
}

async function boot() {
  const db = createTestDb<PlatformDatabase>(); cleanup.push(() => db.destroy());
  const storage = new MemoryStorageProvider();
  const platform = await createApp({ db, adminMasterKey: Buffer.alloc(32, 7), storage });
  const tenant = await createTenant(asCoreDb(db), { name: 'Body limits fixture' });
  return { db, storage, platform, headers: { 'x-tenant-id': tenant.id, 'content-type': 'application/json' } };
}

describe('actual request body admission', () => {
  it.each([undefined, '1'])('rejects over-cap streams with declared length %s before the handler', async len => {
    const headers: Record<string, string> = len ? { 'content-length': len } : {};
    const res = await harness().fetch(streamed('/api/unknown', 'x'.repeat(5 * MiB + 1), headers));
    expect(res.status).toBe(413);
  });

  it.each(['wat', '-1', '1.5', '1e3', '1, 1'])('rejects malformed declared length %s', async value => {
    expect((await harness().fetch(streamed('/api/unknown', '{}', { 'content-length': value }))).status).toBe(400);
  });

  it('rejects a short or understated declared body and accepts an exact length', async () => {
    for (const length of ['1', '3']) {
      expect((await harness().fetch(streamed('/api/unknown', '{}', { 'content-length': length }))).status).toBe(400);
    }
    expect((await harness().fetch(streamed('/api/unknown', '{}', { 'content-length': '2' }))).status).toBe(200);
  });

  it('cancels an overflowing stream before requesting further chunks', async () => {
    const cancel = vi.fn(); let pulls = 0;
    const req = new Request('http://localhost/api/unknown', { method: 'POST', body: new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(5 * MiB + 1)); if (pulls === 2) controller.close(); }, cancel,
    }, { highWaterMark: 0 }), duplex: 'half' } as RequestInit);
    expect((await harness().fetch(req)).status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce(); expect(pulls).toBe(1);
  });

  it('times out an incomplete body even when cancellation never settles', async () => {
    vi.useFakeTimers(); const cancel = vi.fn(() => new Promise<void>(() => {}));
    const req = new Request('http://localhost/api/unknown', { method: 'POST', body: new ReadableStream({ cancel }), duplex: 'half' } as RequestInit);
    const result = harness(25).fetch(req);
    await vi.advanceTimersByTimeAsync(26);
    expect((await result).status).toBe(408); expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects stream errors and aborts before downstream parsing', async () => {
    const app = harness(); const cancel = vi.fn(); const controller = new AbortController();
    const req = new Request('http://localhost/api/unknown', { method: 'POST', signal: controller.signal,
      body: new ReadableStream({ cancel }), duplex: 'half' } as RequestInit);
    const result = app.fetch(req); controller.abort();
    expect((await result).status).toBe(400); expect(cancel).toHaveBeenCalledOnce();
    const broken = new Request('http://localhost/api/unknown', { method: 'POST',
      body: new ReadableStream({ start(c) { c.error(new Error('synthetic disconnect')); } }), duplex: 'half' } as RequestInit);
    expect((await app.fetch(broken)).status).toBe(400);
  });

  it('preserves boundary and differentiated import/file caps', async () => {
    expect((await harness().fetch(streamed('/api/unknown', 'x'.repeat(5 * MiB)))).status).toBe(200);
    for (const path of ['/api/catalog/import/preview', '/api/files/uploads/id/complete', '/api/portal-customer/me/uploads']) {
      expect((await harness().fetch(streamed(path, 'x'.repeat(5 * MiB + 1)))).status).toBe(200);
    }
    expect((await harness().fetch(streamed('/api/files/uploads/id/complete', 'x'.repeat(15 * MiB + 1)))).status).toBe(413);
    expect((await harness().fetch(streamed('/api/catalog/import/preview', 'x'.repeat(50 * MiB + 1)))).status).toBe(413);
  });

  it('preserves exact signed bytes for raw Request clones and Hono parsing', async () => {
    const app = new Hono(); app.onError(errorHandler); app.use('*', bodyLimit());
    const bytes = ' { "note" : "café 🌒", "n": 1 }\n';
    const sign = (s: string) => createHmac('sha256', 'synthetic').update(s).digest('hex');
    app.post('*', async c => {
      expect(sign(await c.req.raw.clone().text())).toBe(c.req.header('x-test-signature'));
      expect(await c.req.text()).toBe(bytes);
      expect(await c.req.json()).toEqual({ note: 'café 🌒', n: 1 });
      return c.json({ ok: true });
    });
    expect((await app.fetch(streamed('/api/orders/webhooks/test', bytes, { 'x-test-signature': sign(bytes) }))).status).toBe(200);
  });

  it('bounds headerless sign-in before validation while preserving bootstrap and login', async () => {
    const { platform, headers } = await boot();
    const big = JSON.stringify({ userId: 'missing', pin: '0000', padding: 'x'.repeat(64 * 1024) });
    const res = await platform.app.fetch(streamed('/api/pos/auth/session', big, headers));
    expect(res.status).toBe(413);
    const seeded = await platform.seedTenant(headers['x-tenant-id']);
    const signedIn = await platform.app.fetch(streamed('/api/pos/auth/bootstrap', '{"pin":"2468"}', headers));
    expect(signedIn.status).toBe(201);
    expect(signedIn.headers.get('set-cookie')).toBeTruthy();
    expect((await platform.app.fetch(streamed('/api/pos/auth/session', JSON.stringify({ userId: seeded.ownerUserId, pin: '2468' }), headers))).status).toBe(201);
    expect((await platform.app.fetch(streamed('/api/pos/auth/session', '{"userId":"missing","pin":"0000"}', headers))).status).toBe(401);
  });

  it('rejects oversized file completion without storing bytes or changing the pending session', async () => {
    const { platform, headers, db, storage } = await boot();
    await platform.seedTenant(headers['x-tenant-id']);
    const put = vi.spyOn(storage, 'put');
    const init = await platform.app.fetch(streamed('/api/files/uploads', '{"name":"test.bin","mime":"application/octet-stream"}', headers));
    expect(init.status).toBe(201); const { data: session } = await init.json() as any;
    const res = await platform.app.fetch(streamed(`/api/files/uploads/${session.id}/complete`, JSON.stringify({ content_base64: 'A'.repeat(15 * MiB) }), headers));
    expect(res.status).toBe(413); expect(put).not.toHaveBeenCalled();
    expect((await db.selectFrom('files_upload_sessions').selectAll().where('id', '=', session.id).executeTakeFirstOrThrow()).status).toBe('pending');
    expect(await db.selectFrom('files_assets').selectAll().execute()).toEqual([]);
    const valid = await platform.app.fetch(streamed(`/api/files/uploads/${session.id}/complete`, '{"content_base64":"b2s="}', headers));
    expect(valid.status).toBe(201); expect(put).toHaveBeenCalledOnce();
    const repeated = await platform.app.fetch(streamed(`/api/files/uploads/${session.id}/complete`, '{"content_base64":"b2s="}', headers));
    expect(repeated.status).toBe(409); expect(put).toHaveBeenCalledOnce();
  });
});
