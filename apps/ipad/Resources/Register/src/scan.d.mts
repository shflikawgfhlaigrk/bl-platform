export const DEFAULT_WINDOW_MS: number;
export interface ScanLine {
  code: string;
  qty: number;
  firstAt: number;
  lastAt: number;
}
export function aggregateScan(
  lines: ScanLine[],
  scan: { code: string; at: number; qty?: number },
  windowMs?: number,
): { lines: ScanLine[]; changed: 'bumped' | 'added'; index: number };
export function wouldAggregate(
  lines: ScanLine[],
  code: string,
  at: number,
  windowMs?: number,
): boolean;
