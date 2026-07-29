import { el } from '../dom.js';
import { icon } from '../icons.js';
import { button, definitionList, drawerSection, mutateWithFeedback, statusLabel } from '../ui.js';
import {
  formatBytes,
  formatDateTime,
  normalizeStatus,
  portfolioOriginLabel,
  portfolioReadinessTone,
  titleCase,
  transformPortfolioDetailPayload,
} from '../../src/transforms.mjs';

function readinessLabel(readiness) {
  return el('span', { className: 'status-label' }, [
    el('span', { className: `status-dot is-${portfolioReadinessTone(readiness)}`, 'aria-hidden': 'true' }),
    el('span', { text: titleCase(readiness) }),
  ]);
}

function readableKey(value, fallback = '—') {
  if (!value) return fallback;
  return titleCase(String(value).replace(/[.:/]+/g, ' '));
}

function proofTime(value) {
  return value?.finishedAt || value?.verifiedAt || value?.builtAt || value?.updatedAt || value?.createdAt || null;
}

function historyList(items, kind) {
  if (!items.length) return el('p', { className: 'view-description', text: kind === 'test' ? 'No test runs recorded.' : 'No packages recorded.' });
  return el('ol', { className: 'product-evidence-list' }, items.map((item) => {
    const title = kind === 'test'
      ? item.suiteKey || readableKey(item.targetKey, 'Test run')
      : item.version ? `Version ${item.version}` : readableKey(item.targetKey, 'Package');
    const detail = kind === 'test'
      ? item.summary || (item.sourceRevision ? `Revision ${item.sourceRevision}` : '')
      : [item.bytes === null ? '' : formatBytes(item.bytes), item.sha256 ? `SHA ${item.sha256}` : ''].filter(Boolean).join(' · ');
    return el('li', {}, [
      el('div', { className: 'product-evidence-heading' }, [el('strong', { text: title }), statusLabel(item.status)]),
      detail ? el('p', { text: detail }) : null,
      el('time', { datetime: proofTime(item) || '', text: formatDateTime(proofTime(item)) }),
    ]);
  }));
}

function mutationAction(label, operation, success, context, reload, options = {}) {
  const control = button(label, { variant: options.variant, icon: options.icon, ariaLabel: options.ariaLabel });
  control.addEventListener('click', async () => {
    try {
      await mutateWithFeedback(control, operation, context, { success });
      await reload();
    } catch {
      // mutateWithFeedback already surfaces the API error in the shared toast stack.
    }
  });
  return control;
}

function productSuite(product) {
  return product.evidence.missingSuiteKeys[0]
    || product.requiredSuiteKeys[0]
    || product.allowedSuiteKeys[0]
    || product.testSuites[0]?.key
    || '';
}

function canPackageProduct(product) {
  const mode = normalizeStatus(product.packageMode);
  const readiness = normalizeStatus(product.catalogReadiness);
  return mode !== 'private reference'
    && readiness !== 'private reference'
    && readiness !== 'retired merged';
}

function packageVersion() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replaceAll('-', '.');
  const time = now.toISOString().slice(11, 19).replaceAll(':', '');
  return `${date}.${time}`;
}

function featureList(product, context, reload) {
  if (!product.features.length) return el('p', { className: 'view-description', text: 'No individually packageable features were registered.' });
  return el('ul', { className: 'product-feature-list' }, product.features.map((feature) => {
    const actions = [];
    const featureSuite = feature.evidence.missingSuiteKeys[0]
      || feature.requiredSuiteKeys[0]
      || feature.allowedSuiteKeys[0]
      || '';
    if (featureSuite) {
      actions.push(mutationAction(
        'Request test',
        () => context.api.runPortfolioTest(product.key, featureSuite, { targetKind: 'feature', targetKey: feature.key }),
        `${feature.name} test queued.`,
        context,
        reload,
        { ariaLabel: `Request test for ${feature.name}` },
      ));
    }
    if (feature.packageable) {
      actions.push(mutationAction(
        'Request package',
        () => context.api.buildPortfolioPackage(product.key, packageVersion(), { targetKind: 'feature', targetKey: feature.key }),
        `${feature.name} package queued.`,
        context,
        reload,
        { ariaLabel: `Request package for ${feature.name}` },
      ));
    }
    return el('li', {}, [
      el('div', { className: 'product-feature-copy' }, [
        el('strong', { text: feature.name }),
        feature.summary ? el('span', { text: feature.summary }) : null,
        el('span', { text: `${titleCase(feature.readiness)} · ${feature.packageable ? 'Individual package enabled' : 'Included with product'}` }),
      ]),
      actions.length ? el('div', { className: 'product-feature-actions' }, actions) : null,
    ]);
  }));
}

function detailSections(data, context, reload) {
  const { product, testRuns, packages } = data;
  const blockers = product.blockers.length
    ? el('ul', { className: 'product-blocker-list' }, product.blockers.map((blocker) => el('li', {}, [icon('alert'), el('span', { text: blocker })])))
    : el('p', { className: 'view-description', text: 'No blockers reported.' });
  const aliases = product.aliases.length ? product.aliases.join(', ') : 'None';
  const actions = [];
  const suiteKey = productSuite(product);
  if (suiteKey) {
    actions.push(mutationAction(
      'Request test',
      () => context.api.runPortfolioTest(product.key, suiteKey, { targetKind: 'product', targetKey: product.key }),
      `${product.name} test queued.`,
      context,
      reload,
      { icon: 'play' },
    ));
  }
  if (canPackageProduct(product)) {
    actions.push(mutationAction(
      'Request product package',
      () => context.api.buildPortfolioPackage(product.key, packageVersion(), { targetKind: 'product', targetKey: product.key }),
      `${product.name} package queued.`,
      context,
      reload,
      { variant: 'primary', icon: 'artifacts' },
    ));
  }

  return [
    drawerSection(null, [
      readinessLabel(product.derivedReadiness),
      product.readinessSummary ? el('p', { className: 'detail-summary', text: product.readinessSummary }) : null,
      definitionList([
        ['Portfolio', portfolioOriginLabel(product.origin)],
        ['Family', readableKey(product.familyKey, 'Standalone')],
        ['Type', readableKey(product.kind)],
        ['Package mode', readableKey(product.packageMode)],
        ['Catalog state', readinessLabel(product.catalogReadiness)],
        ['Source ID', product.sourceId || '—'],
        ['Source repository', product.sourceRepo || '—'],
        ['Sellable', product.sellable ? 'Yes' : 'No'],
        ['Aliases', aliases],
      ]),
    ]),
    actions.length ? drawerSection('Product actions', el('div', { className: 'button-row product-action-row' }, actions)) : null,
    drawerSection(`Features (${product.features.length})`, featureList(product, context, reload)),
    drawerSection(`Blockers (${product.blockers.length})`, blockers),
    drawerSection('Evidence ledger', definitionList([
      ['Passed suites', product.evidence.passedSuiteKeys.length ? product.evidence.passedSuiteKeys.join(', ') : 'None'],
      ['Missing suites', product.evidence.missingSuiteKeys.length ? product.evidence.missingSuiteKeys.join(', ') : 'None'],
      ['Latest test', statusLabel(product.evidence.latestTestStatus)],
      ['Latest package', statusLabel(product.evidence.latestPackageStatus)],
      ['Source references', product.sourceRefs.length ? product.sourceRefs.join(', ') : 'None'],
    ])),
    drawerSection(`Test history (${testRuns.length})`, historyList(testRuns, 'test')),
    drawerSection(`Package history (${packages.length})`, historyList(packages, 'package')),
  ].filter(Boolean);
}

export function openProductDetail(summaryProduct, context) {
  const body = el('div');
  context.drawer.open({ context: 'Product', title: summaryProduct.name, body });

  const load = async () => {
    body.replaceChildren(el('div', { className: 'drawer-loading', role: 'status' }, [icon('refresh'), el('span', { text: 'Loading product evidence…' })]));
    try {
      const [detail, testRuns, packages] = await Promise.all([
        context.api.portfolioProduct(summaryProduct.key, { signal: context.signal }),
        context.api.portfolioTestRuns(summaryProduct.key, { signal: context.signal }),
        context.api.portfolioPackages(summaryProduct.key, { signal: context.signal }),
      ]);
      const data = transformPortfolioDetailPayload(detail, testRuns, packages);
      context.setConnection(true);
      body.replaceChildren(...detailSections(data, context, load));
    } catch (error) {
      if (error?.name === 'AbortError') return;
      context.setConnection(false);
      const retry = button('Try again', { icon: 'refresh', onClick: load });
      body.replaceChildren(drawerSection('Evidence unavailable', [
        el('p', { className: 'detail-summary', text: error?.message || 'Product evidence could not be loaded.' }),
        retry,
      ]));
    }
  };

  load();
}
