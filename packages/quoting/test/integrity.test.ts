import { afterEach, describe, expect, it, vi } from 'vitest';
import { quotePayloadHash } from '@blacklabel/quoting';
import { addAttachment, approveQuote, convertQuote, createQuote, declineQuote, getQuote, removeAttachment, reviseQuote, sendQuote, updateQuote, updateQuoteLine } from '../src/service';
import { ctxFor, json, req, setup, type TestWorld } from './helpers';

const worlds: TestWorld[] = [];
async function fixture() { const world = await setup(); worlds.push(world); return { world, ctx: ctxFor(world, world.tenantA.id) }; }
afterEach(async () => { vi.restoreAllMocks(); for (const world of worlds.splice(0)) await world.db.destroy(); });
const input = { customerId: 'owned-customer', title: 'Accepted scope', notes: 'Work includes cleanup.', taxBps: 825,
  lines: [{ description: 'One visit', quantity: 2.5, unitPriceCents: 3333, discountBps: 750, unitCostCents: 1200 }] };

describe('quote scope integrity and revisions', () => {
  it('captures complete immutable scope and denies attachment changes after sharing and approval', async () => {
    const { world, ctx } = await fixture(); const created = await createQuote(ctx, input);
    await addAttachment(ctx, created.quote.id, 'scope-original'); const sent = await sendQuote(ctx, created.quote.id);
    const snapshot = JSON.parse(sent.approvalEvents[0].payload_json!);
    expect(snapshot).toMatchObject({ notes: input.notes, attachments: ['scope-original'], revision_number: 1 });
    expect(sent.approvalEvents[0].payload_schema_version).toBe(2);
    expect(sent.payloadHash).toBe(quotePayloadHash(sent.quote, sent.lines));
    expect((await req(world.app, world.tenantA.id, 'POST', `/quotes/${created.quote.id}/attachments`, { fileId: 'late-file' })).status).toBe(409);
    const approved = await approveQuote(ctx, created.quote.id, { signerName: 'Customer', expectedPayloadHash: sent.payloadHash });
    await expect(removeAttachment(ctx, created.quote.id, 'scope-original')).rejects.toMatchObject({ status: 409 });
    await expect(reviseQuote(ctx, created.quote.id)).rejects.toMatchObject({ status: 409 });
    expect(approved.approvalEvents.at(-1)?.payload_json).toBe(sent.approvalEvents[0].payload_json);
  });

  it('closes old offers, retains their evidence, copies scope into a new editable version and deduplicates revision retries', async () => {
    const { world, ctx } = await fixture(); const created = await createQuote(ctx, input); await addAttachment(ctx, created.quote.id, 'scope-file');
    const sent = await sendQuote(ctx, created.quote.id);
    const [revised, retry] = await Promise.all([reviseQuote(ctx, created.quote.id), reviseQuote(ctx, created.quote.id)]);
    expect(revised.quote.id).toBe(retry.quote.id); expect(revised.quote.revision_number).toBe(2);
    expect(revised.quote.supersedes_quote_id).toBe(created.quote.id); expect(revised.quote.attachments).toBe('["scope-file"]');
    const old = await getQuote(ctx, created.quote.id); expect(old.quote.status).toBe('expired'); expect(old.quote.superseded_by_quote_id).toBe(revised.quote.id);
    expect(old.approvalEvents[0].payload_hash).toBe(sent.payloadHash);
    await expect(approveQuote(ctx, created.quote.id, { signerName: 'Stale browser', expectedPayloadHash: sent.payloadHash })).rejects.toMatchObject({ status: 409 });
    const line = revised.lines[0]; await updateQuoteLine(ctx, revised.quote.id, line.id, { unitPriceCents: 4100 });
    const second = await sendQuote(ctx, revised.quote.id);
    await expect(approveQuote(ctx, revised.quote.id, { signerName: 'Stale scope', expectedPayloadHash: revised.payloadHash })).rejects.toMatchObject({ status: 409 });
    await approveQuote(ctx, revised.quote.id, { signerName: 'Current scope', expectedPayloadHash: second.payloadHash });
    const other = ctxFor(world, world.tenantB.id);
    await expect(reviseQuote(other, revised.quote.id)).rejects.toMatchObject({ status: 404 });
    expect((await req(world.app, world.tenantB.id, 'POST', `/quotes/${created.quote.id}/revise`, {})).status).toBe(404);
  });

  it('detects out-of-band note, attachment or price drift before approval and accepted drift before conversion', async () => {
    const { world, ctx } = await fixture(); const created = await createQuote(ctx, input); const sent = await sendQuote(ctx, created.quote.id);
    await world.db.updateTable('quoting_quotes').set({ notes: 'Different contract terms' }).where('tenant_id', '=', world.tenantA.id).where('id', '=', created.quote.id).execute();
    await expect(approveQuote(ctx, created.quote.id, { signerName: 'Customer', expectedPayloadHash: sent.payloadHash })).rejects.toMatchObject({ status: 409 });
    expect((await getQuote(ctx, created.quote.id)).quote.status).toBe('sent');
    await world.db.updateTable('quoting_quotes').set({ notes: input.notes }).where('tenant_id', '=', world.tenantA.id).where('id', '=', created.quote.id).execute();
    await approveQuote(ctx, created.quote.id, { signerName: 'Customer', expectedPayloadHash: sent.payloadHash });
    await world.db.updateTable('quoting_quote_lines').set({ description: 'Unapproved extra scope' }).where('tenant_id', '=', world.tenantA.id).where('quote_id', '=', created.quote.id).execute();
    await expect(convertQuote(ctx, created.quote.id)).rejects.toMatchObject({ status: 409 });
    expect((await getQuote(ctx, created.quote.id)).quote.converted_at).toBeNull();
  });

  it('serializes simultaneous customer decisions and publishes one approval only after its snapshot is durable', async () => {
    const { world, ctx } = await fixture(); const created = await createQuote(ctx, input); const sent = await sendQuote(ctx, created.quote.id);
    const observed: string[] = []; world.events.on('quoting.quote.approved', async () => { const details = await getQuote(ctx, created.quote.id); observed.push(details.approvalEvents.at(-1)!.event_type); });
    const outcomes = await Promise.allSettled([approveQuote(ctx, created.quote.id, { signerName: 'A', expectedPayloadHash: sent.payloadHash }), approveQuote(ctx, created.quote.id, { signerName: 'B', expectedPayloadHash: sent.payloadHash })]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(observed).toEqual(['approved']);
    expect((await getQuote(ctx, created.quote.id)).approvalEvents.filter(event => event.event_type === 'approved')).toHaveLength(1);
  });

  it('serializes draft pricing writes against publication so an older displayed hash never approves newly priced work', async () => {
    const { ctx } = await fixture(); const created = await createQuote(ctx, input);
    const outcomes = await Promise.allSettled([sendQuote(ctx, created.quote.id), updateQuote(ctx, created.quote.id, { discountFixedCents: 2000 })]);
    const sent = await getQuote(ctx, created.quote.id);
    expect(sent.quote.status).toBe('sent'); expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(sent.payloadHash).toBe(created.payloadHash); expect(sent.approvalEvents[0].payload_hash).toBe(sent.payloadHash);
  });

  it('expires at the exact UTC instant, including short ISO forms, and retains the expired receipt on denied decisions', async () => {
    const { ctx } = await fixture(); const created = await createQuote(ctx, { ...input, validUntil: '2030-01-01T00:00:00Z' });
    await sendQuote(ctx, created.quote.id); vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T00:00:00Z'));
    await expect(approveQuote(ctx, created.quote.id, { signerName: 'At deadline' })).rejects.toMatchObject({ status: 409 });
    const expired = await getQuote(ctx, created.quote.id); expect(expired.quote.status).toBe('expired'); expect(expired.approvalEvents.at(-1)?.event_type).toBe('expired');
    const second = await createQuote(ctx, { ...input, validUntil: '2020-01-01T00:00:00Z' }); await sendQuote(ctx, second.quote.id);
    await expect(declineQuote(ctx, second.quote.id)).rejects.toMatchObject({ status: 409 }); expect((await getQuote(ctx, second.quote.id)).quote.status).toBe('expired');
  });

  it('rejects unsafe money, fractional cents, invalid quantities and overflow without leaving partial drafts', async () => {
    const { world, ctx } = await fixture();
    for (const line of [{ description: 'Unsafe', quantity: 1, unitPriceCents: Number.MAX_SAFE_INTEGER + 1 },
      { description: 'Fractional cents', quantity: 1, unitPriceCents: 1.5 }, { description: 'Infinite', quantity: Infinity, unitPriceCents: 1 },
      { description: 'Overflow', quantity: 1e20, unitPriceCents: 100 }]) {
      await expect(createQuote(ctx, { customerId: 'c', title: 'Bad', lines: [line] })).rejects.toMatchObject({ status: 400 });
    }
    expect((await json(await req(world.app, world.tenantA.id, 'GET', '/quotes'))).data).toEqual([]);
    const unsafe = await req(world.app, world.tenantA.id, 'POST', '/quotes', { customerId: 'c', title: 'Unsafe HTTP', lines: [{ description: 'x', quantity: 1, unitPriceCents: Number.MAX_SAFE_INTEGER }] });
    expect(unsafe.status).toBe(400);
    const empty = await createQuote(ctx, { customerId: 'c', title: 'No work' }); await expect(sendQuote(ctx, empty.quote.id)).rejects.toMatchObject({ status: 400 });
  });

  it('claims an opaque invoice contract once under concurrency and stops ambiguous failures before retry', async () => {
    const { ctx } = await fixture(); let calls = 0;
    ctx.contracts = { createInvoice: { async createInvoice() { calls += 1; return { id: 'one-invoice' }; } } };
    const created = await createQuote(ctx, input); await sendQuote(ctx, created.quote.id); await approveQuote(ctx, created.quote.id, { signerName: 'Customer' });
    const concurrent = await Promise.allSettled([convertQuote(ctx, created.quote.id), convertQuote(ctx, created.quote.id)]);
    expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(calls).toBe(1);
    ctx.contracts = { createInvoice: { async createInvoice() { calls += 1; throw Error('Ambiguous provider response'); } } };
    const ambiguous = await createQuote(ctx, input); await sendQuote(ctx, ambiguous.quote.id); await approveQuote(ctx, ambiguous.quote.id, { signerName: 'Customer' });
    await expect(convertQuote(ctx, ambiguous.quote.id)).rejects.toThrow('Ambiguous provider response');
    await expect(convertQuote(ctx, ambiguous.quote.id)).rejects.toMatchObject({ status: 409 });
    const stopped = await getQuote(ctx, ambiguous.quote.id); expect(stopped.quote.converted_at).not.toBeNull(); expect(stopped.quote.invoice_id).toBeNull(); expect(calls).toBe(2);
  });

  it('keeps canonical fractional quantity/discount/tax rounding exact through accepted handoff', async () => {
    const { world, ctx } = await fixture(); const calls: any[] = []; ctx.contracts = { createInvoice: { async createInvoice(invoice) { calls.push(invoice); return { id: 'invoice-exact' }; } } };
    const created = await createQuote(ctx, { ...input, discountBps: 333, discountFixedCents: 23 }); await sendQuote(ctx, created.quote.id);
    await approveQuote(ctx, created.quote.id, { signerName: 'Customer' }); const conversion = await convertQuote(ctx, created.quote.id);
    expect(created.lines[0].total_cents).toBe(7708); expect(created.quote.discount_cents).toBe(280); expect(created.quote.tax_cents).toBe(613); expect(created.quote.total_cents).toBe(8041);
    expect(conversion.job.totalCents).toBe(8041); expect(calls[0].discountFixedCents).toBe(280);
    await expect(convertQuote(ctx, created.quote.id)).rejects.toMatchObject({ status: 409 }); expect(calls).toHaveLength(1);
  });
});
