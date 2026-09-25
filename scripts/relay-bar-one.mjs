/** Outbound, authenticated venue transport. Does not retry business requests. */
import { readFileSync } from 'node:fs';
const origin = new URL(process.env.ONECLUB_RELAY_ORIGIN);
if (origin.protocol !== 'https:' || origin.hostname !== 'bar-one-pos.michael-070.workers.dev') throw new Error('Use the configured Bar One relay origin.');
const secret = readFileSync(process.env.ONECLUB_RELAY_SECRET_FILE, 'utf8').trim();
if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid relay credential file.');
const address = new URL('/_venue-relay', origin); address.protocol = 'wss:';
let peer, timer, heartbeat, stopping = false, backoff = 1000, lastPong = 0;
const inflight = new Map();
function send(socket, data) { if (socket.readyState !== WebSocket.OPEN) throw new Error('Relay closed'); socket.send(JSON.stringify(data)); }
async function respond(message, socket) {
  if (!message.id || inflight.has(message.id) || inflight.size >= 80) return;
  const controller = new AbortController(); inflight.set(message.id, controller);
  const timeout = setTimeout(() => controller.abort(), 40000);
  try {
    if (typeof message.path !== 'string' || !message.path.startsWith('/') || message.path.startsWith('//')) throw new Error('Invalid route');
    const url = new URL(message.path, 'http://127.0.0.1:8480');
    if (url.origin !== 'http://127.0.0.1:8480') throw new Error('Invalid upstream');
    const headers = new Headers(message.headers);
    for (const h of ['host', 'connection', 'upgrade', 'content-length', 'sec-websocket-key', 'sec-websocket-protocol', 'sec-websocket-version']) headers.delete(h);
    headers.set('accept-encoding', 'identity');
    const body = Buffer.from(message.body, 'base64');
    const response = await fetch(url, { method: message.method, headers, ...(body.length ? { body } : {}), redirect: 'manual', signal: controller.signal });
    send(socket, { type: 'head', id: message.id, status: response.status, headers: [...response.headers].filter(([k]) => k !== 'set-cookie').concat(response.headers.getSetCookie().map(v => ['set-cookie', v])) });
    let size = 0;
    if (response.body) for await (const bytes of response.body) {
      size += bytes.length; if (size > 16 * 1024 * 1024) throw new Error('Response too large');
      for (let i = 0; i < bytes.length; i += 48 * 1024) {
        while (socket.bufferedAmount > 1024 * 1024 && socket.readyState === WebSocket.OPEN) await new Promise(resolve => setTimeout(resolve, 10));
        send(socket, { type: 'chunk', id: message.id, body: Buffer.from(bytes.subarray(i, i + 48 * 1024)).toString('base64') });
      }
    }
    send(socket, { type: 'end', id: message.id });
  } catch { if (socket.readyState === WebSocket.OPEN) send(socket, { type: 'error', id: message.id }); }
  finally { clearTimeout(timeout); inflight.delete(message.id); }
}
function connect() {
  if (stopping) return;
  const socket = new WebSocket(address, ['bar-one-relay', 'auth.' + secret]); peer = socket;
  socket.addEventListener('open', () => {
    backoff = 1000; lastPong = Date.now(); console.log(new Date().toISOString() + ' Bar One relay connected');
    send(socket, { type: 'ping' });
    heartbeat = setInterval(() => {
      if (Date.now() - lastPong > 35000) { socket.close(); return; }
      if (socket.readyState === WebSocket.OPEN) send(socket, { type: 'ping' });
    }, 10000);
  });
  socket.addEventListener('message', event => {
    try { const message = JSON.parse(event.data); if (message.type === 'pong') lastPong = Date.now(); else if (message.type === 'request') void respond(message, socket); }
    catch { socket.close(); }
  });
  socket.addEventListener('error', () => socket.close());
  socket.addEventListener('close', () => {
    clearInterval(heartbeat); for (const c of inflight.values()) c.abort(); inflight.clear();
    if (!stopping) { console.log(new Date().toISOString() + ' Bar One relay reconnecting'); timer = setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 10000); }
  });
}
function stop() { stopping = true; clearTimeout(timer); clearInterval(heartbeat); for (const c of inflight.values()) c.abort(); peer?.close(); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
connect();
