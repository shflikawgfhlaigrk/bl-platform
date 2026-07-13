/**
 * Scan aggregation window (pure). A keyboard-wedge scanner fires the same code
 * many times in a burst; scanning the same code again within WINDOW_MS should
 * bump the quantity of the pending line rather than create a second line. This
 * is the deterministic core the scan screen drives; it is UI-framework-free so
 * it is unit-testable.
 */

export const DEFAULT_WINDOW_MS = 3000;

/**
 * Fold a scan event into the pending-lines list.
 * @param {Array<{code:string, qty:number, firstAt:number, lastAt:number}>} lines
 * @param {{ code: string, at: number, qty?: number }} scan
 * @param {number} [windowMs]
 * @returns {{ lines: Array, changed: 'bumped'|'added', index: number }}
 */
export function aggregateScan(lines, scan, windowMs = DEFAULT_WINDOW_MS) {
  const list = lines.map((l) => ({ ...l }));
  const add = scan.qty && scan.qty > 0 ? scan.qty : 1;
  // Find the most-recent line for this code still inside the window.
  let idx = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].code === scan.code && scan.at - list[i].lastAt <= windowMs) {
      idx = i;
      break;
    }
  }
  if (idx >= 0) {
    list[idx].qty += add;
    list[idx].lastAt = scan.at;
    return { lines: list, changed: 'bumped', index: idx };
  }
  list.push({ code: scan.code, qty: add, firstAt: scan.at, lastAt: scan.at });
  return { lines: list, changed: 'added', index: list.length - 1 };
}

/** True when a fresh scan of `code` at `at` would bump an existing line. */
export function wouldAggregate(lines, code, at, windowMs = DEFAULT_WINDOW_MS) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].code === code && at - lines[i].lastAt <= windowMs) return true;
  }
  return false;
}
