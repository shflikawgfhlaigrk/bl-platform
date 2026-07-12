/**
 * Weighted-average cost helper — a pure function exported for finance /
 * integration reuse so everyone agrees on the same rounding.
 *
 * newCost = round( (prevQty*prevCost + recvQty*recvCost) / (prevQty+recvQty) )
 * Rounding is Math.round (round half up) to the nearest cent. A zero total
 * quantity yields { qty: 0, costCents: 0 } (never NaN).
 */

export interface CostLot {
  qty: number;
  costCents: number;
}

export function weightedCost(prev: CostLot, received: CostLot): CostLot {
  const prevQty = Number.isFinite(prev.qty) ? prev.qty : 0;
  const recvQty = Number.isFinite(received.qty) ? received.qty : 0;
  const prevCost = Number.isFinite(prev.costCents) ? prev.costCents : 0;
  const recvCost = Number.isFinite(received.costCents) ? received.costCents : 0;

  const totalQty = prevQty + recvQty;
  if (totalQty <= 0) return { qty: 0, costCents: 0 };

  const totalValue = prevQty * prevCost + recvQty * recvCost;
  return { qty: totalQty, costCents: Math.round(totalValue / totalQty) };
}
