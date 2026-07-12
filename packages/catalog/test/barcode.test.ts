import { describe, expect, it } from 'vitest';
import {
  analyzeCode,
  classifySymbology,
  ean13CheckDigit,
  isValidEan13,
  isValidUpcA,
  normalizeCode,
  upcaCheckDigit,
} from '../src/barcode';

describe('barcode normalization', () => {
  it('strips every non-digit', () => {
    expect(normalizeCode('8 40300 30530 2')).toBe('840300305302');
    expect(normalizeCode('4-057052-664366')).toBe('4057052664366');
    expect(normalizeCode('ABC')).toBe('');
    expect(normalizeCode('')).toBe('');
  });
});

describe('UPC-A checksum', () => {
  it('validates a known-good UPC-A', () => {
    expect(upcaCheckDigit('03600029145')).toBe(2);
    expect(isValidUpcA('036000291452')).toBe(true);
  });
  it('rejects a bad check digit but keeps it as a 12-digit code', () => {
    expect(isValidUpcA('036000291451')).toBe(false);
    const a = analyzeCode('036000291451');
    expect(a.symbology).toBe('upca');
    expect(a.checksumValid).toBe(false);
    expect(a.codeNormalized).toBe('036000291451'); // still stored/searchable
  });
  it('validates a UPC-A typed with spaces', () => {
    const a = analyzeCode('0 36000 29145 2');
    expect(a.codeNormalized).toBe('036000291452');
    expect(a.symbology).toBe('upca');
    expect(a.checksumValid).toBe(true);
  });
});

describe('EAN-13 checksum', () => {
  it('validates a known-good EAN-13', () => {
    expect(ean13CheckDigit('400638133393')).toBe(1);
    expect(isValidEan13('4006381333931')).toBe(true);
  });
  it('rejects a bad EAN-13 check digit', () => {
    expect(isValidEan13('4006381333930')).toBe(false);
    const a = analyzeCode('4006381333930');
    expect(a.symbology).toBe('ean13');
    expect(a.checksumValid).toBe(false);
  });
});

describe('symbology classification', () => {
  it('classifies by normalized length', () => {
    expect(classifySymbology('036000291452', '036000291452')).toBe('upca');
    expect(classifySymbology('4006381333931', '4006381333931')).toBe('ean13');
    expect(classifySymbology('ABC-123', '123')).toBe('code128');
    expect(classifySymbology('', '')).toBe('unknown');
  });
});
