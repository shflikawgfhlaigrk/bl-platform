import { describe, expect, it } from 'vitest';
// @ts-expect-error Deployed Cloudflare module is plain JavaScript.
import { VenueRelay } from '../../../deploy/one-club/worker.mjs';

describe('venue relay transport', () => {
  it('denies uncredentialed connector access and reports a disconnected venue', async () => {
    const relay = new VenueRelay({}, { VENUE_RELAY_SECRET: 'private' });
    expect((await relay.fetch(new Request('https://bar.test/_venue-relay'))).status).toBe(401);
    expect((await relay.fetch(new Request('https://bar.test/api/pos/bar/state'))).status).toBe(503);
  });
  it('preserves request bytes, cookies, action keys and streamed response bytes', async () => {
    const relay = new VenueRelay({}, {}); let message: any;
    const peer = { send: (raw: string) => { message = JSON.parse(raw); } }; relay.peer = peer;
    const pending = relay.forward(new Request('https://bar.test/api/pos/bar/menu?x=1', { method: 'POST', headers: { cookie: 'session=x', 'idempotency-key': 'action-1' }, body: 'Piña Colada' }));
    while (!message) await new Promise(resolve => setTimeout(resolve, 1));
    expect(message.path).toBe('/api/pos/bar/menu?x=1');
    expect(Buffer.from(message.body, 'base64').toString()).toBe('Piña Colada');
    expect(new Headers(message.headers).get('idempotency-key')).toBe('action-1');
    expect(new Headers(message.headers).get('cookie')).toBe('session=x');
    const receive = (value: any) => relay.receive(JSON.stringify({ id: message.id, ...value }), peer);
    receive({ type: 'head', status: 201, headers: [['set-cookie', 'session=y; Secure; HttpOnly'], ['content-type', 'application/json']] });
    receive({ type: 'chunk', body: Buffer.from('{"saved":').toString('base64') });
    receive({ type: 'chunk', body: Buffer.from('true}').toString('base64') });
    receive({ type: 'end' });
    const response = await pending;
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(await response.json()).toEqual({ saved: true });
    expect(relay.pending.size).toBe(0);
  });
  it('fails interrupted writes without replaying them and rejects oversized requests', async () => {
    const relay = new VenueRelay({}, {}); const sent: string[] = [];
    const peer = { send: (raw: string) => sent.push(raw) }; relay.peer = peer;
    const pending = relay.forward(new Request('https://bar.test/api/write', { method: 'POST', body: '{}' }));
    while (!sent.length) await new Promise(resolve => setTimeout(resolve, 1));
    relay.disconnect(peer);
    expect((await pending).status).toBe(503); expect(sent).toHaveLength(1); expect(relay.pending.size).toBe(0);
    relay.peer = peer;
    expect((await relay.forward(new Request('https://bar.test/api/write', { method: 'POST', body: 'x'.repeat(512 * 1024 + 1) }))).status).toBe(413);
    expect(sent).toHaveLength(1);
  });
});
