import { describe, expect, it } from 'vitest';
import { parseExportFile } from '../src/export-adapter';
import { SquarePollingClient, type PollRequest, type PollResponse } from '../src/polling-adapter';
import {
  computeWebhookSignature,
  normalizeWebhookEvent,
  verifyWebhookSignature,
  type WebhookSignatureConfig,
} from '../src/webhook-adapter';
import { SimulatedSquareProvider } from '../src/simulator';
import { squarePayment } from './helpers';

describe('export-drop adapter', () => {
  it('parses a bare JSON array', () => {
    const batch = parseExportFile('payments', JSON.stringify([squarePayment('p1', 100)]), { fileName: 'payments.json' });
    expect(batch.source).toBe('square_export');
    expect(batch.kind).toBe('payments');
    expect(batch.records).toHaveLength(1);
    expect(batch.sourceMeta.fileName).toBe('payments.json');
  });

  it('parses a dict-wrapped payload (gift_cards / disputes wrap under their key)', () => {
    const gc = parseExportFile('gift_cards', JSON.stringify({ gift_cards: [{ id: 'g1' }] }));
    expect(gc.records).toHaveLength(1);
    const cat = parseExportFile('catalog', JSON.stringify({ objects: [{ type: 'ITEM', id: 'i1' }] }));
    expect(cat.records).toHaveLength(1);
  });

  it('rejects bad JSON and unknown kinds', () => {
    expect(() => parseExportFile('payments', '{not json')).toThrow();
    expect(() => parseExportFile('nope', '[]')).toThrow();
  });
});

describe('webhook adapter — real HMAC-SHA256', () => {
  const config: WebhookSignatureConfig = {
    signatureKey: 'test-signature-key',
    notificationUrl: 'https://mags.local/webhooks/square',
  };
  const body = JSON.stringify({
    event_id: 'evt_1',
    type: 'payment.updated',
    data: { type: 'payment', id: 'p1', object: { payment: squarePayment('p1', 700) } },
  });

  it('verifies a correctly signed body', () => {
    const sig = computeWebhookSignature(body, config);
    expect(verifyWebhookSignature({ 'x-square-hmacsha256-signature': sig }, body, config)).toBe(true);
  });

  it('rejects a tampered body / bad signature / missing header', () => {
    const sig = computeWebhookSignature(body, config);
    expect(verifyWebhookSignature({ 'x-square-hmacsha256-signature': sig }, body + ' ', config)).toBe(false);
    expect(verifyWebhookSignature({ 'x-square-hmacsha256-signature': 'deadbeef' }, body, config)).toBe(false);
    expect(verifyWebhookSignature({}, body, config)).toBe(false);
  });

  it('normalizes an event into an ImportBatch', () => {
    const { eventId, batch } = normalizeWebhookEvent(JSON.parse(body));
    expect(eventId).toBe('evt_1');
    expect(batch.kind).toBe('payments');
    expect(batch.source).toBe('square_webhook');
    expect(batch.sourceMeta.webhookEventId).toBe('evt_1');
    expect(batch.records).toHaveLength(1);
  });
});

describe('polling client with a fake transport', () => {
  it('follows pagination to the end', async () => {
    const reqs: PollRequest[] = [];
    const transport = async (req: PollRequest): Promise<PollResponse> => {
      reqs.push(req);
      if (req.cursor === null) return { records: [squarePayment('p1', 100)], cursor: 'c1' };
      return { records: [squarePayment('p2', 200)], cursor: null };
    };
    const client = new SquarePollingClient({ transport });
    const res = await client.poll('payments', null);
    expect(res.pagesFetched).toBe(2);
    expect(res.batch.records).toHaveLength(2);
    expect(reqs[0].cursor).toBeNull();
    expect(reqs[1].cursor).toBe('c1');
  });

  it('advances the watermark cursor to the max seen timestamp', async () => {
    const transport = async (): Promise<PollResponse> => ({
      records: [
        { ...squarePayment('p1', 100), updated_at: '2026-03-01T00:00:00.000Z' },
        { ...squarePayment('p2', 200), updated_at: '2026-03-09T00:00:00.000Z' },
      ],
      cursor: null,
    });
    const res = await new SquarePollingClient({ transport }).poll('payments', null);
    expect(res.newCursor).toBe('2026-03-09T00:00:00.000Z');
  });

  it('applies the overlap window to a saved cursor (re-fetch from watermark minus overlap)', async () => {
    const reqs: PollRequest[] = [];
    const transport = async (req: PollRequest): Promise<PollResponse> => {
      reqs.push(req);
      return { records: [], cursor: null };
    };
    const client = new SquarePollingClient({ transport, overlapSeconds: 60 });
    await client.poll('payments', '2026-03-09T00:01:00.000Z');
    expect(reqs[0].beginTime).toBe('2026-03-09T00:00:00.000Z');
  });

  it('respects a 429 retry-after and retries', async () => {
    const waits: number[] = [];
    let calls = 0;
    const transport = async (): Promise<PollResponse> => {
      calls += 1;
      if (calls === 1) return { status: 429, retryAfterMs: 250 };
      return { records: [squarePayment('p1', 100)], cursor: null };
    };
    const client = new SquarePollingClient({
      transport,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const res = await client.poll('payments', null);
    expect(waits).toEqual([250]);
    expect(res.rateLimitWaits).toBe(1);
    expect(res.batch.records).toHaveLength(1);
  });
});

describe('simulator determinism', () => {
  it('same seed → identical batches for every kind', () => {
    const kinds = [
      'payments', 'orders', 'customers', 'catalog', 'gift_cards',
      'payouts', 'disputes', 'invoices', 'inventory_counts', 'refunds',
    ] as const;
    for (const kind of kinds) {
      const a = new SimulatedSquareProvider(42).batch(kind, 5);
      const b = new SimulatedSquareProvider(42).batch(kind, 5);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(a.records).toHaveLength(5);
    }
  });

  it('different seeds → different batches', () => {
    const a = new SimulatedSquareProvider(1).batch('payments', 5);
    const b = new SimulatedSquareProvider(2).batch('payments', 5);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
});
