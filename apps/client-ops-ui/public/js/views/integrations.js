import { el } from '../dom.js';
import { icon } from '../icons.js';
import { openConnectorDetail } from '../panels/connector-detail.js';
import { button, emptyState, errorState, loadingState, statusLabel, tableShell, viewHeader } from '../ui.js';
import { filterConnectors, formatRelativeTime, normalizeStatus, titleCase, transformInstalledConnectors } from '../../src/transforms.mjs';

function connectorTable(connectors, context) {
  return el('table', { className: 'data-table' }, [
    el('thead', {}, el('tr', {}, ['Connector', 'Service', 'State', 'Required', 'Credential reference', 'Last checked', ''].map((label) => el('th', { scope: 'col', text: label })))),
    el('tbody', {}, connectors.map((connector) => el('tr', {}, [
      el('td', { className: 'primary-cell' }, el('button', { className: 'row-button', type: 'button', text: connector.name, onclick: () => openConnectorDetail(connector, context) })),
      el('td', { text: connector.category }),
      el('td', {}, statusLabel(connector.status)),
      el('td', { text: connector.required ? 'Yes' : 'No' }),
      el('td', { text: connector.externalRef || 'Not assigned' }),
      el('td', { className: 'numeric', text: formatRelativeTime(connector.lastChecked) }),
      el('td', {}, el('button', { className: 'icon-button', type: 'button', 'aria-label': `Open ${connector.name}`, onclick: () => openConnectorDetail(connector, context) }, icon('chevron'))),
    ]))),
  ]);
}

export async function renderIntegrations(root, context) {
  root.append(viewHeader('Integrations', 'Filter live connector bindings by service and operational state.', [
    button('Refresh', { icon: 'refresh', onClick: () => context.rerender() }),
  ]));
  const content = el('div');
  root.append(content);
  content.append(loadingState('Loading connector bindings…'));
  try {
    const response = await context.api.integrations({ signal: context.signal });
    const connectors = transformInstalledConnectors(response);
    context.setConnection(true);
    content.replaceChildren();
    if (!connectors.length) {
      content.append(emptyState('No connectors configured', 'No connector bindings were returned for this client.', {
        icon: 'integrations',
        action: button('Open client setup', { variant: 'primary', onClick: () => context.navigate('client-setup') }),
      }));
      return;
    }

    let query = '';
    let status = 'all';
    let service = 'all';
    const shell = el('div');
    const search = el('input', { className: 'input', type: 'search', placeholder: 'Search connectors', 'aria-label': 'Search connectors' });
    const statusSelect = el('select', { className: 'select', 'aria-label': 'Filter by connector state' }, [
      el('option', { value: 'all', text: 'All states' }),
      ...['connected', 'pending', 'unhealthy', 'disabled'].map((value) => el('option', { value, text: titleCase(value) })),
    ]);
    const services = [...new Set(connectors.map((item) => item.category))].sort();
    const serviceSelect = el('select', { className: 'select', 'aria-label': 'Filter by service' }, [
      el('option', { value: 'all', text: 'All services' }),
      ...services.map((value) => el('option', { value, text: value })),
    ]);
    const draw = () => {
      const filtered = filterConnectors(connectors, query, status).filter((connector) => service === 'all' || connector.category === service);
      shell.replaceChildren(tableShell('Connector health', filtered.length ? connectorTable(filtered, context) : el('div', { className: 'empty-state' }, [el('h2', { text: 'No matching connectors' }), el('p', { text: 'Change the search, service, or state filter.' })]), {
        toolbar: el('div', { className: 'filter-row' }, [el('div', { className: 'search-control' }, [icon('search'), search]), serviceSelect, statusSelect]),
        footer: [el('span', { text: `${filtered.length} of ${connectors.length} connectors` })],
      }));
    };
    search.addEventListener('input', () => { query = search.value.trim(); draw(); search.focus(); });
    statusSelect.addEventListener('change', () => { status = statusSelect.value; draw(); });
    serviceSelect.addEventListener('change', () => { service = serviceSelect.value; draw(); });
    draw();
    content.append(shell);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    context.setConnection(false);
    content.replaceChildren(errorState(error, () => context.rerender()));
  }
}
