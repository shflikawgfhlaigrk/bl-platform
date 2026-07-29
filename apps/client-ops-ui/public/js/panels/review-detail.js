import { el } from '../dom.js';
import { button, definitionList, drawerSection, inputField, mutateWithFeedback, statusLabel } from '../ui.js';
import { formatDateTime, normalizeStatus, titleCase } from '../../src/transforms.mjs';

export function openReviewDetail(review, context) {
  const noteField = inputField('Decision note', {
    multiline: true,
    rows: 4,
    placeholder: 'Required for Deny and Hold',
    value: review.decisionNote || '',
  });
  const reviewStatus = normalizeStatus(review.status);
  const actionable = reviewStatus === 'pending' || reviewStatus === 'held';
  const approve = button('Approve', { icon: 'check', variant: 'primary', disabled: !actionable });
  const deny = button('Deny', { icon: 'deny', variant: 'danger', disabled: !actionable });
  const hold = button('Hold', { icon: 'hold', disabled: !actionable });

  function decide(control, decision) {
    const note = noteField.control.value.trim();
    if ((decision === 'deny' || decision === 'hold') && !note) {
      context.toast(`A decision note is required to ${decision} this item.`, 'error');
      noteField.control.focus();
      return;
    }
    mutateWithFeedback(control, () => context.api.decideReview(review.id, decision, note || null), context, {
      success: `Review ${decision === 'deny' ? 'denied' : decision === 'hold' ? 'held' : 'approved'}.`,
    }).then(() => context.rerender()).catch(() => {});
  }

  approve.addEventListener('click', () => decide(approve, 'approve'));
  deny.addEventListener('click', () => decide(deny, 'deny'));
  hold.addEventListener('click', () => decide(hold, 'hold'));

  const contextEntries = Object.entries(review.context || {}).slice(0, 8).map(([key, value]) => [titleCase(key), typeof value === 'object' ? JSON.stringify(value) : String(value)]);
  const body = [
    drawerSection(null, definitionList([
      ['State', statusLabel(review.status)],
      ['Workflow', review.workflow],
      ['Priority', titleCase(review.priority)],
      ['Requested', formatDateTime(review.requestedAt)],
    ])),
    contextEntries.length ? drawerSection('Request context', definitionList(contextEntries)) : null,
    drawerSection('Decision', [noteField.root, el('p', { className: 'view-description', text: 'Deny and Hold require a non-empty operator note.' })]),
  ];

  context.drawer.open({ context: 'Review item', title: review.title, body, actions: [approve, deny, hold] });
}
