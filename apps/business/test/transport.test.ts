import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { HttpBindings } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { RateLimiter } from '../../api/src/security';
import { errorHandler } from '@blacklabel/core';
import { businessFetch, businessRequest, businessTransport } from '../src/transport';

describe('business network boundary', () => {
  const handle = async (request: Request) => new Response(await request.text());
  it('requires TLS for shared interfaces and binds the exact public origin', async () => {
    await expect(businessTransport({ BLACKLABEL_BUSINESS_HOST: '0.0.0.0' })).rejects.toThrow('HTTPS');
    await expect(businessTransport({ BLACKLABEL_BUSINESS_PUBLIC_ORIGIN: 'https://company.example' })).rejects.toThrow('together');
    const transport = { publicOrigin: 'https://company.example', port: 443 };
    expect((await businessRequest(new Request('https://attacker.example/'), transport, handle)).status).toBe(403);
    expect((await businessRequest(new Request('http://company.example/'), transport, handle)).status).toBe(403);
    expect((await businessRequest(new Request('https://company.example/', { headers: { origin: 'https://other.example' } }), transport, handle)).status).toBe(403);
    const response = await businessRequest(new Request('https://company.example/'), transport, handle);
    expect(response.status).toBe(200); expect(response.headers.get('strict-transport-security')).toContain('max-age');
  });
  it('rejects oversized chunked streams and false content lengths before application execution', async () => {
    let called = 0;
    const application = async (request: Request) => { called++; return handle(request); };
    const local = { port: 47832 };
    for (const headers of [{}, { 'content-length': '1' }]) {
      const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4)); controller.enqueue(new Uint8Array(5)); controller.close(); } });
      const request = new Request('http://localhost:47832/', { method: 'POST', body: stream, headers, duplex: 'half' } as RequestInit);
      expect((await businessRequest(request, local, application, { bytes: 8, timeoutMs: 1000 })).status).toBe(413);
    }
    const mismatch = new Request('http://localhost:47832/', { method: 'POST', body: 'abc', headers: { 'content-length': '1' } });
    expect((await businessRequest(mismatch, local, application)).status).toBe(400); expect(called).toBe(0);
    const valid = new Request('http://localhost:47832/', { method: 'POST', body: 'hello' });
    expect(await (await businessRequest(valid, local, application)).text()).toBe('hello'); expect(called).toBe(1);
  });
  it('bounds incomplete request time and rejects foreign local hostnames and ports', async () => {
    const stream = new ReadableStream({ start() {} });
    const request = new Request('http://localhost:47832/', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    expect((await businessRequest(request, { port: 47832 }, handle, { bytes: 8, timeoutMs: 5 })).status).toBe(408);
    expect((await businessRequest(new Request('http://rebound.example:47832/'), { port: 47832 }, handle)).status).toBe(403);
    expect((await businessRequest(new Request('http://localhost:12345/'), { port: 47832 }, handle)).status).toBe(403);
  });

  it('forwards the actual Node socket environment through the serialized request handler', async () => {
    const app = new Hono<{ Bindings: HttpBindings }>();
    app.get('/', c => c.json({ peer: c.env?.incoming?.socket?.remoteAddress }));
    let queued = 0;
    const handler = businessFetch({ port: 0 }, app.fetch, async action => { queued++; return action(); });
    const server = serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
    try {
      if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'x-forwarded-for': '203.0.113.44', 'cf-connecting-ip': '203.0.113.45' } });
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ peer: '127.0.0.1' }); expect(queued).toBe(1);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it('keeps separate socket identities in separate buckets and ignores spoofed forwarding headers', async () => {
    const app = new Hono(); app.onError(errorHandler);
    app.use('*', new RateLimiter({ generalPerMinute: 1, now: () => 0 }).middleware());
    app.get('/', c => c.text('ok'));
    const handler = businessFetch({ port: 0 }, app.fetch);
    const request = () => new Request('http://127.0.0.1/', { headers: { 'x-forwarded-for': randomIp() } });
    let n = 0; function randomIp() { return `203.0.113.${++n}`; }
    const env = (peer: string) => ({ incoming: { socket: { remoteAddress: peer } } });
    expect((await handler(request(), env('192.0.2.1'))).status).toBe(200);
    expect((await handler(request(), env('192.0.2.1'))).status).toBe(429);
    expect((await handler(request(), env('192.0.2.2'))).status).toBe(200);
  });
});
