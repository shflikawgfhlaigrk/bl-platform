import { describe, expect, it } from 'vitest';
import { classify, looksLikeAutoReply, looksLikeBounce, normalizeSubject } from '../src/classify';

describe('classification (mail_replies.py port)', () => {
  it('bounce: mailer-daemon / postmaster sender', () => {
    expect(classify({ from: 'MAILER-DAEMON@mail.example.com', subject: 'anything' }, true)).toBe('bounce');
    expect(classify({ from: 'postmaster@corp.example', subject: 'hi' }, false)).toBe('bounce');
  });

  it('bounce: DSN-shaped subject or DSN flag', () => {
    expect(classify({ from: 'noreply@x.com', subject: 'Undelivered Mail Returned to Sender' }, false)).toBe('bounce');
    expect(classify({ from: 'x@y.com', subject: 'Delivery Status Notification (Failure)' }, false)).toBe('bounce');
    expect(classify({ from: 'x@y.com', subject: 're: your order', isDsn: true }, true)).toBe('bounce');
  });

  it('auto_reply: out-of-office / no-reply / auto-submitted', () => {
    expect(classify({ from: 'jane@buyer.com', subject: 'Out of Office: Re: your order' }, true)).toBe('auto_reply');
    expect(classify({ from: 'no-reply@buyer.com', subject: 'Re: your order' }, true)).toBe('auto_reply');
    expect(classify({ from: 'jane@buyer.com', subject: 'Re: your order', autoSubmitted: true }, true)).toBe('auto_reply');
  });

  it('reply: human answer matched to a real send', () => {
    expect(classify({ from: 'jane@buyer.com', subject: 'Re: New arrivals for your barn' }, true)).toBe('reply');
  });

  it('unknown: unmatched, non-bounce, non-auto', () => {
    expect(classify({ from: 'stranger@vendor.com', subject: 'partnership opportunity' }, false)).toBe('unknown');
  });

  it('bounce/auto win over a would-be reply match', () => {
    // Even matched to a send, a genuine DSN is a bounce, not a "yes".
    expect(classify({ from: 'jane@buyer.com', subject: 'Mail delivery failed', isDsn: true }, true)).toBe('bounce');
  });

  it('normalizeSubject strips Re:/Fwd: chains', () => {
    expect(normalizeSubject('Re: Fwd:  New Arrivals')).toBe('new arrivals');
    expect(normalizeSubject('FW: Re: Re: hi there')).toBe('hi there');
  });

  it('predicates are independently correct', () => {
    expect(looksLikeBounce({ from: 'a@b.com', subject: 'failure notice' })).toBe(true);
    expect(looksLikeAutoReply({ from: 'a@b.com', subject: 'automatic reply' })).toBe(true);
  });
});
