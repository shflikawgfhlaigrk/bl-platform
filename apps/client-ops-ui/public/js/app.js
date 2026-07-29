import { setTenantId } from './api.js';
import { clientOpsApi } from './client-ops-api.js';
import { el } from './dom.js';
import { hydrateIcons, icon } from './icons.js';
import { createDrawer, createToastStack, drawerSection, inputField, button } from './ui.js';
import { DEFAULT_ROUTE, parseHash, ROUTES, routeHash } from '../src/routes.mjs';
import { views } from './views/index.js';

const shell = document.getElementById('app-shell');
const navRail = document.getElementById('nav-rail');
const navList = document.getElementById('nav-list');
const viewRoot = document.getElementById('view-root');
const main = document.getElementById('main');
const mobileMenu = document.getElementById('mobile-menu');
const navCollapse = document.getElementById('nav-collapse');
const scrim = document.getElementById('scrim');
const clientName = document.getElementById('client-name');
const apiState = document.getElementById('api-state');
const executionCost = document.getElementById('execution-cost');

const drawer = createDrawer(
  shell,
  document.getElementById('detail-drawer'),
  document.getElementById('drawer-context'),
  document.getElementById('drawer-title'),
  document.getElementById('drawer-body'),
  document.getElementById('drawer-actions'),
);
const toast = createToastStack(document.getElementById('toast-stack'));

const queryTenant = new URLSearchParams(location.search).get('tenant_id');
let currentTenantId = queryTenant || localStorage.getItem('blacklabel.clientOps.tenantId') || '';
if (currentTenantId) {
  setTenantId(currentTenantId);
  localStorage.setItem('blacklabel.clientOps.tenantId', currentTenantId);
  clientName.textContent = currentTenantId;
} else {
  clientName.textContent = 'Set client context';
}

function setConnection(connected) {
  apiState.replaceChildren(
    el('span', { className: `status-dot is-${connected ? 'gold' : 'danger'}`, 'aria-hidden': 'true' }),
    el('span', { text: connected ? 'Live API' : 'API unavailable' }),
  );
}

function setExecutionCost(cents) {
  if (cents === null || cents === undefined || cents === '' || !Number.isFinite(Number(cents))) {
    executionCost.textContent = '—';
    return;
  }
  executionCost.textContent = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(cents) / 100);
}

function openTenantContext() {
  const field = inputField('Tenant ID', {
    value: currentTenantId,
    placeholder: 'Enter the API tenant ID',
    required: true,
  });
  const help = drawerSection('API context', [
    el('p', { className: 'view-description', text: 'The backend requires an exact tenant ID. This browser stores the value locally and sends it as x-tenant-id.' }),
    field.root,
  ]);
  const save = button('Use tenant', {
    variant: 'primary',
    icon: 'check',
    onClick: () => {
      const value = field.control.value.trim();
      if (!value) {
        field.control.focus();
        return;
      }
      currentTenantId = value;
      setTenantId(value);
      localStorage.setItem('blacklabel.clientOps.tenantId', value);
      clientName.textContent = value;
      drawer.close({ restoreFocus: false });
      toast('Client context updated.');
      renderRoute();
    },
  });
  drawer.open({ context: 'Client', title: 'Tenant context', body: help, actions: [save] });
}

for (const route of ROUTES) {
  const link = el('a', { className: 'nav-link', href: routeHash(route.id), dataset: { route: route.id } }, [
    icon(route.icon),
    el('span', { className: 'nav-label', text: route.label }),
    route.id === 'review-inbox' ? el('span', { className: 'nav-badge', id: 'review-count', text: '—', hidden: true }) : null,
  ]);
  navList.append(el('li', {}, link));
}

hydrateIcons();

let routeController = null;
let renderToken = 0;
let initialized = false;

async function renderRoute() {
  routeController?.abort();
  routeController = new AbortController();
  const token = ++renderToken;
  const { route } = parseHash(location.hash);
  const render = views[route] || views[DEFAULT_ROUTE];

  for (const link of navList.querySelectorAll('.nav-link')) {
    if (link.dataset.route === route) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = `${ROUTES.find((item) => item.id === route)?.title || 'Client Operations'} — Black Label`;
  shell.classList.remove('nav-open');
  mobileMenu.setAttribute('aria-expanded', 'false');
  drawer.close({ restoreFocus: false });
  viewRoot.replaceChildren();
  main.focus({ preventScroll: true });

  const context = {
    api: clientOpsApi,
    signal: routeController.signal,
    drawer,
    toast,
    setConnection,
    setExecutionCost,
    setReviewCount(count) {
      const badge = document.getElementById('review-count');
      if (!badge) return;
      badge.textContent = String(count);
      badge.hidden = !Number.isFinite(count) || count < 1;
    },
    navigate(routeId) { location.hash = routeHash(routeId); },
    rerender() { if (token === renderToken) renderRoute(); },
    openTenantContext,
  };

  try {
    await render(viewRoot, context);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    setConnection(false);
    console.error(error);
  }
}

window.addEventListener('hashchange', () => {
  if (initialized) renderRoute();
});
mobileMenu.addEventListener('click', () => {
  const open = !shell.classList.contains('nav-open');
  shell.classList.toggle('nav-open', open);
  mobileMenu.setAttribute('aria-expanded', String(open));
});
navCollapse.addEventListener('click', () => {
  const collapsed = !shell.classList.contains('nav-collapsed');
  shell.classList.toggle('nav-collapsed', collapsed);
  navCollapse.setAttribute('aria-pressed', String(collapsed));
  localStorage.setItem('blacklabel.clientOps.navCollapsed', String(collapsed));
});
scrim.addEventListener('click', () => {
  shell.classList.remove('nav-open');
  mobileMenu.setAttribute('aria-expanded', 'false');
  drawer.close();
});
document.getElementById('drawer-close').addEventListener('click', () => drawer.close());
clientName.addEventListener('click', openTenantContext);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    shell.classList.remove('nav-open');
    mobileMenu.setAttribute('aria-expanded', 'false');
    if (drawer.isOpen) drawer.close();
  }
});

if (localStorage.getItem('blacklabel.clientOps.navCollapsed') === 'true') {
  shell.classList.add('nav-collapsed');
  navCollapse.setAttribute('aria-pressed', 'true');
}

async function initialize() {
  try {
    const response = await clientOpsApi.bootstrap();
    const data = response?.data ?? response ?? {};
    const bootstrapTenantId = data.tenantId || data.tenant?.id || '';
    if (!queryTenant && bootstrapTenantId) {
      currentTenantId = bootstrapTenantId;
      setTenantId(bootstrapTenantId);
      localStorage.setItem('blacklabel.clientOps.tenantId', bootstrapTenantId);
    }
    const displayName = data.tenantName || data.clientName || data.displayName || data.tenant?.name;
    clientName.textContent = displayName || currentTenantId || 'Set client context';
    const bootstrapCost = data.executionCostCents ?? data.usage?.totalCostCents;
    if (Number.isFinite(Number(bootstrapCost))) setExecutionCost(bootstrapCost);
    else {
      try {
        const usage = await clientOpsApi.usageSummary();
        const totalCostCents = usage?.data?.totalCostCents ?? usage?.totalCostCents;
        if (Number.isFinite(Number(totalCostCents))) setExecutionCost(totalCostCents);
      } catch {
        setExecutionCost(null);
      }
    }
  } catch {
    clientName.textContent = currentTenantId || 'Set client context';
  }
  initialized = true;
  if (!location.hash) location.hash = routeHash(DEFAULT_ROUTE);
  else renderRoute();
}

initialize();
