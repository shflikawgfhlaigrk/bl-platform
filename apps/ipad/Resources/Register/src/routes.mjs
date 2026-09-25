/**
 * Route + navigation table (single source of truth). Hash-based routing:
 * `#/<route>` selects a view. Labels are plain business language for a
 * non-technical owner (MAGS build prompt §7), NOT module/jargon names —
 * "Stock" not "inventory movements ledger", "Buying" not "purchasing".
 *
 * The route-completeness test asserts every nav route has a registered view
 * (see missingViews / extraViews below), so a nav item can never dead-link.
 */

/** @typedef {{ route:string, hash:string, label:string, short:string, group:string, icon:string, primary:string }} NavItem */

/** @type {NavItem[]} */
export const NAV = [
  { route: 'bar', label: 'Bar service', short: 'Bar', group: 'run', icon: '🍸', primary: 'Open a tab and serve drinks' },
  { route: 'actions', label: 'Action Center', short: 'Home', group: 'run', icon: '🔔', primary: 'Resolve what needs attention' },
  { route: 'register', label: 'Register', short: 'Sell', group: 'run', icon: '💳', primary: 'Start a sale' },
  { route: 'scan', label: 'Scan', short: 'Scan', group: 'run', icon: '📷', primary: 'Scan an item' },
  { route: 'stock', label: 'Stock', short: 'Stock', group: 'run', icon: '📦', primary: 'Check on-hand' },
  { route: 'counts', label: 'Counts', short: 'Counts', group: 'run', icon: '📋', primary: 'Start a count' },
  { route: 'transfers', label: 'Transfers', short: 'Transfers', group: 'run', icon: '🔁', primary: 'Move stock' },
  { route: 'shows', label: 'Events', short: 'Events', group: 'run', icon: '🎪', primary: 'Plan an event' },
  { route: 'orders', label: 'Orders', short: 'Orders', group: 'sell', icon: '🧾', primary: 'Find an order' },
  { route: 'buying', label: 'Buying', short: 'Buying', group: 'sell', icon: '🛒', primary: 'Reorder stock' },
  { route: 'customers', label: 'Guests', short: 'Guests', group: 'sell', icon: '👤', primary: 'Find a guest' },
  { route: 'marketing', label: 'Marketing', short: 'Marketing', group: 'sell', icon: '✉️', primary: 'Send an offer' },
  { route: 'money', label: 'Money', short: 'Money', group: 'back', icon: '💵', primary: 'See the numbers' },
  { route: 'team', label: 'Team', short: 'Team', group: 'back', icon: '🧑‍🤝‍🧑', primary: 'Manage the team' },
  { route: 'imports', label: 'Imports', short: 'Imports', group: 'back', icon: '⬇️', primary: 'Check data sync' },
  { route: 'settings', label: 'Settings', short: 'Settings', group: 'back', icon: '⚙️', primary: 'Set things up' },
];

export const DEFAULT_ROUTE = 'bar';

/** Group headers in the left nav, in order. */
export const NAV_GROUPS = [
  { key: 'run', label: 'Club operations' },
  { key: 'sell', label: 'Guest services' },
  { key: 'back', label: 'Club office' },
];

/** Parse a location.hash ("#/scan/abc") into { route, params[] }. */
export function parseHash(hash) {
  const raw = (hash || '').replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  const route = parts[0] || DEFAULT_ROUTE;
  return { route, params: parts.slice(1) };
}

export function hashFor(route, ...params) {
  return `#/${[route, ...params].filter(Boolean).join('/')}`;
}

/** Every route that must have a registered view. */
export function navRoutes() {
  return NAV.map((n) => n.route);
}

/** Nav routes with no registered view (must be empty). */
export function missingViews(registeredKeys) {
  const reg = new Set(registeredKeys);
  return navRoutes().filter((r) => !reg.has(r));
}

/** Registered views that are not reachable from the nav (informational). */
export function extraViews(registeredKeys) {
  const routes = new Set(navRoutes());
  return registeredKeys.filter((k) => !routes.has(k));
}
