/**
 * Reorder suggestion — a PURE, TRANSPARENT function. No DB, no clock, no
 * cross-module reads: the integrator feeds every input. Every step is printed
 * into `formulaTrace` so the owner can explain exactly why a quantity was
 * suggested. Never returns NaN/Infinity — zero velocity yields an honest 0.
 */

export interface SuggestQtyInputs {
  /** Units physically on hand. */
  onHand: number;
  /** Units reserved (committed to open orders). */
  reserved: number;
  /** Units already inbound (on open POs). */
  inbound: number;
  /** Recent sales velocity, units per week. */
  unitsPerWeekVelocity: number;
  /** Seasonal multiplier (1 = neutral). */
  seasonalFactor: number;
  /** Vendor lead time in days. */
  leadTimeDays: number;
  /** Case pack — order rounds UP to a multiple of this (>=1). */
  casePackQty: number;
  /** Vendor minimum order quantity (floor applied when ordering). */
  minOrderQty: number;
  /** Safety stock buffer to hold above lead-time demand. */
  safetyStock: number;
  /** Extra demand from an upcoming show. */
  upcomingShowDemand: number;
  /** Owner override — when set (not null/undefined), it WINS. */
  ownerOverrideQty?: number | null;
}

export interface SuggestQtyResult {
  suggestedQty: number;
  formulaTrace: string[];
}

/** Trim trailing zeros for readable trace numbers while keeping exact math. */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Number(n.toFixed(4)).toString();
}

export function suggestQty(inputs: SuggestQtyInputs): SuggestQtyResult {
  const trace: string[] = [];

  // Coerce to finite numbers; guard case pack >= 1.
  const onHand = Number.isFinite(inputs.onHand) ? inputs.onHand : 0;
  const reserved = Number.isFinite(inputs.reserved) ? inputs.reserved : 0;
  const inbound = Number.isFinite(inputs.inbound) ? inputs.inbound : 0;
  const velWk = Number.isFinite(inputs.unitsPerWeekVelocity) ? inputs.unitsPerWeekVelocity : 0;
  const seasonal = Number.isFinite(inputs.seasonalFactor) ? inputs.seasonalFactor : 1;
  const leadDays = Number.isFinite(inputs.leadTimeDays) ? inputs.leadTimeDays : 0;
  const casePack = Number.isFinite(inputs.casePackQty) && inputs.casePackQty >= 1 ? Math.trunc(inputs.casePackQty) : 1;
  const minOrder = Number.isFinite(inputs.minOrderQty) && inputs.minOrderQty > 0 ? Math.trunc(inputs.minOrderQty) : 0;
  const safety = Number.isFinite(inputs.safetyStock) ? inputs.safetyStock : 0;
  const show = Number.isFinite(inputs.upcomingShowDemand) ? inputs.upcomingShowDemand : 0;

  // 1. Net position.
  const position = onHand - reserved + inbound;
  trace.push(`position = onHand ${fmt(onHand)} − reserved ${fmt(reserved)} + inbound ${fmt(inbound)} = ${fmt(position)}`);

  // 2. Demand during lead time.
  const perDay = velWk / 7;
  const perDaySeasonal = perDay * seasonal;
  const demandLeadTime = perDaySeasonal * leadDays;
  trace.push(
    `velocity ${fmt(velWk)}/wk ÷ 7 = ${fmt(perDay)}/day × seasonal ${fmt(seasonal)} = ${fmt(perDaySeasonal)}/day`,
  );
  trace.push(`demandDuringLeadTime = ${fmt(perDaySeasonal)}/day × leadTime ${fmt(leadDays)}d = ${fmt(demandLeadTime)}`);

  // 3. Target level.
  const target = demandLeadTime + safety + show;
  trace.push(
    `target = demandDuringLeadTime ${fmt(demandLeadTime)} + safetyStock ${fmt(safety)} + upcomingShowDemand ${fmt(show)} = ${fmt(target)}`,
  );

  // 4. Raw need.
  const rawNeed = target - position;
  trace.push(`rawNeed = target ${fmt(target)} − position ${fmt(position)} = ${fmt(rawNeed)}`);

  let qty: number;
  if (rawNeed <= 0) {
    qty = 0;
    trace.push(`rawNeed ≤ 0 → no order needed (0)`);
  } else {
    // 5. Round UP to case pack.
    qty = Math.ceil(rawNeed / casePack) * casePack;
    trace.push(`casePack rounding: ceil(${fmt(rawNeed)} ÷ ${casePack}) × ${casePack} = ${qty}`);

    // 6. Minimum order floor (only when ordering), then re-round to case pack.
    if (minOrder > 0 && qty < minOrder) {
      const bumped = Math.ceil(minOrder / casePack) * casePack;
      trace.push(`minOrder floor: ${qty} < min ${minOrder} → ceil(${minOrder} ÷ ${casePack}) × ${casePack} = ${bumped}`);
      qty = bumped;
    } else {
      trace.push(`minOrder floor: ${qty} ≥ min ${minOrder || 0} → ${qty}`);
    }
  }

  // 7. Owner override wins.
  if (inputs.ownerOverrideQty !== undefined && inputs.ownerOverrideQty !== null) {
    const override = Math.max(0, Math.trunc(inputs.ownerOverrideQty));
    trace.push(`ownerOverride present → final ${override} (overrides computed ${qty})`);
    qty = override;
  }

  return { suggestedQty: qty, formulaTrace: trace };
}
