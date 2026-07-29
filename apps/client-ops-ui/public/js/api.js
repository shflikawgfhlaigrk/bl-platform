export class ApiError extends Error {
  constructor(message, { code = 'request_failed', status = 0, details = null } = {}) {
    super(message || 'The request failed.');
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

let tenantId = null;

export function setTenantId(value) {
  tenantId = value || null;
}

export function newIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `client_ops_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

async function parseResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    return text ? { message: text } : null;
  }
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorFrom(body, status) {
  const error = body?.error || body;
  const fallback = status === 404
    ? 'This Client Operations endpoint is not available yet.'
    : status >= 500
      ? 'Client Operations returned a server error.'
      : 'Client Operations could not complete the request.';
  return new ApiError(error?.message || fallback, {
    code: error?.code || 'request_failed',
    status,
    details: error?.details || null,
  });
}

export async function request(url, options = {}) {
  const method = options.method || 'GET';
  const mutating = method !== 'GET' && method !== 'HEAD';
  const headers = { accept: 'application/json', ...options.headers };
  if (tenantId) headers['x-tenant-id'] = tenantId;
  if (mutating) {
    headers['content-type'] = 'application/json';
    headers['x-mags-csrf'] = '1';
    headers['idempotency-key'] = options.idempotencyKey || newIdempotencyKey();
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      signal: options.signal,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiError('Client Operations is unreachable. Check the API connection and try again.', { code: 'network_unavailable' });
  }
  const body = await parseResponse(response);
  if (!response.ok) throw errorFrom(body, response.status);
  return body;
}
