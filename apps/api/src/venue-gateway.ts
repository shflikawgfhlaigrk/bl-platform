/** Fixed-tenant edge for the single-register venue deployment. */
export function venueGateway(options: {
  tenantId: string;
  origin: string;
  fetch: (request: Request) => Response | Promise<Response>;
}) {
  const origin = new URL(options.origin).origin;
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const incomingOrigin = request.headers.get('origin');
    if (incomingOrigin && incomingOrigin !== origin) {
      return Response.json({ error: { message: 'Use the configured ONE Club app address.', code: 'origin_rejected' } }, { status: 403 });
    }
    const headers = new Headers(request.headers);
    headers.set('x-tenant-id', options.tenantId);
    headers.delete('x-user-id');
    // Only the fixed, local reverse proxy reaches this listener. Do not let
    // untrusted forwarding headers rotate the per-IP rate-limit bucket.
    headers.delete('x-forwarded-for'); headers.delete('x-real-ip');
    headers.delete('forwarded'); headers.delete('x-forwarded-host');
    headers.set('host', new URL(origin).host);
    const forwarded = new Request(`${origin}${url.pathname}${url.search}`, request);
    return options.fetch(new Request(forwarded, { headers }));
  };
}
