import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvRows, serializeCsv, serializeCsvRows } from '@blacklabel/core';

describe('csv helpers', () => {
  it('round-trips records with commas, quotes, newlines and unicode', () => {
    const records = [
      { name: 'Ada, "Countess" Lovelace', notes: 'line1\nline2', city: 'London' },
      { name: '', notes: 'plain', city: 'Åbo' },
      { name: 'O\'Neil', notes: 'tab\there', city: 'New York, NY' },
    ];
    const csv = serializeCsv(records);
    expect(parseCsv(csv)).toEqual(records);
  });

  it('round-trips raw rows', () => {
    const rows = [
      ['a', 'b,c', 'd"e'],
      ['', 'multi\nline', 'plain'],
    ];
    expect(parseCsvRows(serializeCsvRows(rows))).toEqual(rows);
  });

  it('parses \\r\\n row separators', () => {
    expect(parseCsvRows('a,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('handles empty input and trailing newlines', () => {
    expect(parseCsvRows('')).toEqual([]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsvRows('a,b\n')).toEqual([['a', 'b']]);
  });

  it('fills missing trailing fields with empty strings', () => {
    expect(parseCsv('a,b,c\n1,2\n')).toEqual([{ a: '1', b: '2', c: '' }]);
  });

  it('serializes null/undefined as empty and respects explicit column order', () => {
    const csv = serializeCsv([{ a: null, b: undefined, c: 7 }], ['c', 'a', 'b']);
    expect(csv).toBe('c,a,b\n7,,\n');
  });

  it('throws on unterminated quotes', () => {
    expect(() => parseCsvRows('"abc')).toThrow(/unterminated/);
  });
});
