import { describe, it, expect } from 'vitest';
import { aggregateScan, wouldAggregate, DEFAULT_WINDOW_MS } from '../src/scan.mjs';

describe('scan aggregation window', () => {
  it('adds a new line for a first-seen code', () => {
    const r = aggregateScan([], { code: 'ABC', at: 1000 });
    expect(r.changed).toBe('added');
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ code: 'ABC', qty: 1, firstAt: 1000, lastAt: 1000 });
  });

  it('bumps qty when the same code is scanned within the window', () => {
    let lines: any[] = [];
    lines = aggregateScan(lines, { code: 'ABC', at: 1000 }).lines;
    const r = aggregateScan(lines, { code: 'ABC', at: 1000 + 2000 }); // within 3s
    expect(r.changed).toBe('bumped');
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].qty).toBe(2);
    expect(r.lines[0].lastAt).toBe(3000);
    expect(r.lines[0].firstAt).toBe(1000);
  });

  it('starts a new line when the same code is scanned AFTER the window', () => {
    let lines: any[] = aggregateScan([], { code: 'ABC', at: 1000 }).lines;
    const r = aggregateScan(lines, { code: 'ABC', at: 1000 + DEFAULT_WINDOW_MS + 1 });
    expect(r.changed).toBe('added');
    expect(r.lines).toHaveLength(2);
  });

  it('keeps different codes on separate lines', () => {
    let lines: any[] = aggregateScan([], { code: 'ABC', at: 1000 }).lines;
    lines = aggregateScan(lines, { code: 'XYZ', at: 1100 }).lines;
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.code)).toEqual(['ABC', 'XYZ']);
  });

  it('supports an explicit qty on a scan (e.g. keyed burst)', () => {
    const r = aggregateScan([], { code: 'ABC', at: 1000, qty: 5 });
    expect(r.lines[0].qty).toBe(5);
  });

  it('does not mutate the input array', () => {
    const input: any[] = [{ code: 'ABC', qty: 1, firstAt: 1000, lastAt: 1000 }];
    const snapshot = JSON.parse(JSON.stringify(input));
    aggregateScan(input, { code: 'ABC', at: 1500 });
    expect(input).toEqual(snapshot);
  });

  it('wouldAggregate predicts a bump correctly', () => {
    const lines = aggregateScan([], { code: 'ABC', at: 1000 }).lines;
    expect(wouldAggregate(lines, 'ABC', 2000)).toBe(true);
    expect(wouldAggregate(lines, 'ABC', 9000)).toBe(false);
    expect(wouldAggregate(lines, 'OTHER', 2000)).toBe(false);
  });
});
