import { createHash } from 'node:crypto';
import type { ExternalCalendarProvider, ExternalEventInput } from './service';

export interface GoogleCalendarConnection { calendarId: string; clientId: string; clientSecret: string; refreshToken: string }
export interface GoogleCalendarOptions {
  connection: (tenantId: string) => Promise<GoogleCalendarConnection | undefined>;
  fetchImpl?: typeof fetch;
}

/** Buyer-owned Google calendar, deterministic event ids, exact destination readback. */
export class GoogleCalendarProvider implements ExternalCalendarProvider {
  readonly name = 'google-calendar';
  private readonly transport: typeof fetch;
  constructor(private readonly options: GoogleCalendarOptions) { this.transport = options.fetchImpl ?? fetch; }
  private identity(ref: { tenantId: string; calendarId: string; appointmentId: string }) {
    return createHash('sha256').update(JSON.stringify([ref.tenantId, ref.calendarId, ref.appointmentId])).digest('hex');
  }
  private async session(tenantId: string) {
    const connection = await this.options.connection(tenantId);
    if (!connection?.calendarId || !connection.clientId || !connection.clientSecret || !connection.refreshToken) throw Error('Connect this company’s Google Calendar first.');
    const response = await this.transport('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: connection.clientId, client_secret: connection.clientSecret, refresh_token: connection.refreshToken }) });
    if (!response.ok) throw Error(`Google authorization failed (HTTP ${response.status}). Reconnect the company calendar.`);
    const token = await response.json() as { access_token?: string; token_type?: string };
    if (!token.access_token || token.token_type?.toLowerCase() !== 'bearer') throw Error('Google did not provide calendar authorization.');
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(connection.calendarId)}/events`;
    const request = (suffix: string, method = 'GET', body?: unknown) => this.transport(`${base}${suffix}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${token.access_token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { request };
  }
  async upsertEvent(event: ExternalEventInput): Promise<{ externalId: string }> {
    const { request } = await this.session(event.tenantId), eventId = this.identity(event);
    const body = { id: eventId, summary: event.title, start: { dateTime: event.startsAt }, end: { dateTime: event.endsAt },
      extendedProperties: { private: { blacklabel_operation: eventId } } };
    const lookup = await request(`/${eventId}`);
    const exists = lookup.ok;
    if (exists) {
      const prior = await lookup.json() as any;
      if (prior.id !== eventId || prior.extendedProperties?.private?.blacklabel_operation !== eventId) throw Error('The destination event does not belong to this appointment.');
    } else if (lookup.status !== 404) throw Error(`Google event lookup failed (HTTP ${lookup.status}).`);
    let writeStatus = 0;
    try { writeStatus = (await request(exists ? `/${eventId}?sendUpdates=none` : '?sendUpdates=none', exists ? 'PUT' : 'POST', body)).status; }
    catch { /* A lost write response is resolved by reading the deterministic event. */ }
    const readback = await request(`/${eventId}`);
    if (!readback.ok) throw Error(`Google event write remains unverified (HTTP ${writeStatus || 'unknown'}; readback ${readback.status}).`);
    const saved = await readback.json() as any;
    if (saved.id !== eventId || saved.status === 'cancelled' || saved.summary !== event.title
      || Date.parse(saved.start?.dateTime) !== Date.parse(event.startsAt) || Date.parse(saved.end?.dateTime) !== Date.parse(event.endsAt)
      || saved.extendedProperties?.private?.blacklabel_operation !== eventId) throw Error('Google event readback differs from the scheduled appointment.');
    return { externalId: eventId };
  }
  async deleteEvent(ref: { tenantId: string; calendarId: string; appointmentId: string }): Promise<void> {
    const { request } = await this.session(ref.tenantId), eventId = this.identity(ref);
    const existing = await request(`/${eventId}`);
    if ([404, 410].includes(existing.status)) return;
    if (!existing.ok) throw Error(`Google event lookup failed (HTTP ${existing.status}).`);
    const prior = await existing.json() as any;
    if (prior.id !== eventId || prior.extendedProperties?.private?.blacklabel_operation !== eventId) throw Error('The destination event does not belong to this appointment.');
    if (prior.status === 'cancelled') return;
    try { await request(`/${eventId}?sendUpdates=none`, 'DELETE'); } catch { /* Resolve by readback. */ }
    const readback = await request(`/${eventId}`);
    if ([404, 410].includes(readback.status)) return;
    if (readback.ok && (await readback.json() as any).status === 'cancelled') return;
    throw Error('Google event cancellation remains unverified.');
  }
}
