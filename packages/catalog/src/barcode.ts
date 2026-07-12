import type { Symbology } from './schema';

/**
 * Barcode normalization + checksum validation. Pure, dependency-free.
 *
 * Normalization strips every non-digit (so "8 40300 30530 2" → "840300305302").
 * We validate the two symbologies that carry a check digit — UPC-A (12) and
 * EAN-13 (13) — using the standard mod-10 algorithms. Codes that FAIL the check
 * are still first-class data (the ledger has 442 hand-typed bad check digits):
 * we record `checksum_valid = 0` and keep them searchable.
 */

/** Digits-only normalization; '' when the raw code contains no digits. */
export function normalizeCode(raw: string): string {
  return (raw ?? '').replace(/\D/g, '');
}

/**
 * UPC-A check digit: from the 11 data digits, sum odd positions (1-indexed)
 * ×3 plus even positions, then the check digit makes the total a multiple of 10.
 */
export function upcaCheckDigit(first11: string): number {
  let oddSum = 0;
  let evenSum = 0;
  for (let i = 0; i < 11; i += 1) {
    const d = first11.charCodeAt(i) - 48;
    if (i % 2 === 0) oddSum += d; // positions 1,3,5,... (0-indexed even)
    else evenSum += d;
  }
  const total = oddSum * 3 + evenSum;
  return (10 - (total % 10)) % 10;
}

/** True when `code` is 12 digits with a valid UPC-A check digit. */
export function isValidUpcA(code: string): boolean {
  if (!/^\d{12}$/.test(code)) return false;
  return upcaCheckDigit(code.slice(0, 11)) === code.charCodeAt(11) - 48;
}

/**
 * EAN-13 check digit: from the 12 data digits, sum odd positions (1-indexed)
 * ×1 plus even positions ×3, then the check digit makes the total a multiple of 10.
 */
export function ean13CheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    const d = first12.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? d : d * 3; // positions 1,3,... weight 1; 2,4,... weight 3
  }
  return (10 - (sum % 10)) % 10;
}

/** True when `code` is 13 digits with a valid EAN-13 check digit. */
export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  return ean13CheckDigit(code.slice(0, 12)) === code.charCodeAt(12) - 48;
}

/**
 * Classify a code by its normalized form: 12 digits → UPC-A, 13 → EAN-13,
 * any other non-empty content → Code 128 (which can encode anything the
 * printer supports), empty → unknown.
 */
export function classifySymbology(raw: string, normalized: string): Symbology {
  if (/^\d{12}$/.test(normalized)) return 'upca';
  if (/^\d{13}$/.test(normalized)) return 'ean13';
  if ((raw ?? '').trim() !== '' || normalized !== '') return 'code128';
  return 'unknown';
}

export interface AnalyzedCode {
  codeRaw: string;
  codeNormalized: string;
  symbology: Symbology;
  checksumValid: boolean;
}

/** Full analysis of one raw code: normalize, classify, validate checksum. */
export function analyzeCode(raw: string): AnalyzedCode {
  const codeRaw = raw ?? '';
  const codeNormalized = normalizeCode(codeRaw);
  const symbology = classifySymbology(codeRaw, codeNormalized);
  let checksumValid = false;
  if (symbology === 'upca') checksumValid = isValidUpcA(codeNormalized);
  else if (symbology === 'ean13') checksumValid = isValidEan13(codeNormalized);
  return { codeRaw, codeNormalized, symbology, checksumValid };
}
