export interface ClientOpsRoute {
  id: string;
  label: string;
  title: string;
  icon: string;
}

export const ROUTES: readonly ClientOpsRoute[];
export const DEFAULT_ROUTE: string;
export function routeIds(): string[];
export function routeById(id: string): ClientOpsRoute;
export function parseHash(hash?: string): { route: string };
export function routeHash(id: string): string;
export function missingRoutes(registeredIds: Iterable<string>): string[];
