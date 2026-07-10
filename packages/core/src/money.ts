/**
 * Shared money math. ALL modules must use these — never re-implement
 * discount/tax math (see /CONVENTIONS.md "Money").
 *
 * Conventions:
 * - every amount is INTEGER cents
 * - percentages are basis points (bps): 10000 bps = 100%
 * - a Discount is EITHER/BOTH: bps (applied first) and fixedCents
 * - order of application: line discounts -> quote/order discount -> tax
 * - rounding: Math.round at each money-producing step; amounts never go below 0
 */

export interface Discount {
  /** Percent discount in basis points, 0..10000. Applied before fixedCents. */
  bps?: number;
  /** Fixed discount in cents, >= 0. Applied after bps. */
  fixedCents?: number;
}

function assertIntCents(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be integer cents, got ${value}`);
  }
}

/** Apply a discount to an amount of cents. Clamped at 0. */
export function applyDiscount(amountCents: number, discount?: Discount): number {
  assertIntCents(amountCents, 'amountCents');
  if (!discount) return amountCents;
  let out = amountCents;
  if (discount.bps !== undefined) {
    if (!Number.isInteger(discount.bps) || discount.bps < 0 || discount.bps > 10000) {
      throw new Error(`discount.bps must be an integer in [0, 10000], got ${discount.bps}`);
    }
    out -= Math.round((out * discount.bps) / 10000);
  }
  if (discount.fixedCents !== undefined) {
    if (!Number.isInteger(discount.fixedCents) || discount.fixedCents < 0) {
      throw new Error(`discount.fixedCents must be a non-negative integer, got ${discount.fixedCents}`);
    }
    out -= discount.fixedCents;
  }
  return Math.max(out, 0);
}

export interface TotalsLine {
  /** May be fractional (e.g. 2.5 hours). */
  quantity: number;
  unitPriceCents: number;
  discount?: Discount;
}

export interface Totals {
  /** Per-line totals AFTER line discounts, same order as input. */
  lineTotalsCents: number[];
  /** Sum of line totals (after line discounts, before order discount). */
  subtotalCents: number;
  /** Cents removed by the order/quote-level discount. */
  discountCents: number;
  /** Tax on the discounted subtotal. */
  taxCents: number;
  /** subtotal - discount + tax. */
  totalCents: number;
}

/**
 * Canonical quote/invoice totals:
 *   line total  = round(quantity * unitPriceCents), then line discount
 *   subtotal    = sum(line totals)
 *   discounted  = subtotal after order-level discount
 *   tax         = round(discounted * taxBps / 10000)
 *   total       = discounted + tax
 */
export function computeTotals(
  lines: readonly TotalsLine[],
  options: { discount?: Discount; taxBps?: number } = {},
): Totals {
  const lineTotalsCents = lines.map((line) => {
    assertIntCents(line.unitPriceCents, 'unitPriceCents');
    if (!Number.isFinite(line.quantity) || line.quantity < 0) {
      throw new Error(`quantity must be a non-negative number, got ${line.quantity}`);
    }
    return applyDiscount(Math.round(line.quantity * line.unitPriceCents), line.discount);
  });
  const subtotalCents = lineTotalsCents.reduce((a, b) => a + b, 0);
  const discountedCents = applyDiscount(subtotalCents, options.discount);
  const discountCents = subtotalCents - discountedCents;
  let taxCents = 0;
  if (options.taxBps !== undefined) {
    if (!Number.isInteger(options.taxBps) || options.taxBps < 0) {
      throw new Error(`taxBps must be a non-negative integer, got ${options.taxBps}`);
    }
    taxCents = Math.round((discountedCents * options.taxBps) / 10000);
  }
  return {
    lineTotalsCents,
    subtotalCents,
    discountCents,
    taxCents,
    totalCents: discountedCents + taxCents,
  };
}
