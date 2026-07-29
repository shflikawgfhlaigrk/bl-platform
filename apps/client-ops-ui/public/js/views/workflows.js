import { el } from '../dom.js';
import { icon } from '../icons.js';
import { openWorkflowDetail } from '../panels/workflow-detail.js';
import { button, emptyState, errorState, loadingState, statusLabel, tableShell, viewHeader } from '../ui.js';
import { formatDateTime, normalizeStatus, transformInstalledWorkflows } from '../../src/transforms.mjs';

function renderTable(workflows, context) {
  const table = el('table', { className: 'data-table' }, [
    el('thead', {}, el('tr', {}, ['Workflow', 'Service', 'State', 'Last run', 'Outcome', 'Next action', ''].map((label) => el('th', { scope: 'col', text: label })))),
    el('tbody', {}, workflows.map((workflow) => el('tr', {}, [
      el('td', { className: 'primary-cell' }, el('button', { className: 'row-button', type: 'button', text: workflow.name, onclick: () => openWorkflowDetail(workflow, context) })),
      el('td', { text: workflow.service }),
      el('td', {}, statusLabel(workflow.status)),
      el('td', { className: 'numeric', text: formatDateTime(workflow.lastRun) }),
      el('td', { text: workflow.progress !== null ? `${workflow.progress}% complete` : workflow.outcome }),
      el('td', { text: workflow.nextAction }),
      el('td', {}, el('button', { className: 'icon-button', type: 'button', 'aria-label': `Open ${workflow.name}`, onclick: () => openWorkflowDetail(workflow, context) }, icon('chevron'))),
    ]))),
  ]);
  return table;
}

export async function renderWorkflows(root, context) {
  root.append(viewHeader('Workflow operations', 'Run, pause, retry, and inspect the workflows installed for this client.', [
    button('Refresh', { icon: 'refresh', onClick: () => context.rerender() }),
  ]));
  const content = el('div');
  root.append(content);
  content.append(loadingState('Loading installed workflows and latest run state…'));
  try {
    const response = await context.api.workflows({ signal: context.signal });
    const workflows = transformInstalledWorkflows(response);
    context.setConnection(true);
    content.replaceChildren();
    if (!workflows.length) {
      content.append(emptyState('No workflows installed', 'This tenant has no installed workflows. Start with a reusable service from the catalog.', {
        icon: 'workflows',
        action: button('Browse services', { variant: 'primary', onClick: () => context.navigate('services') }),
      }));
      return;
    }

    let query = '';
    let status = 'all';
    const shell = el('div');
    const search = el('input', { className: 'input', type: 'search', placeholder: 'Search workflows', 'aria-label': 'Search workflows' });
    const filter = el('select', { className: 'select', 'aria-label': 'Filter workflows by status' }, [
      el('option', { value: 'all', text: 'All states' }),
      ...['ready', 'running', 'succeeded', 'failed', 'paused', 'blocked', 'requested'].map((value) => el('option', { value, text: value[0].toUpperCase() + value.slice(1) })),
    ]);
    const draw = () => {
      const filtered = workflows.filter((workflow) => {
        const matchesQuery = !query || `${workflow.name} ${workflow.service} ${workflow.outcome}`.toLowerCase().includes(query);
        const matchesStatus = status === 'all' || normalizeStatus(workflow.status) === status;
        return matchesQuery && matchesStatus;
      });
      shell.replaceChildren(tableShell('Installed workflows', filtered.length ? renderTable(filtered, context) : el('div', { className: 'empty-state' }, [el('h2', { text: 'No matching workflows' }), el('p', { text: 'Change the search or state filter.' })]), {
        toolbar: el('div', { className: 'filter-row' }, [el('div', { className: 'search-control' }, [icon('search'), search]), filter]),
        footer: [el('span', { text: `${filtered.length} of ${workflows.length} workflows` })],
      }));
    };
    search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); draw(); search.focus(); });
    filter.addEventListener('change', () => { status = filter.value; draw(); });
    draw();
    content.append(shell);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    context.setConnection(false);
    content.replaceChildren(errorState(error, () => context.rerender()));
  }
}
