import { z } from 'zod';
import type { InboundSummary } from './classify';

/**
 * Provider adapter INTERFACES + config SHAPES + fully-working SIMULATORS.
 *
 * The package contains NO network code. Real SMTP/IMAP transports are wired by
 * the integrator behind admin-configured credentials (referenced by a
 * credential-id string — the secret itself never lives here). Tests drive the
 * whole send/reply lane through the in-memory simulators below.
 */

// ── outbound mail transport ────────────────────────────────────────────────

export interface SendRequest {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
}

export interface SendReceipt {
  providerMessageId: string;
}

/** A mail sender. `send` THROWS on provider failure (→ send row status failed). */
export interface MailTransport {
  send(req: SendRequest): Promise<SendReceipt>;
}

// ── inbound mailbox reader ─────────────────────────────────────────────────

export interface InboundMessage extends InboundSummary {
  to: string;
  inReplyTo?: string;
  /** Provider-unique message ref — the idempotency key for ingest. */
  providerRef: string;
  /**
   * For a DSN/bounce: the ORIGINAL failed recipient, taken from the DSN's
   * structured Final-Recipient (a real reader parses RFC-3464; the simulator
   * sets it). Used to tie a bounce back to its send — the `from` on a bounce is
   * mailer-daemon, never the recipient.
   */
  bouncedRecipient?: string;
  /** ISO-8601 UTC. */
  receivedAt: string;
}

export interface FetchResult {
  messages: InboundMessage[];
  /** Opaque cursor to persist and pass back on the next fetch. */
  nextCursor: string;
}

/** A mailbox reader. `fetchNew` returns everything after `sinceCursor`. */
export interface MailboxReader {
  fetchNew(sinceCursor: string | null): Promise<FetchResult>;
}

// ── provider config shapes (zod) — credentials referenced by id, never inline ─

export const smtpConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1),
  /** Credential-id string resolved by admin at runtime — NOT the password. */
  passwordRef: z.string().min(1),
  secure: z.boolean().optional(),
});
export type SmtpConfig = z.infer<typeof smtpConfigSchema>;

export const imapConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1),
  passwordRef: z.string().min(1),
  secure: z.boolean().optional(),
});
export type ImapConfig = z.infer<typeof imapConfigSchema>;

// ── suppression injection (integrator wires customers.suppressions) ─────────

/** Records a suppression for an address (e.g. after unsubscribe). */
export type SuppressFn = (
  tenantId: string,
  email: string,
  reason: string,
) => void | Promise<void>;

/** True when an address is currently suppressed. */
export type IsSuppressedFn = (tenantId: string, email: string) => boolean | Promise<boolean>;

export interface OutreachAdapters {
  transport?: MailTransport;
  reader?: MailboxReader;
  suppress?: SuppressFn;
  isSuppressed?: IsSuppressedFn;
  /** Public base URL the unsubscribe link points at. */
  unsubscribeBaseUrl?: string;
}

// ── SIMULATORS (test-only, no network) ──────────────────────────────────────

export interface RecordedSend extends SendRequest {
  providerMessageId: string;
}

/**
 * In-memory transport. Records every send; can be told to FAIL (throw) for
 * specific recipients. Bounces are modeled through the reader (a DSN message),
 * exactly like the real world — the transport delivers, the mailbox reports.
 */
export class SimulatorTransport implements MailTransport {
  readonly sent: RecordedSend[] = [];
  readonly failRecipients = new Set<string>();
  private seq = 0;

  failFor(...emails: string[]): this {
    for (const e of emails) this.failRecipients.add(e.trim().toLowerCase());
    return this;
  }

  async send(req: SendRequest): Promise<SendReceipt> {
    if (this.failRecipients.has(req.to.trim().toLowerCase())) {
      throw new Error(`simulated provider failure for ${req.to}`);
    }
    this.seq += 1;
    const providerMessageId = `sim-msg-${this.seq}`;
    this.sent.push({ ...req, providerMessageId });
    return { providerMessageId };
  }
}

/**
 * In-memory mailbox reader. Tests `push()` inbound messages; `fetchNew` returns
 * everything after the numeric cursor and advances it. A DSN helper builds a
 * realistic hard-bounce message for a recipient.
 */
export class SimulatorReader implements MailboxReader {
  readonly messages: InboundMessage[] = [];

  push(...msgs: InboundMessage[]): this {
    this.messages.push(...msgs);
    return this;
  }

  /** Convenience: enqueue a realistic hard-bounce DSN for a prior send. */
  pushBounce(opts: { to: string; recipient: string; subject: string; providerRef: string; receivedAt: string }): this {
    return this.push({
      providerRef: opts.providerRef,
      from: 'mailer-daemon@mail.example.com',
      to: opts.to,
      bouncedRecipient: opts.recipient,
      subject: `Delivery Status Notification (Failure): ${opts.subject}`,
      text: `Your message to ${opts.recipient} could not be delivered.`,
      isDsn: true,
      receivedAt: opts.receivedAt,
    });
  }

  async fetchNew(sinceCursor: string | null): Promise<FetchResult> {
    const start = sinceCursor ? Math.max(0, parseInt(sinceCursor, 10) || 0) : 0;
    const messages = this.messages.slice(start);
    return { messages, nextCursor: String(this.messages.length) };
  }
}
