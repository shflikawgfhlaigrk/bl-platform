/** Hash router + view registry. Views self-register; app.js starts it. */
import { parseHash, DEFAULT_ROUTE, navRoutes } from '../../src/routes.mjs';
import { clear, el } from './dom.js';

const views = new Map();

/** Register a view renderer: async (container, params, ctx) => void. */
export function registerView(route, renderer) {
  views.set(route, renderer);
}

export function registeredRoutes() {
  return Array.from(views.keys());
}

export function hasView(route) {
  return views.has(route);
}

let root = null;
let ctx = null;
let onRoute = null;

export function startRouter(rootEl, context, routeChanged) {
  root = rootEl;
  ctx = context;
  onRoute = routeChanged;
  window.addEventListener('hashchange', render);
  if (!location.hash) location.hash = `#/${DEFAULT_ROUTE}`;
  else render();
}

export function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

async function render() {
  const { route, params } = parseHash(location.hash);
  const renderer = views.get(route) || views.get(DEFAULT_ROUTE);
  if (onRoute) onRoute(route, params);
  clear(root);
  const container = el('div', { class: 'view' });
  root.append(container);
  // Move keyboard focus to main for each navigation (a11y).
  const main = document.getElementById('main');
  if (main) main.focus({ preventScroll: true });
  try {
    await renderer(container, params, ctx);
  } catch (err) {
    clear(container);
    container.append(
      el('div', { class: 'error-banner', role: 'alert' }, [
        el('strong', {}, 'Something went wrong loading this screen. '),
        el('span', {}, (err && err.message) || 'Unknown error.'),
      ]),
    );
  }
}

/** Guard used by app.js at boot: every nav route must have a view. */
export function unregisteredNavRoutes() {
  return navRoutes().filter((r) => !views.has(r));
}
