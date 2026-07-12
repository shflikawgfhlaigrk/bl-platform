/**
 * Transparent packing suggestion — a PURE function. No DB, no clock, no cross-
 * module reads: the integrator gathers the stats and feeds them in, so every
 * input and every arithmetic step is recorded in the returned `formulaTrace`.
 *
 * Formula, per variation (all quantities are whole units):
 *
 *   1. demand
 *        - template-target branch : demand = targetQty
 *          (a template line names this variation with an explicit targetQty)
 *        - velocity-derived branch: demand = ceil(unitsPerWeekVelocity * categoryShowShare)
 *          (zero velocity -> honest 0, never fabricated)
 *   2. withSafety   = demand + safetyStock
 *   3. floored      = max(withSafety, displayMin)          [display-minimum floor]
 *   4. available    = max(onHand - reserved, 0)
 *   5. capped       = min(floored, available)              [availability cap]
 *
 * After all lines are computed, if a vehicle capacity is given and the sum of
 * `capped` exceeds it, every line is proportionally scaled down:
 *
 *   6. scaled       = floor(capped * capacity / totalCapped)   [capacity cap]
 *
 * suggestedQty is the final value; formulaTrace lists each step with its value.
 */

export interface SuggestTemplateLine {
  category?: string | null;
  variationId?: string | null;
  targetQty?: number | null;
  displayMin?: number | null;
}

export interface SuggestVariationStat {
  variationId: string;
  name: string;
  /** Verified historical units sold per week for this variation. */
  unitsPerWeekVelocity: number;
  /** Share of this category's sales that happen at shows (0..1). */
  categoryShowShare: number;
  onHand: number;
  reserved: number;
  displayMin: number;
  safetyStock: number;
}

export interface SuggestInputs {
  templateLines: SuggestTemplateLine[];
  variationStats: SuggestVariationStat[];
  vehicleCapacityUnits?: number | null;
}

export interface FormulaTraceStep {
  step: string;
  value: number;
  note: string;
}

export interface SuggestedLine {
  variationId: string;
  name: string;
  suggestedQty: number;
  formulaTrace: FormulaTraceStep[];
}

export interface SuggestResult {
  lines: SuggestedLine[];
  /** Sum of pre-capacity quantities; present so the scale-down is auditable. */
  totalBeforeCapacity: number;
  vehicleCapacityUnits: number | null;
}

/**
 * Compute transparent suggestions for every variation stat provided. One
 * output line per variation stat; a template line matched by `variationId`
 * (with a numeric `targetQty`) selects the template-target branch, otherwise
 * the velocity-derived branch is used.
 */
export function suggestManifest(inputs: SuggestInputs): SuggestResult {
  const capacity =
    inputs.vehicleCapacityUnits === undefined || inputs.vehicleCapacityUnits === null
      ? null
      : Math.max(Math.trunc(inputs.vehicleCapacityUnits), 0);

  // Index template lines by explicit variationId for the template-target branch.
  const lineByVariation = new Map<string, SuggestTemplateLine>();
  for (const line of inputs.templateLines) {
    if (line.variationId) lineByVariation.set(line.variationId, line);
  }

  interface Pre {
    stat: SuggestVariationStat;
    capped: number;
    trace: FormulaTraceStep[];
  }

  const pre: Pre[] = inputs.variationStats.map((stat) => {
    const trace: FormulaTraceStep[] = [];
    const line = lineByVariation.get(stat.variationId);

    // 1. demand
    let demand: number;
    if (line && typeof line.targetQty === 'number') {
      demand = Math.max(Math.trunc(line.targetQty), 0);
      trace.push({
        step: 'demand',
        value: demand,
        note: `template_target: targetQty=${line.targetQty}`,
      });
    } else {
      demand = Math.max(
        Math.ceil(stat.unitsPerWeekVelocity * stat.categoryShowShare),
        0,
      );
      trace.push({
        step: 'demand',
        value: demand,
        note: `velocity_derived: ceil(unitsPerWeekVelocity=${stat.unitsPerWeekVelocity} * categoryShowShare=${stat.categoryShowShare})`,
      });
    }

    // 2. + safety stock
    const withSafety = demand + Math.max(stat.safetyStock, 0);
    trace.push({
      step: 'safety_stock',
      value: withSafety,
      note: `demand + safetyStock=${stat.safetyStock}`,
    });

    // 3. display-minimum floor (template line override wins over stat displayMin)
    const displayMin =
      line && typeof line.displayMin === 'number' ? line.displayMin : stat.displayMin;
    const floored = Math.max(withSafety, Math.max(displayMin, 0));
    trace.push({
      step: 'display_min_floor',
      value: floored,
      note: `max(${withSafety}, displayMin=${displayMin})`,
    });

    // 4/5. availability cap
    const available = Math.max(stat.onHand - stat.reserved, 0);
    const capped = Math.min(floored, available);
    trace.push({
      step: 'availability_cap',
      value: capped,
      note: `min(${floored}, onHand=${stat.onHand} - reserved=${stat.reserved} = ${available})`,
    });

    return { stat, capped, trace };
  });

  const totalBeforeCapacity = pre.reduce((sum, p) => sum + p.capped, 0);

  const lines: SuggestedLine[] = pre.map((p) => {
    let suggestedQty = p.capped;
    if (capacity !== null && totalBeforeCapacity > capacity && totalBeforeCapacity > 0) {
      suggestedQty = Math.floor((p.capped * capacity) / totalBeforeCapacity);
      p.trace.push({
        step: 'vehicle_capacity_scale',
        value: suggestedQty,
        note: `floor(${p.capped} * capacity=${capacity} / totalBeforeCapacity=${totalBeforeCapacity})`,
      });
    } else if (capacity !== null) {
      p.trace.push({
        step: 'vehicle_capacity_ok',
        value: suggestedQty,
        note: `totalBeforeCapacity=${totalBeforeCapacity} <= capacity=${capacity}; no scale-down`,
      });
    }
    return {
      variationId: p.stat.variationId,
      name: p.stat.name,
      suggestedQty,
      formulaTrace: p.trace,
    };
  });

  return { lines, totalBeforeCapacity, vehicleCapacityUnits: capacity };
}
