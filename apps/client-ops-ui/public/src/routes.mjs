export const ROUTES = Object.freeze([
  { id: 'overview', label: 'Overview', title: 'Operations command center', icon: 'overview' },
  { id: 'products', label: 'Products', title: 'Product portfolio', icon: 'products' },
  { id: 'services', label: 'Services', title: 'Service catalog', icon: 'services' },
  { id: 'workflows', label: 'Workflows', title: 'Workflow operations', icon: 'workflows' },
  { id: 'review-inbox', label: 'Review Inbox', title: 'Review inbox', icon: 'review' },
  { id: 'integrations', label: 'Integrations', title: 'Integrations', icon: 'integrations' },
  { id: 'artifacts', label: 'Artifacts', title: 'Artifacts and receipts', icon: 'artifacts' },
  { id: 'reports', label: 'Reports', title: 'Client reports', icon: 'reports' },
  { id: 'client-setup', label: 'Client Setup', title: 'Client setup', icon: 'setup' },
]);

export const DEFAULT_ROUTE = 'overview';

export function routeIds() {
  return ROUTES.map((route) => route.id);
}

export function routeById(id) {
  return ROUTES.find((route) => route.id === id) || ROUTES[0];
}

export function parseHash(hash = '') {
  const raw = String(hash).replace(/^#\/?/, '').split(/[?#]/)[0].replace(/^\/+|\/+$/g, '');
  const route = routeIds().includes(raw) ? raw : DEFAULT_ROUTE;
  return { route };
}

export function routeHash(id) {
  return `#/${routeById(id).id}`;
}

export function missingRoutes(registeredIds) {
  const registered = new Set(registeredIds);
  return routeIds().filter((id) => !registered.has(id));
}
