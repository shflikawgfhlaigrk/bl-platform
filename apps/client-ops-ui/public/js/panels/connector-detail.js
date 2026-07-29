import { el } from '../dom.js';
import { definitionList, drawerSection, statusLabel } from '../ui.js';
import { formatDateTime } from '../../src/transforms.mjs';

export function openConnectorDetail(connector, context) {
  const body = [
    drawerSection(null, definitionList([
      ['State', statusLabel(connector.status)],
      ['Service', connector.category],
      ['Required', connector.required ? 'Yes' : 'No'],
      ['Credential ref', connector.externalRef || 'Not assigned'],
      ['Last checked', formatDateTime(connector.lastChecked)],
    ])),
    connector.message ? drawerSection('Health detail', el('p', { className: 'detail-summary', text: connector.message })) : null,
    connector.capabilities?.length
      ? drawerSection('Capabilities', el('ul', { className: 'plain-list' }, connector.capabilities.map((capability) =>
        el('li', {}, el('span', { text: capability })),
      )))
      : null,
  ];
  context.drawer.open({ context: 'Integration', title: connector.name, body });
}
