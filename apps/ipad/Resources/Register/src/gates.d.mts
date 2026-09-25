export function humanizeKey(key: string): string;
export function isOpen(gate: unknown): boolean;
export function reasonOf(gate: unknown): string;
export function phraseGate(
  key: string,
  gate: unknown,
): { key: string; label: string; open: boolean; reason: string; phrase: string };
export function phraseReport(report: unknown): {
  gates: { key: string; label: string; open: boolean; reason: string; phrase: string }[];
  openCount: number;
  blockedCount: number;
  allOpen: boolean;
};
