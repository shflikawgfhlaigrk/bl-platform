import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError, asCoreDb, updateTenant, errorHandler, listAuditEntries, listUsers } from '@blacklabel/core';
import { z } from 'zod';
import type { GoogleCalendarConnection } from '@blacklabel/scheduling';
import type { PlatformApp } from '../../api/src/app';
import { isBusinessPortalRoute, type businessEmployeeFiles } from '../../api/src/business-wiring';

export interface BusinessSettings { companyName: string; email?: { apiKey: string; from: string }; publicOrigin?: string; googleCalendar?: GoogleCalendarConnection }
export interface BusinessAppOptions {
  platform: PlatformApp; tenantId: string; ownerUserId: string; accessToken: string;
  settings: () => Promise<BusinessSettings>;
  saveSettings: (settings: BusinessSettings) => Promise<void>;
  asset: (name: string) => Promise<Uint8Array>;
  backup?: () => Promise<{ name: string; sha256: string; bytes: number }>;
  version: string;
  buildId?: string;
  installationId?: string;
  employeeFiles?: ReturnType<typeof businessEmployeeFiles>;
}

/** Customer composition surface. Tenant and acting owner are bound by the server. */
export function createBusinessApp(options: BusinessAppOptions) {
  const app = new Hono(); app.onError(errorHandler);
  const sessions = new Map<string, number>();
  let attempts = 0, windowStart = 0;
  const cookie = 'blacklabel_business_session';
  const teamCookie = 'blacklabel_team_session';
  const teamSessions = new Map<string, { token: string; expires: number }>();
  const teamToken = (request: Request) => {
    const key = request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(`${teamCookie}=`))?.slice(teamCookie.length + 1);
    const session = key ? teamSessions.get(key) : undefined;
    return session && session.expires > Date.now() ? session.token : undefined;
  };
  const equal = (left: string, right: string) => {
    const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b);
  };
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff');
    // no-referrer makes browser form navigations send Origin: null. Keep the
    // origin available for CSRF checks without sharing paths or login tokens.
    c.header('Referrer-Policy', 'strict-origin');
    c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const ownOrigin = new URL(c.req.url).origin;
    const settings = await options.settings();
    const origins = new Set([ownOrigin, ...(settings.publicOrigin ? [settings.publicOrigin] : [])]);
    const origin = c.req.header('origin');
    if (origin && !origins.has(origin)) throw ApiError.forbidden('request origin does not match this business');
    if (Number(c.req.header('content-length') ?? 0) > 15 * 1024 * 1024) throw new ApiError(413, 'request is too large');
    if (c.req.header('sec-fetch-site') === 'cross-site') throw ApiError.forbidden('cross-site request rejected');
    await next();
    // The inner platform adds its own headers. Apply the browser boundary after
    // forwarding as well, so its no-referrer default cannot null form origins.
    c.res.headers.set('Referrer-Policy', 'strict-origin');
    c.res.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  });
  const resolveOwnerRequest = (request: Request): string | undefined => {
    const authorization = request.headers.get('authorization');
    if (authorization?.startsWith('Bearer ') && equal(authorization.slice(7), options.accessToken)) return options.ownerUserId;
    const token = request.headers.get('cookie')?.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${cookie}=`))?.slice(cookie.length + 1);
    return token && (sessions.get(token) ?? 0) > Date.now() ? options.ownerUserId : undefined;
  };
  app.get('/api/business/health', (c) => c.json({ data: { brand: 'BlackLabel', version: options.version, buildId: options.buildId, installationId: options.installationId, status: 'ok' } }));
  app.post('/api/business/login', async (c) => {
    if (Date.now() - windowStart > 60000) { attempts = 0; windowStart = Date.now(); }
    if (++attempts > 20) throw new ApiError(429, 'Too many sign-in attempts. Try again in a minute.');
    const input = z.object({ token: z.string().max(1024) }).parse(await c.req.json());
    if (!equal(input.token, options.accessToken)) throw ApiError.unauthorized('That access key is incorrect.');
    const token = randomBytes(32).toString('base64url');
    for (const [key, expires] of sessions) if (expires <= Date.now()) sessions.delete(key);
    if (sessions.size >= 200) throw new ApiError(429, 'Too many active owner sessions. Sign out of an existing session.');
    sessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
    setCookie(c, cookie, token, { httpOnly: true, sameSite: 'Strict', secure: new URL(c.req.url).protocol === 'https:', path: '/', maxAge: 12 * 60 * 60 });
    return c.json({ data: { signedIn: true } });
  });
  app.post('/api/business/logout', (c) => {
    sessions.delete(getCookie(c, cookie) ?? ''); deleteCookie(c, cookie, { path: '/' }); return c.json({ data: { signedOut: true } });
  });
  app.post('/api/business/team/login', async (c) => {
    if (Date.now() - windowStart > 60000) { attempts = 0; windowStart = Date.now(); }
    if (++attempts > 40) throw new ApiError(429, 'Too many sign-in attempts. Try again in a minute.');
    const input = z.object({ token: z.string().min(1).max(1024) }).parse(await c.req.json());
    const response = await options.platform.app.request('/api/portal-employee/portal/me', { headers: { 'x-tenant-id': options.tenantId, 'x-employee-token': input.token } });
    if (!response.ok) throw ApiError.unauthorized('That team access key is invalid, expired or revoked.');
    for (const [key, session] of teamSessions) if (session.expires <= Date.now()) teamSessions.delete(key);
    if (teamSessions.size >= 2000) throw new ApiError(429, 'Too many active team sessions.');
    const session = randomBytes(32).toString('base64url');
    teamSessions.set(session, { token: input.token, expires: Date.now() + 12 * 60 * 60 * 1000 });
    setCookie(c, teamCookie, session, { httpOnly: true, sameSite: 'Strict', secure: new URL(c.req.url).protocol === 'https:', path: '/', maxAge: 12 * 60 * 60 });
    return c.json({ data: { signedIn: true } });
  });
  app.post('/api/business/team/logout', (c) => {
    teamSessions.delete(getCookie(c, teamCookie) ?? ''); deleteCookie(c, teamCookie, { path: '/' }); return c.json({ data: { signedOut: true } });
  });
  app.post('/api/business/team/assignments/:assignmentId/photos', async (c) => {
    const token = teamToken(c.req.raw); if (!token) throw ApiError.unauthorized('Sign in to your team workspace.');
    if (!options.employeeFiles) throw new ApiError(501, 'Team photo storage is not connected.');
    const input = z.object({ name: z.string().min(1).max(255), mime: z.enum(['image/jpeg', 'image/png', 'image/webp']),
      contentBase64: z.string().min(1), caption: z.string().max(2000).optional() }).strict().parse(await c.req.json());
    return c.json({ data: await options.employeeFiles.upload({ ...input, tenantId: options.tenantId, token, assignmentId: c.req.param('assignmentId') }) }, 201);
  });
  app.get('/api/business/team/assignments/:assignmentId/photos/:fileId', async (c) => {
    const token = teamToken(c.req.raw); if (!token) throw ApiError.unauthorized('Sign in to your team workspace.');
    if (!options.employeeFiles) throw new ApiError(501, 'Team photo storage is not connected.');
    const file = await options.employeeFiles.read({ tenantId: options.tenantId, token, assignmentId: c.req.param('assignmentId'), fileId: c.req.param('fileId') });
    c.header('Content-Type', file.mime); c.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    return c.body(new Uint8Array(file.content));
  });
  const portalPath = isBusinessPortalRoute;
  app.use('/api/*', async (c, next) => {
    if (portalPath(c.req.path)) return next(); // Modules authenticate their own customer/employee identities.
    if (!resolveOwnerRequest(c.req.raw)) throw ApiError.unauthorized('Sign in to your BlackLabel business.');
    await next();
  });
  app.get('/api/business/settings', async (c) => {
    const settings = await options.settings();
    return c.json({ data: { companyName: settings.companyName, version: options.version, ownerUserId: options.ownerUserId,
      email: { connected: !!settings.email?.apiKey, from: settings.email?.from ?? '' },
      googleCalendar: { connected: !!settings.googleCalendar, calendarId: settings.googleCalendar?.calendarId ?? '' },
      customerPortal: `${settings.publicOrigin ?? ''}/api/portal-customer/ui`, publicOrigin: settings.publicOrigin ?? null,
      onboardingComplete: settings.companyName !== 'Your company' } });
  });
  app.get('/api/business/users', async (c) => c.json({ data: await listUsers(asCoreDb(options.platform.db), options.tenantId, { limit: 200, offset: 0 }) }));
  app.patch('/api/business/settings', async (c) => {
    const input = z.object({ companyName: z.string().trim().min(1).max(150).optional(),
      email: z.object({ apiKey: z.string().min(1).max(512), from: z.string().email() }).nullable().optional(),
      googleCalendar: z.object({ calendarId: z.string().min(1).max(512), clientId: z.string().min(1).max(512), clientSecret: z.string().min(1).max(1024), refreshToken: z.string().min(1).max(4096) }).nullable().optional() }).strict().parse(await c.req.json());
    const previous = await options.settings();
    const next: BusinessSettings = { ...previous, ...input, email: input.email === null ? undefined : input.email ?? previous.email, googleCalendar: input.googleCalendar === null ? undefined : input.googleCalendar ?? previous.googleCalendar };
    if (input.companyName) await updateTenant(asCoreDb(options.platform.db), options.tenantId, { name: input.companyName });
    await options.saveSettings(next);
    if (input.email) {
      // A connection and its configured sender are the same tenant-owned setting.
      const headers = { 'x-tenant-id': options.tenantId, 'x-user-id': options.ownerUserId, 'content-type': 'application/json' };
      const list = await options.platform.app.request('/api/messaging/channels?limit=200', { headers });
      const rows = (await list.json() as any).data ?? [];
      const own = rows.find((row: any) => row.type === 'email' && row.address === input.email!.from);
      for (const row of rows.filter((row: any) => row.type === 'email' && row.id !== own?.id && row.is_active)) {
        await options.platform.app.request(`/api/messaging/channels/${row.id}`, { method: 'PATCH', headers, body: JSON.stringify({ isActive: false }) });
      }
      const response = await options.platform.app.request(own ? `/api/messaging/channels/${own.id}` : '/api/messaging/channels', {
        method: own ? 'PATCH' : 'POST', headers, body: JSON.stringify(own ? { isActive: true } : { type: 'email', name: 'Company email', address: input.email.from }) });
      if (!response.ok) throw ApiError.conflict('Email settings saved; sender activation failed. Review the company inbox connection.');
    }
    return c.json({ data: { saved: true } });
  });
  app.get('/api/business/audit', async c => {
    const query = z.object({ entityType: z.string().regex(/^crm\.[a-z_]+$/), entityId: z.string().min(1).max(200) }).parse(c.req.query());
    return c.json({ data: await listAuditEntries(asCoreDb(options.platform.db), options.tenantId, query.entityType, query.entityId) });
  });
  app.post('/api/business/backups', async (c) => {
    if (!options.backup) throw new ApiError(501, 'Backup storage is not connected.');
    return c.json({ data: await options.backup() });
  });
  app.all('/api/*', async (c) => {
    const headers = new Headers(c.req.raw.headers);
    headers.set('x-tenant-id', options.tenantId); headers.delete('x-user-id');
    if (c.req.path.startsWith('/api/portal-employee/portal/')) {
      const token = teamToken(c.req.raw); if (token) headers.set('x-employee-token', token);
    }
    // A public portal request never receives the caller-supplied staff identity.
    if (!portalPath(c.req.path)) headers.set('x-user-id', options.ownerUserId);
    return options.platform.app.fetch(new Request(c.req.raw, { headers }));
  });
  for (const [route, name, mime] of [['/', 'index.html', 'text/html'], ['/app.js', 'app.js', 'text/javascript'], ['/crm.js', 'crm.js', 'text/javascript'], ['/scheduling.js', 'scheduling.js', 'text/javascript'], ['/quoting.js', 'quoting.js', 'text/javascript'], ['/app.css', 'app.css', 'text/css'], ['/brand.svg', 'brand.svg', 'image/svg+xml'],
    ...['workflows','files','billing','messaging','reviews','industries'].map(name => [`/${name}.js`, `${name}.js`, 'text/javascript']),
    ['/team', 'team.html', 'text/html'], ['/team.js', 'team.js', 'text/javascript'], ['/review', 'review.html', 'text/html'], ['/review.js', 'review.js', 'text/javascript']]) {
    app.get(route, async (c) => { c.header('Content-Type', `${mime}; charset=utf-8`); return c.body(new Uint8Array(await options.asset(name))); });
  }
  return Object.assign(app, { resolveOwnerRequest });
}
