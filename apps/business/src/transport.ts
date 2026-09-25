import fs from 'node:fs/promises';
import { X509Certificate, createPrivateKey } from 'node:crypto';

export interface BusinessTransport {
  host: string; port: number; publicOrigin?: string;
  tls?: { cert: Buffer; key: Buffer; minVersion: 'TLSv1.2' };
}

/** Shared access uses this installation's certificate and exact HTTPS origin. */
export async function businessTransport(env: NodeJS.ProcessEnv): Promise<BusinessTransport> {
  const host = env.BLACKLABEL_BUSINESS_HOST ?? '127.0.0.1';
  const port = Number(env.BLACKLABEL_BUSINESS_PORT ?? 47832);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid BlackLabel business port.');
  const publicOrigin = env.BLACKLABEL_BUSINESS_PUBLIC_ORIGIN;
  const certPath = env.BLACKLABEL_BUSINESS_TLS_CERT, keyPath = env.BLACKLABEL_BUSINESS_TLS_KEY;
  if (!publicOrigin && !certPath && !keyPath) {
    if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Shared access requires an HTTPS origin and TLS certificate.');
    return { host, port };
  }
  if (!publicOrigin || !certPath || !keyPath) throw new Error('Provide the public HTTPS origin, TLS certificate and private key together.');
  const url = new URL(publicOrigin);
  if (url.protocol !== 'https:' || url.origin !== publicOrigin || url.username || url.password) throw new Error('Use an exact HTTPS origin without a path or credentials.');
  if (port !== 0 && Number(url.port || 443) !== port) throw new Error('The public origin and listening port must match.');
  const [cert, key, keyStat] = await Promise.all([fs.readFile(certPath), fs.readFile(keyPath), fs.stat(keyPath)]);
  if ((keyStat.mode & 0o077) !== 0) throw new Error('The TLS private key must be readable only by its owner.');
  const certificate = new X509Certificate(cert);
  if (!certificate.checkPrivateKey(createPrivateKey(key))) throw new Error('The TLS private key does not match the certificate.');
  const name = url.hostname.replace(/^\[|\]$/g, '');
  if (!certificate.checkHost(name) && !certificate.checkIP(name)) throw new Error('The TLS certificate does not cover the public hostname.');
  if (Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) throw new Error('The TLS certificate is outside its validity period.');
  return { host, port, publicOrigin, tls: { cert, key, minVersion: 'TLSv1.2' } };
}

/** Bound streamed bytes before they enter the serialized database request queue. */
export async function businessRequest(request: Request, transport: Pick<BusinessTransport, 'publicOrigin' | 'port'>,
  handle: (request: Request) => Promise<Response>, limits = { bytes: 15 * 1024 * 1024, timeoutMs: 30000 }): Promise<Response> {
  const reject = (status: number, message: string) => Response.json({ error: { message } }, { status, headers: { 'Cache-Control': 'no-store' } });
  const url = new URL(request.url);
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (transport.publicOrigin ? url.origin !== transport.publicOrigin : !local || (transport.port !== 0 && Number(url.port || 80) !== transport.port)) return reject(403, 'Unexpected business address.');
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return reject(403, 'Request origin does not match this business.');
  if (request.headers.get('sec-fetch-site') === 'cross-site') return reject(403, 'Cross-site request rejected.');
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limits.bytes)) return reject(413, 'Request is too large.');
  if (request.body) {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = []; let total = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('body-timeout')), limits.timeoutMs); });
    try {
      for (;;) {
        const part = await Promise.race([reader.read(), timeout]);
        if (part.done) break;
        total += part.value.byteLength;
        if (total > limits.bytes) { void reader.cancel().catch(() => {}); return reject(413, 'Request is too large.'); }
        chunks.push(part.value);
      }
      if (declared !== null && Number(declared) !== total) return reject(400, 'Request length does not match its body.');
      const body = Buffer.concat(chunks, total);
      const headers = new Headers(request.headers); headers.set('content-length', String(body.length));
      request = new Request(request, { headers, body });
    } catch { void reader.cancel().catch(() => {}); return reject(408, 'Request body did not complete.'); }
    finally { if (timer) clearTimeout(timer); }
  }
  const response = await handle(request);
  if (transport.publicOrigin) response.headers.set('Strict-Transport-Security', 'max-age=31536000');
  return response;
}
