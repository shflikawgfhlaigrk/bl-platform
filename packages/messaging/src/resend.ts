import { createHash } from 'node:crypto';
import type { ChannelProvider, ChannelSendResult, ChannelDeliveryResult, OutboundPayload } from './service';

export interface ResendConnection { apiKey: string; from: string }
export interface ResendOptions {
  /** Resolved by tenant on every request; never shared across customer accounts. */
  connection: (tenantId: string) => Promise<ResendConnection | undefined>;
  fetchImpl?: typeof fetch;
}

/** Resend REST adapter. POST admits a message; GET proves its subsequent state. */
export class ResendEmailProvider implements ChannelProvider {
  readonly type = 'email' as const;
  private readonly transport: typeof fetch;
  constructor(private readonly options: ResendOptions) { this.transport = options.fetchImpl ?? fetch; }

  private async connected(payload: OutboundPayload): Promise<ResendConnection> {
    const connection = await this.options.connection(payload.tenantId);
    if (!connection?.apiKey || !connection.from) throw new Error('Email connection is incomplete for this company.');
    if (!payload.from || connection.from !== payload.from) throw new Error('The selected sender does not match this company\'s email connection.');
    return connection;
  }

  async send(payload: OutboundPayload): Promise<ChannelSendResult> {
    let connection: ResendConnection;
    try { connection = await this.connected(payload); }
    catch (error) { return { status: 'failed', providerMessageId: '', detail: (error as Error).message }; }
    if (!payload.operationId) return { status: 'failed', providerMessageId: '', detail: 'A durable message operation is required.' };
    let response: Response;
    try {
      response = await this.transport('https://api.resend.com/emails', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${connection.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': payload.operationId },
        body: JSON.stringify({ from: connection.from, to: [payload.to], subject: payload.subject ?? '', text: payload.body,
          tags: [{ name: 'blacklabel_operation', value: payload.operationId }] }),
      });
    } catch { return { status: 'queued', providerMessageId: '', detail: 'Email submission outcome is unresolved. Read the provider record before retrying.' }; }
    // A server timeout/failure may follow admission. Never convert it into permission to resend.
    if (response.status >= 500 || response.status === 408) return { status: 'queued', providerMessageId: '', detail: `Email provider outcome unresolved (HTTP ${response.status}).` };
    if (!response.ok) return { status: 'failed', providerMessageId: '', detail: `Email provider rejected the request (HTTP ${response.status}).` };
    const row = await response.json().catch(() => null) as { id?: unknown } | null;
    if (typeof row?.id !== 'string' || !row.id) return { status: 'queued', providerMessageId: '', detail: 'Email provider did not return a message id.' };
    return { status: 'sent', providerMessageId: row.id };
  }

  async reconcile(payload: OutboundPayload & { providerMessageId: string }): Promise<ChannelDeliveryResult> {
    const connection = await this.connected(payload);
    if (!/^[a-zA-Z0-9_-]{1,255}$/.test(payload.providerMessageId)) throw new Error('Invalid provider message id.');
    let response: Response;
    try {
      response = await this.transport(`https://api.resend.com/emails/${encodeURIComponent(payload.providerMessageId)}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${connection.apiKey}` },
      });
    } catch { throw new Error('Provider readback is unavailable; the recorded submission stays unchanged.'); }
    if (!response.ok) throw new Error(`Provider readback failed (HTTP ${response.status}); submission unchanged.`);
    const text = await response.text();
    let row: { id?: string; from?: string; to?: string[]; subject?: string; text?: string; last_event?: string };
    try { row = JSON.parse(text); } catch { throw new Error('Provider readback returned invalid data.'); }
    if (row.id !== payload.providerMessageId || row.from !== payload.from || row.to?.length !== 1 || row.to[0] !== payload.to
      || row.subject !== (payload.subject ?? '') || row.text !== payload.body) throw new Error('Provider readback does not match the exact sender, recipient, subject and body.');
    const event = row.last_event?.replace(/^email\./, '');
    const status = ['delivered', 'opened', 'clicked'].includes(event ?? '') ? 'delivered'
      : ['bounced', 'complained', 'failed', 'suppressed'].includes(event ?? '') ? 'failed'
      : ['sent', 'scheduled', 'delivery_delayed'].includes(event ?? '') ? 'accepted' : 'unknown';
    return { status, providerMessageId: row.id, detail: event ?? 'No delivery event available',
      evidenceSha256: createHash('sha256').update(text).digest('hex') };
  }
}
