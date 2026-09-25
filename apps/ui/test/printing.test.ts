import { describe, expect, it } from 'vitest';
// @ts-expect-error Browser module is tested directly.
import { createPrintClient, receiptPrintDocument, ticketPrintDocument } from '../public/js/printing.js';

const ticket = (id = 'k1', version = 1, station = 'kitchen', status = 'queued') => ({ id, version,
  createdAt: '2026-09-06T12:00:00.000Z', value: { station, status, tabName: 'Test table', table: '7',
    items: [{ name: 'Burger', seat: 2, modifiers: ['No onions'], instructions: 'Keep sauce separate', voided: version > 1 }] } });

describe('Native printer routing and recovery', () => {
  it('prints only enabled queued stations, preserves void revisions and deduplicates polling', async () => {
    const requests: any[] = [];
    const bridge = { status: async () => ({ configuredRoles: ['kitchen'], automaticRoles: ['kitchen'] }),
      print: async (r: any) => { requests.push(r); return { status: 'submitted' }; } };
    const client = createPrintClient({ getBridge: () => bridge });
    const tickets = [ticket(), ticket('bar1', 1, 'bar'), ticket('ready1', 1, 'kitchen', 'ready')];
    await client.pump(tickets); await client.pump(tickets);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ id: 'ticket:k1:1', role: 'kitchen', automatic: true, reprint: false });
    expect(requests[0].text).toContain('No onions');
    await client.pump([ticket('k1', 2)]);
    expect(requests).toHaveLength(2);
    expect(requests[1].text).toContain('UPDATED TICKET');
    expect(requests[1].text).toContain('VOID — Burger');
  });
  it('does not retry an uncertain print and preserves the same request key for a retryable failure', async () => {
    let time = 0; const keys: string[] = []; let result: any = new Error('Offline before sending');
    const bridge = { status: async () => ({ configuredRoles: ['kitchen'], automaticRoles: ['kitchen'] }),
      print: async (r: any) => { keys.push(r.id); if (result instanceof Error) throw result; return result; } };
    const client = createPrintClient({ getBridge: () => bridge, now: () => time });
    await client.pump([ticket()]); await client.pump([ticket()]); expect(keys).toHaveLength(1);
    time = 31_000; result = { status: 'unknown' }; await client.pump([ticket()]);
    time = 600_000; await client.pump([ticket()]);
    expect(keys).toEqual(['ticket:k1:1', 'ticket:k1:1']);
  });
  it('keeps original transaction references and cash change in receipt output', () => {
    const doc = receiptPrintDocument({ merchant: { name: 'Test venue' }, order: { id: 'o1', receipt_number: 'R1', status: 'paid',
      note: 'Bill: Michael\nTab: Patio 7', lines: [{ description: 'Lunch', qty: 2, line_total_cents: 1200 }], tax_cents: 100, tip_cents: 200, total_cents: 1500 },
      amountPaidCents: 1500, amountRefundedCents: 0, tenders: [{ kind: 'provider', status: 'captured', amount_cents: 1000, provider_ref: 'original-payment-reference' },
        { kind: 'cash', status: 'captured', amount_cents: 500, cash_received_cents: 1000, change_due_cents: 500 }] });
    expect(doc.role).toBe('receipt'); expect(doc.text).toContain('Transaction ID: original-payment-reference');
    expect(doc.text).toMatch(/2 × Lunch\s+\$12\.00/);
    expect(doc.text).toContain('Bill: Michael\nTab: Patio 7');
    expect(doc.text).toMatch(/Change given\s+\$5\.00/); expect(doc.text).toMatch(/TOTAL\s+\$15\.00/);
    expect(ticketPrintDocument(ticket()).text).toContain('Keep sauce separate');
  });
});
