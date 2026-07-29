import { el } from '../dom.js';
import { button, emptyState, errorState, loadingState, panel, statusLabel, tableShell, viewHeader } from '../ui.js';
import { formatDateTime, formatMoney, normalizeStatus, titleCase, transformReportingPayload } from '../../src/transforms.mjs';

function providerTable(providers) {
  return el('table', { className: 'data-table' }, [
    el('thead', {}, el('tr', {}, ['Provider', 'Model', 'Events', 'Quantity', 'Cost'].map((label) => el('th', { scope: 'col', text: label })))),
    el('tbody', {}, providers.map((provider) => el('tr', {}, [
      el('td', { className: 'primary-cell', text: provider.provider || 'Unknown provider' }),
      el('td', { text: provider.model || '—' }),
      el('td', { className: 'numeric', text: provider.eventCount ?? '—' }),
      el('td', { className: 'numeric', text: provider.quantity ?? '—' }),
      el('td', { className: 'numeric', text: formatMoney(provider.costCents) }),
    ]))),
  ]);
}

function runTable(runs) {
  return el('table', { className: 'data-table' }, [
    el('thead', {}, el('tr', {}, ['Run', 'Workflow', 'State', 'Attempt', 'Requested', 'Finished'].map((label) => el('th', { scope: 'col', text: label })))),
    el('tbody', {}, runs.slice(0, 12).map((run) => el('tr', {}, [
      el('td', { className: 'primary-cell', text: run.id }),
      el('td', { text: run.workflowId }),
      el('td', {}, statusLabel(run.status)),
      el('td', { className: 'numeric', text: run.attempt }),
      el('td', { className: 'numeric', text: formatDateTime(run.requestedAt) }),
      el('td', { className: 'numeric', text: formatDateTime(run.finishedAt) }),
    ]))),
  ]);
}

export async function renderReports(root, context) {
  root.append(viewHeader('Client reports', 'Live usage, provider cost, run state, and completion evidence for this tenant.', [
    button('Refresh', { icon: 'refresh', onClick: () => context.rerender() }),
  ]));
  const content = el('div');
  root.append(content);
  content.append(loadingState('Loading usage summary, execution history, and receipts…'));
  try {
    const response = await context.api.reports({ signal: context.signal });
    const data = transformReportingPayload(response);
    context.setConnection(true);
    context.setExecutionCost(data.summary.totalCostCents);
    content.replaceChildren();
    const hasData = data.summary.eventCount || data.runs.length || data.receipts.length;
    if (!hasData) {
      content.append(emptyState('No reporting activity yet', 'The API is live, but this tenant has no usage events, workflow runs, or completion receipts to report.', { icon: 'reports' }));
      return;
    }
    const succeeded = data.runs.filter((run) => normalizeStatus(run.status) === 'succeeded').length;
    const failed = data.runs.filter((run) => normalizeStatus(run.status) === 'failed').length;
    content.append(
      el('section', { className: 'card-grid' }, [
        el('article', { className: 'panel metric-card' }, [el('div', { className: 'metric-label', text: 'Execution cost (MTD)' }), el('div', { className: 'metric-value', text: formatMoney(data.summary.totalCostCents) }), el('div', { className: 'metric-note', text: 'From recorded usage events' })]),
        el('article', { className: 'panel metric-card' }, [el('div', { className: 'metric-label', text: 'Usage events' }), el('div', { className: 'metric-value', text: data.summary.eventCount }), el('div', { className: 'metric-note', text: 'Append-only billing evidence' })]),
        el('article', { className: 'panel metric-card' }, [el('div', { className: 'metric-label', text: 'Workflow runs' }), el('div', { className: 'metric-value', text: data.runs.length }), el('div', { className: 'metric-note', text: `${succeeded} succeeded · ${failed} failed` })]),
        el('article', { className: 'panel metric-card' }, [el('div', { className: 'metric-label', text: 'Completion receipts' }), el('div', { className: 'metric-value', text: data.receipts.length }), el('div', { className: 'metric-note', text: 'Returned by the live evidence ledger' })]),
      ]),
      el('div', { className: 'overview-grid' }, [
        panel('Cost by provider', data.summary.byProvider.length ? el('div', { className: 'table-scroll' }, providerTable(data.summary.byProvider)) : el('div', { className: 'panel-body view-description', text: 'No provider cost groups were returned.' }), { className: 'report-provider-panel' }),
        panel('Cost by metric', data.summary.byMetric.length ? el('ul', { className: 'compact-list' }, data.summary.byMetric.map((metric) => el('li', { className: 'compact-row' }, [
          el('span', { className: 'compact-row-copy' }, [el('strong', { text: titleCase(metric.metric) }), el('span', { text: `${metric.quantity} ${metric.unit}` })]),
          el('span', { className: 'compact-row-meta', text: formatMoney(metric.costCents) }),
        ]))) : el('div', { className: 'panel-body view-description', text: 'No metric cost groups were returned.' })),
        panel('Report evidence', el('div', { className: 'panel-body' }, [
          el('div', { className: 'metric-value', text: data.receipts.length }),
          el('p', { className: 'detail-summary', text: 'Completion receipts available for client reporting.' }),
          button('View receipts', { onClick: () => context.navigate('artifacts') }),
        ])),
      ]),
      tableShell('Recent executions', runTable(data.runs), {
        footer: [el('span', { text: `Showing ${Math.min(12, data.runs.length)} of ${data.runs.length} runs` })],
      }),
    );
  } catch (error) {
    if (error?.name === 'AbortError') return;
    context.setConnection(false);
    content.replaceChildren(errorState(error, () => context.rerender()));
  }
}
