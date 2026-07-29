import { el } from '../dom.js';
import { icon } from '../icons.js';
import { openReviewDetail } from '../panels/review-detail.js';
import { button, emptyState, errorState, loadingState, statusLabel, tableShell, viewHeader } from '../ui.js';
import { formatDateTime, listFrom, normalizeStatus, titleCase, transformReview } from '../../src/transforms.mjs';

function renderReviewTable(reviews, context) {
  return el('table', { className: 'data-table' }, [
    el('thead', {}, el('tr', {}, ['Review item', 'Workflow', 'Requested', 'Priority', 'State', ''].map((label) => el('th', { scope: 'col', text: label })))),
    el('tbody', {}, reviews.map((review) => el('tr', {}, [
      el('td', { className: 'primary-cell' }, el('button', { className: 'row-button', type: 'button', text: review.title, onclick: () => openReviewDetail(review, context) })),
      el('td', { text: review.workflow }),
      el('td', { className: 'numeric', text: formatDateTime(review.requestedAt) }),
      el('td', {}, el('span', { className: `priority is-${review.priority.toLowerCase()}`, text: titleCase(review.priority) })),
      el('td', {}, statusLabel(review.status)),
      el('td', {}, el('button', { className: 'icon-button', type: 'button', 'aria-label': `Review ${review.title}`, onclick: () => openReviewDetail(review, context) }, icon('chevron'))),
    ]))),
  ]);
}

export async function renderReviewInbox(root, context) {
  root.append(viewHeader('Review inbox', 'Approve, deny, or hold high-impact workflow decisions with an auditable operator note.', [
    button('Refresh', { icon: 'refresh', onClick: () => context.rerender() }),
  ]));
  const content = el('div');
  root.append(content);
  content.append(loadingState('Loading review items…'));
  try {
    const response = await context.api.reviews({ signal: context.signal });
    const reviews = listFrom(response, ['reviews']).map(transformReview);
    const pendingCount = reviews.filter((review) => normalizeStatus(review.status) === 'pending').length;
    context.setConnection(true);
    context.setReviewCount(pendingCount);
    content.replaceChildren();
    if (!reviews.length) {
      content.append(emptyState('Review inbox is clear', 'The API returned no review items for this client.', { icon: 'review' }));
      return;
    }

    let activeStatus = 'pending';
    let query = '';
    const shell = el('div');
    const search = el('input', { className: 'input', type: 'search', placeholder: 'Search review items', 'aria-label': 'Search review items' });
    const segments = el('div', { className: 'segmented-control', role: 'group', 'aria-label': 'Review status' });
    const controls = ['all', 'pending', 'held', 'approved', 'denied'].map((value) => {
      const control = el('button', { className: 'segment', type: 'button', text: titleCase(value), 'aria-pressed': String(value === activeStatus) });
      control.addEventListener('click', () => {
        activeStatus = value;
        for (const item of controls) item.setAttribute('aria-pressed', String(item === control));
        draw();
      });
      return control;
    });
    segments.append(...controls);
    const draw = () => {
      const filtered = reviews.filter((review) => {
        const matchesStatus = activeStatus === 'all' || normalizeStatus(review.status) === activeStatus;
        const matchesQuery = !query || `${review.title} ${review.workflow} ${review.priority}`.toLowerCase().includes(query);
        return matchesStatus && matchesQuery;
      });
      const body = filtered.length ? renderReviewTable(filtered, context) : el('div', { className: 'empty-state' }, [el('h2', { text: 'No matching review items' }), el('p', { text: 'Change the state or search filter.' })]);
      shell.replaceChildren(tableShell('Decision queue', body, {
        toolbar: el('div', { className: 'filter-row' }, [segments, el('div', { className: 'search-control' }, [icon('search'), search])]),
        footer: [el('span', { text: `${filtered.length} items shown` }), el('span', { text: `${pendingCount} pending` })],
      }));
    };
    search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); draw(); search.focus(); });
    draw();
    content.append(shell);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    context.setConnection(false);
    content.replaceChildren(errorState(error, () => context.rerender()));
  }
}
