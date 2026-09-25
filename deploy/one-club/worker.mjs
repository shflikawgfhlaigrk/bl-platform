/** Fixed app address with a credentialed outbound connection from the venue Mac. */
const unavailable = () => Response.json({ error: { code: 'venue_unavailable', message: 'The bar server is reconnecting. Saved tabs remain on the server. Try again.' } }, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '3' } });
const encode = bytes => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
const decode = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));

export default {
  fetch(request, env) {
    return env.VENUE_RELAY.get(env.VENUE_RELAY.idFromName('bar-one')).fetch(request);
  },
};

export class VenueRelay {
  constructor(_state, env) { this.env = env; this.peer = null; this.pending = new Map(); }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/_venue-relay') {
      const protocols = (request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(s => s.trim());
      if (!this.env.VENUE_RELAY_SECRET || !protocols.includes('auth.' + this.env.VENUE_RELAY_SECRET)) return new Response('Unauthorized', { status: 401 });
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 });
      const [client, server] = Object.values(new WebSocketPair());
      if (this.peer) { const old = this.peer; this.disconnect(old); old.close(1012, 'Relay replaced'); }
      this.peer = server;
      server.accept();
      server.addEventListener('message', event => this.receive(event.data, server));
      server.addEventListener('close', () => this.disconnect(server));
      server.addEventListener('error', () => this.disconnect(server));
      return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'bar-one-relay' } });
    }
    return this.forward(request);
  }
  disconnect(peer) {
    if (this.peer !== peer) return;
    for (const id of [...this.pending.keys()]) this.fail(id);
    this.peer = null;
  }
  fail(id) {
    const p = this.pending.get(id); if (!p) return;
    clearTimeout(p.timer); this.pending.delete(id);
    if (p.controller) p.controller.error(new Error('Venue connection interrupted'));
    else p.resolve(unavailable());
  }
  receive(raw, peer) {
    if (this.peer !== peer) return;
    try {
      const message = JSON.parse(raw);
      if (message.type === 'ping') { peer.send('{"type":"pong"}'); return; }
      const p = this.pending.get(message.id); if (!p) return;
      if (message.type === 'head') {
        if (p.controller) throw new Error('Duplicate response');
        const headers = new Headers(message.headers);
        for (const h of ['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'cdn-cache-control', 'cloudflare-cdn-cache-control']) headers.delete(h);
        headers.set('Cache-Control', 'no-store');
        const stream = new ReadableStream({ start: controller => { p.controller = controller; }, cancel: () => this.fail(message.id) });
        p.resolve(new Response([204, 205, 304].includes(message.status) || p.method === 'HEAD' ? null : stream, { status: message.status, headers }));
      } else if (message.type === 'chunk') {
        const bytes = decode(message.body); p.bytes += bytes.length;
        if (p.bytes > 16 * 1024 * 1024 || !p.controller) throw new Error('Invalid response stream');
        if (p.method !== 'HEAD') p.controller.enqueue(bytes);
      } else if (message.type === 'end') {
        clearTimeout(p.timer); this.pending.delete(message.id);
        if (p.controller) p.controller.close(); else p.resolve(unavailable());
      } else if (message.type === 'error') this.fail(message.id);
    } catch { this.disconnect(peer); peer.close(1011, 'Invalid relay response'); }
  }
  async forward(request) {
    if (!this.peer || this.pending.size >= 80) return unavailable();
    // Keep each request frame below Cloudflare's WebSocket message limit.
    const chunks = []; let length = 0;
    if (request.body) {
      const reader = request.body.getReader();
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.length;
        if (length > 512 * 1024) { await reader.cancel(); return new Response('Request exceeds 512 KiB', { status: 413 }); }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const url = new URL(request.url), id = crypto.randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => this.fail(id), 45000);
      this.pending.set(id, { resolve, timer, method: request.method, bytes: 0 });
      try { this.peer.send(JSON.stringify({ type: 'request', id, method: request.method, path: url.pathname + url.search, headers: [...request.headers], body: encode(bytes) })); }
      catch { this.fail(id); }
    });
  }
}
