import { el } from '../dom.js';
import { icon } from '../icons.js';
import { openProductDetail } from '../panels/product-detail.js';
import { button, emptyState, errorState, loadingState, statusLabel, tableShell, viewHeader } from '../ui.js';
import {
  filterPortfolioProducts,
  formatRelativeTime,
  normalizeStatus,
  portfolioOriginLabel,
  portfolioReadinessTone,
  titleCase,
  transformPortfolioPayload,
} from '../../src/transforms.mjs';

function readableKey(value, fallback = '—') {
  if (!value) return fallback;
  return titleCase(String(value).replace(/[.:/]+/g, ' '));
}

function readinessLabel(readiness) {
  return el('span', { className: 'status-label' }, [
    el('span', { className: `status-dot is-${portfolioReadinessTone(readiness)}`, 'aria-hidden': 'true' }),
    el('span', { text: titleCase(readiness) }),
  ]);
}

function latestProof(product) {
  return product.evidence?.latestTestAt || product.latestTest?.finishedAt || product.latestTest?.updatedAt || product.latestTest?.createdAt || null;
}

function summaryStrip(summary) {
  const metrics = [
    ['Total products', summary.total],
    ['New', summary.newCount],
    ['Existing', summary.existingCount],
    ['Verified', summary.verifiedCount],
    ['Needs attention', summary.attentionCount],
    ['Feature packages', summary.packageableFeatureCount],
  ];
  return el('section', { className: 'portfolio-summary', 'aria-label': 'Portfolio summary' }, metrics.map(([label, value]) => el('div', { className: 'portfolio-summary-item' }, [
    el('span', { text: label }),
    el('strong', { text: value }),
  ])));
}

function productTable(products, selectedKey, openProduct) {
  return el('table', { className: 'data-table product-table' }, [
    el('thead', {}, el('tr', {}, ['Product', 'Family', 'Type', 'Package state', 'Readiness', 'Latest test', 'Proof age', ''].map((label) => el('th', { scope: 'col', text: label })))),
    el('tbody', {}, products.map((product) => {
      const open = () => openProduct(product);
      return el('tr', { className: selectedKey === product.key ? 'is-selected' : '' }, [
        el('td', { className: 'primary-cell' }, el('button', { className: 'row-button product-name-button', type: 'button', onclick: open }, [
          el('strong', { text: product.name }),
          el('span', { text: portfolioOriginLabel(product.origin) }),
        ])),
        el('td', { text: readableKey(product.familyKey, 'Standalone') }),
        el('td', { text: readableKey(product.kind) }),
        el('td', {}, statusLabel(product.evidence?.latestPackageStatus || product.latestPackage?.status || 'not packaged')),
        el('td', {}, readinessLabel(product.derivedReadiness)),
        el('td', {}, statusLabel(product.evidence?.latestTestStatus || product.latestTest?.status || 'not run')),
        el('td', { className: 'numeric', text: formatRelativeTime(latestProof(product)) }),
        el('td', {}, el('button', { className: 'icon-button', type: 'button', 'aria-label': `Open ${product.name}`, onclick: open }, icon('chevron'))),
      ]);
    })),
  ]);
}

function selectOptions(values, label) {
  return [
    el('option', { value: 'all', text: `All ${label}` }),
    ...values.map((value) => el('option', { value: normalizeStatus(value), text: titleCase(value) })),
  ];
}

export async function renderProducts(root, context) {
  root.append(viewHeader('Products', 'Inspect readiness evidence and request allowlisted tests or individually versioned packages.', [
    button('Refresh', { icon: 'refresh', onClick: () => context.rerender() }),
  ]));
  const content = el('div');
  root.append(content);
  content.append(loadingState('Loading the product registry and latest verification evidence…'));

  try {
    const response = await context.api.portfolio({ signal: context.signal });
    const data = transformPortfolioPayload(response);
    context.setConnection(true);
    content.replaceChildren();
    if (!data.products.length) {
      content.append(emptyState('No products registered', 'The portfolio API returned no product definitions.', { icon: 'products' }));
      return;
    }

    let query = '';
    let origin = 'all';
    let kind = 'all';
    let readiness = 'all';
    let packageState = 'all';
    let selectedKey = '';
    const shell = el('div');
    const search = el('input', { className: 'input', type: 'search', placeholder: 'Search products', 'aria-label': 'Search products' });
    const originSelect = el('select', { className: 'select', 'aria-label': 'Filter by portfolio origin' }, [
      el('option', { value: 'all', text: 'All portfolios' }),
      el('option', { value: 'new', text: 'New' }),
      el('option', { value: 'existing', text: 'Existing' }),
      el('option', { value: 'assistance', text: 'Assistance' }),
    ]);
    const kinds = [...new Set(data.products.map((product) => product.kind).filter(Boolean))].sort();
    const readinessStates = [...new Set(data.products.map((product) => product.derivedReadiness).filter(Boolean))].sort();
    const packageStates = [...new Set(data.products.map((product) => product.latestPackage?.status || 'not packaged'))].sort();
    const kindSelect = el('select', { className: 'select', 'aria-label': 'Filter by product type' }, selectOptions(kinds, 'types'));
    const readinessSelect = el('select', { className: 'select', 'aria-label': 'Filter by readiness' }, selectOptions(readinessStates, 'readiness'));
    const packageSelect = el('select', { className: 'select', 'aria-label': 'Filter by package state' }, selectOptions(packageStates, 'package states'));

    const draw = () => {
      const filtered = filterPortfolioProducts(data.products, { query, origin, kind, readiness, packageState });
      const body = filtered.length
        ? productTable(filtered, selectedKey, (product) => {
          selectedKey = product.key;
          draw();
          openProductDetail(product, context);
        })
        : el('div', { className: 'empty-state' }, [
          el('h2', { text: 'No matching products' }),
          el('p', { text: 'Change the portfolio, type, readiness, package, or search filter.' }),
        ]);
      shell.replaceChildren(
        summaryStrip(data.summary),
        tableShell('Product portfolio', body, {
          toolbar: el('div', { className: 'filter-row portfolio-filters' }, [
            el('div', { className: 'search-control' }, [icon('search'), search]),
            originSelect,
            kindSelect,
            readinessSelect,
            packageSelect,
          ]),
          footer: [
            el('span', { text: `${filtered.length} of ${data.products.length} products` }),
            el('span', { text: `${data.summary.verifiedCount} verified` }),
          ],
        }),
      );
    };

    search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); draw(); search.focus(); });
    originSelect.addEventListener('change', () => { origin = originSelect.value; draw(); });
    kindSelect.addEventListener('change', () => { kind = kindSelect.value; draw(); });
    readinessSelect.addEventListener('change', () => { readiness = readinessSelect.value; draw(); });
    packageSelect.addEventListener('change', () => { packageState = packageSelect.value; draw(); });
    draw();
    content.append(shell);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    context.setConnection(false);
    content.replaceChildren(errorState(error, () => context.rerender()));
  }
}
