import { describe, expect, it } from 'vitest';
import type { PlatformEvent } from '@blacklabel/core';
import { quotePayloadHash } from '@blacklabel/quoting';
import {
  addQuoteLine,
  approveQuote,
  createQuote,
  declineQuote,
  expireQuoteManually,
  getQuote,
  markQuoteViewed,
  sendQuote,
  updateQuote,
} from '../src/service';
import { ctxFor, setup } from './helpers';

async function draftQuote(ctx: any) {
  const { quote } = await createQuote(ctx, {
    customerId: 'cust-7',
    title: 'Approval flow',
    taxBps: 800,
    lines: [{ description: 'Service', quantity: 2, unitPriceCents: 5000, unitCostCents: 1000 }],
  });
  return quote;
}

describe('approval flow', () => {
  it('walks draft -> sent -> viewed -> approved recording ApprovalEvents with signer + hash', async () => {
    const world = await setup();
    const ctx = ctxFor(world, world.tenantA.id);
    const quote = await draftQuote(ctx);
    expect(quote.status).toBe('draft');

    const sent = await sendQuote(ctx, quote.id);
    expect(sent.quote.status).toBe('sent');

    const viewed = await markQuoteViewed(ctx, quote.id, { signerIp: '10.0.0.9' });
    expect(viewed.quote.status).toBe('viewed');

    const approved = await approveQuote(ctx, quote.id, {
      signerName: 'Jane Doe',
      signerIp: '10.0.0.9',
      note: 'looks good',
    });
    expect(approved.quote.status).toBe('approved');

    const events = approved.approvalEvents;
    expect(events.map((e) => e.event_type)).toEqual(['sent', 'viewed', 'approved']);

    const approval = events[2]!;
    expect(approval.signer_name).toBe('Jane Doe');
    expect(approval.signer_ip).toBe('10.0.0.9');
    expect(approval.note).toBe('looks good');
    // hash is e-signature-verifiable: recomputing over the stored quote matches
    expect(approval.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(approval.payload_hash).toBe(quotePayloadHash(approved.quote, approved.lines));
    // every event carries a hash of the payload as it was at that moment
    expect(events.every((e) => /^[0-9a-f]{64}$/.test(e.payload_hash))).toBe(true);
  });

  it('emits quoting.quote.approved with quoteId, customerId and totalCents', async () => {
    const world = await setup();
    const ctx = ctxFor(world, world.tenantA.id);
    const received: PlatformEvent[] = [];
    world.events.on('quoting.quote.approved', (e) => {
      received.push(e);
    });

    const quote = await draftQuote(ctx);
    await sendQuote(ctx, quote.id);
    await approveQuote(ctx, quote.id, { signerName: 'Jane Doe' });

    expect(received).toHaveLength(1);
    expect(received[0]!.tenantId).toBe(world.tenantA.id);
    expect(received[0]!.payload).toEqual({
      quoteId: quote.id,
      customerId: 'cust-7',
      totalCents: 10800, // 10000 + 8% tax
    });
  });

  it('rejects invalid transitions and edits after leaving draft', async () => {
    const world = await setup();
    const ctx = ctxFor(world, world.tenantA.id);
    const quote = await draftQuote(ctx);

    // approve straight from draft
    await expect(approveQuote(ctx, quote.id, { signerName: 'X' })).rejects.toMatchObject({
      status: 409,
    });
    // view straight from draft
    await expect(markQuoteViewed(ctx, quote.id)).rejects.toMatchObject({ status: 409 });

    await sendQuote(ctx, quote.id);
    // no edits once sent
    await expect(updateQuote(ctx, quote.id, { title: 'nope' })).rejects.toMatchObject({ status: 409 });
    await expect(
      addQuoteLine(ctx, quote.id, { description: 'x', quantity: 1, unitPriceCents: 1 }),
    ).rejects.toMatchObject({ status: 409 });
    // cannot send twice
    await expect(sendQuote(ctx, quote.id)).rejects.toMatchObject({ status: 409 });

    await approveQuote(ctx, quote.id, { signerName: 'Jane' });
    // approved is terminal for the approval flow
    await expect(declineQuote(ctx, quote.id)).rejects.toMatchObject({ status: 409 });
    await expect(approveQuote(ctx, quote.id, { signerName: 'Jane' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('supports decline and manual expire, recording events', async () => {
    const world = await setup();
    const ctx = ctxFor(world, world.tenantA.id);

    const q1 = await draftQuote(ctx);
    await sendQuote(ctx, q1.id);
    const declined = await declineQuote(ctx, q1.id, { signerName: 'Bob', note: 'too pricey' });
    expect(declined.quote.status).toBe('declined');
    expect(declined.approvalEvents.at(-1)?.event_type).toBe('declined');
    expect(declined.approvalEvents.at(-1)?.note).toBe('too pricey');

    const q2 = await draftQuote(ctx);
    await sendQuote(ctx, q2.id);
    const expired = await expireQuoteManually(ctx, q2.id);
    expect(expired.quote.status).toBe('expired');
    expect(expired.approvalEvents.at(-1)?.event_type).toBe('expired');
  });

  it('auto-expires a stale quote on approval attempt (valid_until passed)', async () => {
    const world = await setup();
    const ctx = ctxFor(world, world.tenantA.id);
    const { quote } = await createQuote(ctx, {
      customerId: 'c',
      title: 'stale',
      validUntil: '2020-01-01T00:00:00.000Z',
      lines: [{ description: 'x', quantity: 1, unitPriceCents: 100 }],
    });
    await sendQuote(ctx, quote.id);

    await expect(approveQuote(ctx, quote.id, { signerName: 'Late Larry' })).rejects.toMatchObject({
      status: 409,
    });
    const after = await getQuote(ctx, quote.id);
    expect(after.quote.status).toBe('expired');
    expect(after.approvalEvents.at(-1)?.event_type).toBe('expired');
  });

  it('requires a signer name to approve', async () => {
    const world = await setup();
    const ctx = ctxFor(world, world.tenantA.id);
    const quote = await draftQuote(ctx);
    await sendQuote(ctx, quote.id);
    await expect(approveQuote(ctx, quote.id, { signerName: '   ' })).rejects.toMatchObject({
      status: 400,
    });
  });
});
