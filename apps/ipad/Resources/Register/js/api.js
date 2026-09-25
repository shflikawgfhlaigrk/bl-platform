/**
 * API client. Talks to the same-origin /api/* surface the platform mounts.
 *
 * - Reads envelopes: success `{ data, ... }`, error `{ error:{message,code} }`.
 * - Mutations carry `x-mags-csrf: 1` (the composition root's CSRF guard) and an
 *   idempotency key where the endpoint supports one.
 * - The tenant header is injected server-side in single-tenant owner mode, so
 *   the browser does not send x-tenant-id. `setTenantId()` is available if a
 *   future multi-tenant mode needs it.
 * - Mutations can be `queueable`: if the network is down they are handed to the
 *   offline queue and replayed later; the call resolves optimistically.
 */
import { queueMutation } from './offline.js';

const BASE = '/api';
let TENANT_ID = null;
let ACTOR_ID = null;

export function setTenantId(id) {
  TENANT_ID = id || null;
}

/** Bind live and offline mutations to the operator who initiated them. */
export function setAuthenticatedActor(id) {
  ACTOR_ID = id || null;
}

export function authenticatedActorId() { return ACTOR_ID; }

export class ApiError extends Error {
  constructor(message, code, status, details) {
    super(message || 'request failed');
    this.code = code || 'error';
    this.status = status || 0;
    this.details = details || null;
  }
}

export function newIdempotencyKey() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `k_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function buildUrl(path, query) {
  const url = path.startsWith('/api') ? path : `${BASE}${path.startsWith('/') ? '' : '/'}${path}`;
  if (!query) return url;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${url}?${s}` : url;
}

function baseHeaders(mutating, expectedActorId = ACTOR_ID) {
  const h = { accept: 'application/json' };
  if (TENANT_ID) h['x-tenant-id'] = TENANT_ID;
  if (expectedActorId) h['x-pos-expected-user-id'] = expectedActorId;
  if (mutating) h['x-mags-csrf'] = '1';
  return h;
}

async function parse(res) {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  return { _text: await res.text() };
}

function signalExpiredSession(path, status) {
  if (
    status === 401
    && path.startsWith('/api/')
    && !path.startsWith('/api/pos/auth')
  ) {
    window.dispatchEvent(new CustomEvent('mags:auth-required'));
  }
}

/** Low-level GET returning the parsed body; throws ApiError on !ok. */
export async function apiGet(path, query) {
  const url = buildUrl(path, query);
  const res = await fetch(url, { headers: baseHeaders(false), credentials: 'same-origin' });
  const body = await parse(res);
  if (!res.ok) {
    signalExpiredSession(url, res.status);
    throw fromBody(body, res.status);
  }
  return body;
}

/** GET a single entity's `.data`. */
export async function getData(path, query) {
  return (await apiGet(path, query)).data;
}

/** GET a list envelope `{ data, limit, offset }`. */
export async function getList(path, query) {
  const body = await apiGet(path, query);
  return { data: body.data ?? [], limit: body.limit, offset: body.offset };
}

function fromBody(body, status) {
  const e = body && body.error;
  return new ApiError(e?.message, e?.code, status, e?.details);
}

/**
 * Raw send for a mutation object `{ url, method, body, idempotencyKey }`.
 * Resolves `{ ok, status, body }`; rejects ONLY on network failure so the
 * offline queue can tell a 409 from being offline.
 */
export async function sendRaw(m) {
  const authRequest = m.url.startsWith('/api/pos/auth');
  if (!authRequest && !m.actorId) {
    return {
      ok: false,
      status: 409,
      body: { error: { message: 'Queued change has no operator attribution; review it before retrying.', code: 'operator_attribution_missing' } },
    };
  }
  const headers = baseHeaders(true, m.actorId || null);
  if (m.body !== null && m.body !== undefined) headers['content-type'] = 'application/json';
  if (m.idempotencyKey) headers['idempotency-key'] = m.idempotencyKey;
  const res = await fetch(m.url, {
    method: m.method || 'POST',
    headers,
    credentials: 'same-origin',
    body: m.body !== null && m.body !== undefined ? JSON.stringify(m.body) : undefined,
  });
  const body = await parse(res);
  signalExpiredSession(m.url, res.status);
  return { ok: res.ok, status: res.status, body };
}

/**
 * Perform a mutation. Options:
 *   queueable  — if offline, enqueue for later replay (returns { queued:true }).
 *   idempotencyKey — supply one, or set `idempotency:true` to auto-generate.
 * Returns the parsed success body on success; throws ApiError on a live error.
 */
export async function mutate(path, method, body, opts = {}) {
  const url = buildUrl(path, opts.query);
  let idempotencyKey = opts.idempotencyKey;
  if (!idempotencyKey && opts.idempotency) idempotencyKey = newIdempotencyKey();
  // Some bodies embed their own idempotency key field the API reads.
  if (idempotencyKey && body && typeof body === 'object' && opts.bodyKeyField) {
    body = { ...body, [opts.bodyKeyField]: idempotencyKey };
  }

  const mutation = {
    id: newIdempotencyKey(),
    url,
    method,
    body: body ?? null,
    idempotencyKey: idempotencyKey || newIdempotencyKey(),
    queuedAt: new Date().toISOString(),
    actorId: ACTOR_ID,
  };

  if (opts.queueable && !navigator.onLine && document.body.dataset.nativePos !== 'true') {
    await queueMutation(mutation);
    return { queued: true, id: mutation.id };
  }

  try {
    const result = await sendRaw(mutation);
    if (result.ok) return result.body;
    throw fromBody(result.body, result.status);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // Network failure mid-flight — queue it if allowed, else surface.
    if (opts.queueable) {
      await queueMutation(mutation);
      return { queued: true, id: mutation.id };
    }
    throw new ApiError('network unavailable', 'offline', 0);
  }
}
