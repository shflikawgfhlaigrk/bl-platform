import { afterEach, expect, it, vi } from 'vitest';
import { setup, headers, type TestContext } from './helpers';
import { completeUpload, SYSTEM_ACTOR } from '../src/service';

let ctx: TestContext | undefined;
afterEach(async () => { await ctx?.db.destroy(); });
const MAX_BYTES = 10 * 1024 * 1024;

async function pending() {
  ctx = await setup();
  const h = headers(ctx.tenantA.id, ctx.users.member1.id);
  const init = await ctx.app.request('/uploads', { method: 'POST', headers: h,
    body: JSON.stringify({ name: 'bounded.bin', mime: 'application/octet-stream' }) });
  const { data: session } = await init.json() as any;
  return { ...ctx, h, session, put: vi.spyOn(ctx.storage, 'put') };
}

it('rejects encoded and decoded oversize before storage, leaving sessions pending', async () => {
  const { app, db, storage, events, tenantA, h, session, put } = await pending();
  // Same base64 length as the maximum file, but padding represents one extra byte.
  const justOver = Buffer.alloc(MAX_BYTES + 1).toString('base64');
  for (const content_base64 of [justOver, justOver + 'AAAA']) {
    const res = await app.request(`/uploads/${session.id}/complete`, { method: 'POST', headers: h, body: JSON.stringify({ content_base64 }) });
    expect(res.status).toBe(413);
  }
  await expect(completeUpload(db, events, storage, tenantA.id, SYSTEM_ACTOR, session.id, Buffer.alloc(MAX_BYTES + 1))).rejects.toMatchObject({ status: 413 });
  expect(put).not.toHaveBeenCalled();
  expect((await db.selectFrom('files_upload_sessions').selectAll().where('id', '=', session.id).executeTakeFirstOrThrow()).status).toBe('pending');
  expect(await db.selectFrom('files_assets').selectAll().execute()).toEqual([]);
});

it.each(['a', 'YQ=!', 'YQ==junk', 'Y Q==', 'YQ__', 'YR=='])('rejects malformed/noncanonical base64 %s without changing storage', async content_base64 => {
  const { app, h, session, put } = await pending();
  const res = await app.request(`/uploads/${session.id}/complete`, { method: 'POST', headers: h, body: JSON.stringify({ content_base64 }) });
  expect(res.status).toBe(400); expect(put).not.toHaveBeenCalled();
});

it('accepts the exact file cap and empty files and preserves tenant/session ownership', async () => {
  const { app, h, session, put, tenantA, tenantB, users } = await pending();
  const body = JSON.stringify({ content_base64: Buffer.alloc(MAX_BYTES, 65).toString('base64') });
  expect((await app.request(`/uploads/${session.id}/complete`, { method: 'POST', headers: headers(tenantB.id), body: '{"content_base64":"b2s="}' })).status).toBe(404);
  expect((await app.request(`/uploads/${session.id}/complete`, { method: 'POST', headers: headers(tenantA.id, users.member2.id), body: '{"content_base64":"b2s="}' })).status).toBe(403);
  expect(put).not.toHaveBeenCalled();
  const res = await app.request(`/uploads/${session.id}/complete`, { method: 'POST', headers: h, body });
  expect(res.status).toBe(201); expect(((await res.json()) as any).data.size_bytes).toBe(MAX_BYTES);
  const init = await app.request('/uploads', { method: 'POST', headers: h, body: '{"name":"empty","mime":"text/plain"}' });
  const { data: empty } = await init.json() as any;
  expect((await app.request(`/uploads/${empty.id}/complete`, { method: 'POST', headers: h, body: '{"content_base64":""}' })).status).toBe(201);
});
