import { describe, it, expect } from 'vitest';
import { formatCents, formatCentsPlain, formatBps } from '../public/src/money.mjs';

describe('money formatting (integer cents)', () => {
  it('formats positive amounts with thousands separators', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(99)).toBe('$0.99');
    expect(formatCents(100)).toBe('$1.00');
    expect(formatCents(123456)).toBe('$1,234.56');
    expect(formatCents(239983980)).toBe('$2,399,839.80');
  });

  it('formats zero and negatives correctly', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(-5)).toBe('-$0.05');
    expect(formatCents(-123456)).toBe('-$1,234.56');
  });

  it('never uses floating-point rounding artifacts', () => {
    // 0.1 + 0.2 style errors are impossible with integer math.
    expect(formatCents(70)).toBe('$0.70');
    expect(formatCents(1010)).toBe('$10.10');
    expect(formatCents(999999999)).toBe('$9,999,999.99');
  });

  it('supports an always-sign option and a plain (symbol-less) form', () => {
    expect(formatCents(500, { sign: 'always' })).toBe('+$5.00');
    expect(formatCents(-500, { sign: 'always' })).toBe('-$5.00');
    expect(formatCentsPlain(123456)).toBe('1,234.56');
  });

  it('handles non-finite input defensively', () => {
    expect(formatCents(NaN)).toBe('$0.00');
    expect(formatCents(Infinity)).toBe('$0.00');
  });

  it('formats basis points as percents', () => {
    expect(formatBps(10000)).toBe('100%');
    expect(formatBps(1250)).toBe('12.5%');
    expect(formatBps(0)).toBe('0%');
    expect(formatBps(-500)).toBe('-5%');
  });
});
