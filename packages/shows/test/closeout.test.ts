import { describe, expect, it } from 'vitest';
import { makeShow, req, setup } from './helpers';

const ALL_REVIEWED = {
  sales: 1, cash: 1, inventory: 1, damages: 1, refunds: 1,
  labor: 1, travel: 1, booth_fees: 1, exceptions: 1,
};

describe('closeout gating + P&L honesty', () => {
  it('opens an empty closeout on first GET with all fields null and status open', async () => {
    const { app, tenantA } = await setup();
    const { showId } = await makeShow(app, tenantA);
    const co = await req(app, 'GET', `/shows/${showId}/closeout`, tenantA);
    expect(co.status).toBe(200);
    expect(co.json.data.status).toBe('open');
    expect(co.json.data.sales_total_cents).toBeNull();
    expect(co.json.data.review).toEqual({
      sales: 0, cash: 0, inventory: 0, damages: 0, refunds: 0,
      labor: 0, travel: 0, booth_fees: 0, exceptions: 0,
    });
  });

  it('refuses to complete until EVERY review section is marked', async () => {
    const { app, tenantA } = await setup();
    const { showId } = await makeShow(app, tenantA);
    await req(app, 'PATCH', `/shows/${showId}/closeout`, tenantA, {
      review: { sales: 1, cash: 1 }, // partial
    });
    const early = await req(app, 'POST', `/shows/${showId}/closeout/complete`, tenantA);
    expect(early.status).toBe(409);
    expect(early.json.error.details.unreviewed.length).toBeGreaterThan(0);

    await req(app, 'PATCH', `/shows/${showId}/closeout`, tenantA, { review: ALL_REVIEWED });
    const done = await req(app, 'POST', `/shows/${showId}/closeout/complete`, tenantA);
    expect(done.status).toBe(200);
    expect(done.json.data.status).toBe('complete');
  });

  it('refuses to complete while unresolved exceptions remain, and tracks the count', async () => {
    const { app, tenantA } = await setup();
    const { showId } = await makeShow(app, tenantA);
    const posted = await req(app, 'POST', `/shows/${showId}/discrepancies`, tenantA, {
      entries: [{ variationId: 'v1', expectedQty: 5, returnedQty: 3 }],
    });
    await req(app, 'PATCH', `/shows/${showId}/closeout`, tenantA, { review: ALL_REVIEWED });

    const co = await req(app, 'GET', `/shows/${showId}/closeout`, tenantA);
    expect(co.json.data.unresolved_exceptions_count).toBe(1);

    const blocked = await req(app, 'POST', `/shows/${showId}/closeout/complete`, tenantA);
    expect(blocked.status).toBe(409);

    await req(app, 'POST', `/discrepancies/${posted.json.data[0].id}/resolve`, tenantA, {
      resolution: 'damaged',
    });
    const done = await req(app, 'POST', `/shows/${showId}/closeout/complete`, tenantA);
    expect(done.status).toBe(200);
    expect(done.json.data.unresolved_exceptions_count).toBe(0);
  });

  it('P&L never fabricates: nulls stay null and are listed as missing inputs', async () => {
    const { app, tenantA } = await setup();
    const { showId } = await makeShow(app, tenantA);
    const pnl = await req(app, 'GET', `/shows/${showId}/pnl`, tenantA);
    expect(pnl.status).toBe(200);
    expect(pnl.json.data.revenueCents).toBeNull();
    expect(pnl.json.data.netProfitCents).toBeNull();
    expect(pnl.json.data.marginBps).toBeNull();
    expect(pnl.json.data.missingInputs).toEqual(
      expect.arrayContaining([
        'salesTotalCents', 'refundsCents', 'laborCents', 'travelCents',
        'boothFeeCents', 'cashVarianceCents', 'damagesCount',
      ]),
    );
  });

  it('P&L computes net profit + margin ONLY when every component is posted', async () => {
    const { app, tenantA } = await setup();
    const { showId } = await makeShow(app, tenantA);

    // Post revenue + only SOME costs -> profit still null, remaining costs still missing.
    await req(app, 'PATCH', `/shows/${showId}/closeout`, tenantA, {
      salesTotalCents: 500000,
      refundsCents: 10000,
      // labor/travel/booth still null
    });
    const partial = await req(app, 'GET', `/shows/${showId}/pnl`, tenantA);
    expect(partial.json.data.revenueCents).toBe(500000);
    expect(partial.json.data.netProfitCents).toBeNull(); // not zero-filled
    expect(partial.json.data.missingInputs).toEqual(
      expect.arrayContaining(['laborCents', 'travelCents', 'boothFeeCents']),
    );

    // Now post the rest.
    await req(app, 'PATCH', `/shows/${showId}/closeout`, tenantA, {
      cashVarianceCents: 0,
      laborCents: 40000,
      travelCents: 30000,
      boothFeeCents: 50000,
      damagesCount: 0,
    });
    const full = await req(app, 'GET', `/shows/${showId}/pnl`, tenantA);
    // 500000 - (10000 + 40000 + 30000 + 50000) = 370000
    expect(full.json.data.netProfitCents).toBe(370000);
    // 370000 / 500000 = 0.74 -> 7400 bps
    expect(full.json.data.marginBps).toBe(7400);
    expect(full.json.data.missingInputs).toEqual([]);
  });

  it('a completed closeout cannot be edited', async () => {
    const { app, tenantA } = await setup();
    const { showId } = await makeShow(app, tenantA);
    await req(app, 'PATCH', `/shows/${showId}/closeout`, tenantA, { review: ALL_REVIEWED });
    await req(app, 'POST', `/shows/${showId}/closeout/complete`, tenantA);
    const late = await req(app, 'PATCH', `/shows/${showId}/closeout`, tenantA, { salesTotalCents: 1 });
    expect(late.status).toBe(409);
  });

  it('denies cross-tenant closeout + pnl access', async () => {
    const { app, tenantA, tenantB } = await setup();
    const { showId } = await makeShow(app, tenantA);
    expect((await req(app, 'GET', `/shows/${showId}/closeout`, tenantB)).status).toBe(404);
    expect((await req(app, 'GET', `/shows/${showId}/pnl`, tenantB)).status).toBe(404);
    expect(
      (await req(app, 'PATCH', `/shows/${showId}/closeout`, tenantB, { salesTotalCents: 1 })).status,
    ).toBe(404);
  });
});
