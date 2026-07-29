import { el } from '../dom.js';
import { icon } from '../icons.js';
import { openArtifactDetail } from '../panels/artifact-detail.js';
import { openConnectorDetail } from '../panels/connector-detail.js';
import { openReviewDetail } from '../panels/review-detail.js';
import { openServiceDetail } from '../panels/service-detail.js';
import { openWorkflowDetail } from '../panels/workflow-detail.js';
import { button, emptyState, errorState, inlineLink, loadingState, panel, serviceIcon, statusLabel, tableShell, viewHeader } from '../ui.js';
import { formatDateTime, formatRelativeTime, normalizeStatus, transformOverviewPayload } from '../../src/transforms.mjs';

function workflowTable(workflows, context) {
  const table = el('table', { className: 'data-table' }, [
    el('thead', {}, el('tr', {}, ['Workflow', 'Service', 'State', 'Last run', 'Outcome', 'Next action', ''].map((label) => el('th', { scope: 'col', text: label })))),
    el('tbody', {}, workflows.slice(0, 8).map((workflow, index) => el('tr', { className: index === 0 ? 'is-selected' : '' }, [
      el('td', { className: 'primary-cell' }, el('button', { className: 'row-button', type: 'button', text: workflow.name, onclick: () => openWorkflowDetail(workflow, context) })),
      el('td', { text: workflow.service }),
      el('td', {}, statusLabel(workflow.status)),
      el('td', { className: 'numeric', text: formatDateTime(workflow.lastRun) }),
      el('td', { text: workflow.progress !== null ? `${workflow.progress}% complete` : workflow.outcome }),
      el('td', { text: workflow.nextAction }),
      el('td', { className: 'row-chevron' }, el('button', { className: 'icon-button', type: 'button', 'aria-label': `Open ${workflow.name}`, onclick: () => openWorkflowDetail(workflow, context) }, icon('chevron'))),
    ]))),
  ]);
  return tableShell('Workflow operations', table, {
    footer: [
      el('span', { text: `Showing ${Math.min(8, workflows.length)} of ${workflows.length} workflows` }),
      inlineLink('View all workflows', { onClick: () => context.navigate('workflows') }),
    ],
  });
}

function reviewPanel(reviews, context) {
  const list = el('ul', { className: 'compact-list' }, reviews.slice(0, 5).map((review) => el('li', { className: 'compact-row' }, [
    el('span', { className: 'compact-row-icon' }, icon('review')),
    el('button', { className: 'row-button compact-row-copy', type: 'button', onclick: () => openReviewDetail(review, context) }, [
      el('strong', { text: review.title }),
      el('span', { text: review.workflow }),
    ]),
    el('span', { className: `priority is-${review.priority.toLowerCase()}`, text: review.priority }),
  ])));
  return panel('Review inbox', reviews.length ? list : el('div', { className: 'panel-body view-description', text: 'No review items were returned.' }), {
    action: inlineLink('View all', { onClick: () => context.navigate('review-inbox') }),
  });
}

function connectorPanel(connectors, context) {
  const list = el('ul', { className: 'compact-list' }, connectors.slice(0, 7).map((connector) => el('li', { className: 'compact-row' }, [
    el('span', { className: 'compact-row-icon' }, icon('connector')),
    el('button', { className: 'row-button compact-row-copy', type: 'button', onclick: () => openConnectorDetail(connector, context) }, [
      el('strong', { text: connector.name }),
      el('span', { text: connector.category }),
    ]),
    statusLabel(connector.status),
  ])));
  return panel('Integration health', connectors.length ? list : el('div', { className: 'panel-body view-description', text: 'No connector bindings were returned.' }), {
    action: inlineLink('View all', { onClick: () => context.navigate('integrations') }),
  });
}

function artifactPanel(artifacts, context) {
  const timeline = el('ol', { className: 'timeline' }, artifacts.slice(0, 5).map((artifact) => el('li', { className: 'timeline-item' }, [
    el('time', { className: 'timeline-time', text: formatDateTime(artifact.createdAt).split(',').at(-1)?.trim() || '—' }),
    el('span', { className: 'timeline-marker' }, icon(artifact.kind.includes('receipt') ? 'receipt' : 'file')),
    el('button', { className: 'row-button timeline-copy', type: 'button', onclick: () => openArtifactDetail(artifact, context) }, [
      el('strong', { text: artifact.name }),
      el('span', { text: artifact.kind }),
    ]),
  ])));
  return panel('Artifact / completion receipts', artifacts.length ? timeline : el('div', { className: 'panel-body view-description', text: 'No artifacts or receipts were returned.' }), {
    action: inlineLink('View all', { onClick: () => context.navigate('artifacts') }),
  });
}

function renderDashboard(data, context) {
  const container = el('div');
  if (data.services.length) {
    container.append(el('section', { className: 'overview-service-rail', 'aria-label': 'Service health' }, data.services.slice(0, 8).map((service, index) => el('button', {
      className: `service-health${index === 0 ? ' is-selected' : ''}`,
      type: 'button',
      onclick: () => openServiceDetail(service, context),
    }, [
      icon(serviceIcon(service)),
      el('strong', { text: service.name }),
      statusLabel(service.readiness),
    ]))));
  }
  if (data.workflows.length) container.append(workflowTable(data.workflows, context));
  container.append(el('div', { className: 'overview-grid' }, [
    reviewPanel(data.reviews, context),
    connectorPanel(data.connectors, context),
    artifactPanel(data.artifacts, context),
  ]));
  return container;
}

export async function renderOverview(root, context) {
  const refresh = button('Refresh', { icon: 'refresh', onClick: () => context.rerender() });
  root.append(viewHeader('Operations command center', '', [refresh]));
  const content = el('div');
  root.append(content);
  content.append(loadingState());
  try {
    const response = await context.api.overview({ signal: context.signal });
    const data = transformOverviewPayload(response);
    context.setConnection(true);
    context.setExecutionCost(data.executionCostCents);
    context.setReviewCount(data.reviews.filter((item) => normalizeStatus(item.status) === 'pending').length);
    content.replaceChildren();
    const hasOperationalData = data.services.length || data.workflows.length || data.reviews.length || data.connectors.length || data.artifacts.length;
    if (!hasOperationalData) {
      content.append(emptyState('No client operations installed', 'The API is live, but this tenant has no installed services, workflows, reviews, connectors, artifacts, or receipts yet.', {
        icon: 'services',
        action: button('Browse services', { variant: 'primary', onClick: () => context.navigate('services') }),
      }));
      return;
    }
    content.append(renderDashboard(data, context));
  } catch (error) {
    if (error?.name === 'AbortError') return;
    context.setConnection(false);
    content.replaceChildren(errorState(error, () => context.rerender()));
  }
}
