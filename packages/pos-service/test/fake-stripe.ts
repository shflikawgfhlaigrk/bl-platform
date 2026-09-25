import type { StripeFetch } from '../src/stripe-client';

export interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  form: URLSearchParams | null;
  json: Record<string, unknown> | null;
}

type Reply = { status?: number; body: unknown; requestId?: string };
type Route = (call: RecordedCall) => Reply | undefined;

/** A scripted Stripe: routes by method + path, records every request exactly as sent. */
export function fakeStripe(state: {
  cardPayments?: string;
  requirements?: unknown[];
  readerDeviceType?: string;
  intentStatuses?: string[];
  refundStatus?: string;
  /** Set when the card was declined: Stripe returns the intent to requires_payment_method with this error. */
  declineCode?: string;
  /** The test charge was refunded in full (for example by hand in the Stripe Dashboard). */
  chargeRefunded?: boolean;
  /** Error code the reader's cancel_action answers with, such as terminal_reader_busy. */
  readerCancelError?: string;
  failPath?: string;
} = {}) {
  const calls: RecordedCall[] = [];
  let intentsCreated = 0;
  const intentId = (n: number) => (n <= 1 ? 'pi_TestSale' : `pi_TestSale${n}`);
  const intentPath = /^\/v1\/payment_intents\/(pi_TestSale\d*)(\/capture|\/cancel)?$/;
  const nextIntentStatus = () => {
    const statuses = state.intentStatuses ?? ['requires_capture'];
    return statuses.length > 1 ? statuses.shift()! : statuses[0];
  };
  const routes: Route[] = [
    (c) => (c.method === 'POST' && c.path === '/v2/core/accounts'
      ? { body: { id: 'acct_1TestMerchant', object: 'v2.core.account', configuration: { merchant: { capabilities: { card_payments: { status: 'pending', status_details: [] } } } } } }
      : undefined),
    (c) => (c.method === 'POST' && c.path === '/v2/core/account_links'
      ? { body: { object: 'v2.core.account_link', url: 'https://accounts.stripe.com/r/acct_1TestMerchant#alu_test_1', expires_at: '2026-09-15T20:10:00.000Z' } }
      : undefined),
    (c) => (c.method === 'GET' && c.path === '/v2/core/accounts/acct_1TestMerchant'
      ? { body: { id: 'acct_1TestMerchant', configuration: { merchant: { capabilities: { card_payments: { status: state.cardPayments ?? 'active', status_details: [] } } } }, requirements: { entries: state.requirements ?? [] } } }
      : undefined),
    (c) => (c.method === 'POST' && c.path === '/v1/terminal/locations' ? { body: { id: 'tml_TestLocation', object: 'terminal.location' } } : undefined),
    (c) => (c.method === 'POST' && c.path === '/v1/terminal/readers'
      ? { body: { id: 'tmr_TestReader', object: 'terminal.reader', device_type: state.readerDeviceType ?? 'stripe_s700', status: 'online' } }
      : undefined),
    (c) => (c.method === 'DELETE' && c.path.startsWith('/v1/terminal/readers/') ? { body: { id: c.path.split('/').pop(), deleted: true } } : undefined),
    (c) => (c.method === 'POST' && c.path === '/v1/payment_intents' ? { body: { id: intentId(++intentsCreated), status: 'requires_payment_method' } } : undefined),
    (c) => (c.method === 'POST' && c.path === '/v1/terminal/readers/tmr_TestReader/process_payment_intent' ? { body: { id: 'tmr_TestReader', action: { status: 'in_progress' } } } : undefined),
    (c) => {
      if (c.method !== 'POST' || c.path !== '/v1/terminal/readers/tmr_TestReader/cancel_action') return undefined;
      return state.readerCancelError
        ? { status: 400, body: { error: { code: state.readerCancelError, message: 'Reader could not cancel.' } } }
        : { body: { id: 'tmr_TestReader', action: null } };
    },
    (c) => {
      const match = intentPath.exec(c.path);
      if (!match) return undefined;
      const [, id, suffix] = match;
      if (c.method === 'GET' && !suffix) {
        const expanded = c.query.getAll('expand[]').includes('latest_charge');
        const charge = expanded ? { id: 'ch_TestCharge', object: 'charge', refunded: state.chargeRefunded ?? false } : 'ch_TestCharge';
        return { body: { id, status: nextIntentStatus(), latest_charge: charge, last_payment_error: state.declineCode ? { code: state.declineCode } : null } };
      }
      if (c.method === 'POST' && suffix === '/capture') return { body: { id, status: 'succeeded', latest_charge: 'ch_TestCharge' } };
      if (c.method === 'POST' && suffix === '/cancel') return { body: { id, status: 'canceled' } };
      return undefined;
    },
    (c) => (c.method === 'POST' && c.path === '/v1/refunds' ? { body: { id: 're_TestRefund', status: state.refundStatus ?? 'succeeded' } } : undefined),
  ];
  const fetch: StripeFetch = async (url, init) => {
    const parsed = new URL(url);
    const contentType = init.headers['Content-Type'] ?? '';
    const call: RecordedCall = {
      method: init.method,
      path: parsed.pathname,
      query: parsed.searchParams,
      headers: init.headers,
      form: contentType.includes('x-www-form-urlencoded') ? new URLSearchParams(init.body ?? '') : null,
      json: contentType.includes('json') ? (JSON.parse(init.body ?? '{}') as Record<string, unknown>) : null,
    };
    calls.push(call);
    if (state.failPath && call.path === state.failPath) {
      return { status: 400, headers: { get: (n) => (n === 'request-id' ? 'req_fail' : null) }, text: async () => JSON.stringify({ error: { code: 'resource_missing', message: 'No such thing' } }) };
    }
    const reply = routes.map((route) => route(call)).find(Boolean);
    if (!reply) return { status: 404, text: async () => JSON.stringify({ error: { code: 'unrouted', message: `${call.method} ${call.path}` } }) };
    return { status: reply.status ?? 200, headers: { get: (n) => (n === 'request-id' ? reply.requestId ?? 'req_test' : null) }, text: async () => JSON.stringify(reply.body) };
  };
  return { fetch, calls, state };
}
