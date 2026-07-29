import { el } from '../dom.js';
import { icon } from '../icons.js';
import { openArtifactDetail } from '../panels/artifact-detail.js';
import { button, emptyState, errorState, loadingState, statusLabel, tableShell, viewHeader } from '../ui.js';
import { formatBytes, formatDateTime, titleCase, transformArtifactsPayload } from '../../src/transforms.mjs';

function artifactTable(items, context) {
  return el('table', { className: 'data-table' }, [
    el('thead', {}, el('tr', {}, ['Artifact / receipt', 'Type', 'Workflow', 'Created', 'Size', 'Verification', ''].map((label) => el('th', { scope: 'col', text: label })))),
    el('tbody', {}, items.map((artifact) => el('tr', {}, [
      el('td', { className: 'primary-cell' }, el('button', { className: 'row-button', type: 'button', text: artifact.name, onclick: () => openArtifactDetail(artifact, context) })),
      el('td', { text: titleCase(artifact.kind) }),
      el('td', { text: artifact.workflow }),
      el('td', { className: 'numeric', text: formatDateTime(artifact.createdAt) }),
      el('td', { text: formatBytes(artifact.sizeBytes) }),
      el('td', {}, statusLabel(artifact.status)),
      el('td', {}, el('button', { className: 'icon-button', type: 'button', 'aria-label': `Open ${artifact.name}`, onclick: () => openArtifactDetail(artifact, context) }, icon('chevron'))),
    ]))),
  ]);
}

export async function renderArtifacts(root, context) {
  root.append(viewHeader('Artifacts and receipts', 'Inspect generated artifacts and completion evidence returned by the live API.', [
    button('Refresh', { icon: 'refresh', onClick: () => context.rerender() }),
  ]));
  const content = el('div');
  root.append(content);
  content.append(loadingState('Loading artifacts and completion receipts…'));
  try {
    const response = await context.api.artifacts({ signal: context.signal });
    const data = transformArtifactsPayload(response);
    context.setConnection(true);
    content.replaceChildren();
    if (!data.all.length) {
      content.append(emptyState('No artifacts or receipts', 'The live API returned no generated artifacts or completion receipts for this client.', { icon: 'artifacts' }));
      return;
    }
    let kind = 'all';
    let query = '';
    const shell = el('div');
    const search = el('input', { className: 'input', type: 'search', placeholder: 'Search artifacts', 'aria-label': 'Search artifacts' });
    const filter = el('select', { className: 'select', 'aria-label': 'Filter artifact type' }, [
      el('option', { value: 'all', text: 'All evidence' }),
      el('option', { value: 'receipt', text: 'Completion receipts' }),
      el('option', { value: 'artifact', text: 'Artifacts' }),
    ]);
    const draw = () => {
      const filtered = data.all.filter((item) => {
        const receipt = item.kind.includes('receipt');
        const matchesKind = kind === 'all' || (kind === 'receipt' ? receipt : !receipt);
        const matchesQuery = !query || `${item.name} ${item.kind} ${item.workflow}`.toLowerCase().includes(query);
        return matchesKind && matchesQuery;
      });
      shell.replaceChildren(tableShell('Evidence ledger', filtered.length ? artifactTable(filtered, context) : el('div', { className: 'empty-state' }, [el('h2', { text: 'No matching evidence' }), el('p', { text: 'Change the search or evidence filter.' })]), {
        toolbar: el('div', { className: 'filter-row' }, [el('div', { className: 'search-control' }, [icon('search'), search]), filter]),
        footer: [el('span', { text: `${filtered.length} of ${data.all.length} records` })],
      }));
    };
    search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); draw(); search.focus(); });
    filter.addEventListener('change', () => { kind = filter.value; draw(); });
    draw();
    content.append(shell);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    context.setConnection(false);
    content.replaceChildren(errorState(error, () => context.rerender()));
  }
}
