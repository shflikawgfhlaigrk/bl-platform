/**
 * Deterministic reply-vs-bounce classification, ported from
 * ProjectUtah/utah/mail_replies.py (classify + DSN detection) to pure
 * TypeScript. No IMAP, no network — operates on an already-fetched message
 * summary so every branch is unit-testable.
 *
 * ── RULES (evaluated in this order) ───────────────────────────────────────
 *  1. bounce      — a delivery-failure notice. Detected by EITHER a
 *                   mailer-daemon@ / postmaster@ sender local-part, OR a DSN-
 *                   shaped subject ("delivery status notification", "undelivered
 *                   mail", "mail delivery failed", "delivery has failed",
 *                   "failure notice", "returned mail", "undeliverable").
 *  2. auto_reply  — an auto-generated response. Detected by a no-reply/
 *                   do-not-reply sender, an "auto-submitted" style flag, or an
 *                   out-of-office / auto-reply / vacation subject.
 *  3. reply       — a human answer that matches one of our real prior sends
 *                   (recipient + normalized subject). Matching a real send is the
 *                   corroboration that this is a genuine prospect reply, not a
 *                   spoof — exactly like mail_replies' `pitched` membership.
 *  4. unknown     — none of the above (vendor noise, unmatched inbound).
 *
 * bounce/auto-reply win over `reply` so a bounce whose From happens to match a
 * pitched address (a real DSN) is never misfiled as a "yes". This inverts
 * mail_replies' pitched-wins ordering deliberately: here bounces are detected by
 * subject/DSN shape (we don't parse full MIME), so shape must win to avoid
 * marking a bounce as a reply.
 */

export type Classification = 'reply' | 'bounce' | 'auto_reply' | 'unknown';

export interface InboundSummary {
  from: string;
  subject: string;
  text?: string;
  /** RFC-3464 structure flag when the reader can surface it. */
  isDsn?: boolean;
  /** Any auto-submitted / x-autoreply header the reader surfaced. */
  autoSubmitted?: boolean;
}

const BOUNCE_LOCAL_PARTS = new Set(['mailer-daemon', 'postmaster']);

const BOUNCE_SUBJECT = /(delivery status notification|undelivered mail|mail delivery (failed|subsystem)|delivery has failed|failure notice|returned mail|undeliverable|delivery failure)/i;

const AUTO_REPLY_SUBJECT = /(out of (the )?office|auto[-\s]?reply|automatic reply|vacation|away from|autoresponder)/i;

const AUTO_REPLY_LOCAL = /^(no[-.]?reply|do[-.]?not[-.]?reply|donotreply|noreply)$/i;

/** Normalize an email address to a lowercase comparable form. */
export function normalizeEmail(email: string): string {
  return (email ?? '').trim().toLowerCase();
}

function localPart(email: string): string {
  return normalizeEmail(email).split('@', 1)[0] ?? '';
}

/** Strip leading Re:/Fwd: prefixes and collapse whitespace for subject matching. */
export function normalizeSubject(subject: string): string {
  let s = (subject ?? '').trim();
  // Strip any run of leading "re:" / "fwd:" / "fw:" prefixes.
  while (true) {
    const stripped = s.replace(/^\s*(re|fwd|fw)\s*:\s*/i, '');
    if (stripped === s) break;
    s = stripped;
  }
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function looksLikeBounce(msg: InboundSummary): boolean {
  if (msg.isDsn) return true;
  if (BOUNCE_LOCAL_PARTS.has(localPart(msg.from))) return true;
  return BOUNCE_SUBJECT.test(msg.subject ?? '');
}

export function looksLikeAutoReply(msg: InboundSummary): boolean {
  if (msg.autoSubmitted) return true;
  if (AUTO_REPLY_LOCAL.test(localPart(msg.from))) return true;
  return AUTO_REPLY_SUBJECT.test(msg.subject ?? '');
}

/**
 * Classify one inbound message. `matchedSend` = whether this message ties back
 * to a real prior send (recipient + normalized subject) — computed by the
 * caller against the send-of-record.
 */
export function classify(msg: InboundSummary, matchedSend: boolean): Classification {
  if (looksLikeBounce(msg)) return 'bounce';
  if (looksLikeAutoReply(msg)) return 'auto_reply';
  if (matchedSend) return 'reply';
  return 'unknown';
}
