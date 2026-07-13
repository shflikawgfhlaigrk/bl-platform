/**
 * Money formatting — integer cents in, human string out. INTEGER MATH ONLY
 * (no floating-point division of dollars). The API is the source of truth for
 * amounts; this module only renders. Mirrors the platform rule: money is
 * integer cents everywhere (CONVENTIONS §7).
 */

/** Group an integer digit string with thousands separators. */
function groupThousands(digits) {
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return out;
}

/**
 * Format integer cents as a currency string, e.g. 123456 -> "$1,234.56",
 * -5 -> "-$0.05", 0 -> "$0.00". Never uses float division.
 * @param {number} cents integer number of cents (may be negative)
 * @param {{ sign?: 'auto'|'always', symbol?: string }} [opts]
 */
export function formatCents(cents, opts = {}) {
  const symbol = opts.symbol ?? '$';
  if (!Number.isFinite(cents)) return `${symbol}0.00`;
  const n = Math.trunc(cents);
  const negative = n < 0;
  const abs = Math.abs(n);
  const dollars = Math.floor(abs / 100); // integer
  const remainder = abs % 100; // integer 0..99
  const centsStr = remainder < 10 ? `0${remainder}` : String(remainder);
  const body = `${symbol}${groupThousands(String(dollars))}.${centsStr}`;
  if (negative) return `-${body}`;
  if (opts.sign === 'always' && n > 0) return `+${body}`;
  return body;
}

/** Bare number form without symbol, e.g. 123456 -> "1,234.56". */
export function formatCentsPlain(cents) {
  return formatCents(cents, { symbol: '' });
}

/** Basis points -> percent string, e.g. 1250 -> "12.5%". Integer-safe. */
export function formatBps(bps) {
  if (!Number.isFinite(bps)) return '0%';
  const n = Math.trunc(bps);
  const negative = n < 0;
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  let s = String(whole);
  if (frac !== 0) {
    const fracStr = frac % 10 === 0 ? String(frac / 10) : (frac < 10 ? `0${frac}` : String(frac));
    s += `.${fracStr}`;
  }
  return `${negative ? '-' : ''}${s}%`;
}
