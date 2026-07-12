import { describe, expect, it } from 'vitest';
import { suggestManifest, type SuggestVariationStat } from '../src/suggest';

function stat(over: Partial<SuggestVariationStat> = {}): SuggestVariationStat {
  return {
    variationId: 'v1',
    name: 'Item',
    unitsPerWeekVelocity: 0,
    categoryShowShare: 1,
    onHand: 1000,
    reserved: 0,
    displayMin: 0,
    safetyStock: 0,
    ...over,
  };
}

describe('suggestManifest formula', () => {
  it('template-target branch uses the template targetQty as demand', () => {
    const res = suggestManifest({
      templateLines: [{ variationId: 'v1', targetQty: 12 }],
      variationStats: [stat({ variationId: 'v1', unitsPerWeekVelocity: 99 })],
    });
    const line = res.lines[0];
    expect(line.suggestedQty).toBe(12);
    expect(line.formulaTrace[0].step).toBe('demand');
    expect(line.formulaTrace[0].note).toContain('template_target');
  });

  it('velocity-derived branch = ceil(velocity * categoryShowShare)', () => {
    const res = suggestManifest({
      templateLines: [],
      variationStats: [stat({ unitsPerWeekVelocity: 10, categoryShowShare: 0.35 })],
    });
    // ceil(10 * 0.35) = ceil(3.5) = 4
    expect(res.lines[0].suggestedQty).toBe(4);
    expect(res.lines[0].formulaTrace[0].note).toContain('velocity_derived');
  });

  it('zero velocity is an honest 0, never fabricated', () => {
    const res = suggestManifest({
      templateLines: [],
      variationStats: [stat({ unitsPerWeekVelocity: 0, displayMin: 0, safetyStock: 0 })],
    });
    expect(res.lines[0].suggestedQty).toBe(0);
  });

  it('display_min floor lifts a low demand up to the minimum', () => {
    const res = suggestManifest({
      templateLines: [],
      variationStats: [stat({ unitsPerWeekVelocity: 1, categoryShowShare: 1, displayMin: 6 })],
    });
    // demand 1 -> floored to displayMin 6
    expect(res.lines[0].suggestedQty).toBe(6);
    const floorStep = res.lines[0].formulaTrace.find((s) => s.step === 'display_min_floor');
    expect(floorStep?.value).toBe(6);
  });

  it('safety stock is added before the floor', () => {
    const res = suggestManifest({
      templateLines: [{ variationId: 'v1', targetQty: 4 }],
      variationStats: [stat({ safetyStock: 3, onHand: 1000 })],
    });
    // 4 + 3 = 7
    expect(res.lines[0].suggestedQty).toBe(7);
  });

  it('availability cap limits the suggestion to onHand - reserved', () => {
    const res = suggestManifest({
      templateLines: [{ variationId: 'v1', targetQty: 20 }],
      variationStats: [stat({ onHand: 10, reserved: 4 })],
    });
    // min(20, 10-4=6) = 6
    expect(res.lines[0].suggestedQty).toBe(6);
    const cap = res.lines[0].formulaTrace.find((s) => s.step === 'availability_cap');
    expect(cap?.value).toBe(6);
  });

  it('vehicle capacity proportionally scales down, documented in the trace', () => {
    const res = suggestManifest({
      templateLines: [
        { variationId: 'a', targetQty: 60 },
        { variationId: 'b', targetQty: 40 },
      ],
      variationStats: [
        stat({ variationId: 'a', name: 'A', onHand: 1000 }),
        stat({ variationId: 'b', name: 'B', onHand: 1000 }),
      ],
      vehicleCapacityUnits: 50,
    });
    // total 100 > cap 50: a -> floor(60*50/100)=30, b -> floor(40*50/100)=20
    const a = res.lines.find((l) => l.variationId === 'a')!;
    const b = res.lines.find((l) => l.variationId === 'b')!;
    expect(a.suggestedQty).toBe(30);
    expect(b.suggestedQty).toBe(20);
    expect(a.formulaTrace.at(-1)?.step).toBe('vehicle_capacity_scale');
    expect(res.totalBeforeCapacity).toBe(100);
  });

  it('vehicle capacity does not scale when total is within capacity', () => {
    const res = suggestManifest({
      templateLines: [{ variationId: 'v1', targetQty: 5 }],
      variationStats: [stat({ onHand: 1000 })],
      vehicleCapacityUnits: 100,
    });
    expect(res.lines[0].suggestedQty).toBe(5);
    expect(res.lines[0].formulaTrace.at(-1)?.step).toBe('vehicle_capacity_ok');
  });

  it('records a complete trace: every step present and ending at suggestedQty', () => {
    const res = suggestManifest({
      templateLines: [],
      variationStats: [stat({ unitsPerWeekVelocity: 4, categoryShowShare: 1, safetyStock: 2, displayMin: 3, onHand: 100 })],
      vehicleCapacityUnits: 1000,
    });
    const steps = res.lines[0].formulaTrace.map((s) => s.step);
    expect(steps).toEqual([
      'demand',
      'safety_stock',
      'display_min_floor',
      'availability_cap',
      'vehicle_capacity_ok',
    ]);
    // demand 4 + safety 2 = 6; floor max(6,3)=6; avail min(6,100)=6
    expect(res.lines[0].suggestedQty).toBe(6);
    expect(res.lines[0].formulaTrace.at(-1)?.value).toBe(6);
  });
});
