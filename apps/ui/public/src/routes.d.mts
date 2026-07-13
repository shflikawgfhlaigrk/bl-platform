export interface NavItem {
  route: string;
  label: string;
  short: string;
  group: string;
  icon: string;
  primary: string;
}
export const NAV: NavItem[];
export const DEFAULT_ROUTE: string;
export const NAV_GROUPS: { key: string; label: string }[];
export function parseHash(hash: string): { route: string; params: string[] };
export function hashFor(route: string, ...params: string[]): string;
export function navRoutes(): string[];
export function missingViews(registeredKeys: string[]): string[];
export function extraViews(registeredKeys: string[]): string[];
