/**
 * Bar One — PWA bootstrap. Registers the service worker, boots the
 * offline queue, paints the header + left nav, wires the sync indicator, and
 * starts the hash router. Views live in ./views/* and self-register.
 */
import { NAV, NAV_GROUPS, hashFor, DEFAULT_ROUTE } from '../../src/routes.mjs';
import { $, $$, el, clear } from './dom.js';
import { initOfflineQueue, onQueueChange, retryFailed } from './offline.js';
import { sendRaw, apiGet, getData } from './api.js';
import { primeAudio } from './audio.js';
import { startRouter, unregisteredNavRoutes } from './router.js';
import { dataAsOf } from '../../src/format.mjs';
import { requireOperatorSession } from './auth.js';
import { navSymbol } from './brand.js';

// Register every view (side-effect imports).
import './views/actions.js';
import './views/register.js';
import './views/bar.js';
import './views/scan.js';
import './views/stock.js';
import './views/counts.js';
import './views/transfers.js';
import './views/shows.js';
import './views/buying.js';
import './views/orders.js';
import './views/customers.js';
import './views/marketing.js';
import './views/money.js';
import './views/team.js';
import './views/settings.js';
import './views/imports.js';

const ctx = { asOf: null, tenantName: 'Bar One' };

function buildNav() {
  const list = $('#nav-list');
  clear(list);
  for (const group of NAV_GROUPS) {
    const barSections = ['bar', 'orders', 'money', 'team', 'settings'];
    const items = NAV.filter((n) => n.group === group.key &&
      (document.body.dataset.posProfile !== 'bar' || barSections.includes(n.route)));
    if (!items.length) continue;
    list.append(el('li', { class: 'nav-group-label', role: 'presentation' }, group.label));
    for (const n of items) {
      const link = el(
        'a',
        { class: 'nav-link', href: hashFor(n.route), 'data-route': n.route },
        [
          navSymbol(n.route),
          el('span', {}, n.label),
          el('span', { class: 'nav-badge', 'data-badge': n.route, hidden: true }),
        ],
      );
      list.append(el('li', {}, link));
    }
  }
}

function markActive(route) {
  $$('.nav-link').forEach((a) => {
    if (a.dataset.route === route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  // Close the mobile nav on navigation.
  $('#app-nav').classList.remove('open');
  $('#nav-toggle').setAttribute('aria-expanded', 'false');
}

/** Update the sync indicator from a queue snapshot. */
function paintSync(snap) {
  const ind = $('#sync-indicator');
  const text = $('#sync-text');
  ind.classList.remove('sync-synced', 'sync-queued', 'sync-failed');
  if (snap.status === 'failed') {
    ind.classList.add('sync-failed');
    const n = snap.counts.failed + snap.counts.conflict;
    text.textContent = `${n} to fix — retry`;
    ind.title = 'Some changes could not be saved to the server. Click to retry.';
  } else if (snap.status === 'queued') {
    ind.classList.add('sync-queued');
    text.textContent = `${snap.pending} saving…`;
    ind.title = 'Changes are queued and will sync when connection returns.';
  } else {
    ind.classList.add('sync-synced');
    text.textContent = document.body.dataset.nativePos === 'true' ? 'Saved on iPad' : 'Synced';
    ind.title = 'All changes saved.';
  }
}

async function loadHeader() {
  // "Data as of" = newest sale date from the owner sales rollup, if available.
  try {
    const owner = await getData('/api/dashboard/owner.json');
    const asOf =
      owner?.dataAsOf || owner?.asOf || owner?.dataThrough || owner?.through || owner?.generatedAt || null;
    if (asOf) {
      ctx.asOf = asOf;
      $('#data-as-of').textContent = dataAsOf(asOf);
    }
    if (owner?.tenantName) {
      ctx.tenantName = owner.tenantName;
      $('#tenant-name').textContent = owner.tenantName;
      $('#tenant-name').title = `Connected account: ${owner.tenantName}`;
    }
  } catch {
    $('#data-as-of').textContent = 'Data as of — (offline)';
  }
}

function wireChrome() {
  $('#nav-toggle').addEventListener('click', () => {
    const nav = $('#app-nav');
    const open = nav.classList.toggle('open');
    $('#nav-toggle').setAttribute('aria-expanded', String(open));
  });
  $('#sync-indicator').addEventListener('click', () => retryFailed());
  // Prime audio on the first interaction (autoplay policy).
  window.addEventListener('pointerdown', primeAudio, { once: true });
  window.addEventListener('keydown', primeAudio, { once: true });
}

async function main() {
  buildNav();
  wireChrome();

  // No business-data request or register action runs under an implicit owner.
  // The server-issued operator session is established before the app boots.
  await requireOperatorSession();

  // Boot the offline queue with the real network sender.
  await initOfflineQueue(sendRaw);
  onQueueChange(paintSync);

  // Fail loudly in dev if a nav item has no view (route-table completeness).
  const missing = unregisteredNavRoutes();
  if (missing.length) console.error('[one-club-pos] nav routes with no view:', missing);

  await loadHeader();

  startRouter($('#view-root'), ctx, (route) => markActive(route));

  // Register the service worker last (never blocks first paint).
  if ('serviceWorker' in navigator && document.body.dataset.nativePos !== 'true') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

main().catch((error) => {
  const root = $('#view-root');
  clear(root);
  root.append(el('div', { class: 'empty', role: 'alert' }, [
    el('div', { class: 'empty-icon', 'aria-hidden': 'true' }, '🔒'),
    el('h1', {}, 'Register sign-in unavailable'),
    el('p', {}, error?.message || 'The local register service could not be reached.'),
    el('button', { class: 'btn btn-primary', type: 'button', onclick: () => window.location.reload() }, 'Try again'),
  ]));
});
