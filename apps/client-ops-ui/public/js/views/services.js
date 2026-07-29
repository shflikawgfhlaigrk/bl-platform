import { el } from '../dom.js';
import { icon } from '../icons.js';
import { button, emptyState, errorState, inlineLink, loadingState, mutateWithFeedback, packIcon, serviceIcon, statusLabel, viewHeader } from '../ui.js';
import { titleCase, transformCatalogPayload } from '../../src/transforms.mjs';

function itemList(items, labelKey = 'name') {
  if (!items?.length) return el('p', { className: 'view-description', text: 'None listed.' });
  return el('ul', { className: 'plain-list' }, items.slice(0, 8).map((item) => el('li', {}, [
    icon('file'),
    el('span', { text: typeof item === 'string' ? item : item[labelKey] || item.label || item.title || item.id || 'Untitled' }),
  ])));
}

function catalogRows(services, selected, select) {
  return el('div', {}, [
    el('div', { className: 'catalog-columns', 'aria-hidden': 'true' }, [
      el('span', { text: `Service (${services.length})` }),
      el('span', { text: 'Readiness' }),
      el('span', { text: 'Workflows' }),
      el('span', { text: 'Connectors' }),
      el('span'),
    ]),
    ...services.map((service) => el('button', {
      className: `catalog-row${selected?.id === service.id ? ' is-selected' : ''}`,
      type: 'button',
      'aria-pressed': String(selected?.id === service.id),
      onclick: () => select(service),
    }, [
      el('span', { className: 'catalog-service-name' }, [icon(serviceIcon(service)), el('span', { text: service.name })]),
      statusLabel(service.readiness),
      el('span', { className: 'muted-value', text: service.workflowCount ?? '—' }),
      el('span', { className: 'muted-value', text: service.connectorCount ?? '—' }),
      icon('chevron'),
    ])),
  ]);
}

function serviceDetail(service, context) {
  if (!service) return el('div', { className: 'catalog-detail' }, emptyState('Select a service', 'Choose a service from the catalog to inspect its reusable workflows, connectors, artifacts, metrics, and setup requirements.'));

  const start = button(service.installed ? 'Continue client setup' : 'Start client setup', { variant: 'primary' });
  start.addEventListener('click', () => {
    if (service.installed) {
      context.navigate('client-setup');
      return;
    }
    mutateWithFeedback(start, () => context.api.createInstallation('service', service.id, service.name), context, {
      success: `${service.name} installation created.`,
    }).then(() => context.navigate('client-setup')).catch(() => {});
  });

  const blockers = [
    ...(service.connectors || []).filter((item) => item.required).map((item) => item.label || item.name),
    ...(service.onboarding || []).filter((item) => item.required).map((item) => item.title || item.name),
  ];

  return el('article', { className: 'catalog-detail' }, [
    el('div', { className: 'detail-title-row' }, [
      el('div', { className: 'detail-title' }, [icon(serviceIcon(service)), el('div', {}, [el('h2', { text: service.name })])]),
      el('div', {}, [statusLabel(service.readiness), el('div', { className: 'view-description', text: titleCase(service.status) })]),
    ]),
    service.summary ? el('p', { className: 'detail-summary', text: service.summary }) : null,
    el('div', { className: 'detail-columns' }, [
      el('section', { className: 'detail-column' }, [el('h3', { text: `Included workflows (${service.workflows.length})` }), itemList(service.workflows)]),
      el('section', { className: 'detail-column' }, [
        el('h3', { text: `Connector requirements (${service.connectors.length})` }),
        itemList(service.connectors, 'label'),
        el('h3', { text: 'Approval policy' }),
        itemList(service.workflows.map((workflow) => ({ name: workflow.approvalId || 'Configured in workflow' })).slice(0, 3)),
      ]),
      el('section', { className: 'detail-column' }, [
        el('h3', { text: 'Artifacts / receipts' }), itemList(service.artifacts, 'label'),
        el('h3', { text: 'KPIs this service impacts' }), itemList(service.metrics, 'label'),
      ]),
    ]),
    el('footer', { className: 'detail-footer' }, [
      el('section', { className: 'detail-section' }, [
        el('h3', { text: 'Onboarding checklist' }),
        el('ul', { className: 'check-list' }, (service.onboarding || []).slice(0, 5).map((step) => el('li', {}, [icon('hold'), el('span', { text: step.title || step.name })]))),
      ]),
      el('div', { className: 'detail-cta' }, [start, inlineLink('Preview workflows', { onClick: () => context.navigate('workflows') })]),
    ]),
  ]);
}

function packsSection(packs, selectedPack, selectPack, engagementModels, context) {
  let packAction = null;
  if (selectedPack) {
    packAction = button(selectedPack.installed ? 'Continue pack setup' : 'Install selected pack', { variant: 'primary' });
    packAction.addEventListener('click', () => {
      if (selectedPack.installed) {
        context.navigate('client-setup');
        return;
      }
      mutateWithFeedback(packAction, () => context.api.createInstallation('vertical_pack', selectedPack.id, selectedPack.name), context, {
        success: `${selectedPack.name} installation created.`,
      }).then(() => context.navigate('client-setup')).catch(() => {});
    });
  }
  return el('section', { className: 'pack-section' }, [
    el('div', { className: 'panel-header' }, [
      el('div', {}, [el('h2', { text: 'Vertical packs' }), el('span', { className: 'view-description', text: selectedPack ? selectedPack.name : 'Choose one' })]),
      packAction,
    ]),
    packs.length ? el('div', { className: 'pack-grid' }, packs.map((pack, index) => el('button', {
      className: `pack-card${selectedPack?.id === pack.id ? ' is-selected' : ''}`,
      type: 'button',
      'aria-pressed': String(selectedPack?.id === pack.id),
      onclick: () => selectPack(pack),
    }, [
      el('span', { className: 'pack-number', text: index + 1 }),
      icon(packIcon(pack)),
      el('strong', { text: pack.name }),
      el('p', { text: pack.summary }),
    ]))) : emptyState('No vertical packs returned', 'The live catalog did not include any vertical packs.'),
    engagementModels.length ? el('div', { className: 'card-grid pack-section' }, engagementModels.map((model) => el('article', { className: 'panel metric-card' }, [
      el('span', { className: 'metric-label', text: model.name }),
      el('p', { className: 'detail-summary', text: model.description }),
    ]))) : null,
  ]);
}

export async function renderServices(root, context) {
  root.append(viewHeader('Service catalog'));
  const content = el('div');
  root.append(content);
  content.append(loadingState('Loading the signed service catalog and current installations…'));
  try {
    const response = await context.api.services({ signal: context.signal });
    const data = transformCatalogPayload(response);
    context.setConnection(true);
    content.replaceChildren();
    if (!data.services.length) {
      content.append(emptyState('No services returned', 'The Client Operations catalog is live, but it did not return any services.', { icon: 'services' }));
      return;
    }
    let selected = data.services[0];
    let selectedPack = null;
    const layout = el('div');
    const draw = () => {
      layout.replaceChildren(
        el('section', { className: 'catalog-layout' }, [
          el('div', { className: 'catalog-pane' }, [
            el('header', { className: 'catalog-heading' }, [el('h2', { text: 'Reusable services' }), data.catalogVersion ? el('span', { className: 'view-description', text: `Catalog ${data.catalogVersion}` }) : null]),
            catalogRows(data.services, selected, (service) => { selected = service; draw(); }),
          ]),
          serviceDetail(selected, context),
        ]),
        packsSection(data.verticalPacks, selectedPack, (pack) => { selectedPack = pack; draw(); }, data.engagementModels, context),
      );
    };
    draw();
    content.append(layout);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    context.setConnection(false);
    content.replaceChildren(errorState(error, () => context.rerender()));
  }
}
