import { describe, expect, it } from 'vitest';
import { api, json, setup } from './helpers';

describe('COGS cost history + margin honesty', () => {
  it('currentCost respects effective window boundaries (non-overlapping)', async () => {
    const ctx = await setup();
    await api(ctx.app, ctx.tenantA, 'POST', '/item-costs', {
      variationId: 'var_1',
      costCents: 1000,
      method: 'manual',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });
    await api(ctx.app, ctx.tenantA, 'POST', '/item-costs', {
      variationId: 'var_1',
      costCents: 1200,
      method: 'vendor_invoice',
      effectiveFrom: '2026-06-01T00:00:00.000Z',
    });

    // before any cost → unknown
    const before = await json(
      await api(ctx.app, ctx.tenantA, 'GET', '/item-costs/current?variationId=var_1&at=2025-12-31T00:00:00.000Z'),
    );
    expect(before.data).toBeNull();

    // in first window
    const mid = await json(
      await api(ctx.app, ctx.tenantA, 'GET', '/item-costs/current?variationId=var_1&at=2026-03-01T00:00:00.000Z'),
    );
    expect(mid.data.cost_cents).toBe(1000);

    // exactly at the boundary → the new window
    const at = await json(
      await api(ctx.app, ctx.tenantA, 'GET', '/item-costs/current?variationId=var_1&at=2026-06-01T00:00:00.000Z'),
    );
    expect(at.data.cost_cents).toBe(1200);

    // history preserved: two rows, first closed at second's effective_from
    const hist = await json(await api(ctx.app, ctx.tenantA, 'GET', '/item-costs?variationId=var_1'));
    expect(hist.data).toHaveLength(2);
    expect(hist.data[0].effective_to).toBe('2026-06-01T00:00:00.000Z');
    expect(hist.data[1].effective_to).toBeNull();
  });

  it('UNKNOWN cost stays NULL — never 0, never assumed; aggregate splits known/unknown', async () => {
    const ctx = await setup();
    await api(ctx.app, ctx.tenantA, 'POST', '/item-costs', {
      variationId: 'known_var',
      costCents: 600,
      method: 'manual',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
    });

    const r = await json(
      await api(ctx.app, ctx.tenantA, 'POST', '/margin', {
        at: '2026-03-01T00:00:00.000Z',
        lines: [
          { variationId: 'known_var', unitPriceCents: 1000, qty: 2 },
          { variationId: 'unknown_var', unitPriceCents: 1500, qty: 1 },
        ],
      }),
    );

    const known = r.data.lines[0];
    expect(known.revenueCents).toBe(2000);
    expect(known.costCents).toBe(1200);
    expect(known.marginCents).toBe(800);
    expect(known.marginBps).toBe(4000);

    const unknown = r.data.lines[1];
    expect(unknown.revenueCents).toBe(1500);
    // THE honesty invariant — NULL, not 0.
    expect(unknown.costCents).toBeNull();
    expect(unknown.marginCents).toBeNull();
    expect(unknown.marginBps).toBeNull();
    expect(unknown.costCents).not.toBe(0);
    expect(unknown.marginCents).not.toBe(0);

    expect(r.data.totalRevenueCents).toBe(3500);
    expect(r.data.knownRevenueCents).toBe(2000);
    expect(r.data.unknownCostRevenueCents).toBe(1500);
    expect(r.data.knownMarginCents).toBe(800);
    expect(r.data.knownMarginBps).toBe(4000);
  });

  it('all-unknown margin: knownMarginBps null, unknown revenue accumulated, no zero-fill', async () => {
    const ctx = await setup();
    const r = await json(
      await api(ctx.app, ctx.tenantA, 'POST', '/margin', {
        lines: [
          { variationId: 'a', unitPriceCents: 500, qty: 1 },
          { variationId: 'b', unitPriceCents: 700, qty: 3 },
        ],
      }),
    );
    expect(r.data.knownRevenueCents).toBe(0);
    expect(r.data.unknownCostRevenueCents).toBe(2600);
    expect(r.data.knownMarginBps).toBeNull();
    for (const line of r.data.lines) {
      expect(line.costCents).toBeNull();
      expect(line.marginCents).toBeNull();
    }
  });
});
