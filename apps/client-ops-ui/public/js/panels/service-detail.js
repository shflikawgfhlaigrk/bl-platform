import { icon } from '../icons.js';
import { el } from '../dom.js';
import { button, definitionList, drawerSection, serviceIcon, statusLabel } from '../ui.js';

function namedList(items, fallbackKey = 'name') {
  return el('ul', { className: 'plain-list' }, items.map((item) => el('li', {}, [
    icon('file'),
    el('span', { text: typeof item === 'string' ? item : item[fallbackKey] || item.label || item.title || item.id || 'Untitled' }),
  ])));
}

export function openServiceDetail(service, context) {
  const body = [
    drawerSection(null, [
      el('div', { className: 'detail-title' }, [icon(serviceIcon(service)), el('div', {}, [statusLabel(service.status)])]),
      service.summary ? el('p', { className: 'detail-summary', text: service.summary }) : null,
      definitionList([
        ['Readiness', statusLabel(service.readiness)],
        ['Workflows', service.workflowCount ?? '—'],
        ['Connectors', service.connectorCount ?? '—'],
        ['Installation', service.installationId || (service.installed ? 'Installed' : 'Not installed')],
      ]),
    ]),
  ];
  if (service.workflows?.length) body.push(drawerSection('Included workflows', namedList(service.workflows)));
  if (service.connectors?.length) body.push(drawerSection('Connector requirements', namedList(service.connectors, 'label')));
  if (service.artifacts?.length) body.push(drawerSection('Artifacts and receipts', namedList(service.artifacts, 'label')));

  const go = button('Open service catalog', { variant: 'primary', onClick: () => context.navigate('services') });
  context.drawer.open({ context: 'Service', title: service.name, body, actions: [go] });
}
